import { NormalizedMessage, ParsedConversation, Platform, MessageType } from "@/types/message";
import fs from "fs";
import path from "path";

// Standard CSV parser supporting multiline fields and escaped quotes
export function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const nextChar = content[i + 1];
    
    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        field += '"';
        i++; // skip next quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      row.push(field);
      field = "";
    } else if ((char === '\r' || char === '\n') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') {
        i++; // skip \n
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  
  if (row.length > 0 || field !== "") {
    row.push(field);
    rows.push(row);
  }
  
  return rows;
}

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

let contactsCache: { phoneMap: Map<string, string>; emailMap: Map<string, string> } | null = null;
let cachedDir: string | null = null;

function loadContacts(contactsDir: string) {
  if (contactsCache && cachedDir === contactsDir) {
    return contactsCache;
  }

  const phoneMap = new Map<string, string>();
  const emailMap = new Map<string, string>();

  if (fs.existsSync(contactsDir)) {
    const files = fs.readdirSync(contactsDir);
    
    // 1. Parse VCF files
    for (const file of files) {
      if (file.toLowerCase().endsWith(".vcf")) {
        const filePath = path.join(contactsDir, file);
        try {
          const content = fs.readFileSync(filePath, "utf-8");
          let name = "";
          const phones: string[] = [];
          const emails: string[] = [];
          
          const lines = content.split(/\r?\n/);
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("FN:")) {
              name = trimmed.slice(3).trim();
            } else if (trimmed.startsWith("N:") && !name) {
              const parts = trimmed.slice(2).split(";");
              const family = parts[0]?.trim() || "";
              const given = parts[1]?.trim() || "";
              name = `${given} ${family}`.trim();
            } else if (trimmed.includes("TEL")) {
              const parts = trimmed.split(":");
              if (parts.length > 1) phones.push(parts[1].trim());
            } else if (trimmed.includes("EMAIL")) {
              const parts = trimmed.split(":");
              if (parts.length > 1) emails.push(parts[1].trim().toLowerCase());
            }
          }
          
          if (name) {
            for (const phone of phones) {
              const norm = normalizePhone(phone);
              if (norm) phoneMap.set(norm, name);
            }
            for (const email of emails) {
              if (email) emailMap.set(email, name);
            }
          }
        } catch (e) {
          // ignore
        }
      }
    }

    // 2. Parse CSV contacts
    const csvFile = files.find(f => f.toLowerCase().endsWith(".csv"));
    if (csvFile) {
      const filePath = path.join(contactsDir, csvFile);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const rows = parseCsv(content);
        if (rows.length > 0) {
          const headers = rows[0].map(h => h.toLowerCase());
          let nameIdx = -1;
          const phoneCols: number[] = [];
          const emailCols: number[] = [];
          
          headers.forEach((h, idx) => {
            if (h === "name" || h === "\ufeffname") {
              nameIdx = idx;
            } else if (h.includes("phone") && h.includes("value")) {
              phoneCols.push(idx);
            } else if (h.includes("e-mail") && h.includes("value")) {
              emailCols.push(idx);
            }
          });
          
          for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            if (!row || row.length <= Math.max(nameIdx, 0)) continue;
            let name = row[nameIdx]?.trim() || "";
            if (!name) {
              const given = row[1]?.trim() || "";
              const family = row[3]?.trim() || "";
              name = `${given} ${family}`.trim();
            }
            if (!name) continue;
            
            for (const col of phoneCols) {
              if (col < row.length) {
                const val = row[col]?.trim();
                if (val) {
                  const norm = normalizePhone(val);
                  if (norm) phoneMap.set(norm, name);
                }
              }
            }
            for (const col of emailCols) {
              if (col < row.length) {
                const val = row[col]?.trim().toLowerCase();
                if (val) emailMap.set(val, name);
              }
            }
          }
        }
      } catch (e) {
        // ignore
      }
    }
  }

  contactsCache = { phoneMap, emailMap };
  cachedDir = contactsDir;
  return contactsCache;
}

export function parseAnytransCsv(
  content: string,
  sourceFile: string,
  ownerName: string
): ParsedConversation {
  const rows = parseCsv(content);
  if (rows.length < 2) {
    throw new Error("Invalid CSV format: File has fewer than 2 rows.");
  }

  // Row 1: Headers
  // Row 2: Metadata / Contact Identifier
  const metaRow = rows[1];
  const rawContacts = metaRow[2]?.trim() || "";
  
  if (!rawContacts) {
    throw new Error("Invalid CSV format: Missing contact details in Row 2.");
  }

  const rawTokens = rawContacts.split(",").map(t => t.trim());

  // Attempt to load sibling Contacts directory
  const siblingContactsDir = path.join(path.dirname(sourceFile), "..", "Contacts");
  const { phoneMap, emailMap } = loadContacts(siblingContactsDir);

  const resolveContact = (token: string): string => {
    if (token.includes("@")) {
      return emailMap.get(token.toLowerCase()) || token;
    }
    const norm = normalizePhone(token);
    return phoneMap.get(norm) || token;
  };

  const resolvedContacts = rawTokens.map(resolveContact);
  const title = resolvedContacts.join(", ") || rawContacts;

  const messages: NormalizedMessage[] = [];
  const participantSet = new Set<string>();

  for (let i = 2; i < rows.length; i++) {
    const row = rows[i];
    if (row.length < 7) continue;

    const messageTypeRaw = row[3]?.trim(); // "Received" or "Sent"
    if (!messageTypeRaw) continue;

    const isIncoming = messageTypeRaw.toLowerCase() === "received";
    
    // In group chats, MobiMover CSVs lack specific sender attribution in the row,
    // so we fall back to the resolved list of contacts or the title.
    let senderName = isIncoming ? resolvedContacts[0] : ownerName;
    
    const dateTimeStr = row[4]?.trim();
    if (!dateTimeStr) continue;

    const timestamp = new Date(dateTimeStr);
    if (isNaN(timestamp.getTime())) continue;

    const receivedContent = row[5]?.trim();
    const sentContent = row[6]?.trim();
    const messageContent = isIncoming ? receivedContent : sentContent;

    participantSet.add(senderName);
    
    let messageType: MessageType = "text";
    if (messageContent && (messageContent.includes("￼") || messageContent.includes("[Attachment]"))) {
      // Very basic media heuristic
      messageType = "image";
    }

    messages.push({
      content: messageContent || null,
      timestamp,
      timestampMs: timestamp.getTime(),
      senderName,
      isIncoming,
      messageType,
      platform: "sms",
      sourceFile,
      sourceIndex: messages.length,
    });
  }

  participantSet.add(ownerName);
  for (const contact of resolvedContacts) {
    participantSet.add(contact);
  }

  return {
    title,
    platform: "sms",
    participants: Array.from(participantSet),
    messages,
    sourceFile,
  };
}
