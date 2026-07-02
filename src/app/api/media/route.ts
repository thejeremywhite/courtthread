import { NextRequest, NextResponse } from "next/server";
import { getDb, scheduleSave } from "@/lib/db";
import fs from "fs";
import path from "path";

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".aac": "audio/aac",
};

// Where to hunt for media folders that browser (upload://) imports can't locate on their
// own. CT_MEDIA_DIRS (semicolon-separated, optional) is checked first, then legacy defaults.
// This is just a fast-path list; findExportRoot() below is the general, machine-independent
// resolver.
// Known folders that hold message exports on this machine — checked before any wider
// drive scan so resolution is instant. (On another PC these simply don't exist and
// findExportRoot's drive walk takes over.)
const KNOWN_EXPORT_DIRS = [
  "D:\\Storage Drive I Backup",
  "D:\\Storage Drive I Backup\\Trish FB",
  "D:\\Storage Drive I Backup\\Jeremy FB Messages",
  "H:\\OneDrive\\_Waylon Court\\_Supreme Court - Case Conference\\Messaging_Emails_Texts",
  "D:\\tmp\\fb_zips",
];

function mediaSearchDirs(): string[] {
  const dirs = (process.env.CT_MEDIA_DIRS || "")
    .split(";").map((s) => s.trim()).filter(Boolean);
  dirs.push(...KNOWN_EXPORT_DIRS);
  return dirs;
}

// System/huge folders never worth descending into when hunting for an export.
const SKIP_DIRS = new Set([
  "windows", "program files", "program files (x86)", "programdata", "$recycle.bin",
  "system volume information", "node_modules", "appdata", "recovery", "perflogs",
  "$windows.~ws", "$windows.~bt", "msocache", "windows.old",
]);

// Bounded folder search: find a directory named `name` within `maxDepth` of `root`,
// skipping system/hidden dirs. Direct children first (cheap common case).
function findFolderBounded(root: string, name: string, maxDepth: number): string | null {
  let entries: string[];
  try { if (!fs.statSync(root).isDirectory()) return null; entries = fs.readdirSync(root); } catch { return null; }
  for (const e of entries) {
    if (e === name) { try { if (fs.statSync(path.join(root, e)).isDirectory()) return path.join(root, e); } catch {} }
  }
  if (maxDepth <= 0) return null;
  for (const e of entries) {
    if (e.startsWith(".") || e.startsWith("$") || SKIP_DIRS.has(e.toLowerCase())) continue;
    const full = path.join(root, e);
    try { if (!fs.statSync(full).isDirectory()) continue; } catch { continue; }
    const found = findFolderBounded(full, name, maxDepth - 1);
    if (found) return found;
  }
  return null;
}

// Locate an export's ROOT folder (e.g. "facebook-patriciamann-2024-06-08") on local
// storage — any fixed drive or common user folder — WITHOUT hardcoded paths. The caller
// then appends the rest of the relative path to reach the conversation's own folder, where
// the media sits beside the message json. Machine-independent; result gets persisted so
// this scan runs at most once per source.
function findExportRoot(rootName: string): string | null {
  if (!rootName || rootName === "." || rootName.includes(".")) return null;
  const parents: string[] = (process.env.CT_MEDIA_DIRS || "").split(";").map((s) => s.trim()).filter(Boolean);
  parents.push(...KNOWN_EXPORT_DIRS); // known export folders first — instant on this machine
  const up = process.env.USERPROFILE;
  if (up) parents.push(path.join(up, "Desktop"), path.join(up, "Downloads"), path.join(up, "Documents"), up);
  for (let c = 67; c <= 90; c++) { // fixed drive roots C:..Z:
    const d = String.fromCharCode(c) + ":\\";
    try { if (fs.existsSync(d)) parents.push(d); } catch {}
  }
  const seen = new Set<string>();
  for (const p of parents) {
    if (seen.has(p)) continue; seen.add(p);
    const found = findFolderBounded(p, rootName, 4);
    if (found) return found;
  }
  return null;
}

// Per-source in-memory caches so a source's directory is hunted AT MOST ONCE, ever, per
// server run. Without these, every missing file (URL gifs, photos absent from the export)
// re-ran the deep disk hunt — 40+ SECONDS per 404, serializing and starving the browser's
// request queue until the whole app felt dead.
const _dirCache = new Map<string, string>();      // sourceId -> known-good dir (unverified ok)
const _failCache = new Map<string, number>();     // sourceId -> when deep hunt found nothing
const FAIL_TTL_MS = 10 * 60 * 1000;

function resolveSourceDir(db: any, sourceId: string, ignorePersisted = false, deep = false): { dir: string | null; debug?: string; needsPersist?: boolean } {
  const safeId = sourceId.replace(/'/g, "''");
  const result = db.exec(`SELECT file_path, metadata FROM sources WHERE id = '${safeId}'`);
  const sourcePath = result[0]?.values[0]?.[0] as string | undefined;
  const metadataStr = result[0]?.values[0]?.[1] as string | undefined;
  if (!sourcePath) return { dir: null, debug: `no source row for id=${sourceId}` };

  // Check metadata for a user-linked local media path (skipped when the caller wants a
  // from-scratch re-search, e.g. after the persisted path stopped producing hits)
  if (!ignorePersisted && metadataStr) {
    try {
      const meta = JSON.parse(metadataStr);
      if (meta.localMediaPath) {
        try {
          const dir = fs.statSync(meta.localMediaPath).isDirectory()
            ? meta.localMediaPath
            : path.dirname(meta.localMediaPath);
          return { dir };
        } catch {
          // localMediaPath set but not accessible, fall through
        }
      }
    } catch { /* ignore parse errors */ }
  }

  if (sourcePath.startsWith("upload://")) {
    // Try to find a sibling source with a real local path (same conversation title+platform)
    const convResult = db.exec(
      `SELECT DISTINCT s.file_path FROM conversations c
       JOIN conversations c2 ON c.title = c2.title AND c.platform = c2.platform
       JOIN sources s ON c2.source_id = s.id
       WHERE c.source_id = '${safeId}'
         AND s.file_path NOT LIKE 'upload://%'
       LIMIT 1`
    );
    const fallback = convResult[0]?.values[0]?.[0] as string | undefined;
    if (fallback) {
      try {
        const dir = fs.statSync(fallback).isDirectory() ? fallback : path.dirname(fallback);
        return { dir, needsPersist: true };
      } catch {}
    }

    const uploadRel = sourcePath.replace("upload://", "");
    const segments = uploadRel.split(/[/\\]/).filter(Boolean);
    const firstSeg = segments[0] || "";
    const lastSeg = segments[segments.length - 1] || "";
    const searchDirs = mediaSearchDirs();

    // Exact relative-path match first: the browser folder picker preserves the export's
    // internal structure (e.g. "<export>/messages/inbox/<convo>"), so if that export
    // folder sits inside a search dir, <searchDir>\<uploadRel> IS this convo's folder.
    for (const sd of searchDirs) {
      try {
        const direct = path.join(sd, uploadRel);
        if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) return { dir: direct, needsPersist: true };
      } catch {}
    }

    // General machine-independent resolve: find the export ROOT anywhere on local storage,
    // then the conversation folder = <exportRoot>\<rest-of-relative-path> (media beside the
    // json). EXPENSIVE (walks drives) — only in deep mode, which GET runs at most once per
    // source thanks to _dirCache/_failCache.
    if (deep && firstSeg && !firstSeg.includes(".")) {
      const exportRoot = findExportRoot(firstSeg);
      if (exportRoot) {
        const rest = segments.slice(1);
        const convDir = rest.length ? path.join(exportRoot, ...rest) : exportRoot;
        try {
          if (fs.existsSync(convDir) && fs.statSync(convDir).isDirectory()) return { dir: convDir, needsPersist: true };
        } catch {}
      }
    }

    // Then hunt by folder NAME — the deepest segment (the conversation's own folder)
    // first, then the top segment (single-folder uploads like "jessicaarsenault_101...").
    const names = [...new Set([lastSeg, firstSeg])].filter((n) => n && n !== "." && !n.includes("."));
    for (const folderName of names) {
      const allSources = db.exec(`SELECT file_path FROM sources WHERE file_path NOT LIKE 'upload://%'`);
      for (const row of (allSources[0]?.values || [])) {
        const sp = row[0] as string;
        try {
          const spDir = fs.statSync(sp).isDirectory() ? sp : path.dirname(sp);
          if (path.basename(spDir) === folderName) return { dir: spDir, needsPersist: true };
          const candidate = path.join(path.dirname(spDir), folderName);
          if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return { dir: candidate, needsPersist: true };
        } catch {}
      }

      for (const sd of searchDirs) {
        const candidate = path.join(sd, folderName);
        try {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return { dir: candidate, needsPersist: true };
        } catch {}
      }
    }

    return { dir: null, debug: `upload source (${sourcePath}), could not locate the export "${firstSeg}" on local storage. Keep the exported message folder on a local drive, or use "Link Media" on the Import page.` };
  }

  try {
    const dir = fs.statSync(sourcePath).isDirectory() ? sourcePath : path.dirname(sourcePath);
    return { dir };
  } catch (e: any) {
    return { dir: null, debug: `source path not accessible: ${sourcePath} (${e.message})` };
  }
}

function findFile(sourceDir: string, filename: string, subdirs: string[]): string | null {
  for (const sub of subdirs) {
    const candidate = path.join(sourceDir, sub, filename);
    if (fs.existsSync(candidate)) return candidate;
  }
  const direct = path.join(sourceDir, filename);
  if (fs.existsSync(direct)) return direct;
  return null;
}

export async function GET(request: NextRequest) {
  try {
    const sourceId = request.nextUrl.searchParams.get("sourceId");
    const filename = request.nextUrl.searchParams.get("filename");
    const mediaType = request.nextUrl.searchParams.get("type") || "image";

    if (!sourceId || !filename) {
      return NextResponse.json({ error: "sourceId and filename required" }, { status: 400 });
    }

    const db = await getDb();
    // Cheap resolve only: persisted path, sibling source, direct existsSync joins.
    const resolved = resolveSourceDir(db, sourceId);
    let sourceDir = resolved.dir || _dirCache.get(sourceId) || null;

    const subdirs = mediaType === "image" ? ["photos", "gifs", "stickers", "stickers_used"]
      : mediaType === "video" ? ["videos"]
      : mediaType === "audio" ? ["audio"]
      : mediaType === "sticker" ? ["stickers", "stickers_used", "photos"]
      : mediaType === "gif" ? ["gifs", "photos"]
      : ["photos", "gifs", "stickers", "stickers_used", "videos", "audio", "files"];

    let filePath = sourceDir ? findFile(sourceDir, filename, subdirs) : null;
    let usedDir = sourceDir;

    // No directory known for this source at all — run the DEEP hunt (drive walk), but at
    // most once per source: the outcome (good dir or definitive failure) is cached, so
    // every later request — including 404s for files absent from the export — is instant.
    if (!filePath && !sourceDir) {
      const failedAt = _failCache.get(sourceId);
      if (failedAt && Date.now() - failedAt < FAIL_TTL_MS) {
        return NextResponse.json({ error: `Source media folder not found (cached)`, debug: resolved.debug }, { status: 404 });
      }
      const deep = resolveSourceDir(db, sourceId, true, true);
      if (deep.dir) {
        _dirCache.set(sourceId, deep.dir);
        sourceDir = usedDir = deep.dir;
        filePath = findFile(deep.dir, filename, subdirs);
      } else {
        _failCache.set(sourceId, Date.now());
        console.error(`[media] deep resolve failed for source=${sourceId}: ${deep.debug}`);
        return NextResponse.json({ error: `Source not found or no local path available`, debug: deep.debug }, { status: 404 });
      }
    }

    if (!filePath) {
      // Directory is known and trusted — the file simply isn't in the export. 404 NOW;
      // no per-file hunting (that's what made every missing photo cost 40+ seconds).
      return NextResponse.json({ error: `File not found: ${filename}` }, { status: 404 });
    }

    // Persist the working directory ONLY now that a file was actually served from it.
    // (Persisting unverified guesses used to poison sources with a wrong root forever.)
    if (resolved.needsPersist || usedDir !== resolved.dir) {
      try {
        const safeId2 = sourceId.replace(/'/g, "''");
        const metaResult = db.exec(`SELECT metadata FROM sources WHERE id = '${safeId2}'`);
        const existing = metaResult[0]?.values[0]?.[0] as string | undefined;
        let meta: Record<string, unknown> = {};
        try { meta = JSON.parse(existing || "{}"); } catch {}
        meta.localMediaPath = usedDir;
        db.run(`UPDATE sources SET metadata = ? WHERE id = ?`, [JSON.stringify(meta), sourceId]);
        scheduleSave();
        _dirCache.delete(sourceId);
      } catch {}
    }

    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] || "application/octet-stream";
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;

    // Stream video/audio with range request support
    if (mediaType === "video" || mediaType === "audio" || ext === ".mp4" || ext === ".webm" || ext === ".mov" || ext === ".mp3") {
      const rangeHeader = request.headers.get("range");
      if (rangeHeader) {
        const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (match) {
          const start = parseInt(match[1]);
          const end = match[2] ? parseInt(match[2]) : Math.min(start + 1024 * 1024, fileSize - 1);
          const chunkSize = end - start + 1;
          const stream = fs.createReadStream(filePath, { start, end });
          const readable = new ReadableStream({
            start(controller) {
              stream.on("data", (chunk) => controller.enqueue(new Uint8Array(typeof chunk === "string" ? Buffer.from(chunk) : chunk)));
              stream.on("end", () => controller.close());
              stream.on("error", (err) => controller.error(err));
            },
          });
          return new NextResponse(readable, {
            status: 206,
            headers: {
              "Content-Type": mime,
              "Content-Range": `bytes ${start}-${end}/${fileSize}`,
              "Accept-Ranges": "bytes",
              "Content-Length": chunkSize.toString(),
              "Cache-Control": "public, max-age=86400",
            },
          });
        }
      }
      // No range header — return full file with Accept-Ranges
      const stream = fs.createReadStream(filePath);
      const readable = new ReadableStream({
        start(controller) {
          stream.on("data", (chunk) => controller.enqueue(new Uint8Array(typeof chunk === "string" ? Buffer.from(chunk) : chunk)));
          stream.on("end", () => controller.close());
          stream.on("error", (err) => controller.error(err));
        },
      });
      return new NextResponse(readable, {
        headers: {
          "Content-Type": mime,
          "Content-Length": fileSize.toString(),
          "Accept-Ranges": "bytes",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }

    // Images/other: read whole file (typically small)
    const fileBuffer = fs.readFileSync(filePath);
    return new NextResponse(fileBuffer, {
      headers: {
        "Content-Type": mime,
        "Content-Length": fileBuffer.length.toString(),
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
