import { NormalizedMessage, ParsedConversation, MediaAttachment } from "@/types/message";

const MONTH_MAP: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

function parseTimestamp(dateStr: string): { date: Date; ms: number } {
  const match = dateStr.match(
    /^(\w+)\s+(\d{1,2}),\s+(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})(am|pm)$/i
  );
  if (!match) {
    const d = new Date(dateStr);
    return { date: d, ms: d.getTime() };
  }

  let hour = parseInt(match[4]);
  const ampm = match[7].toLowerCase();
  if (ampm === "pm" && hour !== 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;

  const d = new Date(
    parseInt(match[3]),
    MONTH_MAP[match[1]],
    parseInt(match[2]),
    hour,
    parseInt(match[5]),
    parseInt(match[6])
  );
  return { date: d, ms: d.getTime() };
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").trim();
}

interface RawMessage {
  sender: string;
  contentHtml: string;
  timestamp: string;
  media: MediaAttachment[];
  reactions: string[];
}

function extractMessages(html: string): RawMessage[] {
  const messages: RawMessage[] = [];

  const msgBlockRe = /<div class="_a6-g"><div class="_2ph_ _a6-h[^"]*">([^<]+)<\/div><div class="_2ph_ _a6-p">([\s\S]*?)<\/div><div class="_3-94 _a6-o"><div class="_a72d">([^<]+)<\/div>/g;

  let match;
  while ((match = msgBlockRe.exec(html)) !== null) {
    const sender = decodeHtmlEntities(match[1].trim());
    const contentBlock = match[2];
    const timestamp = decodeHtmlEntities(match[3].trim());

    const media: MediaAttachment[] = [];
    const imgRe = /<img[^>]+src="([^"]+)"[^>]*>/g;
    let imgMatch;
    while ((imgMatch = imgRe.exec(contentBlock)) !== null) {
      const src = decodeHtmlEntities(imgMatch[1]);
      if (!src.startsWith("data:")) {
        media.push({
          filename: src.split("/").pop() || "",
          localPath: src,
          type: "image",
        });
      }
    }

    // FB exports videos as <video src="videos/x.mp4" ...> (src on the tag itself);
    // older exports use <video>...<source src="...">. Handle both forms.
    const videoRe = /<video[^>]*\ssrc="([^"]+)"|<video\b[^>]*>[\s\S]*?<source[^>]+src="([^"]+)"/g;
    let videoMatch;
    while ((videoMatch = videoRe.exec(contentBlock)) !== null) {
      const src = decodeHtmlEntities(videoMatch[1] || videoMatch[2]);
      media.push({
        filename: src.split("/").pop() || "",
        localPath: src,
        type: "video",
      });
    }

    const audioRe = /<audio[^>]*\ssrc="([^"]+)"|<audio\b[^>]*>[\s\S]*?<source[^>]+src="([^"]+)"/g;
    let audioMatch;
    while ((audioMatch = audioRe.exec(contentBlock)) !== null) {
      const src = decodeHtmlEntities(audioMatch[1] || audioMatch[2]);
      media.push({
        filename: src.split("/").pop() || "",
        localPath: src,
        type: "audio",
      });
    }

    const reactions: string[] = [];
    const reactionRe = /<li>([^<]+)<\/li>/g;
    let reactionMatch;
    const reactionSection = contentBlock.match(/<ul class="_a6-q">([\s\S]*?)<\/ul>/);
    if (reactionSection) {
      while ((reactionMatch = reactionRe.exec(reactionSection[1])) !== null) {
        reactions.push(decodeHtmlEntities(reactionMatch[1].trim()));
      }
    }

    let textContent = contentBlock;
    textContent = textContent.replace(/<ul class="_a6-q">[\s\S]*?<\/ul>/g, "");
    textContent = textContent.replace(/<img[^>]*>/g, "");
    textContent = textContent.replace(/<video[\s\S]*?<\/video>/g, "");
    textContent = textContent.replace(/<audio[\s\S]*?<\/audio>/g, "");
    textContent = textContent.replace(/<a[^>]*>([\s\S]*?)<\/a>/g, "$1");
    textContent = stripTags(textContent);
    textContent = decodeHtmlEntities(textContent).trim();

    messages.push({ sender, contentHtml: textContent, timestamp, media, reactions });
  }

  return messages;
}

function extractTitle(html: string): string {
  const titleMatch = html.match(/<title>([^<]+)<\/title>/);
  if (titleMatch) return decodeHtmlEntities(titleMatch[1].trim());
  return "Unknown";
}

function extractPageLinks(html: string): string[] {
  const links: string[] = [];
  const linkRe = /href="(message_\d+\.html)"/g;
  let match;
  while ((match = linkRe.exec(html)) !== null) {
    if (!links.includes(match[1])) links.push(match[1]);
  }
  return links.sort((a, b) => {
    const numA = parseInt(a.match(/(\d+)/)?.[1] || "0");
    const numB = parseInt(b.match(/(\d+)/)?.[1] || "0");
    return numA - numB;
  });
}

export function parseFacebookHtml(
  htmlContent: string,
  sourceFile: string,
  ownerName: string
): ParsedConversation {
  const title = extractTitle(htmlContent);
  const rawMessages = extractMessages(htmlContent);
  const participantSet = new Set<string>();

  const messages: NormalizedMessage[] = rawMessages.map((msg, index) => {
    participantSet.add(msg.sender);
    const { date, ms } = parseTimestamp(msg.timestamp);

    let messageType: NormalizedMessage["messageType"] = "text";
    if (msg.media.length > 0 && !msg.contentHtml) {
      const firstMedia = msg.media[0];
      if (firstMedia.type === "image") messageType = "image";
      else if (firstMedia.type === "video") messageType = "video";
      else if (firstMedia.type === "audio") messageType = "audio";
    }
    if (msg.media.some((m) => m.localPath.includes("stickers_used"))) {
      messageType = "sticker";
    }

    return {
      content: msg.contentHtml || null,
      timestamp: date,
      timestampMs: ms,
      senderName: msg.sender,
      isIncoming: msg.sender !== ownerName,
      messageType,
      platform: "facebook" as const,
      media: msg.media.length > 0 ? msg.media : undefined,
      metadata: msg.reactions.length > 0 ? { reactions: msg.reactions } : undefined,
      sourceFile,
      sourceIndex: index,
    };
  });

  const participants = Array.from(participantSet);

  return {
    title,
    platform: "facebook",
    participants,
    messages,
    sourceFile,
    metadata: {
      page_links: extractPageLinks(htmlContent),
    },
  };
}

export function parseFacebookHtmlDirectory(
  files: Array<{ name: string; content: string }>,
  sourceDir: string,
  ownerName: string
): ParsedConversation {
  const sorted = files.sort((a, b) => {
    const numA = parseInt(a.name.match(/(\d+)/)?.[1] || "0");
    const numB = parseInt(b.name.match(/(\d+)/)?.[1] || "0");
    return numA - numB;
  });

  let combined: ParsedConversation | null = null;

  for (const file of sorted) {
    const parsed = parseFacebookHtml(file.content, `${sourceDir}/${file.name}`, ownerName);
    if (!combined) {
      combined = parsed;
      combined.sourceFile = sourceDir;
    } else {
      combined.messages.push(...parsed.messages);
      for (const p of parsed.participants) {
        if (!combined.participants.includes(p)) combined.participants.push(p);
      }
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
  return combined;
}
