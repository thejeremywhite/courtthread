import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const db = await getDb();
    const q = request.nextUrl.searchParams.get("q") || "";
    const sourceId = request.nextUrl.searchParams.get("sourceId");
    const conversationId = request.nextUrl.searchParams.get("conversationId");

    let query: string;
    if (conversationId) {
      query = `
        SELECT DISTINCT p.id, p.display_name, p.phone_number, p.platform_id, p.is_owner,
          c.platform, c.title as conversation_title, c.id as conversation_id
        FROM participants p
        JOIN conversation_participants cp ON p.id = cp.participant_id
        JOIN conversations c ON cp.conversation_id = c.id
        WHERE cp.conversation_id = '${conversationId.replace(/'/g, "''")}'
        ${q.length >= 3 ? `AND (p.display_name LIKE '%${q.replace(/'/g, "''")}%' OR p.phone_number LIKE '%${q.replace(/'/g, "''")}%')` : ""}
        ORDER BY p.display_name ASC
      `;
    } else if (sourceId) {
      query = `
        SELECT DISTINCT p.id, p.display_name, p.phone_number, p.platform_id, p.is_owner,
          c.platform, c.title as conversation_title, c.id as conversation_id
        FROM participants p
        JOIN conversation_participants cp ON p.id = cp.participant_id
        JOIN conversations c ON cp.conversation_id = c.id
        WHERE c.source_id = '${sourceId.replace(/'/g, "''")}'
        ${q.length >= 3 ? `AND (p.display_name LIKE '%${q.replace(/'/g, "''")}%' OR p.phone_number LIKE '%${q.replace(/'/g, "''")}%')` : ""}
        ORDER BY p.display_name ASC
      `;
    } else {
      query = `
        SELECT DISTINCT p.id, p.display_name, p.phone_number, p.platform_id, p.is_owner,
          c.platform, c.title as conversation_title, c.id as conversation_id
        FROM participants p
        JOIN conversation_participants cp ON p.id = cp.participant_id
        JOIN conversations c ON cp.conversation_id = c.id
        ${q.length >= 3 ? `WHERE p.display_name LIKE '%${q.replace(/'/g, "''")}%' OR p.phone_number LIKE '%${q.replace(/'/g, "''")}%'` : ""}
        ORDER BY p.display_name ASC
      `;
    }

    const result = db.exec(query);
    let participants: any[] = [];
    if (result && result[0]) {
      const { columns, values } = result[0];
      participants = values.map((row: any[]) => {
        const obj: any = {};
        columns.forEach((col: string, i: number) => { obj[col] = row[i]; });
        return obj;
      });
    }

    const grouped = new Map<string, any>();
    for (const p of participants) {
      const key = p.display_name + "|" + (p.phone_number || "");
      if (!grouped.has(key)) {
        grouped.set(key, {
          id: p.id,
          display_name: p.display_name,
          phone_number: p.phone_number,
          is_owner: p.is_owner,
          platforms: [],
          conversations: [],
        });
      }
      const entry = grouped.get(key)!;
      if (p.platform && !entry.platforms.includes(p.platform)) {
        entry.platforms.push(p.platform);
      }
      entry.conversations.push({
        id: p.conversation_id,
        title: p.conversation_title,
        platform: p.platform,
      });
    }

    return NextResponse.json({ participants: Array.from(grouped.values()) });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
