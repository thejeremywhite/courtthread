import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const db = await getDb();
    const q = request.nextUrl.searchParams.get("q") || "";
    const platform = request.nextUrl.searchParams.get("platform") || "";
    const sourceId = request.nextUrl.searchParams.get("sourceId") || "";
    const cursor = request.nextUrl.searchParams.get("cursor") || "";
    const sort = request.nextUrl.searchParams.get("sort") || "newest";
    const dateFrom = request.nextUrl.searchParams.get("dateFrom") || "";
    const dateTo = request.nextUrl.searchParams.get("dateTo") || "";
    const limit = parseInt(request.nextUrl.searchParams.get("limit") || "30");
    // Both resolved CLIENT-SIDE to conversation ids (from a picked person's .conversations),
    // not participant ids — a display name like "Facebook user" is a separate DB row per
    // import, so a single-id lookup here would miss all but one of them.
    const conversationIds = (request.nextUrl.searchParams.get("conversationIds") || "")
      .split(",").filter(Boolean);
    const excludeConversationIds = (request.nextUrl.searchParams.get("excludeConversationIds") || "")
      .split(",").filter(Boolean);

    let where = "WHERE 1=1";
    if (q.length >= 2) {
      const safe = q.replace(/'/g, "''");
      where += ` AND (c.title LIKE '%${safe}%' OR p_names.names LIKE '%${safe}%')`;
    }
    if (platform) {
      where += ` AND c.platform = '${platform.replace(/'/g, "''")}'`;
    }
    if (sourceId) {
      where += ` AND c.source_id = '${sourceId.replace(/'/g, "''")}'`;
    }
    if (conversationIds.length > 0) {
      const safe = conversationIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
      where += ` AND c.id IN (${safe})`;
    }
    if (excludeConversationIds.length > 0) {
      const safe = excludeConversationIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
      where += ` AND c.id NOT IN (${safe})`;
    }
    if (dateFrom) {
      where += ` AND c.last_message_at >= '${dateFrom.replace(/'/g, "''")}'`;
    }
    if (dateTo) {
      where += ` AND c.first_message_at <= '${dateTo.replace(/'/g, "''")}'`;
    }
    // Duplicate conversations (same export imported twice — see findDuplicateGroup) are never
    // deleted or merged in the DB. For the list view we only show the most complete member of
    // each duplicate_group_id group; the rest stay in the DB for provenance but are hidden here.
    where += ` AND c.id = (
      SELECT c2.id FROM conversations c2
      WHERE COALESCE(c2.duplicate_group_id, c2.id) = COALESCE(c.duplicate_group_id, c.id)
      ORDER BY c2.message_count DESC, c2.id ASC LIMIT 1
    )`;

    const orderCol = "c.last_message_at";
    const orderDir = sort === "oldest" ? "ASC" : "DESC";

    if (cursor) {
      const safeCursor = cursor.replace(/'/g, "''");
      if (sort === "oldest") {
        where += ` AND c.last_message_at > '${safeCursor}'`;
      } else {
        where += ` AND c.last_message_at < '${safeCursor}'`;
      }
    }

    const query = `
      SELECT c.*, GROUP_CONCAT(p.display_name, ', ') as participant_names,
        (SELECT COUNT(*) FROM conversations c3 WHERE COALESCE(c3.duplicate_group_id, c3.id) = COALESCE(c.duplicate_group_id, c.id)) as duplicate_count
      FROM conversations c
      LEFT JOIN conversation_participants cp ON c.id = cp.conversation_id
      LEFT JOIN participants p ON cp.participant_id = p.id
      LEFT JOIN (
        SELECT cp2.conversation_id, GROUP_CONCAT(p2.display_name, ', ') as names
        FROM conversation_participants cp2
        JOIN participants p2 ON cp2.participant_id = p2.id
        GROUP BY cp2.conversation_id
      ) p_names ON p_names.conversation_id = c.id
      ${where}
      GROUP BY c.id
      ORDER BY ${orderCol} ${orderDir}
      LIMIT ${limit + 1}
    `;

    const result = db.exec(query);
    let rows: any[] = [];
    if (result && result[0]) {
      const { columns, values } = result[0];
      rows = values.map((row: any[]) => {
        const obj: any = {};
        columns.forEach((col: string, i: number) => { obj[col] = row[i]; });
        return obj;
      });
    }

    const hasMore = rows.length > limit;
    if (hasMore) rows = rows.slice(0, limit);
    const nextCursor = hasMore && rows.length > 0 ? rows[rows.length - 1].last_message_at : null;

    const totalResult = db.exec(`
      SELECT COUNT(DISTINCT c.id) FROM conversations c
      LEFT JOIN conversation_participants cp ON c.id = cp.conversation_id
      LEFT JOIN participants p ON cp.participant_id = p.id
      LEFT JOIN (
        SELECT cp2.conversation_id, GROUP_CONCAT(p2.display_name, ', ') as names
        FROM conversation_participants cp2
        JOIN participants p2 ON cp2.participant_id = p2.id
        GROUP BY cp2.conversation_id
      ) p_names ON p_names.conversation_id = c.id
      ${where}
    `);
    const total = (totalResult[0]?.values[0]?.[0] as number) || 0;

    const platformsResult = db.exec("SELECT DISTINCT platform FROM conversations ORDER BY platform");
    const platforms: string[] = [];
    if (platformsResult[0]) {
      for (const row of platformsResult[0].values) platforms.push(row[0] as string);
    }

    return NextResponse.json({ conversations: rows, total, nextCursor, platforms });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
