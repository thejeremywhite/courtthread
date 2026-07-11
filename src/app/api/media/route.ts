import { NextRequest, NextResponse } from "next/server";
import { getDb, scheduleSave } from "@/lib/db";
import { resolveSourceDir, findFile, subdirsForType, sourceFileIndex, dirCache as _dirCache, failCache as _failCache, FAIL_TTL_MS } from "@/lib/media-resolver";
import fs from "fs";
import path from "path";

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".aac": "audio/aac",
};

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

    const subdirs = subdirsForType(mediaType);

    // In-memory file index first (zero fs syscalls); findFile as fallback. Exact-case
    // lookup before lowercased — same-stem files differing only by case are DIFFERENT
    // photos in phone extracts.
    const idx = sourceDir ? sourceFileIndex(sourceDir, sourceId) : null;
    let filePath = idx
      ? (idx.get(filename) || idx.get(filename.toLowerCase()) || findFile(sourceDir!, filename, subdirs))
      : null;
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
