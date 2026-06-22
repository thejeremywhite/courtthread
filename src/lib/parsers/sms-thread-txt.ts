import { NormalizedMessage, ParsedConversation } from "@/types/message";

// Parses the "SMS Backup & Restore" per-thread text export format:
//
//   Thread: Kelly Mann
//   Messages: 124
//   Range: Jan 13, 2018 9:21:02 p.m. -> Jun 7, 2024 5:50:11 p.m.
//   (THEM = Kelly Mann; JEREMY = Jeremy White)
//
//   [Jan 13, 2018 9:21:02 p.m.] JEREMY: It's Jeremy. New number
//   [May 10, 2017 8:02:35 p.m.] THEM: [MMS] <smil>...</smil>
//
// Each message starts with a "[<date> <time>] <SENDER>:" header; content can span
// multiple lines until the next "[" header line. SENDER is THEM or JEREMY, mapped
// to real names via the "(THEM = X; JEREMY = Y)" header line.

const MSG_LINE = /^\[([A-Za-z]{3,9} \d{1,2}, \d{4} \d{1,2}:\d{2}:\d{2}\s*[ap]\.?m\.?)\]\s*(THEM|JEREMY|ME)\s*:\s?(.*)$/i;

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function parseDate(raw: string): { date: Date; ms: number } | null {
  // e.g. "Jan 13, 2018 9:21:02 p.m." (also "a.m."/"am"/"pm")
  const m = raw.trim().match(
    /^([A-Za-z]{3,9})\s+(\d{1,2}),\s+(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*([ap])\.?m\.?$/i
  );
  if (!m) {
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : { date: d, ms: d.getTime() };
  }
  const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (month === undefined) return null;
  let hour = parseInt(m[4]);
  const ap = m[7].toLowerCase();
  if (ap === "p" && hour !== 12) hour += 12;
  if (ap === "a" && hour === 12) hour = 0;
  const d = new Date(parseInt(m[3]), month, parseInt(m[2]), hour, parseInt(m[5]), parseInt(m[6]));
  return isNaN(d.getTime()) ? null : { date: d, ms: d.getTime() };
}

// Detect whether content is this SMS thread-text format.
export function isSmsThreadTxt(content: string): boolean {
  const head = content.slice(0, 4000);
  if (/^\s*Thread:\s*/m.test(head) && /\b(THEM|JEREMY|ME)\s*=/.test(head)) return true;
  // Fallback: several "[date] THEM/JEREMY:" lines
  const matches = head.split("\n").filter((l) => MSG_LINE.test(l.trim()));
  return matches.length >= 2;
}

export function parseSmsThreadTxt(
  content: string,
  sourceFile: string,
  ownerName: string,
  fileBaseName?: string
): ParsedConversation {
  const lines = content.split(/\r?\n/);

  // Parse header for the THEM/JEREMY -> real name map and the thread title.
  let themName = "";
  let jeremyName = ownerName;
  let threadTitle = "";
  for (let i = 0; i < Math.min(lines.length, 12); i++) {
    const line = lines[i];
    const tm = line.match(/^\s*Thread:\s*(.+?)\s*$/i);
    if (tm) threadTitle = tm[1];
    const map = line.match(/THEM\s*=\s*([^;)\n]+?)\s*;\s*JEREMY\s*=\s*([^;)\n]+?)\s*\)/i);
    if (map) { themName = map[1].trim(); jeremyName = map[2].trim(); }
  }

  const senderRealName = (token: string): string => {
    const t = token.toUpperCase();
    if (t === "THEM") return themName || threadTitle || "Unknown";
    return jeremyName || ownerName; // JEREMY or ME
  };

  const messages: NormalizedMessage[] = [];
  const participantSet = new Set<string>();
  let parseErrors = 0;

  let current: { dateRaw: string; sender: string; contentLines: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const parsed = parseDate(current.dateRaw);
    if (!parsed) { parseErrors++; current = null; return; }
    let text = current.contentLines.join("\n").trim();
    let messageType: NormalizedMessage["messageType"] = "text";
    // MMS messages carry a SMIL layout placeholder; the real text/media lives in
    // sidecar files we don't have. Mark as media and keep a readable marker.
    const isMms = /^\[MMS\]/i.test(text);
    if (isMms) {
      const afterMarker = text.replace(/^\[MMS\]\s*/i, "");
      const stripped = afterMarker.replace(/<smil>[\s\S]*?<\/smil>/gi, "").trim();
      if (stripped) {
        text = stripped;
        messageType = "text";
      } else {
        text = "[MMS attachment]";
        messageType = "image";
      }
    }
    const senderName = senderRealName(current.sender);
    participantSet.add(senderName);
    messages.push({
      content: text || null,
      timestamp: parsed.date,
      timestampMs: parsed.ms,
      senderName,
      isIncoming: senderName !== (jeremyName || ownerName),
      messageType,
      platform: "sms",
      sourceFile,
      sourceIndex: messages.length,
    });
    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    const m = line.match(MSG_LINE);
    if (m) {
      flush();
      current = { dateRaw: m[1], sender: m[2], contentLines: m[3] ? [m[3]] : [] };
    } else if (current) {
      // Continuation line of the current message's content.
      current.contentLines.push(rawLine);
    }
    // Lines before the first message header (the Thread:/Messages:/Range: header) are ignored.
  }
  flush();

  // Make sure both participants appear even if one never sent a message.
  if (themName) participantSet.add(themName);
  participantSet.add(jeremyName || ownerName);

  const participants = Array.from(participantSet);
  const title = threadTitle
    || (fileBaseName ? fileBaseName.replace(/\.txt$/i, "") : "")
    || themName
    || participants.filter((n) => n !== (jeremyName || ownerName)).join(", ")
    || "Unknown";

  return {
    title,
    platform: "sms",
    participants,
    messages,
    sourceFile,
    metadata: parseErrors > 0 ? { parseErrors } : undefined,
  };
}
