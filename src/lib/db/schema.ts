export const schema = `
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  file_path TEXT,
  file_type TEXT NOT NULL,
  file_size INTEGER,
  checksum TEXT,
  metadata TEXT,
  imported_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  platform TEXT NOT NULL,
  source_id TEXT REFERENCES sources(id),
  message_count INTEGER DEFAULT 0,
  first_message_at TEXT,
  last_message_at TEXT,
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  phone_number TEXT,
  platform_id TEXT,
  aliases TEXT,
  is_owner INTEGER DEFAULT 0,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS conversation_participants (
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  participant_id TEXT REFERENCES participants(id),
  PRIMARY KEY (conversation_id, participant_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id TEXT REFERENCES participants(id),
  content TEXT,
  timestamp TEXT NOT NULL,
  timestamp_ms INTEGER,
  message_type TEXT DEFAULT 'text',
  is_incoming INTEGER,
  platform TEXT NOT NULL,
  source_id TEXT REFERENCES sources(id),
  source_index INTEGER,
  metadata TEXT,
  sort_order INTEGER
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  sender_name,
  tokenize='porter unicode61'
);

CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  media_type TEXT NOT NULL,
  original_filename TEXT,
  local_path TEXT NOT NULL,
  mime_type TEXT,
  file_size INTEGER,
  width INTEGER,
  height INTEGER,
  duration_seconds INTEGER,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS corrections (
  id TEXT PRIMARY KEY,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  original_value TEXT,
  corrected_value TEXT,
  reason TEXT,
  corrected_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS saved_filters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  filter_config TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
