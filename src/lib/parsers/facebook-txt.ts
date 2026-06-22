import { NormalizedMessage, ParsedConversation } from "@/types/message";

const DATE_PATTERN = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}\s+\d{1,2}:\d{2}:\d{2}(?:am|pm)$/i;
const TAB_LINE_PATTERN = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}\s+\d{1,2}:\d{2}:\d{2}(?:am|pm)\t/i;

function parseDate(dateStr: string): { date: Date; ms: number } {
  const cleaned = dateStr.trim();
  const match = cleaned.match(
    /^(\w+)\s+(\d{1,2}),\s+(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})(am|pm)$/i
  );
  if (!match) {
    const d = new Date(cleaned);
    return { date: d, ms: d.getTime() };
  }

  const months: Record<string, number> = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  };

  let hour = parseInt(match[4]);
  const ampm = match[7].toLowerCase();
  if (ampm === "pm" && hour !== 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;

  const d = new Date(
    parseInt(match[3]),
    months[match[1]],
    parseInt(match[2]),
    hour,
    parseInt(match[5]),
    parseInt(match[6])
  );
  return { date: d, ms: d.getTime() };
}

export function parseFacebookTxtBlockFormat(
  content: string,
  sourceFile: string,
  ownerName: string
): ParsedConversation {
  const lines = content.split("\n");
  const messages: NormalizedMessage[] = [];
  const participantSet = new Set<string>();

  let headerEnd = 0;
  for (let i = 0; i < Math.min(lines.length, 50); i++) {
    if (DATE_PATTERN.test(lines[i].trim())) {
      headerEnd = Math.max(0, i - 2);
      break;
    }
  }

  let i = headerEnd;
  while (i < lines.length) {
    const line = lines[i].trim();

    if (DATE_PATTERN.test(line)) {
      const dateStr = line;
      const contentLines: string[] = [];
      let senderName = "";

      let j = i - 1;
      while (j >= headerEnd) {
        const prevLine = lines[j].trim();
        if (!prevLine || DATE_PATTERN.test(prevLine)) break;
        contentLines.unshift(prevLine);
        j--;
      }

      if (contentLines.length > 0) {
        senderName = contentLines[0];
        contentLines.shift();
      }

      if (senderName) {
        participantSet.add(senderName);
        const { date, ms } = parseDate(dateStr);
        const msgContent = contentLines.join("\n") || null;

        messages.push({
          content: msgContent,
          timestamp: date,
          timestampMs: ms,
          senderName,
          isIncoming: senderName !== ownerName,
          messageType: "text",
          platform: "facebook",
          sourceFile,
          sourceIndex: messages.length,
        });
      }

      i++;
      continue;
    }

    i++;
  }

  messages.reverse();

  const participants = Array.from(participantSet);
  const title = participants.filter((n) => n !== ownerName).join(", ") || "Unknown";

  return {
    title,
    platform: "facebook",
    participants,
    messages,
    sourceFile,
  };
}

export function parseFacebookTxtTabFormat(
  content: string,
  sourceFile: string,
  ownerName: string
): ParsedConversation {
  const lines = content.split("\n");
  const messages: NormalizedMessage[] = [];
  const participantSet = new Set<string>();

  for (const line of lines) {
    if (!TAB_LINE_PATTERN.test(line)) continue;

    const parts = line.split("\t");
    if (parts.length < 3) continue;

    const dateStr = parts[0].trim();
    const msgContent = parts[1]?.trim() || null;
    const senderName = parts[2]?.trim() || "Unknown";

    participantSet.add(senderName);
    const { date, ms } = parseDate(dateStr);

    messages.push({
      content: msgContent,
      timestamp: date,
      timestampMs: ms,
      senderName,
      isIncoming: senderName !== ownerName,
      messageType: "text",
      platform: "facebook",
      sourceFile,
      sourceIndex: messages.length,
    });
  }

  const participants = Array.from(participantSet);
  const title = participants.filter((n) => n !== ownerName).join(", ") || "Unknown";

  return {
    title,
    platform: "facebook",
    participants,
    messages,
    sourceFile,
  };
}

export function parseFacebookTxt(
  content: string,
  sourceFile: string,
  ownerName: string
): ParsedConversation {
  const lines = content.split("\n").slice(0, 50);
  const hasTabFormat = lines.some((l) => TAB_LINE_PATTERN.test(l));

  if (hasTabFormat) {
    return parseFacebookTxtTabFormat(content, sourceFile, ownerName);
  }
  return parseFacebookTxtBlockFormat(content, sourceFile, ownerName);
}
