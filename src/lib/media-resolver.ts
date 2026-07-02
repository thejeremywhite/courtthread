import fs from "fs";
import path from "path";

// Shared media-location logic for /api/media (serving) and /api/media/browse
// (pre-marking missing files so the client never requests them).

// Known folders that hold message exports on this machine — checked before any wider
// drive scan so resolution is instant. On another PC these simply don't exist and
// findExportRoot's drive walk takes over.
// Omitted entirely in the generic/portable build (CT_GENERIC_TEMPLATE=1) so no personal
// paths ship on the stick; there CT_MEDIA_DIRS + the drive walk do the locating.
const KNOWN_EXPORT_DIRS = process.env.CT_GENERIC_TEMPLATE === "1" ? [] : [
  "D:\\Storage Drive I Backup",
  "D:\\Storage Drive I Backup\\Trish FB",
  "D:\\Storage Drive I Backup\\Jeremy FB Messages",
  "H:\\OneDrive\\_Waylon Court\\_Supreme Court - Case Conference\\Messaging_Emails_Texts",
  "D:\\tmp\\fb_zips",
];

export function mediaSearchDirs(): string[] {
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

// Locate an export's ROOT folder (e.g. "facebook-xxxx-2024-06-08") on local storage —
// any fixed drive or common user folder — WITHOUT hardcoded paths. The caller then
// appends the rest of the relative path to reach the conversation's own folder, where
// the media sits beside the message json. EXPENSIVE — deep mode only, once per source.
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

// Per-source in-memory caches so a source's directory is hunted AT MOST ONCE per server
// run. Without these, every missing file re-ran the deep hunt — 40+ seconds PER 404 —
// serializing and starving the browser's request queue until the whole app felt dead.
export const dirCache = new Map<string, string>();   // sourceId -> known-good dir
export const failCache = new Map<string, number>();  // sourceId -> when deep hunt failed
export const FAIL_TTL_MS = 10 * 60 * 1000;

export function resolveSourceDir(db: any, sourceId: string, ignorePersisted = false, deep = false): { dir: string | null; debug?: string; needsPersist?: boolean } {
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
    // internal structure, so <searchDir>\<uploadRel> IS this convo's folder — also tried
    // under Facebook's standard middles, because picking the "inbox"/"archived_threads"
    // folder itself yields relative paths WITHOUT the "messages\" prefix that exists on
    // disk (e.g. upload://archived_threads/x vs <export>\messages\archived_threads\x).
    for (const sd of searchDirs) {
      for (const mid of ["", "messages", "your_activity_across_facebook\\messages"]) {
        try {
          const direct = mid ? path.join(sd, mid, uploadRel) : path.join(sd, uploadRel);
          if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) return { dir: direct, needsPersist: true };
        } catch {}
      }
    }

    // General machine-independent resolve: find the export ROOT anywhere on local storage,
    // then the conversation folder = <exportRoot>\<rest-of-relative-path> (media beside the
    // json). EXPENSIVE (walks drives) — deep mode only, which runs at most once per source
    // thanks to dirCache/failCache.
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

export function subdirsForType(mediaType: string): string[] {
  return mediaType === "image" ? ["photos", "gifs", "stickers", "stickers_used"]
    : mediaType === "video" ? ["videos"]
    : mediaType === "audio" ? ["audio"]
    : mediaType === "sticker" ? ["stickers", "stickers_used", "photos"]
    : mediaType === "gif" ? ["gifs", "photos"]
    : ["photos", "gifs", "stickers", "stickers_used", "videos", "audio", "files"];
}

export function findFile(sourceDir: string, filename: string, subdirs: string[]): string | null {
  for (const sub of subdirs) {
    const candidate = path.join(sourceDir, sub, filename);
    if (fs.existsSync(candidate)) return candidate;
  }
  const direct = path.join(sourceDir, filename);
  if (fs.existsSync(direct)) return direct;
  return null;
}

// Cheap best-effort dir for a source: persisted/cached/direct joins only — never hunts.
// Used by browse to pre-mark missing files. Returns null when nothing is known yet.
export function cachedSourceDir(db: any, sourceId: string): string | null {
  const hit = dirCache.get(sourceId);
  if (hit) return hit;
  const r = resolveSourceDir(db, sourceId);
  if (r.dir) return r.dir;
  return null;
}

// Per-source file index: ONE readdir sweep of the conversation folder + its media subdirs,
// cached. Turns every per-file existence check into an in-memory lookup — thousands of
// existsSync calls per browse request were blocking Node's single thread, which stalled
// EVERY other page's requests (10-15s sidebar navigation while media loaded).
const fileIndexCache = new Map<string, { at: number; files: Map<string, string> }>();
const MEDIA_SUBDIRS = ["photos", "videos", "audio", "gifs", "stickers", "stickers_used", "files"];
export function sourceFileIndex(dir: string, sourceId: string): Map<string, string> {
  const hit = fileIndexCache.get(sourceId);
  if (hit && Date.now() - hit.at < FAIL_TTL_MS) return hit.files;
  const files = new Map<string, string>(); // lowercased filename -> absolute path
  for (const sub of ["", ...MEDIA_SUBDIRS]) {
    const d = sub ? path.join(dir, sub) : dir;
    try {
      for (const f of fs.readdirSync(d)) {
        const k = f.toLowerCase();
        if (!files.has(k)) files.set(k, path.join(d, f));
      }
    } catch { /* subdir absent */ }
  }
  fileIndexCache.set(sourceId, { at: Date.now(), files });
  return files;
}

// Definitive dir for a source: cheap first, then the deep hunt AT MOST ONCE (cached both
// ways). Browse uses this so missing/present is decided up-front and NEVER changes between
// page requests — an unstable pool shifted page boundaries and made the grid reshuffle
// under the user mid-scroll.
export function ensureSourceDir(db: any, sourceId: string): string | null {
  const cheap = cachedSourceDir(db, sourceId);
  if (cheap) return cheap;
  const failedAt = failCache.get(sourceId);
  if (failedAt && Date.now() - failedAt < FAIL_TTL_MS) return null;
  const deep = resolveSourceDir(db, sourceId, true, true);
  if (deep.dir) { dirCache.set(sourceId, deep.dir); return deep.dir; }
  failCache.set(sourceId, Date.now());
  return null;
}
