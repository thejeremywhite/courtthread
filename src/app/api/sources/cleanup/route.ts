import { NextResponse } from "next/server";
import { deleteEmptySources } from "@/lib/db/queries";

// Remove all sources that imported zero messages (empty/failed imports).
export async function POST() {
  try {
    const removed = await deleteEmptySources();
    return NextResponse.json({ success: true, removed });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
