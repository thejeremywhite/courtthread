import { NextResponse } from "next/server";
import { clearAll } from "@/lib/db/queries";

export async function POST() {
  try {
    await clearAll();
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
