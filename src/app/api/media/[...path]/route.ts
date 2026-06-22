import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const ALLOWED_DIRS = (process.env.DATA_DIRS || "")
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean);

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".aac": "audio/aac",
  ".pdf": "application/pdf",
};

function isPathAllowed(filePath: string): boolean {
  const normalized = path.resolve(filePath);
  return ALLOWED_DIRS.some((dir) =>
    normalized.startsWith(path.resolve(dir))
  );
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path: segments } = await params;
  const filePath = decodeURIComponent(segments.join("/"));

  if (!isPathAllowed(filePath)) {
    return NextResponse.json(
      { error: "Access denied: path not in allowed directories" },
      { status: 403 }
    );
  }

  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  const stat = fs.statSync(filePath);
  const fileBuffer = fs.readFileSync(filePath);

  return new NextResponse(fileBuffer, {
    headers: {
      "Content-Type": contentType,
      "Content-Length": stat.size.toString(),
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
