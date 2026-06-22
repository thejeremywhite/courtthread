export type Platform = "facebook" | "sms" | "call";

export type MessageType =
  | "text"
  | "image"
  | "video"
  | "call"
  | "system"
  | "sticker"
  | "share"
  | "audio";

export interface NormalizedMessage {
  content: string | null;
  timestamp: Date;
  timestampMs: number;
  senderName: string;
  isIncoming: boolean;
  messageType: MessageType;
  platform: Platform;
  media?: MediaAttachment[];
  metadata?: Record<string, unknown>;
  sourceFile: string;
  sourceIndex?: number;
}

export interface MediaAttachment {
  filename: string;
  localPath: string;
  type: string;
}

export interface ParsedConversation {
  title: string;
  platform: Platform;
  participants: string[];
  messages: NormalizedMessage[];
  sourceFile: string;
  metadata?: Record<string, unknown>;
}

export interface ConversationRow {
  id: string;
  title: string;
  platform: Platform;
  message_count: number;
  first_message_at: string;
  last_message_at: string;
  participant_names: string;
  metadata: string | null;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  sender_name: string;
  content: string | null;
  timestamp: string;
  timestamp_ms: number;
  message_type: MessageType;
  is_incoming: number;
  platform: Platform;
  source_id: string;
  metadata: string | null;
}

export interface SearchOptions {
  query: string;
  useRegex?: boolean;
  includeMisspellings?: boolean;
  conversationId?: string;
  participantId?: string;
  platform?: Platform;
  dateFrom?: string;
  dateTo?: string;
  contextBefore?: number;
  contextAfter?: number;
}
