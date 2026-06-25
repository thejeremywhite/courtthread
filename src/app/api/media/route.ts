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

function findFolderRecursive(root: string, folderName: string, maxDepth: number): string | null {
  if (maxDepth <= 0) return null;
  try {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return null;
    const entries = fs.readdirSync(root);
    for (const entry of entries) {
      if (entry === folderName) {
        const full = path.join(root, entry);
        try { if (fs.statSync(full).isDirectory()) return full; } catch {}
      }
    }
    for (const entry of entries) {
      try {
        const full = path.join(root, entry);
        if (!fs.statSync(full).isDirectory() || entry.startsWith('.')) continue;
        const found = findFolderRecursive(full, folderName, maxDepth - 1);
        if (found) return found;
      } catch {}
    }
  } catch {}
  return null;
}

function resolveSourceDir(db: any, sourceId: string): { dir: string | null; debug?: string; needsPersist?: boolean } {
  const safeId = sourceId.replace(/'/g, "''");
  const result = db.exec(`SELECT file_path, metadata FROM sources WHERE id = '${safeId}'`);
  const sourcePath = result[0]?.values[0]?.[0] as string | undefined;
  const metadataStr = result[0]?.values[0]?.[1] as string | undefined;
  if (!sourcePath) return { dir: null, debug: `no source row for id=${sourceId}` };

  // Check metadata for a user-linked local media path
  if (metadataStr) {
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
    const folderName = uploadRel.split(/[/\\]/)[0];
    if (folderName && folderName !== "." && !folderName.includes(".")) {
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

      const searchDirs = [
        "H:\\OneDrive\\_Waylon Court\\_Supreme Court - Case Conference\\Messaging_Emails_Texts",
        "D:\\tmp\\fb_zips",
      ];
      for (const sd of searchDirs) {
        const candidate = path.join(sd, folderName);
        try {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return { dir: candidate, needsPersist: true };
        } catch {}
      }
      for (const sd of searchDirs) {
        const found = findFolderRecursive(sd, folderName, 8);
        if (found) return { dir: found, needsPersist: true };
      }
    }

    return { dir: null, debug: `upload source (${sourcePath}), could not auto-detect local folder "${folderName}". Use "Link Media" on Import page to set path manually.` };
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
    const { dir: sourceDir, debug, needsPersist } = resolveSourceDir(db, sourceId);
    if (!sourceDir) {
      console.error(`[media] resolve failed for source=${sourceId}: ${debug}`);
      return NextResponse.json({ error: `Source not found or no local path available`, debug }, { status: 404 });
    }
    if (needsPersist) {
      try {
        const safeId2 = sourceId.replace(/'/g, "''");
        const metaResult = db.exec(`SELECT metadata FROM sources WHERE id = '${safeId2}'`);
        const existing = metaResult[0]?.values[0]?.[0] as string | undefined;
        let meta: Record<string, unknown> = {};
        try { meta = JSON.parse(existing || "{}"); } catch {}
        meta.localMediaPath = sourceDir;
        db.run(`UPDATE sources SET metadata = ? WHERE id = ?`, [JSON.stringify(meta), sourceId]);
        scheduleSave();
      } catch {}
    }

    const subdirs = mediaType === "image" ? ["photos", "gifs", "stickers", "stickers_used"]
      : mediaType === "video" ? ["videos"]
      : mediaType === "audio" ? ["audio"]
      : mediaType === "sticker" ? ["stickers", "stickers_used", "photos"]
      : mediaType === "gif" ? ["gifs", "photos"]
      : ["photos", "gifs", "stickers", "stickers_used", "videos", "audio", "files"];

    let filePath = findFile(sourceDir, filename, subdirs);

    if (!filePath) {
      const safeId3 = sourceId!.replace(/'/g, "''");
      const srcResult = db.exec(`SELECT file_path FROM sources WHERE id = '${safeId3}'`);
      const srcPath = srcResult[0]?.values[0]?.[0] as string | undefined;
      const folderName2 = srcPath?.startsWith("upload://")
        ? srcPath.replace("upload://", "").split(/[/\\]/).filter(Boolean).pop()
        : null;
      if (folderName2 && folderName2 !== "." && !folderName2.includes(".")) {
        const fallbackDirs = [
          "H:\\OneDrive\\_Waylon Court\\_Supreme Court - Case Conference\\Messaging_Emails_Texts",
          "D:\\tmp\\fb_zips",
        ];
        for (const sd of fallbackDirs) {
          const found = findFolderRecursive(sd, folderName2, 8);
          if (found && found !== sourceDir) {
            const fpath = findFile(found, filename, subdirs);
            if (fpath) { filePath = fpath; break; }
          }
        }
      }
    }

    if (!filePath) {
      return NextResponse.json({ error: `File not found: ${filename}` }, { status: 404 });
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
