import { getDb, scheduleSave } from "./index";

export async function getStats() {
  const db = await getDb();
  const conversations = db.exec("SELECT COUNT(*) FROM conversations")[0]?.values[0]?.[0] as number || 0;
  const messages = db.exec("SELECT COUNT(*) FROM messages")[0]?.values[0]?.[0] as number || 0;
  const participants = db.exec("SELECT COUNT(*) FROM participants")[0]?.values[0]?.[0] as number || 0;
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

      if (msg.content) {
        db.run(
          `INSERT INTO messages_fts (rowid, content, sender_name)
           SELECT m.rowid, m.content, COALESCE(p.display_name, '')
           FROM messages m LEFT JOIN participants p ON m.sender_id = p.id
           WHERE m.id = ?`,
          [msg.id]
        );
      }
    }
    db.run("COMMIT");
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }
  scheduleSave();
}
