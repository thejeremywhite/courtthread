import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
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
    const result = db.exec(`SELECT file_path FROM sources WHERE id = '${sourceId.replace(/'/g, "''")}'`);
    if (!result[0]?.values[0]?.[0]) {
      return NextResponse.json({ error: "Source not found" }, { status: 404 });
    }

    const sourcePath = result[0].values[0][0] as string;
    if (sourcePath.startsWith("upload://")) {
      return NextResponse.json({ error: "Uploaded files don't have local media" }, { status: 404 });
    }

    const sourceDir = fs.statSync(sourcePath).isDirectory() ? sourcePath : path.dirname(sourcePath);

    const subdirs = mediaType === "image" ? ["photos", "gifs", "stickers"]
      : mediaType === "video" ? ["videos"]
      : mediaType === "audio" ? ["audio"]
      : ["photos", "gifs", "stickers", "videos", "audio", "files"];

    let filePath: string | null = null;
    for (const sub of subdirs) {
      const candidate = path.join(sourceDir, sub, filename);
      if (fs.existsSync(candidate)) { filePath = candidate; break; }
    }
    if (!filePath) {
      const direct = path.join(sourceDir, filename);
      if (fs.existsSync(direct)) filePath = direct;
    }

    if (!filePath) {
      return NextResponse.json({ error: `File not found: ${filename}` }, { status: 404 });
    }

    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] || "application/octet-stream";
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
