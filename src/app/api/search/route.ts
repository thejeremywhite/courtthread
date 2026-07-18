import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// A photo/video message has content IS NULL — its filename lives only in metadata's
// media[].filename/localPath. Search needs to match against those too (e.g. locating a
// specific photo by its filename or hash-like identifier), not just message text.
function mediaFilenames(metadataJson: string | null): string[] {
  if (!metadataJson) return [];
  try {
    const meta = JSON.parse(metadataJson);
    if (!Array.isArray(meta?.media)) return [];
    return meta.media.flatMap((m: any) => [m.filename, m.localPath].filter(Boolean));
  } catch {
    return [];
  }
}

// Facebook (and others) export media under the file's short INTERNAL id — e.g.
// "647682466327544.jpg" — while the browser shows the long CDN-served name when you open
// the photo, something like "277911411_..._7496580356120897148_n_647682466327544.jpg". The
// short exported name is always a substring of the long CDN one, but not vice versa, so a
// plain "does the filename contain the query" check misses every search pasted from a
// browser tab. Check both directions: does a filename contain the query, or does the
// (much more specific) query contain a filename.
function matchesMediaFilename(filenames: string[], query: string, matchCase: boolean): boolean {
  const q = matchCase ? query : query.toLowerCase();
  for (const f of filenames) {
    const name = matchCase ? f : f.toLowerCase();
    // Also compare without the extension — a query copied from a browser tab or the app's
    // own search box commonly omits the trailing ".jpg"/".mp4", which would otherwise break
    // the "query contains the short stored filename" direction.
    const nameNoExt = name.replace(/\.[a-z0-9]{2,5}$/, "");
    if (name.includes(q) || q.includes(name) || q.includes(nameNoExt)) return true;
  }
  return false;
}

export async function POST(request: NextRequest) {
  try {
    const {
      query,
      useRegex = false,
      matchCase = false,
      conversationIds,
      participantIds,
      excludeConversationIds,
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
      // Media-only messages (a photo/video with no caption) have content IS NULL — the
      // filename lives only in metadata's media[].filename/localPath. A search for a
      // filename (or any hash-like media identifier — common for locating a specific
      // photo/video in context) must not exclude those rows up front.
      if (useRegex) {
        where += " AND (m.content IS NOT NULL OR m.metadata LIKE '%\"filename\":%')";
      } else {
        const safeQuery = query.replace(/'/g, "''");
        where += ` AND (m.content LIKE '%${safeQuery}%' OR m.metadata LIKE '%${safeQuery}%')`;
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
    // Exempt whole conversations by id — e.g. filtering out the "Facebook user" placeholder
    // or numeric-only (unresolved) names that clutter results. The client resolves an
    // excluded PERSON to their conversation ids (same aggregation as include's
    // participantIds->conversations), which correctly covers every distinct participant
    // row sharing that display name across separate imports — a name-only lookup here
    // would miss all but one of those rows.
    if (excludeConversationIds && excludeConversationIds.length > 0) {
      const safe = excludeConversationIds.map((id: string) => `'${id.replace(/'/g, "''")}'`).join(",");
      where += ` AND m.conversation_id NOT IN (${safe})`;
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

    // Wildcard / filters-only browse (no search TEXT): a flat per-message dump of an
    // entire import is useless noise (Jeremy: "makes the page super long" — 164k rows for
    // one browse; "it should bring up each conversation... that contains the specific
    // things we filtered for"). Return one row per CONVERSATION that has at least one
    // message matching the applied filters (date range, sender, included/excluded person),
    // with the matched date range and count — a compact summary instead of every message.
    if (!hasQuery) {
      // This mode returns one row per CONVERSATION (see below), so — unlike the message-
      // level search further down — duplicate-group copies really do need collapsing to
      // just the most complete one here, or the same conversation shows up twice in the
      // summary list (exactly the "88 imports" duplicate-picker bug from earlier).
      //
      // The "which copy is primary" check used to run as a correlated subquery attached
      // directly to the per-MESSAGE where clause — evaluated once per matching message row
      // (up to 200k+ at Jeremy's current scale) instead of once per conversation (~1k).
      // sql.js runs synchronously on Node's single thread, so that didn't just make this
      // endpoint slow, it froze the ENTIRE server for the duration — every other request
      // (search person, sources, everything) queued up behind it and looked broken/stuck.
      // Compute the small non-primary-id set ONCE here (one pass over conversations) and
      // fold it into a plain NOT IN, which is a cheap indexed lookup like excludeConversationIds.
      const nonPrimaryRes = db.exec(`
        SELECT c.id FROM conversations c
        WHERE c.id != (
          SELECT c2.id FROM conversations c2
          WHERE COALESCE(c2.duplicate_group_id, c2.id) = COALESCE(c.duplicate_group_id, c.id)
          ORDER BY c2.message_count DESC, c2.id ASC LIMIT 1
        )
      `);
      const nonPrimaryIds: string[] = (nonPrimaryRes[0]?.values || []).map((r: any[]) => r[0] as string);
      const whereConvSummary = nonPrimaryIds.length > 0
        ? where + ` AND m.conversation_id NOT IN (${nonPrimaryIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")})`
        : where;
      const convAgg = `
        SELECT m.conversation_id,
               COUNT(*) as matched_count,
               MIN(m.timestamp) as first_matched_at,
               MAX(m.timestamp) as last_matched_at
        FROM messages m
        LEFT JOIN participants p ON m.sender_id = p.id
        ${whereConvSummary}
        GROUP BY m.conversation_id
      `;
      const convQuery = `
        SELECT c.id, c.title, c.platform, c.source_id,
               GROUP_CONCAT(DISTINCT p2.display_name) as participant_names,
               c.message_count as total_message_count,
               agg.matched_count, agg.first_matched_at, agg.last_matched_at
        FROM (${convAgg}) agg
        JOIN conversations c ON c.id = agg.conversation_id
        LEFT JOIN conversation_participants cp2 ON cp2.conversation_id = c.id
        LEFT JOIN participants p2 ON p2.id = cp2.participant_id
        GROUP BY c.id
        ORDER BY agg.last_matched_at ${order}
        LIMIT ${limit} OFFSET ${offset}
      `;
      const countQuery = `SELECT COUNT(*) as cnt FROM (${convAgg})`;

      const toObjects = (res: any) => {
        if (!res || !res[0]) return [];
        const { columns, values } = res[0];
        return values.map((row: any[]) => {
          const obj: any = {};
          columns.forEach((col: string, i: number) => { obj[col] = row[i]; });
          return obj;
        });
      };

      const conversations = toObjects(db.exec(convQuery));
      const countResult = db.exec(countQuery);
      const total = (countResult[0]?.values[0]?.[0] as number) || 0;

      return NextResponse.json({
        mode: "conversations",
        conversations,
        total,
        page,
        limit,
        query,
      });
    }

    const mainQuery = `
      SELECT m.*, p.display_name as sender_name, c.title as conversation_title,
             s.file_type as source_file_type, s.metadata as source_metadata,
             c.duplicate_group_id as conv_dup_group_id, c.message_count as conv_message_count
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
        allRows = allRows.filter((row) =>
          re.test(row.content || "") || matchesMediaFilename(mediaFilenames(row.metadata), query, matchCase)
        );
      } catch (e: any) {
        return NextResponse.json(
          { error: `Invalid regex: ${e.message}` },
          { status: 400 }
        );
      }
    }

    // Duplicate conversations (same export imported twice — see findDuplicateGroup) are
    // never deleted or merged in the DB. Unlike the conversation-summary mode above, a
    // message-level search must NOT just pick one copy and drop the other — a truncated
    // copy can have real messages the "more complete" copy is missing (that's the whole
    // "join them, never duplicate" point). So every copy stays in the candidate pool, and
    // only EXACT content collisions between copies collapse to one result (preferring the
    // more complete conversation's version), same signature logic as the conversation
    // detail view's message union.
    const seenSignatures = new Map<string, number>();
    const deduped: any[] = [];
    for (const row of allRows) {
      const groupAnchor = row.conv_dup_group_id || row.conversation_id;
      const key = `${groupAnchor}|${row.sender_name}|${String(row.timestamp).slice(0, 19)}|${row.content ?? ""}`;
      const existingIdx = seenSignatures.get(key);
      if (existingIdx === undefined) {
        seenSignatures.set(key, deduped.length);
        deduped.push(row);
      } else if ((row.conv_message_count || 0) > (deduped[existingIdx].conv_message_count || 0)) {
        deduped[existingIdx] = row;
      }
    }
    allRows = deduped;

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
