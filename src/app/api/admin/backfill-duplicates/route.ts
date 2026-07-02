import { NextResponse } from "next/server";
import { backfillDuplicateGroups } from "@/lib/db/queries";

// One-time (re-runnable) maintenance action: links conversations imported before duplicate
// detection existed at import time. Non-destructive — only sets duplicate_group_id, never
// deletes or merges rows. Safe to call again after importing an old archive.
export async function POST() {
  try {
    const result = await backfillDuplicateGroups();
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
