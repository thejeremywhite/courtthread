import { NormalizedMessage, ParsedConversation, MediaAttachment, MessageType } from "@/types/message";
import path from "path";

// Parser for phone-extract "Bubble" HTML exports of a phone's SMS/iMessage
// threads (Messages/HTML/<thread>/<thread>-<numbers>(<count>)-Bubble.html).
//
// Real format (verified against Patricia Mann's E:\MessageExtracts export):
// - Header: two spans — contact list on the left, the PHONE OWNER's name on the right:
//     <span style="font-size: 15px; ... color: #272727;">Kelly Mann (+16048575929)</span>
//     <span style="font-size: 15px; ... color: #555;">Patricia Mann</span>
// - Each message: <p class='date'>Date: YYYY-MM-DD HH:MM:SS</p>, then (group chats,
//   incoming only) a <div ...>Sender Name (+phone)</div>, then the bubble:
//     <p class='triangle-isosceles'>  = incoming (gray)
//     <p class='triangle-isosceles2'> = outgoing SMS (green)
//     <p class='triangle-isosceles3'> = outgoing iMessage (blue)
// - Attachments are DOUBLE-quoted <img src="../../SMS Attachments/x.png"> INSIDE the
//   bubble; the single-quoted <img src='../Bubble/3l.png'> after each bubble is just the
//   bubble-tail decoration and must be ignored.

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch { return ""; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ""; } })
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

// "Kelly Mann (+16048575929)" -> { name: "Kelly Mann", contact: "+16048575929" }
// "+12024107222" -> { name: "+12024107222", contact: "+12024107222" }
function parseContactToken(token: string): { name: string; contact: string } {
  const m = token.trim().match(/^(.+?)\s*\(([^)]*)\)$/);
  if (m) return { name: m[1].trim(), contact: m[2].trim() };
  return { name: token.trim(), contact: token.trim() };
}

// Header contact list: "Colin Davies (+17789822770), Kelly Mann (+16048575929)" or
// bare identifiers like "+12024107222" / "sueanddarcy@shaw.ca". When name(phone) tokens
// are present, split on the ")" boundaries so commas inside names can't break tokens.
function splitContacts(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.includes("(")) {
    return trimmed
      .split(/\)\s*,\s*/)
      .map((t, i, arr) => (i < arr.length - 1 && !t.endsWith(")") ? `${t})` : t))
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return trimmed.split(/\s*,\s*/).filter(Boolean);
}

function mediaTypeForFile(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".bmp", ".tif", ".tiff"].includes(ext)) return "image";
  if ([".mp4", ".mov", ".3gp", ".m4v", ".avi", ".webm"].includes(ext)) return "video";
  if ([".mp3", ".m4a", ".amr", ".wav", ".caf", ".aac", ".ogg", ".opus"].includes(ext)) return "audio";
  return "file";
}

export function parseBubbleHtml(
  content: string,
  sourceFile: string,
  ownerName: string
): ParsedConversation {
  // Header: contact element (#272727) then owner span (#555). 1:1 threads render the
  // contact as a <span>; group threads use a <div> so long contact lists can wrap.
  const headerMatch = content.match(
    /<(?:span|div)[^>]*color:\s*#272727;?[^>]*>([^<]*)<\/(?:span|div)>\s*<span[^>]*color:\s*#555;?[^>]*>([^<]*)<\/span>/i
  );
  const rawContacts = decodeEntities(headerMatch?.[1]?.trim() || "");
  const headerOwner = decodeEntities(headerMatch?.[2]?.trim() || "") || ownerName;

  const contactTokens = splitContacts(rawContacts).map(parseContactToken);
  // Fallbacks when the header is absent: <title>, then the thread folder name.
  let title = contactTokens.map((c) => c.name).join(", ");
  if (!title) {
    const titleMatch = content.match(/<title>\s*(.*?)\s*<\/title>/i);
    title = decodeEntities(titleMatch?.[1]?.trim() || "");
  }
  if (!title) title = path.basename(path.dirname(sourceFile));

  const defaultIncomingSender = contactTokens[0]?.name || title || "Contact";

  const messages: NormalizedMessage[] = [];
  const participantSet = new Set<string>();

  // date <p>, optional group-chat sender <div>, then the bubble <p>. Attachment <img>
  // tags are self-closing and sit INSIDE the bubble, so lazy-matching to the first </p>
  // still captures them.
  const msgRegex =
    /<p class='date'>Date:\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})<\/p>\s*(?:<div[^>]*>([^<]*)<\/div>\s*)?<p class='(triangle-isosceles\d?)'>([\s\S]*?)<\/p>/gi;

  let match: RegExpExecArray | null;
  while ((match = msgRegex.exec(content)) !== null) {
    const [, dateStr, senderDivRaw, bubbleClass, bubbleRaw] = match;

    const timestamp = new Date(dateStr);
    if (isNaN(timestamp.getTime())) continue;

    const isIncoming = bubbleClass.toLowerCase() === "triangle-isosceles";

    let senderName: string;
    if (isIncoming) {
      senderName = senderDivRaw
        ? parseContactToken(decodeEntities(senderDivRaw.trim())).name
        : defaultIncomingSender;
    } else {
      senderName = headerOwner;
    }

    // Attachments (skip the ../Bubble/*.png tail decorations); localPath is stored
    // relative to the export's Messages root (e.g. "SMS Attachments/image_1.png") so the
    // media resolver can join it against the imported source directory.
    const media: MediaAttachment[] = [];
    const imgRegex = /<img[^>]*src=["']([^"']+)["'][^>]*>/gi;
    let img: RegExpExecArray | null;
    while ((img = imgRegex.exec(bubbleRaw)) !== null) {
      let src = decodeEntities(img[1]);
      // srcs are URL-encoded (%20, %E2%80%AF …) but the files on disk have the literal
      // characters — without decoding, every such attachment resolves as missing.
      try { src = decodeURIComponent(src); } catch { /* malformed escape — keep raw */ }
      if (/(^|\/)Bubble\//i.test(src)) continue;
      const localPath = src.replace(/^(\.\.\/)+/, "").replace(/^\.\//, "");
      media.push({
        filename: path.basename(localPath),
        localPath,
        type: mediaTypeForFile(localPath),
      });
    }

    const cleanContent = decodeEntities(
      bubbleRaw
        .replace(/<img[^>]*>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, "")
    )
      .replace(/￼/g, "")
      .trim();

    let messageType: MessageType = "text";
    if (media.length > 0) {
      const t = media[0].type;
      messageType = t === "video" ? "video" : t === "audio" ? "audio" : "image";
    }

    participantSet.add(senderName);

    messages.push({
      content: cleanContent || null,
      timestamp,
      timestampMs: timestamp.getTime(),
      senderName,
      isIncoming,
      messageType,
      platform: "sms",
      media: media.length > 0 ? media : undefined,
      sourceFile,
      sourceIndex: messages.length,
    });
  }

  participantSet.add(headerOwner);
  for (const c of contactTokens) participantSet.add(c.name);

  return {
    title,
    platform: "sms",
    participants: Array.from(participantSet),
    messages,
    sourceFile,
    metadata: { bubble_html: true, raw_contacts: rawContacts, owner: headerOwner },
  };
}
