import { NextRequest, NextResponse } from "next/server";
import { deleteConversation, getConversation, getMessages, getDuplicateGroupIds } from "@/lib/db/queries";
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
    const { memberIds, primaryId } = await getDuplicateGroupIds(id);
    const safeIds = memberIds.map((mid) => `'${mid.replace(/'/g, "''")}'`).join(",");
    const participantsResult = db.exec(
      `SELECT DISTINCT p.display_name
       FROM participants p
       INNER JOIN conversation_participants cp ON p.id = cp.participant_id
       WHERE cp.conversation_id IN (${safeIds})
       ORDER BY p.display_name`
    );
    const participants: string[] = [];
    if (participantsResult[0]) {
      for (const row of participantsResult[0].values) {
        participants.push(row[0] as string);
      }
    }

    // Deduped message count across all copies in the duplicate group (see getDuplicateGroupIds) —
    // exact-duplicate messages (same sender/timestamp/content in two import copies) count once;
    // messages unique to a truncated copy still count, satisfying "join them, never duplicate".
    let messageCount = conversation.message_count;
    if (memberIds.length > 1) {
      const countRes = db.exec(`
        SELECT COUNT(*) FROM (
          SELECT DISTINCT p.display_name, m.timestamp, m.content
          FROM messages m LEFT JOIN participants p ON m.sender_id = p.id
          WHERE m.conversation_id IN (${safeIds})
        )
      `);
      messageCount = (countRes[0]?.values[0]?.[0] as number) || messageCount;
    }

    return NextResponse.json({
      ...conversation,
      participants,
      message_count: messageCount,
      duplicate_group_member_ids: memberIds.length > 1 ? memberIds : undefined,
      duplicate_group_primary_id: memberIds.length > 1 ? primaryId : undefined,
    });
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
