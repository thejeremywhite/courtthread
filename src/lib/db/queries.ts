import { getDb, scheduleSave } from "./index";

export async function getStats() {
  const db = await getDb();
  const conversations = db.exec("SELECT COUNT(*) FROM conversations")[0]?.values[0]?.[0] as number || 0;
  const messages = db.exec("SELECT COUNT(*) FROM messages")[0]?.values[0]?.[0] as number || 0;
  // Count unique PEOPLE by name (the same person appears as a separate participant
  // row in each import, so counting by id double-counts).
  const participants = db.exec("SELECT COUNT(DISTINCT p.display_name) FROM participants p INNER JOIN conversation_participants cp ON p.id = cp.participant_id INNER JOIN conversations c ON cp.conversation_id = c.id")[0]?.values[0]?.[0] as number || 0;
  const sources = db.exec("SELECT COUNT(*) FROM sources")[0]?.values[0]?.[0] as number || 0;
  return { conversations, messages, participants, sources };
}

// Floors an epoch-ms timestamp to the nearest whole second. Different export formats round
// sub-second precision differently for the SAME real message (one exporter keeps
// milliseconds, another rounds to :000), so exact-ms equality misses most real duplicates —
// used everywhere a message-content signature is built for duplicate detection.
function toSecondMs(ms: number): number {
  return Math.floor(ms / 1000) * 1000;
}

function rowsToObjects(result: any): any[] {
  if (!result || !result[0]) return [];
  const { columns, values } = result[0];
  return values.map((row: any[]) => {
    const obj: any = {};
    columns.forEach((col: string, i: number) => {
      obj[col] = row[i];
    });
    return obj;
  });
}

export async function getConversations(
  page = 1,
  limit = 50,
  sortBy = "last_message_at",
  sortDir: "ASC" | "DESC" = "DESC"
) {
  const db = await getDb();
  const offset = (page - 1) * limit;
  const allowedSorts = ["title", "platform", "message_count", "first_message_at", "last_message_at"];
  const sort = allowedSorts.includes(sortBy) ? sortBy : "last_message_at";

  const result = db.exec(
    `SELECT c.*, GROUP_CONCAT(p.display_name, ', ') as participant_names
     FROM conversations c
     LEFT JOIN conversation_participants cp ON c.id = cp.conversation_id
     LEFT JOIN participants p ON cp.participant_id = p.id
     GROUP BY c.id
     ORDER BY c.${sort} ${sortDir}
     LIMIT ${limit} OFFSET ${offset}`
  );

  const totalResult = db.exec("SELECT COUNT(*) FROM conversations");
  const total = (totalResult[0]?.values[0]?.[0] as number) || 0;

  return { rows: rowsToObjects(result), total, page, limit };
}

export async function getConversation(id: string) {
  const db = await getDb();
  const result = db.exec(
    `SELECT c.*, GROUP_CONCAT(p.display_name, ', ') as participant_names
     FROM conversations c
     LEFT JOIN conversation_participants cp ON c.id = cp.conversation_id
     LEFT JOIN participants p ON cp.participant_id = p.id
     WHERE c.id = '${id.replace(/'/g, "''")}'
     GROUP BY c.id`
  );
  const rows = rowsToObjects(result);
  return rows[0] || null;
}

// Resolves the full set of conversation ids that are duplicate copies of the same
// real-world thread as `id` (see findDuplicateGroup — never merged/deleted in the DB, only
// linked via duplicate_group_id). `primaryId` is the most complete copy (highest
// message_count), used as the tie-breaker when two copies contain an identical message.
export async function getDuplicateGroupIds(id: string): Promise<{ memberIds: string[]; primaryId: string }> {
  const db = await getDb();
  const safeId = id.replace(/'/g, "''");
  const res = db.exec(`
    SELECT c2.id FROM conversations c2
    WHERE COALESCE(c2.duplicate_group_id, c2.id) = (
      SELECT COALESCE(duplicate_group_id, id) FROM conversations WHERE id = '${safeId}'
    )
    ORDER BY c2.message_count DESC, c2.id ASC
  `);
  const memberIds = (res[0]?.values || []).map((r: any[]) => r[0] as string);
  if (memberIds.length === 0) return { memberIds: [id], primaryId: id };
  return { memberIds, primaryId: memberIds[0] };
}

// One-time (re-runnable) retroactive scan: links EXISTING conversations imported before
// findDuplicateGroup existed. Same matching rule (normalized title + platform + identical
// participant name set + at least one overlapping message signature), but pairwise across
// the whole table via union-find so a group can have more than 2 members. Never deletes or
// merges rows — only sets duplicate_group_id, same as the live import-time check.
export async function backfillDuplicateGroups(): Promise<{
  groupsLinked: number;
  conversationsLinked: number;
  details: Array<{ primary: string; primaryTitle: string; linked: string[] }>;
}> {
  const db = await getDb();
  const convRes = db.exec(
    `SELECT id, title, platform, message_count, first_message_at, last_message_at, duplicate_group_id FROM conversations`
  );
  const convs = rowsToObjects(convRes);

  const buckets = new Map<string, any[]>();
  for (const c of convs) {
    const key = `${(c.title || "").trim().toLowerCase()}|${c.platform}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(c);
  }

  const sigCache = new Map<string, Set<string>>();
  const getSignatures = (id: string): Set<string> => {
    if (sigCache.has(id)) return sigCache.get(id)!;
    const safeId = id.replace(/'/g, "''");
    const res = db.exec(
      `SELECT p.display_name, m.timestamp_ms, m.content FROM messages m
       LEFT JOIN participants p ON m.sender_id = p.id WHERE m.conversation_id = '${safeId}'`
    );
    const set = new Set((res[0]?.values || []).map((r: any[]) => `${r[0]}|${toSecondMs(r[1] as number)}|${r[2] || ""}`));
    sigCache.set(id, set);
    return set;
  };

  const parent = new Map<string, string>();
  for (const c of convs) parent.set(c.id, c.id);
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const [, list] of buckets) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.last_message_at < b.first_message_at || b.last_message_at < a.first_message_at) continue;
        const sa = getSignatures(a.id), sb = getSignatures(b.id);
        const required = Math.min(DUPLICATE_MIN_OVERLAP, sa.size, sb.size);
        let overlap = 0;
        for (const s of sa) { if (sb.has(s)) { overlap++; if (overlap >= required) break; } }
        if (overlap >= required) union(a.id, b.id);
      }
    }
  }

  const groups = new Map<string, any[]>();
  for (const c of convs) {
    const root = find(c.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(c);
  }

  let groupsLinked = 0;
  let conversationsLinked = 0;
  const details: Array<{ primary: string; primaryTitle: string; linked: string[] }> = [];
  for (const [, members] of groups) {
    if (members.length < 2) continue;
    members.sort((x, y) => (y.message_count || 0) - (x.message_count || 0) || (x.id < y.id ? -1 : 1));
    const primary = members[0];
    const rest = members.slice(1);
    for (const m of rest) {
      db.run(`UPDATE conversations SET duplicate_group_id = ? WHERE id = ?`, [primary.id, m.id]);
    }
    if (primary.duplicate_group_id) {
      db.run(`UPDATE conversations SET duplicate_group_id = NULL WHERE id = ?`, [primary.id]);
    }
    groupsLinked++;
    conversationsLinked += rest.length;
    details.push({ primary: primary.id, primaryTitle: primary.title, linked: rest.map((r) => r.id) });
  }

  scheduleSave();
  return { groupsLinked, conversationsLinked, details };
}

// One-time (re-runnable) repair for a real parser bug: when a group-chat export omitted a
// member from its participant header even though their messages were still present, the
// import created a throwaway sender_id for them with NO matching participants row — every
// message from that person then showed a blank sender name everywhere (Media grid,
// conversation view, exports). insertConversation/importConversation now back this up going
// forward; this repairs conversations already affected in the live database.
//
// The original name isn't stored anywhere on the orphaned message itself, so recovery works
// by cross-referencing a duplicate-group SIBLING conversation (see findDuplicateGroup) that
// has the same message (matched by truncated-to-the-second timestamp + content) WITH correct
// sender attribution. Where no sibling has that message, the sender is unrecoverable and
// gets a clearly-labeled placeholder instead of staying blank.
export async function repairOrphanedSenders(): Promise<{
  recovered: number;
  unrecoverable: number;
  details: Array<{ conversationId: string; conversationTitle: string; senderId: string; name: string; recovered: boolean }>;
}> {
  const db = await getDb();
  const orphanRes = db.exec(`
    SELECT DISTINCT m.conversation_id, m.sender_id, c.title
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.sender_id NOT IN (SELECT id FROM participants)
  `);
  const orphans = (orphanRes[0]?.values || []).map((r: any[]) => ({
    conversationId: r[0] as string, senderId: r[1] as string, conversationTitle: r[2] as string,
  }));

  let recovered = 0;
  let unrecoverable = 0;
  const details: Array<{ conversationId: string; conversationTitle: string; senderId: string; name: string; recovered: boolean }> = [];

  for (const { conversationId, senderId, conversationTitle } of orphans) {
    const safeConvId = conversationId.replace(/'/g, "''");
    const safeSenderId = senderId.replace(/'/g, "''");
    const { memberIds } = await getDuplicateGroupIds(conversationId);
    const siblingIds = memberIds.filter((mid) => mid !== conversationId);

    let recoveredName: string | null = null;
    if (siblingIds.length > 0) {
      // A handful of sample messages is enough to find one match — no need to check all
      // (sometimes thousands) of this sender's messages in this conversation.
      const sampleRes = db.exec(`
        SELECT substr(timestamp, 1, 19), content FROM messages
        WHERE conversation_id = '${safeConvId}' AND sender_id = '${safeSenderId}'
        LIMIT 5
      `);
      const samples = sampleRes[0]?.values || [];
      for (const sibId of siblingIds) {
        const safeSibId = sibId.replace(/'/g, "''");
        for (const [ts, content] of samples) {
          const contentClause = content == null
            ? "m2.content IS NULL"
            : `m2.content = '${String(content).replace(/'/g, "''")}'`;
          const matchRes = db.exec(`
            SELECT p.display_name FROM messages m2
            LEFT JOIN participants p ON m2.sender_id = p.id
            WHERE m2.conversation_id = '${safeSibId}' AND substr(m2.timestamp, 1, 19) = '${ts}' AND ${contentClause}
            LIMIT 1
          `);
          const name = matchRes[0]?.values?.[0]?.[0] as string | undefined;
          if (name) { recoveredName = name; break; }
        }
        if (recoveredName) break;
      }
    }

    const displayName = recoveredName || "Unknown participant (name lost at import)";
    await insertParticipant({ id: senderId, display_name: displayName });
    db.run(
      `INSERT OR IGNORE INTO conversation_participants (conversation_id, participant_id) VALUES (?, ?)`,
      [conversationId, senderId]
    );

    if (recoveredName) recovered++; else unrecoverable++;
    details.push({ conversationId, conversationTitle, senderId, name: displayName, recovered: !!recoveredName });
  }

  scheduleSave();
  return { recovered, unrecoverable, details };
}

export async function getMessages(
  conversationId: string,
  order: "ASC" | "DESC" = "ASC",
  page = 1,
  limit = 100
) {
  const db = await getDb();
  const offset = (page - 1) * limit;
  const safeId = conversationId.replace(/'/g, "''");

  const result = db.exec(
    `SELECT m.*, p.display_name as sender_name
     FROM messages m
     LEFT JOIN participants p ON m.sender_id = p.id
     WHERE m.conversation_id = '${safeId}'
     ORDER BY COALESCE(m.sort_order, m.rowid) ${order},
              m.timestamp ${order}
     LIMIT ${limit} OFFSET ${offset}`
  );

  const totalResult = db.exec(
    `SELECT COUNT(*) FROM messages WHERE conversation_id = '${safeId}'`
  );
  const total = (totalResult[0]?.values[0]?.[0] as number) || 0;

  return { rows: rowsToObjects(result), total, page, limit };
}

export async function searchMessages(
  query: string,
  options: {
    conversationId?: string;
    participantId?: string;
    platform?: string;
    dateFrom?: string;
    dateTo?: string;
    page?: number;
    limit?: number;
  } = {}
) {
  const db = await getDb();
  const page = options.page || 1;
  const limit = options.limit || 50;
  const offset = (page - 1) * limit;

  let where = "WHERE 1=1";
  if (query) {
    const safeQuery = query.replace(/'/g, "''");
    where += ` AND m.content LIKE '%${safeQuery}%'`;
  }
  if (options.conversationId) {
    where += ` AND m.conversation_id = '${options.conversationId.replace(/'/g, "''")}'`;
  }
  if (options.participantId) {
    where += ` AND m.sender_id = '${options.participantId.replace(/'/g, "''")}'`;
  }
  if (options.platform) {
    where += ` AND m.platform = '${options.platform.replace(/'/g, "''")}'`;
  }
  if (options.dateFrom) {
    where += ` AND m.timestamp >= '${options.dateFrom.replace(/'/g, "''")}'`;
  }
  if (options.dateTo) {
    where += ` AND m.timestamp <= '${options.dateTo.replace(/'/g, "''")}'`;
  }

  const result = db.exec(
    `SELECT m.*, p.display_name as sender_name, c.title as conversation_title
     FROM messages m
     LEFT JOIN participants p ON m.sender_id = p.id
     LEFT JOIN conversations c ON m.conversation_id = c.id
     ${where}
     ORDER BY m.timestamp ASC
     LIMIT ${limit} OFFSET ${offset}`
  );

  const countResult = db.exec(
    `SELECT COUNT(*) FROM messages m ${where}`
  );
  const total = (countResult[0]?.values[0]?.[0] as number) || 0;

  return { rows: rowsToObjects(result), total, page, limit };
}

export async function insertSource(source: {
  id: string;
  filename: string;
  file_path: string;
  file_type: string;
  file_size: number;
  checksum: string;
  metadata: string;
  case_id?: string | null;
  section_id?: string | null;
}) {
  const db = await getDb();
  db.run(
    `INSERT OR REPLACE INTO sources (id, filename, file_path, file_type, file_size, checksum, metadata, case_id, section_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [source.id, source.filename, source.file_path, source.file_type, source.file_size, source.checksum, source.metadata,
     source.case_id || null, source.section_id || null]
  );
  scheduleSave();
}

export async function insertConversation(conv: {
  id: string;
  title: string;
  platform: string;
  source_id: string;
  message_count: number;
  first_message_at: string;
  last_message_at: string;
  metadata: string;
  case_id?: string | null;
  section_id?: string | null;
  duplicate_group_id?: string | null;
}) {
  const db = await getDb();
  db.run(
    `INSERT OR REPLACE INTO conversations (id, title, platform, source_id, message_count, first_message_at, last_message_at, metadata, case_id, section_id, duplicate_group_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [conv.id, conv.title, conv.platform, conv.source_id, conv.message_count, conv.first_message_at, conv.last_message_at, conv.metadata,
     conv.case_id || null, conv.section_id || null, conv.duplicate_group_id || null]
  );
  scheduleSave();
}

// Detect whether a conversation about to be imported is the SAME real-world thread as one
// already in the database (the same export folder uploaded twice, or Facebook's own
// "inbox" + "archived_threads" duplicate of one conversation). NEVER deletes or merges any
// row — returns a duplicate_group_id to LINK them so the app's views can present the group
// as one conversation (messages deduped-by-content for display, unioning truncated/
// complementary imports) while every original row stays intact for provenance.
//
// Matching is: same normalized title + platform, with an overlapping date range as a cheap
// SQL pre-filter, confirmed by finding several messages with an identical
// (sender, timestamp_ms, content) signature in both. Participant lists are NOT required to
// match exactly — real Facebook exports of the "same" thread can legitimately list different
// members depending on when it was exported (people leaving a group, etc.), so requiring
// exact equality caused real duplicates to be missed. Multiple exact message-signature
// matches (sender + millisecond timestamp + content, all identical) is a far stronger and
// still effectively false-positive-proof signal on its own.
const DUPLICATE_MIN_OVERLAP = 3;

export async function findDuplicateGroup(
  title: string,
  platform: string,
  participantNames: string[],
  messages: Array<{ senderName: string; timestampMs: number; content: string | null }>
): Promise<string | null> {
  if (messages.length === 0) return null;
  const db = await getDb();
  const normTitle = (title || "").trim().toLowerCase().replace(/'/g, "''");
  const safePlatform = platform.replace(/'/g, "''");
  const minTs = new Date(Math.min(...messages.map((m) => m.timestampMs))).toISOString();
  const maxTs = new Date(Math.max(...messages.map((m) => m.timestampMs))).toISOString();

  const res = db.exec(`
    SELECT c.id, c.duplicate_group_id
    FROM conversations c
    WHERE LOWER(TRIM(c.title)) = '${normTitle}'
      AND c.platform = '${safePlatform}'
      AND c.first_message_at <= '${maxTs}' AND c.last_message_at >= '${minTs}'
  `);
  const candidates = (res[0]?.values || []).map((r: any[]) => ({ id: r[0] as string, groupId: r[1] as string | null }));
  if (candidates.length === 0) return null;

  const incomingSigs = new Set(messages.map((m) => `${m.senderName}|${toSecondMs(m.timestampMs)}|${m.content || ""}`));
  const requiredOverlap = Math.min(DUPLICATE_MIN_OVERLAP, messages.length);

  for (const cand of candidates) {
    const safeCandId = cand.id.replace(/'/g, "''");
    const mRes = db.exec(`
      SELECT m.timestamp_ms, m.content, p2.display_name
      FROM messages m JOIN participants p2 ON m.sender_id = p2.id
      WHERE m.conversation_id = '${safeCandId}'
    `);
    const candMsgs = mRes[0]?.values || [];
    let overlap = 0;
    for (const row of candMsgs) {
      const sig = `${row[2]}|${toSecondMs(row[0] as number)}|${row[1] || ""}`;
      if (incomingSigs.has(sig)) { overlap++; if (overlap >= requiredOverlap) break; }
    }
    if (overlap >= requiredOverlap) return cand.groupId || cand.id;
  }
  return null;
}

export async function insertParticipant(participant: {
  id: string;
  display_name: string;
  phone_number?: string;
  platform_id?: string;
  aliases?: string;
  is_owner?: number;
}) {
  const db = await getDb();
  db.run(
    `INSERT OR IGNORE INTO participants (id, display_name, phone_number, platform_id, aliases, is_owner)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [participant.id, participant.display_name, participant.phone_number || null, participant.platform_id || null, participant.aliases || null, participant.is_owner || 0]
  );
  scheduleSave();
}

export async function insertMessages(messages: Array<{
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string | null;
  timestamp: string;
  timestamp_ms: number;
  message_type: string;
  is_incoming: number;
  platform: string;
  source_id: string;
  source_index: number;
  metadata: string;
}>) {
  const db = await getDb();
  const stmt = `INSERT OR REPLACE INTO messages (id, conversation_id, sender_id, content, timestamp, timestamp_ms, message_type, is_incoming, platform, source_id, source_index, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  db.run("BEGIN TRANSACTION");
  try {
    for (const msg of messages) {
      db.run(stmt, [
        msg.id, msg.conversation_id, msg.sender_id, msg.content,
        msg.timestamp, msg.timestamp_ms, msg.message_type, msg.is_incoming,
        msg.platform, msg.source_id, msg.source_index, msg.metadata
      ]);

    }
    db.run("COMMIT");
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }
  scheduleSave();
}

export async function getSources() {
  const db = await getDb();
  // Pre-aggregate message/conversation counts in one pass each, then join — far
  // faster than correlated subqueries when there are many sources.
  const result = db.exec(
    `SELECT s.*,
       COALESCE(cc.cnt, 0) as conversation_count,
       COALESCE(mc.cnt, 0) as message_count,
       COALESCE(dc.cnt, 0) as duplicate_conversation_count
     FROM sources s
     LEFT JOIN (SELECT source_id, COUNT(*) cnt FROM conversations GROUP BY source_id) cc ON cc.source_id = s.id
     LEFT JOIN (SELECT source_id, COUNT(*) cnt FROM messages GROUP BY source_id) mc ON mc.source_id = s.id
     LEFT JOIN (
       SELECT c.source_id, COUNT(*) cnt FROM conversations c
       WHERE c.id != (
         SELECT c2.id FROM conversations c2
         WHERE COALESCE(c2.duplicate_group_id, c2.id) = COALESCE(c.duplicate_group_id, c.id)
         ORDER BY c2.message_count DESC, c2.id ASC LIMIT 1
       )
       GROUP BY c.source_id
     ) dc ON dc.source_id = s.id
     ORDER BY s.imported_at DESC`
  );
  const sources = rowsToObjects(result) as any[];
  // Participant names per source — drives the searchable import pickers: typing a
  // person's name finds every import (incl. group chats) they appear in.
  const pRes = db.exec(
    `SELECT c.source_id, GROUP_CONCAT(DISTINCT p.display_name) AS names
     FROM conversations c
     JOIN conversation_participants cp ON cp.conversation_id = c.id
     JOIN participants p ON p.id = cp.participant_id
     GROUP BY c.source_id`
  );
  const namesBySource = new Map<string, string>(
    (pRes[0]?.values || []).map((r: any[]) => [r[0] as string, (r[1] as string) || ""])
  );
  for (const s of sources) {
    s.participant_names = namesBySource.get(s.id) || "";
    // Every conversation this source produced is just a redundant copy of one already
    // present in an earlier import — nothing here is new. Import-scope pickers (Search,
    // Media) use this to hide it so the same import doesn't show up twice; the Import
    // page still lists it (with the duplicate badge) since it's never deleted.
    s.is_duplicate_source = s.conversation_count > 0 && s.duplicate_conversation_count === s.conversation_count;
  }
  return sources;
}

// Delete every source that has no messages (e.g. failed/empty imports), plus
// their empty conversations and any participants left orphaned. Returns count removed.
export async function deleteEmptySources(): Promise<number> {
  const db = await getDb();
  const idsRes = db.exec(
    `SELECT s.id FROM sources s
     WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.source_id = s.id)`
  );
  const ids: string[] = (idsRes[0]?.values || []).map((r: any[]) => r[0] as string);
  if (ids.length === 0) return 0;
  const inList = ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
  db.run("BEGIN TRANSACTION");
  try {
    db.run(`DELETE FROM conversation_participants WHERE conversation_id IN (SELECT id FROM conversations WHERE source_id IN (${inList}))`);
    db.run(`DELETE FROM conversations WHERE source_id IN (${inList})`);
    db.run(`DELETE FROM sources WHERE id IN (${inList})`);
    db.run(`DELETE FROM participants WHERE id NOT IN (SELECT DISTINCT participant_id FROM conversation_participants)`);
    db.run("COMMIT");
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }
  scheduleSave();
  return ids.length;
}

// Delete every source whose EVERY conversation is a non-primary duplicate-group member
// (see findDuplicateGroup / is_duplicate_source in getSources) — the same export imported
// more than once, kept until now for provenance/audit via the Import page's duplicate
// badge. This is a real, permanent, user-triggered delete (unlike the app-wide dedup
// grouping elsewhere, which never touches the underlying rows). Returns count removed.
export async function deleteDuplicateSources(): Promise<number> {
  const db = await getDb();
  const idsRes = db.exec(`
    SELECT s.id FROM sources s
    WHERE EXISTS (SELECT 1 FROM conversations c WHERE c.source_id = s.id)
      AND NOT EXISTS (
        SELECT 1 FROM conversations c WHERE c.source_id = s.id
        AND c.id = (
          SELECT c2.id FROM conversations c2
          WHERE COALESCE(c2.duplicate_group_id, c2.id) = COALESCE(c.duplicate_group_id, c.id)
          ORDER BY c2.message_count DESC, c2.id ASC LIMIT 1
        )
      )
  `);
  const ids: string[] = (idsRes[0]?.values || []).map((r: any[]) => r[0] as string);
  if (ids.length === 0) return 0;
  const inList = ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
  db.run("BEGIN TRANSACTION");
  try {
    db.run(`DELETE FROM messages WHERE source_id IN (${inList})`);
    db.run(`DELETE FROM conversation_participants WHERE conversation_id IN (SELECT id FROM conversations WHERE source_id IN (${inList}))`);
    db.run(`DELETE FROM conversations WHERE source_id IN (${inList})`);
    db.run(`DELETE FROM participants WHERE id NOT IN (SELECT DISTINCT participant_id FROM conversation_participants)`);
    db.run(`DELETE FROM sources WHERE id IN (${inList})`);
    db.run("COMMIT");
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }
  scheduleSave();
  return ids.length;
}

export async function deleteSource(sourceId: string) {
  const db = await getDb();
  const safeId = sourceId.replace(/'/g, "''");
  db.run("BEGIN TRANSACTION");
  try {
    db.run(`DELETE FROM messages WHERE source_id = '${safeId}'`);
    db.run(`DELETE FROM conversation_participants WHERE conversation_id IN (SELECT id FROM conversations WHERE source_id = '${safeId}')`);
    db.run(`DELETE FROM conversations WHERE source_id = '${safeId}'`);
    db.run(`DELETE FROM participants WHERE id NOT IN (SELECT DISTINCT participant_id FROM conversation_participants)`);
    db.run(`DELETE FROM sources WHERE id = '${safeId}'`);
    db.run("COMMIT");
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }
  scheduleSave();
}

export async function deleteConversation(convId: string) {
  const db = await getDb();
  const safeId = convId.replace(/'/g, "''");
  db.run("BEGIN TRANSACTION");
  try {
    db.run(`DELETE FROM messages WHERE conversation_id = '${safeId}'`);
    db.run(`DELETE FROM conversation_participants WHERE conversation_id = '${safeId}'`);
    db.run(`DELETE FROM conversations WHERE id = '${safeId}'`);
    db.run("COMMIT");
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }
  scheduleSave();
}

export async function clearAll() {
  const db = await getDb();
  db.run("BEGIN TRANSACTION");
  try {
    db.run("DELETE FROM messages");
    db.run("DELETE FROM media");
    db.run("DELETE FROM corrections");
    db.run("DELETE FROM conversation_participants");
    db.run("DELETE FROM conversations");
    db.run("DELETE FROM participants");
    db.run("DELETE FROM sources");
    db.run("DELETE FROM saved_filters");
    db.run("DELETE FROM case_sections");
    db.run("DELETE FROM cases");
    db.run("COMMIT");
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }
  scheduleSave();
}

export async function getCases() {
  const db = await getDb();
  const result = db.exec(
    `SELECT c.*,
       (SELECT COUNT(*) FROM case_sections cs WHERE cs.case_id = c.id) as section_count,
       (SELECT COUNT(*) FROM conversations cv WHERE cv.case_id = c.id) as conversation_count
     FROM cases c
     ORDER BY c.created_at DESC`
  );
  return rowsToObjects(result);
}

export async function createCase(data: {
  id: string;
  name: string;
  court_file_number?: string;
  court_name?: string;
  parties?: string;
}) {
  const db = await getDb();
  db.run(
    `INSERT INTO cases (id, name, court_file_number, court_name, parties)
     VALUES (?, ?, ?, ?, ?)`,
    [data.id, data.name, data.court_file_number || null, data.court_name || null, data.parties || null]
  );
  scheduleSave();
}

export async function getCaseSections(caseId: string) {
  const db = await getDb();
  const safeId = caseId.replace(/'/g, "''");
  const result = db.exec(
    `SELECT cs.*,
       (SELECT COUNT(*) FROM conversations cv WHERE cv.section_id = cs.id) as conversation_count
     FROM case_sections cs
     WHERE cs.case_id = '${safeId}'
     ORDER BY cs.sort_order ASC, cs.created_at ASC`
  );
  return rowsToObjects(result);
}

export async function createCaseSection(data: {
  id: string;
  case_id: string;
  name: string;
  section_type?: string;
  description?: string;
  exhibit_prefix?: string;
}) {
  const db = await getDb();
  const maxOrder = db.exec(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 FROM case_sections WHERE case_id = '${data.case_id.replace(/'/g, "''")}'`
  );
  const sortOrder = (maxOrder[0]?.values[0]?.[0] as number) || 0;

  db.run(
    `INSERT INTO case_sections (id, case_id, name, section_type, description, exhibit_prefix, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [data.id, data.case_id, data.name, data.section_type || "general", data.description || null, data.exhibit_prefix || null, sortOrder]
  );
  scheduleSave();
}

export async function deleteCase(caseId: string) {
  const db = await getDb();
  const safeId = caseId.replace(/'/g, "''");
  db.run("BEGIN TRANSACTION");
  try {
    db.run(`UPDATE sources SET case_id = NULL, section_id = NULL WHERE case_id = '${safeId}'`);
    db.run(`UPDATE conversations SET case_id = NULL, section_id = NULL WHERE case_id = '${safeId}'`);
    db.run(`DELETE FROM case_sections WHERE case_id = '${safeId}'`);
    db.run(`DELETE FROM cases WHERE id = '${safeId}'`);
    db.run("COMMIT");
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }
  scheduleSave();
}

export async function getBookmarks(conversationId?: string) {
  const db = await getDb();
  const where = conversationId
    ? `WHERE b.conversation_id = '${conversationId.replace(/'/g, "''")}'`
    : "";
  const result = db.exec(
    `SELECT b.*, m.content, m.timestamp, m.is_incoming, p.display_name as sender_name,
       c.title as conversation_title, c.platform
     FROM bookmarks b
     JOIN messages m ON b.message_id = m.id
     LEFT JOIN participants p ON m.sender_id = p.id
     LEFT JOIN conversations c ON b.conversation_id = c.id
     ${where}
     ORDER BY m.timestamp ASC`
  );
  return rowsToObjects(result);
}

export async function toggleBookmark(messageId: string, conversationId: string, note?: string) {
  const db = await getDb();
  const safeMsg = messageId.replace(/'/g, "''");
  const existing = db.exec(`SELECT id FROM bookmarks WHERE message_id = '${safeMsg}'`);
  if (existing[0]?.values?.length) {
    db.run(`DELETE FROM bookmarks WHERE message_id = '${safeMsg}'`);
    scheduleSave();
    return { bookmarked: false };
  } else {
    const id = crypto.randomUUID ? crypto.randomUUID() : `bm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    db.run(
      `INSERT INTO bookmarks (id, message_id, conversation_id, note) VALUES (?, ?, ?, ?)`,
      [id, messageId, conversationId, note || null]
    );
    scheduleSave();
    return { bookmarked: true, id };
  }
}

export async function getBookmarkedMessageIds(conversationId: string): Promise<Set<string>> {
  const db = await getDb();
  const safeId = conversationId.replace(/'/g, "''");
  const result = db.exec(`SELECT message_id FROM bookmarks WHERE conversation_id = '${safeId}'`);
  const ids = new Set<string>();
  if (result[0]?.values) {
    for (const row of result[0].values) ids.add(row[0] as string);
  }
  return ids;
}

export async function getDashboardData() {
  const db = await getDb();
  const stats = await getStats();
  const bookmarkCount = (db.exec("SELECT COUNT(*) FROM bookmarks")[0]?.values[0]?.[0] as number) || 0;

  const recentConvs = db.exec(
    `SELECT c.id, c.title, c.platform, c.message_count,
       GROUP_CONCAT(p.display_name, ', ') as participant_names,
       c.last_message_at
     FROM conversations c
     LEFT JOIN conversation_participants cp ON c.id = cp.conversation_id
     LEFT JOIN participants p ON cp.participant_id = p.id
     GROUP BY c.id
     ORDER BY c.last_message_at DESC
     LIMIT 5`
  );

  const recentSources = db.exec(
    `SELECT s.id, s.filename, s.file_type, s.imported_at,
       (SELECT COUNT(*) FROM messages m WHERE m.source_id = s.id) as message_count
     FROM sources s
     ORDER BY s.imported_at DESC
     LIMIT 5`
  );

  return {
    ...stats,
    bookmarks: bookmarkCount,
    recentConversations: rowsToObjects(recentConvs),
    recentSources: rowsToObjects(recentSources),
  };
}

export async function deleteCaseSection(sectionId: string) {
  const db = await getDb();
  const safeId = sectionId.replace(/'/g, "''");
  db.run("BEGIN TRANSACTION");
  try {
    db.run(`UPDATE sources SET section_id = NULL WHERE section_id = '${safeId}'`);
    db.run(`UPDATE conversations SET section_id = NULL WHERE section_id = '${safeId}'`);
    db.run(`DELETE FROM case_sections WHERE id = '${safeId}'`);
    db.run("COMMIT");
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }
  scheduleSave();
}

// Auto-detect the OWNER of an import (archive) and put their messages on the right
// (is_incoming=0). The owner is the participant present in a clear majority of the
// import's conversations — the account holder appears in (nearly) every thread, everyone
// else in just theirs. Facebook exports carry no per-message "this is me" flag, so this
// cross-conversation heuristic is the reliable signal. Returns the owner name, or null
// if no clear owner (e.g. a single conversation, or a mixed/ambiguous set) — in which
// case the parse-time ownerName sides are left untouched.
export async function detectAndApplyOwner(sourceIds: string[]): Promise<string | null> {
  const db = await getDb();
  if (!sourceIds || sourceIds.length === 0) return null;
  const inC = sourceIds.map((id) => `'${String(id).replace(/'/g, "''")}'`).join(",");

  const convCount = (db.exec(`SELECT COUNT(*) FROM conversations WHERE source_id IN (${inC})`)[0]?.values[0]?.[0] as number) || 0;
  if (convCount < 2) return null; // can't tell owner from a single conversation

  const res = db.exec(
    `SELECT p.display_name, COUNT(DISTINCT c.id) cnt
     FROM conversations c
     JOIN conversation_participants cp ON cp.conversation_id = c.id
     JOIN participants p ON p.id = cp.participant_id
     WHERE c.source_id IN (${inC})
     GROUP BY p.display_name
     ORDER BY cnt DESC`
  );
  const rows = res[0]?.values || [];
  if (rows.length === 0) return null;
  const owner = rows[0][0] as string;
  const topCnt = rows[0][1] as number;
  const secondCnt = (rows[1]?.[1] as number) || 0;
  // Must dominate: strictly ahead of #2 AND in at least half the conversations.
  if (!owner || topCnt <= secondCnt || topCnt < convCount * 0.5) return null;

  const safe = owner.replace(/'/g, "''");
  db.run(
    `UPDATE messages SET is_incoming = CASE
       WHEN (SELECT display_name FROM participants WHERE id = messages.sender_id) = '${safe}' THEN 0 ELSE 1 END
     WHERE source_id IN (${inC})`
  );
  // Flag the owner's participant rows for this import (used elsewhere, e.g. avatars).
  db.run(
    `UPDATE participants SET is_owner = CASE WHEN display_name = '${safe}' THEN 1 ELSE 0 END
     WHERE id IN (SELECT cp.participant_id FROM conversation_participants cp
                  JOIN conversations c ON c.id = cp.conversation_id WHERE c.source_id IN (${inC}))`
  );
  scheduleSave();
  return owner;
}

// All source ids grouped by import batch (imported_at to the minute), most recent first.
export async function getImportBatches(): Promise<string[][]> {
  const db = await getDb();
  const res = db.exec(`SELECT id, substr(imported_at,1,16) b FROM sources ORDER BY imported_at DESC`);
  const rows = res[0]?.values || [];
  const byBatch = new Map<string, string[]>();
  for (const r of rows) {
    const id = r[0] as string; const b = (r[1] as string) || "";
    if (!byBatch.has(b)) byBatch.set(b, []);
    byBatch.get(b)!.push(id);
  }
  return [...byBatch.values()];
}
