import { NormalizedMessage, ParsedConversation, MediaAttachment } from "@/types/message";

interface FbJsonMessage {
  sender_name: string;
  timestamp_ms: number;
  content?: string;
  type?: string;
  is_unsent?: boolean;
  photos?: Array<{ uri: string; creation_timestamp: number }>;
  videos?: Array<{ uri: string; creation_timestamp: number }>;
  audio_files?: Array<{ uri: string; creation_timestamp: number }>;
  sticker?: { uri: string };
  share?: { link?: string; share_text?: string };
  reactions?: Array<{ reaction: string; actor: string }>;
  call_duration?: number;
  is_geoblocked_for_viewer?: boolean;
}

interface FbJsonThread {
  participants: Array<{ name: string }>;
  messages: FbJsonMessage[];
  title?: string;
  thread_path?: string;
  _agent_notes?: string;
}

function decodeFbUtf8(text: string): string {
  try {
    const bytes = new Uint8Array(
      text.split("").map((c) => c.charCodeAt(0))
    );
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return text;
  }
}

function classifyMessage(msg: FbJsonMessage): { type: string; media: MediaAttachment[] } {
  const media: MediaAttachment[] = [];

  if (msg.photos) {
    for (const p of msg.photos) {
      media.push({ filename: p.uri.split("/").pop() || "", localPath: p.uri, type: "image" });
    }
    return { type: media.length > 0 && !msg.content ? "image" : "text", media };
  }
  if (msg.videos) {
    for (const v of msg.videos) {
      media.push({ filename: v.uri.split("/").pop() || "", localPath: v.uri, type: "video" });
    }
    return { type: media.length > 0 && !msg.content ? "video" : "text", media };
  }
  if (msg.audio_files) {
    for (const a of msg.audio_files) {
      media.push({ filename: a.uri.split("/").pop() || "", localPath: a.uri, type: "audio" });
    }
    return { type: "audio", media };
  }
  if (msg.sticker) {
    media.push({ filename: msg.sticker.uri.split("/").pop() || "", localPath: msg.sticker.uri, type: "sticker" });
    return { type: "sticker", media };
  }
  if (msg.share) {
    return { type: "share", media };
  }
  if (msg.call_duration !== undefined || msg.type === "Call") {
    return { type: "call", media };
  }

  return { type: "text", media };
}

export function parseFacebookJson(
  jsonString: string,
  sourceFile: string,
  ownerName: string
): ParsedConversation {
  const data: FbJsonThread = JSON.parse(jsonString);
  const participants = data.participants.map((p) => decodeFbUtf8(p.name));
  const title = data.title ? decodeFbUtf8(data.title) : participants.filter((n) => n !== ownerName).join(", ") || "Unknown";

  const messages: NormalizedMessage[] = data.messages
    .filter((msg) => !msg.is_unsent)
    .map((msg, index) => {
      const senderName = decodeFbUtf8(msg.sender_name);
      const { type, media } = classifyMessage(msg);
      let content = msg.content ? decodeFbUtf8(msg.content) : null;

      if (msg.share?.link) {
        content = content ? `${content}\n${msg.share.link}` : msg.share.link;
      }
      if (msg.call_duration !== undefined) {
        const mins = Math.floor(msg.call_duration / 60);
        const secs = msg.call_duration % 60;
        content = `Call duration: ${mins}m ${secs}s`;
      }

      const reactions = msg.reactions?.map((r) => ({
        reaction: decodeFbUtf8(r.reaction),
        actor: decodeFbUtf8(r.actor),
      }));

      return {
        content,
        timestamp: new Date(msg.timestamp_ms),
        timestampMs: msg.timestamp_ms,
        senderName,
        isIncoming: senderName !== ownerName,
        messageType: type as NormalizedMessage["messageType"],
        platform: "facebook" as const,
        media: media.length > 0 ? media : undefined,
        metadata: reactions ? { reactions } : undefined,
        sourceFile,
        sourceIndex: index,
      };
    })
    .reverse();

  return {
    title,
    platform: "facebook",
    participants,
    messages,
    sourceFile,
    metadata: {
      thread_path: data.thread_path,
      message_count_raw: data.messages.length,
    },
  };
}

export function parseFacebookJsonDirectory(
  files: Array<{ name: string; content: string }>,
  sourceDir: string,
  ownerName: string
): ParsedConversation {
  const sorted = files.sort((a, b) => {
    const numA = parseInt(a.name.match(/_(\d+)\.json$/)?.[1] || "0");
    const numB = parseInt(b.name.match(/_(\d+)\.json$/)?.[1] || "0");
    if (numA === 0 && numB > 0) return -1;
    if (numB === 0 && numA > 0) return 1;
    return numA - numB;
  });

  let combined: ParsedConversation | null = null;

  for (const file of sorted) {
    const parsed = parseFacebookJson(file.content, `${sourceDir}/${file.name}`, ownerName);
    if (!combined) {
      combined = parsed;
    } else {
      combined.messages.push(...parsed.messages);
    }
  }

  if (!combined) {
    return {
      title: "Empty",
      platform: "facebook",
      participants: [],
      messages: [],
      sourceFile: sourceDir,
    };
  }

  combined.messages.sort((a, b) => a.timestampMs - b.timestampMs);
  combined.sourceFile = sourceDir;
  return combined;
}
