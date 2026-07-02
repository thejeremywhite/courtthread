import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getDuplicateGroupIds } from "@/lib/db/queries";

// Drops exact-duplicate messages (same sender name + timestamp + content — i.e. the same
// real message present in more than one duplicate-group import copy), keeping the first
// occurrence. Rows are pre-sorted so the "primary" (most complete) copy's version wins ties.
// Messages unique to a truncated copy have no matching signature and simply pass through —
// this is the "join them, never duplicate" behavior.
function dedupeMessageRows(rows: any[]): any[] {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const row of rows) {
    const key = `${row.sender_name}|${row.timestamp}|${row.content ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = await getDb();
    const cursor = request.nextUrl.searchParams.get("cursor") || "";
    const direction = request.nextUrl.searchParams.get("direction") || "forward";
    const limit = parseInt(request.nextUrl.searchParams.get("limit") || "100");

    const sender = request.nextUrl.searchParams.get("sender") || "";
    const dateFrom = request.nextUrl.searchParams.get("dateFrom") || "";
    const dateTo = request.nextUrl.searchParams.get("dateTo") || "";
    const anchor = request.nextUrl.searchParams.get("anchor") || "";

    const { memberIds, primaryId } = await getDuplicateGroupIds(id);
    const isGrouped = memberIds.length > 1;
    const safeIds = memberIds.map((mid) => `'${mid.replace(/'/g, "''")}'`).join(",");
    const safePrimaryId = primaryId.replace(/'/g, "''");
    // Tiebreaker so that when two group members have an identical message (same timestamp),
    // the primary/most-complete copy's row is fetched first and wins the dedup above.
    const primaryFirst = isGrouped ? `, CASE WHEN m.conversation_id = '${safePrimaryId}' THEN 0 ELSE 1 END` : "";
    const conversationFilter = isGrouped ? `m.conversation_id IN (${safeIds})` : `m.conversation_id = '${id.replace(/'/g, "''")}'`;

    // Anchored load: jump to a specific message anywhere in the thread and return a
    // window of messages around it (filters ignored — this is a direct jump).
    if (anchor) {
      const safeAnchor = anchor.replace(/'/g, "''");
      const aRes = db.exec(`SELECT timestamp FROM messages WHERE id = '${safeAnchor}' AND ${conversationFilter}`);
      const aTs = aRes[0]?.values[0]?.[0] as string | undefined;
      if (aTs) {
        const beforeWin = 20;
        const afterWin = Math.min(Math.max(limit, 50), 300);
        // Over-fetch when grouped so that after dedup we still have a full window.
        const fetchMult = isGrouped ? memberIds.length : 1;
        const toObjs = (res: any): any[] => {
          if (!res || !res[0]) return [];
          const { columns, values } = res[0];
          return values.map((row: any[]) => {
            const o: any = {}; columns.forEach((c: string, i: number) => { o[c] = row[i]; }); return o;
          });
        };
        const beforeRes = db.exec(`
          SELECT m.*, p.display_name as sender_name FROM messages m
          LEFT JOIN participants p ON m.sender_id = p.id
          WHERE ${conversationFilter} AND m.timestamp < '${aTs}'
          ORDER BY m.timestamp DESC${primaryFirst} LIMIT ${beforeWin * fetchMult}`);
        const afterRes = db.exec(`
          SELECT m.*, p.display_name as sender_name FROM messages m
          LEFT JOIN participants p ON m.sender_id = p.id
          WHERE ${conversationFilter} AND m.timestamp >= '${aTs}'
          ORDER BY m.timestamp ASC${primaryFirst} LIMIT ${afterWin * fetchMult}`);
        const before = dedupeMessageRows(toObjs(beforeRes)).reverse().slice(-beforeWin);
        const after = dedupeMessageRows(toObjs(afterRes)).slice(0, afterWin);
        const rows = [...before, ...after];
        const totalRes = isGrouped
          ? db.exec(`SELECT COUNT(*) FROM (SELECT DISTINCT p.display_name, m.timestamp, m.content FROM messages m LEFT JOIN participants p ON m.sender_id = p.id WHERE ${conversationFilter})`)
          : db.exec(`SELECT COUNT(*) FROM messages WHERE ${conversationFilter}`);
        const total = (totalRes[0]?.values[0]?.[0] as number) || 0;
        const hasMore = after.length >= afterWin;
        return NextResponse.json({
          messages: rows,
          total,
          hasMore,
          nextCursor: hasMore && rows.length > 0 ? rows[rows.length - 1].timestamp : null,
        });
      }
    }

    let where = `WHERE ${conversationFilter}`;

    if (sender) {
      where += ` AND p.display_name = '${sender.replace(/'/g, "''")}'`;
    }
    if (dateFrom) {
      where += ` AND m.timestamp >= '${dateFrom.replace(/'/g, "''")}'`;
    }
    if (dateTo) {
      where += ` AND m.timestamp <= '${dateTo.replace(/'/g, "''")}'`;
    }

    if (cursor) {
      const safeCursor = cursor.replace(/'/g, "''");
      if (direction === "forward") {
        where += ` AND m.timestamp > '${safeCursor}'`;
      } else {
        where += ` AND m.timestamp < '${safeCursor}'`;
      }
    }

    const order = direction === "forward" ? "ASC" : "DESC";
    // Over-fetch when grouped so dedup still leaves a full page.
    const fetchMult = isGrouped ? memberIds.length : 1;

    const query = `
      SELECT m.*, p.display_name as sender_name
      FROM messages m
      LEFT JOIN participants p ON m.sender_id = p.id
      ${where}
      ORDER BY m.timestamp ${order}${primaryFirst}
      LIMIT ${(limit + 1) * fetchMult}
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
    if (isGrouped) rows = dedupeMessageRows(rows);

    const hasMore = rows.length > limit;
    if (hasMore) rows = rows.slice(0, limit);
    if (direction === "backward") rows.reverse();

    let totalQuery: string;
    if (isGrouped) {
      totalQuery = `SELECT COUNT(*) FROM (SELECT DISTINCT p.display_name, m.timestamp, m.content FROM messages m LEFT JOIN participants p ON m.sender_id = p.id WHERE ${conversationFilter}`;
      if (sender) totalQuery += ` AND p.display_name = '${sender.replace(/'/g, "''")}'`;
      if (dateFrom) totalQuery += ` AND m.timestamp >= '${dateFrom.replace(/'/g, "''")}'`;
      if (dateTo) totalQuery += ` AND m.timestamp <= '${dateTo.replace(/'/g, "''")}'`;
      totalQuery += ")";
    } else if (sender) {
      totalQuery = `SELECT COUNT(*) FROM messages m LEFT JOIN participants p ON m.sender_id = p.id WHERE ${conversationFilter} AND p.display_name = '${sender.replace(/'/g, "''")}'`;
      if (dateFrom) totalQuery += ` AND m.timestamp >= '${dateFrom.replace(/'/g, "''")}'`;
      if (dateTo) totalQuery += ` AND m.timestamp <= '${dateTo.replace(/'/g, "''")}'`;
    } else {
      totalQuery = `SELECT COUNT(*) FROM messages m WHERE ${conversationFilter}`;
      if (dateFrom) totalQuery += ` AND m.timestamp >= '${dateFrom.replace(/'/g, "''")}'`;
      if (dateTo) totalQuery += ` AND m.timestamp <= '${dateTo.replace(/'/g, "''")}'`;
    }
    const totalResult = db.exec(totalQuery);
    const total = (totalResult[0]?.values[0]?.[0] as number) || 0;

    // For backward mode, rows are reversed (oldest first after reverse).
    // The cursor must be the oldest timestamp (rows[0]) so the next page
    // fetches messages OLDER than the oldest we already have.
    const cursorRow = direction === "backward" ? rows[0] : rows[rows.length - 1];
    return NextResponse.json({
      messages: rows,
      total,
      hasMore,
      nextCursor: hasMore && cursorRow ? cursorRow.timestamp : null,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
