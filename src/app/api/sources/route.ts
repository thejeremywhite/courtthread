import { NextResponse } from "next/server";
import { getSources } from "@/lib/db/queries";

export async function GET() {
  try {
    const sources = await getSources();
    return NextResponse.json({ sources });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
