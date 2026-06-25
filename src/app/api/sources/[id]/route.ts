import { NextRequest, NextResponse } from "next/server";
import { deleteSource } from "@/lib/db/queries";
import { getDb, scheduleSave } from "@/lib/db";
import fs from "fs";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await deleteSource(id);
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();

    const db = await getDb();
    const safeId = id.replace(/'/g, "''");
    const result = db.exec(`SELECT metadata FROM sources WHERE id = '${safeId}'`);
    if (!result[0]) {
      return NextResponse.json({ error: "Source not found" }, { status: 404 });
    }
    const existing = result[0]?.values[0]?.[0] as string | undefined;

    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(existing || "{}"); } catch {}

    if (body.metadata && typeof body.metadata === "object") {
      Object.assign(meta, body.metadata);
    } else if (body.localMediaPath && typeof body.localMediaPath === "string") {
      const trimmed = body.localMediaPath.trim();
      if (!fs.existsSync(trimmed)) {
        return NextResponse.json({ error: `Path does not exist: ${trimmed}` }, { status: 400 });
      }
      meta.localMediaPath = trimmed;
    }

    if (meta.localMediaPath && typeof meta.localMediaPath === "string") {
      const mp = (meta.localMediaPath as string).trim();
      if (mp && !fs.existsSync(mp)) {
        return NextResponse.json({ error: `Media path does not exist: ${mp}` }, { status: 400 });
      }
    }

    db.run(`UPDATE sources SET metadata = ? WHERE id = ?`, [JSON.stringify(meta), id]);
    scheduleSave();

    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
