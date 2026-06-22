import { NextRequest, NextResponse } from "next/server";
import { getCaseSections, createCaseSection } from "@/lib/db/queries";
import { v4 as uuidv4 } from "uuid";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const sections = await getCaseSections(id);
    return NextResponse.json({ sections });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: caseId } = await params;
    const { name, section_type, description, exhibit_prefix } = await request.json();
    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    const id = uuidv4();
    await createCaseSection({
      id,
      case_id: caseId,
      name,
      section_type,
      description,
      exhibit_prefix,
    });
    return NextResponse.json({ id, name });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
