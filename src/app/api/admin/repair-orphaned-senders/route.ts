import { NextResponse } from "next/server";
import { repairOrphanedSenders } from "@/lib/db/queries";

// One-time (re-runnable) maintenance action: backfills a participants row for messages whose
// sender was never persisted (a real parser bug — see repairOrphanedSenders), recovering the
// real name from a duplicate-group sibling conversation where possible. Non-destructive.
export async function POST() {
  try {
    const result = await repairOrphanedSenders();
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
