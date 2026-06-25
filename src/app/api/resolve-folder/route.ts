import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import fs from "fs";
import path from "path";

export async function POST(request: NextRequest) {
  try {
    const { folderName } = await request.json();
    if (!folderName) {
      return NextResponse.json({ path: null });
    }

    // 1. Check if any existing source has a real path containing this folder name
    const db = await getDb();
    const result = db.exec(
      `SELECT file_path FROM sources WHERE file_path NOT LIKE 'upload://%' ORDER BY imported_at DESC`
    );
    const knownPaths = (result[0]?.values || []).map((r: any[]) => r[0] as string);
    for (const kp of knownPaths) {
      const dir = fs.statSync(kp).isDirectory() ? kp : path.dirname(kp);
      if (path.basename(dir) === folderName && fs.existsSync(dir)) {
        return NextResponse.json({ path: dir });
      }
      const parent = path.dirname(dir);
      const candidate = path.join(parent, folderName);
      if (fs.existsSync(candidate)) {
        return NextResponse.json({ path: candidate });
      }
    }

    // 2. Search common parent directories
    const searchDirs = [
      "H:\\OneDrive\\_Waylon Court\\_Supreme Court - Case Conference\\Messaging_Emails_Texts",
      "D:\\tmp\\fb_zips",
      "D:\\tmp\\fb_zips\\facebook-TheJeremyWhite-2024-10-04-l4hWHVZF\\your_facebook_activity\\messages\\inbox",
    ];
    for (const dir of searchDirs) {
      const candidate = path.join(dir, folderName);
      if (fs.existsSync(candidate)) {
        return NextResponse.json({ path: candidate });
      }
    }

    return NextResponse.json({ path: null });
  } catch {
    return NextResponse.json({ path: null });
  }
}
