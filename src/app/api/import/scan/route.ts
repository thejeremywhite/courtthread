import { NextRequest, NextResponse } from "next/server";
import { scanForFiles } from "@/lib/parsers";

export async function POST(request: NextRequest) {
  try {
    const { path: dirPath, recursive = true } = await request.json();

    if (!dirPath) {
      return NextResponse.json({ error: "Path is required" }, { status: 400 });
    }

    const files = await scanForFiles(dirPath, recursive);
    return NextResponse.json({ files, count: files.length });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
