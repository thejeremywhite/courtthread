import { NextRequest, NextResponse } from "next/server";
import { getCases, createCase } from "@/lib/db/queries";
import { v4 as uuidv4 } from "uuid";

export async function GET() {
  try {
    const cases = await getCases();
    return NextResponse.json({ cases });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { name, court_file_number, court_name, parties } = await request.json();
    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    const id = uuidv4();
    await createCase({ id, name, court_file_number, court_name, parties });
    return NextResponse.json({ id, name });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
