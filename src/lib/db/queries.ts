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
}) {
  const db = await getDb();
  db.run(
    `INSERT OR REPLACE INTO sources (id, filename, file_path, file_type, file_size, checksum, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [source.id, source.filename, source.file_path, source.file_type, source.file_size, source.checksum, source.metadata]
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
}) {
  const db = await getDb();
  db.run(
    `INSERT OR REPLACE INTO conversations (id, title, platform, source_id, message_count, first_message_at, last_message_at, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [conv.id, conv.title, conv.platform, conv.source_id, conv.message_count, conv.first_message_at, conv.last_message_at, conv.metadata]
  );
  scheduleSave();
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
       COALESCE(mc.cnt, 0) as message_count
     FROM sources s
     LEFT JOIN (SELECT source_id, COUNT(*) cnt FROM conversations GROUP BY source_id) cc ON cc.source_id = s.id
     LEFT JOIN (SELECT source_id, COUNT(*) cnt FROM messages GROUP BY source_id) mc ON mc.source_id = s.id
     ORDER BY s.imported_at DESC`
  );
  return rowsToObjects(result);
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
