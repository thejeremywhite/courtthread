import { NextRequest, NextResponse } from "next/server";
import { getDb, scheduleSave } from "@/lib/db";

// One-time maintenance: rewrites attachment references inside messages.metadata for a
// phone-extract source whose HTML pointed multiple messages at the same filename (the
// extractor saved colliding attachments as X, X(1), X(2)… but a later conversion pass
// rewrote every HTML ref to the bare X). Corrections are computed OFFLINE by matching
// each file variant's EXIF capture date to message timestamps; this endpoint only
// applies the given list — it never guesses, and rows without an exact match are
// reported back untouched.
export async function POST(request: NextRequest) {
  try {
    const { sourceId, corrections } = await request.json();
    if (!sourceId || !Array.isArray(corrections)) {
      return NextResponse.json({ error: "sourceId and corrections[] required" }, { status: 400 });
    }
    const db = await getDb();
    const safeSource = sourceId.replace(/'/g, "''");

    let applied = 0;
    const misses: any[] = [];
    const multi: any[] = [];

    for (const c of corrections) {
      const { title, dt, oldFilename, newFilename, newLocalPath } = c;
      if (!dt || !oldFilename || !newFilename) { misses.push({ ...c, reason: "malformed" }); continue; }
      // Same local-time interpretation the importer used (new Date("YYYY-MM-DD HH:MM:SS")).
      const ts = new Date(dt).getTime();
      if (isNaN(ts)) { misses.push({ ...c, reason: "bad date" }); continue; }

      const safeTitle = (title || "").replace(/'/g, "''");
      const safeFile = oldFilename.replace(/'/g, "''").replace(/%/g, "");
      // Title narrows the match when thread and conversation names agree; when the
      // extractor truncated a long thread folder name the titles diverge, so fall back
      // to timestamp+filename — but ONLY when that identifies exactly one message.
      const titleClause = title ? `AND cv.title = '${safeTitle}'` : "";
      let res = db.exec(`
        SELECT m.id, m.metadata FROM messages m
        JOIN conversations cv ON cv.id = m.conversation_id
        WHERE m.source_id = '${safeSource}' AND m.timestamp_ms = ${ts}
          ${titleClause}
          AND m.metadata LIKE '%${safeFile}%'
      `);
      let rows = (res[0]?.values || []) as any[][];
      if (rows.length === 0 && title) {
        res = db.exec(`
          SELECT m.id, m.metadata FROM messages m
          WHERE m.source_id = '${safeSource}' AND m.timestamp_ms = ${ts}
            AND m.metadata LIKE '%${safeFile}%'
        `);
        const loose = (res[0]?.values || []) as any[][];
        if (loose.length === 1) rows = loose;
      }
      if (rows.length === 0) { misses.push({ ...c, reason: "no matching message" }); continue; }
      if (rows.length > 1) multi.push({ ...c, count: rows.length });

      for (const [id, metaStr] of rows) {
        let meta: any;
        try { meta = JSON.parse(metaStr as string); } catch { misses.push({ ...c, reason: "bad metadata json" }); continue; }
        if (!Array.isArray(meta.media)) { misses.push({ ...c, reason: "no media array" }); continue; }
        let changed = false;
        for (const entry of meta.media) {
          if (entry.filename === oldFilename) {
            entry.filename = newFilename;
            entry.localPath = newLocalPath || `SMS Attachments/${newFilename}`;
            changed = true;
          }
        }
        if (changed) {
          db.run(`UPDATE messages SET metadata = ? WHERE id = ?`, [JSON.stringify(meta), id as string]);
          applied++;
        } else {
          misses.push({ ...c, reason: "media entry not found in matched message" });
        }
      }
    }

    scheduleSave();
    return NextResponse.json({ applied, misses: misses.length, multiMatched: multi.length, missDetails: misses.slice(0, 50) });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
