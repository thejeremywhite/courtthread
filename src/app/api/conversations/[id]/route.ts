import { NextRequest, NextResponse } from "next/server";
import { deleteConversation, getConversation, getMessages } from "@/lib/db/queries";
import { getDb } from "@/lib/db";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const conversation = await getConversation(id);
    if (!conversation) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const db = await getDb();
    const safeId = id.replace(/'/g, "''");
    const participantsResult = db.exec(
      `SELECT DISTINCT p.display_name
       FROM participants p
       INNER JOIN conversation_participants cp ON p.id = cp.participant_id
       WHERE cp.conversation_id = '${safeId}'
       ORDER BY p.display_name`
    );
    const participants: string[] = [];
    if (participantsResult[0]) {
      for (const row of participantsResult[0].values) {
        participants.push(row[0] as string);
      }
    }

    return NextResponse.json({ ...conversation, participants });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await deleteConversation(id);
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
