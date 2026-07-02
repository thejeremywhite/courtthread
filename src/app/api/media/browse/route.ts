import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { ensureSourceDir, sourceFileIndex } from "@/lib/media-resolver";

interface MediaEntry {
  filename: string;
  localPath: string;
  type: string;
}

export async function POST(request: NextRequest) {
  try {
    const {
      sourceIds,
      conversationIds,
      senderNames,
      platforms,
      dateFrom,
      dateTo,
      mediaTypes,
      sortOrder = "desc",
      page = 1,
      limit = 40,
      hideMissing = false,
    } = await request.json();

    const hasScope = !!(
      (sourceIds && sourceIds.length > 0) ||
      (conversationIds && conversationIds.length > 0) ||
      (senderNames && senderNames.length > 0) ||
      (platforms && platforms.length > 0) ||
      dateFrom || dateTo
    );

    if (!hasScope) {
      return NextResponse.json(
        { error: "Select at least one filter (import, conversation, sender, date, or platform)." },
        { status: 400 }
      );
    }

    const db = await getDb();

    // Media is stored inside the messages.metadata JSON column as
    // {"media": [{"filename":"x.jpg","localPath":"photos/x.jpg","type":"image"}, ...]}
    // The separate `media` table is not populated by the parsers.
    // Filter to messages that contain media references in metadata.
    let where = `WHERE m.metadata LIKE '%"media":%' AND m.metadata LIKE '%"filename":%'`;

    if (sourceIds && sourceIds.length > 0) {
      const safe = sourceIds.map((id: string) => `'${id.replace(/'/g, "''")}'`).join(",");
      where += ` AND m.source_id IN (${safe})`;
    }
    if (conversationIds && conversationIds.length > 0) {
      const safe = conversationIds.map((id: string) => `'${id.replace(/'/g, "''")}'`).join(",");
      where += ` AND m.conversation_id IN (${safe})`;
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
      SELECT
        m.id as message_id,
        m.content,
        m.timestamp,
        m.conversation_id,
        m.source_id,
        m.is_incoming,
        m.metadata,
        m.message_type,
        p.display_name as sender_name,
        c.title as conversation_title
      FROM messages m
      LEFT JOIN participants p ON m.sender_id = p.id
      LEFT JOIN conversations c ON m.conversation_id = c.id
      ${where}
      ORDER BY m.timestamp ${order}
    `;

    const result = db.exec(mainQuery);
    let allRows: any[] = [];
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

    // Expand each message into one item per media attachment, then apply
    // mediaType filtering in JS (since it's inside JSON, not a SQL column).
    const mediaTypeSet = mediaTypes && mediaTypes.length > 0
      ? new Set(mediaTypes as string[])
      : null;

    function classifyMedia(m: MediaEntry, messageType: string): string {
      const path = (m.localPath || "").toLowerCase();
      const fname = (m.filename || "").toLowerCase();
      // Stickers: path contains stickers_used or stickers/
      if (path.includes("stickers_used") || path.includes("/stickers/") || path.includes("\\stickers\\")) return "sticker";
      // GIFs: path contains /gifs/ or filename ends with .gif
      if (path.includes("/gifs/") || path.includes("\\gifs\\") || fname.endsWith(".gif")) return "gif";
      // Trust the stored type if it's specific (video, audio, sticker)
      if (m.type === "video" || m.type === "audio" || m.type === "sticker") return m.type;
      // Fall back to message_type for single-media messages
      if (messageType === "video" || messageType === "audio" || messageType === "sticker") return messageType;
      return m.type || "image";
    }

    const allItems: any[] = [];
    for (const row of allRows) {
      let meta: any;
      try { meta = JSON.parse(row.metadata); } catch { continue; }
      if (!meta.media || !Array.isArray(meta.media)) continue;

      for (const m of meta.media as MediaEntry[]) {
        if (!m.filename && !m.localPath) continue;
        const resolvedType = classifyMedia(m, row.message_type || "");
        if (mediaTypeSet && !mediaTypeSet.has(resolvedType)) continue;

        allItems.push({
          media_id: `${row.message_id}_${m.filename || m.localPath}`,
          media_type: resolvedType,
          original_filename: m.filename || m.localPath.split(/[/\\]/).pop() || null,
          local_path: m.localPath || "",
          message_id: row.message_id,
          content: row.content,
          timestamp: row.timestamp,
          conversation_id: row.conversation_id,
          source_id: row.source_id,
          is_incoming: row.is_incoming,
          sender_name: row.sender_name,
          conversation_title: row.conversation_title,
        });
      }
    }

    // Mark files that don't exist on disk (missing:true) using cheap CACHED source-dir
    // resolution — the client renders those as missing WITHOUT issuing a request, so
    // doomed 404s never clog the browser's connection pool (they made the sidebar nav
    // hang). With hideMissing, missing items are dropped SERVER-SIDE before pagination:
    // every returned page is then full of real, renderable media — otherwise a page of
    // hidden tiles leaves the viewport empty and the auto-loader chains through the
    // entire catalog nonstop.
    // ensureSourceDir settles each source's folder ONCE (deep hunt cached both ways), and
    // sourceFileIndex makes each per-file check an in-memory lookup (no fs syscalls in the
    // hot path). Both make missing/present DETERMINISTIC across page requests — an
    // unstable pool shifted page boundaries and reshuffled the grid mid-scroll.
    const idxBySource = new Map<string, Map<string, string> | null>();
    const markMissing = (it: any) => {
      let idx = idxBySource.get(it.source_id);
      if (idx === undefined) {
        try {
          const dir = ensureSourceDir(db, it.source_id);
          idx = dir ? sourceFileIndex(dir, it.source_id) : null;
        } catch { idx = null; }
        idxBySource.set(it.source_id, idx);
      }
      it.missing = idx ? !idx.has((it.original_filename || "").toLowerCase()) : true;
    };

    let pool = allItems;
    if (hideMissing) {
      for (const it of pool) markMissing(it);
      pool = pool.filter((it) => it.missing !== true);
    }

    const total = pool.length;
    const offset = (page - 1) * limit;
    const items = pool.slice(offset, offset + limit);
    if (!hideMissing) for (const it of items) markMissing(it);

    return NextResponse.json({
      items,
      total,
      page,
      limit,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
