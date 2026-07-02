import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function POST(request: NextRequest) {
  try {
    const {
      query,
      useRegex = false,
      matchCase = false,
      conversationIds,
      participantIds,
      excludeParticipantIds,
      senderNames,
      sourceIds,
      platforms,
      dateFrom,
      dateTo,
      contextLines = 3,
      contextMode = "time",
      contextDirection = "both",
      sortOrder = "asc",
      page = 1,
      limit = 50,
    } = await request.json();

    const hasQuery = !!(query && query.trim());
    const hasScope = !!(
      (conversationIds && conversationIds.length > 0) ||
      (participantIds && participantIds.length > 0) ||
      (senderNames && senderNames.length > 0) ||
      (sourceIds && sourceIds.length > 0) ||
      (platforms && platforms.length > 0) ||
      dateFrom || dateTo
    );

    // Allow a query-less search (e.g. by date or sender), but require SOME filter
    // so we never dump the entire database.
    if (!hasQuery && !hasScope) {
      return NextResponse.json(
        { error: "Enter a search term or apply at least one filter (date, sender, conversation, or import)." },
        { status: 400 }
      );
    }

    const db = await getDb();
    const offset = (page - 1) * limit;

    let where = "WHERE 1=1";

    if (hasQuery) {
      if (useRegex) {
        where += " AND m.content IS NOT NULL";
      } else {
        const safeQuery = query.replace(/'/g, "''");
        where += ` AND m.content LIKE '%${safeQuery}%'`;
      }
    }

    if (conversationIds && conversationIds.length > 0) {
      const safe = conversationIds.map((id: string) => `'${id.replace(/'/g, "''")}'`).join(",");
      where += ` AND m.conversation_id IN (${safe})`;
    }
    if (sourceIds && sourceIds.length > 0) {
      const safe = sourceIds.map((id: string) => `'${id.replace(/'/g, "''")}'`).join(",");
      where += ` AND m.source_id IN (${safe})`;
    }
    if (participantIds && participantIds.length > 0) {
      const safe = participantIds.map((id: string) => `'${id.replace(/'/g, "''")}'`).join(",");
      where += ` AND m.conversation_id IN (
        SELECT conversation_id FROM conversation_participants WHERE participant_id IN (${safe})
      )`;
    }
    // Exempt whole conversations that any of these participants are part of — e.g. filtering
    // out the "Facebook user" placeholder or numeric-only (unresolved) names that clutter
    // results, without hand-picking every conversation they happen to appear in.
    if (excludeParticipantIds && excludeParticipantIds.length > 0) {
      const safe = excludeParticipantIds.map((id: string) => `'${id.replace(/'/g, "''")}'`).join(",");
      where += ` AND m.conversation_id NOT IN (
        SELECT conversation_id FROM conversation_participants WHERE participant_id IN (${safe})
      )`;
    }
    if (senderNames && senderNames.length > 0) {
      const safe = senderNames.map((n: string) => `'${n.replace(/'/g, "''")}'`).join(",");
      where += ` AND p.display_name IN (${safe})`;
    }
    if (platforms && platforms.length > 0) {
      const safe = platforms.map((p: string) => `'${p.replace(/'/g, "''")}'`).join(",");
      where += ` AND m.platform IN (${safe})`;
    }
    if (dateFrom) {
      where += ` AND m.timestamp >= '${dateFrom.replace(/'/g, "''")}'`;
    }
    if (dateTo) {
      where += ` AND m.timestamp <= '${dateTo.replace(/'/g, "''")}'`;
    }

    const order = sortOrder === "desc" ? "DESC" : "ASC";
    const mainQuery = `
      SELECT m.*, p.display_name as sender_name, c.title as conversation_title,
             s.file_type as source_file_type, s.metadata as source_metadata
      FROM messages m
      LEFT JOIN participants p ON m.sender_id = p.id
      LEFT JOIN conversations c ON m.conversation_id = c.id
      LEFT JOIN sources s ON m.source_id = s.id
      ${where}
      ORDER BY m.timestamp ${order}
    `;

    let allRows: any[] = [];
    const result = db.exec(mainQuery);
    if (result && result[0]) {
      const { columns, values } = result[0];
      allRows = values.map((row: any[]) => {
        const obj: any = {};
        columns.forEach((col: string, i: number) => {
          obj[col] = row[i];
        });
        return obj;
      });
    }

    if (hasQuery && useRegex) {
      try {
        const flags = matchCase ? "" : "i";
        const re = new RegExp(query, flags);
        allRows = allRows.filter((row) => row.content && re.test(row.content));
      } catch (e: any) {
        return NextResponse.json(
          { error: `Invalid regex: ${e.message}` },
          { status: 400 }
        );
      }
    }

    const total = allRows.length;
    const matchedRows = allRows.slice(offset, offset + limit);

    const resultsWithContext = await Promise.all(
      matchedRows.map(async (row) => {
        let contextMessages: any[] = [];

        if (contextLines > 0) {
          let contextQuery: string;

          if (contextMode === "messages") {
            const safeConvId = row.conversation_id.replace(/'/g, "''");
            const toObjects = (res: any) => {
              if (!res || !res[0]) return [];
              const { columns: cols, values: vals } = res[0];
              return vals.map((r: any[]) => {
                const o: any = {};
                cols.forEach((c: string, i: number) => { o[c] = r[i]; });
                return o;
              });
            };
            let before: any[] = [];
            let after: any[] = [];
            if (contextDirection !== "after") {
              const beforeResult = db.exec(`
                SELECT m.*, p.display_name as sender_name
                FROM messages m
                LEFT JOIN participants p ON m.sender_id = p.id
                WHERE m.conversation_id = '${safeConvId}'
                AND m.timestamp <= '${row.timestamp}'
                ORDER BY m.timestamp DESC
                LIMIT ${contextLines + 1}
              `);
              before = toObjects(beforeResult).reverse();
            }
            if (contextDirection !== "before") {
              const afterResult = db.exec(`
                SELECT m.*, p.display_name as sender_name
                FROM messages m
                LEFT JOIN participants p ON m.sender_id = p.id
                WHERE m.conversation_id = '${safeConvId}'
                AND m.timestamp > '${row.timestamp}'
                ORDER BY m.timestamp ASC
                LIMIT ${contextLines}
              `);
              after = toObjects(afterResult);
            }
            if (contextDirection === "after") {
              const selfResult = db.exec(`
                SELECT m.*, p.display_name as sender_name
                FROM messages m
                LEFT JOIN participants p ON m.sender_id = p.id
                WHERE m.id = '${row.id.replace(/'/g, "''")}'
                LIMIT 1
              `);
              before = toObjects(selfResult);
            }
            contextMessages = [...before, ...after];
            contextQuery = "";
          } else {
            const ts = new Date(row.timestamp);
            const startMs = contextDirection !== "after" ? ts.getTime() - contextLines * 60 * 1000 : ts.getTime();
            const endMs = contextDirection !== "before" ? ts.getTime() + contextLines * 60 * 1000 : ts.getTime();
            const startIso = new Date(startMs).toISOString();
            const endIso = new Date(endMs).toISOString();
            contextQuery = `
              SELECT m.*, p.display_name as sender_name
              FROM messages m
              LEFT JOIN participants p ON m.sender_id = p.id
              WHERE m.conversation_id = '${row.conversation_id.replace(/'/g, "''")}'
              AND m.timestamp >= '${startIso}'
              AND m.timestamp <= '${endIso}'
              ORDER BY m.timestamp ASC
              LIMIT 100`;
          }

          if (contextQuery) {
            const contextResult = db.exec(contextQuery);
            if (contextResult && contextResult[0]) {
              const { columns, values } = contextResult[0];
              contextMessages = values.map((r: any[]) => {
                const obj: any = {};
                columns.forEach((col: string, i: number) => {
                  obj[col] = r[i];
                });
                return obj;
              });
            }
          }
        }

        return { ...row, context: contextMessages };
      })
    );

    return NextResponse.json({
      results: resultsWithContext,
      total,
      page,
      limit,
      query,
      useRegex,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
