import { NextResponse } from "next/server";
import { deleteDuplicateSources } from "@/lib/db/queries";

// Permanently deletes every source whose every conversation is a non-primary duplicate-group
// member (the same export imported more than once) — an explicit, user-triggered cleanup.
export async function POST() {
  try {
    const removed = await deleteDuplicateSources();
    return NextResponse.json({ success: true, removed });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
