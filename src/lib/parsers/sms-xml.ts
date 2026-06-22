import { NormalizedMessage, ParsedConversation } from "@/types/message";

interface SmsEntry {
  address: string;
  date: string;
  type: string; // 1=received, 2=sent
  body: string;
  contact_name: string;
  readable_date: string;
  date_sent: string;
}

interface MmsEntry {
  address: string;
  date: string;
  msg_box: string; // 1=received, 2=sent
  contact_name: string;
  readable_date: string;
  parts: Array<{ text?: string; data?: string; ct: string }>;
}

function parseXmlAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let match;
  while ((match = re.exec(tag)) !== null) {
    attrs[match[1]] = match[2]
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n)));
  }
  return attrs;
}

function groupByContact(entries: SmsEntry[]): Map<string, SmsEntry[]> {
  const groups = new Map<string, SmsEntry[]>();
  for (const entry of entries) {
    const key = entry.address.replace(/\D/g, "").slice(-10);
    const existing = groups.get(key);
    if (existing) {
      existing.push(entry);
    } else {
      groups.set(key, [entry]);
    }
  }
  return groups;
}

export function parseSmsXml(
  xmlContent: string,
  sourceFile: string,
  ownerName: string
): ParsedConversation[] {
  const conversations: ParsedConversation[] = [];

  const smsEntries: SmsEntry[] = [];
  const smsRegex = /<sms\s+([^/]*?)\/>/g;
  let match;

  while ((match = smsRegex.exec(xmlContent)) !== null) {
    const attrs = parseXmlAttributes(match[1]);
    smsEntries.push({
      address: attrs.address || "",
      date: attrs.date || "0",
      type: attrs.type || "1",
      body: attrs.body || "",
      contact_name: attrs.contact_name || attrs.address || "Unknown",
      readable_date: attrs.readable_date || "",
      date_sent: attrs.date_sent || "0",
    });
  }

  const grouped = groupByContact(smsEntries);

  for (const [phoneKey, entries] of grouped) {
    const contactName = entries[0].contact_name || phoneKey;
    const messages: NormalizedMessage[] = entries
      .map((entry, index) => {
        const timestampMs = parseInt(entry.date);
        const isSent = entry.type === "2";

        return {
          content: entry.body || null,
          timestamp: new Date(timestampMs),
          timestampMs,
          senderName: isSent ? ownerName : contactName,
          isIncoming: !isSent,
          messageType: "text" as const,
          platform: "sms" as const,
          sourceFile,
          sourceIndex: index,
        };
      })
      .sort((a, b) => a.timestampMs - b.timestampMs);

    conversations.push({
      title: contactName,
      platform: "sms",
      participants: [ownerName, contactName],
      messages,
      sourceFile,
      metadata: {
        phone_number: entries[0].address,
        phone_key: phoneKey,
        message_count_raw: entries.length,
      },
    });
  }

  return conversations;
}

export function parseCallsXml(
  xmlContent: string,
  sourceFile: string,
  ownerName: string
): ParsedConversation[] {
  const conversations: ParsedConversation[] = [];
  const callEntries: Array<{
    address: string;
    date: string;
    type: string;
    duration: string;
    contact_name: string;
    readable_date: string;
  }> = [];

  const callRegex = /<call\s+([^/]*?)\/>/g;
  let match;

  while ((match = callRegex.exec(xmlContent)) !== null) {
    const attrs = parseXmlAttributes(match[1]);
    callEntries.push({
      address: attrs.number || attrs.address || "",
      date: attrs.date || "0",
      type: attrs.type || "1",
      duration: attrs.duration || "0",
      contact_name: attrs.contact_name || attrs.number || "Unknown",
      readable_date: attrs.readable_date || "",
    });
  }

  const grouped = new Map<string, typeof callEntries>();
  for (const entry of callEntries) {
    const key = entry.address.replace(/\D/g, "").slice(-10);
    const existing = grouped.get(key);
    if (existing) existing.push(entry);
    else grouped.set(key, [entry]);
  }

  for (const [phoneKey, entries] of grouped) {
    const contactName = entries[0].contact_name || phoneKey;
    const messages: NormalizedMessage[] = entries
      .map((entry, index) => {
        const timestampMs = parseInt(entry.date);
        const duration = parseInt(entry.duration);
        const isIncoming = entry.type === "1";
        const isMissed = entry.type === "3";
        const isRejected = entry.type === "5";

        let content = "";
        if (isMissed) content = "Missed call";
        else if (isRejected) content = "Rejected call";
        else {
          const mins = Math.floor(duration / 60);
          const secs = duration % 60;
          content = `${isIncoming ? "Incoming" : "Outgoing"} call (${mins}m ${secs}s)`;
        }

        return {
          content,
          timestamp: new Date(timestampMs),
          timestampMs,
          senderName: isIncoming ? contactName : ownerName,
          isIncoming,
          messageType: "call" as const,
          platform: "call" as const,
          sourceFile,
          sourceIndex: index,
        };
      })
      .sort((a, b) => a.timestampMs - b.timestampMs);

    conversations.push({
      title: `Calls: ${contactName}`,
      platform: "sms",
      participants: [ownerName, contactName],
      messages,
      sourceFile,
      metadata: {
        phone_number: entries[0].address,
        phone_key: phoneKey,
        is_call_log: true,
        call_count: entries.length,
      },
    });
  }

  return conversations;
}
