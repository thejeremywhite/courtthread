import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

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

    const safeId = id.replace(/'/g, "''");
    let where = `WHERE m.conversation_id = '${safeId}'`;

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

    const query = `
      SELECT m.*, p.display_name as sender_name
      FROM messages m
      LEFT JOIN participants p ON m.sender_id = p.id
      ${where}
      ORDER BY m.timestamp ${order}
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
    if (direction === "backward") rows.reverse();

    let countWhere = `WHERE conversation_id = '${safeId}'`;
    if (sender) {
      countWhere = `WHERE m.conversation_id = '${safeId}'`;
      if (dateFrom) countWhere += ` AND m.timestamp >= '${dateFrom.replace(/'/g, "''")}'`;
      if (dateTo) countWhere += ` AND m.timestamp <= '${dateTo.replace(/'/g, "''")}'`;
    }
    let totalQuery: string;
    if (sender) {
      totalQuery = `SELECT COUNT(*) FROM messages m LEFT JOIN participants p ON m.sender_id = p.id WHERE m.conversation_id = '${safeId}' AND p.display_name = '${sender.replace(/'/g, "''")}'`;
      if (dateFrom) totalQuery += ` AND m.timestamp >= '${dateFrom.replace(/'/g, "''")}'`;
      if (dateTo) totalQuery += ` AND m.timestamp <= '${dateTo.replace(/'/g, "''")}'`;
    } else {
      totalQuery = `SELECT COUNT(*) FROM messages m WHERE m.conversation_id = '${safeId}'`;
      if (dateFrom) totalQuery += ` AND m.timestamp >= '${dateFrom.replace(/'/g, "''")}'`;
      if (dateTo) totalQuery += ` AND m.timestamp <= '${dateTo.replace(/'/g, "''")}'`;
    }
    const totalResult = db.exec(totalQuery);
    const total = (totalResult[0]?.values[0]?.[0] as number) || 0;

    return NextResponse.json({
      messages: rows,
      total,
      hasMore,
      nextCursor: hasMore && rows.length > 0 ? rows[rows.length - 1].timestamp : null,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
