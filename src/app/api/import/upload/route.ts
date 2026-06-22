import { NextRequest, NextResponse } from "next/server";
import { parseFacebookJson, parseFacebookJsonDirectory } from "@/lib/parsers/facebook-json";
import { parseFacebookHtml } from "@/lib/parsers/facebook-html";
import { parseSmsXml, parseCallsXml } from "@/lib/parsers/sms-xml";
import { parseFacebookTxt } from "@/lib/parsers/facebook-txt";
import { detectFileType } from "@/lib/parsers";
import {
  insertSource,
  insertConversation,
  insertParticipant,
  insertMessages,
} from "@/lib/db/queries";
import { getDb } from "@/lib/db";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import path from "path";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const ownerName = (formData.get("ownerName") as string) || "Jeremy White";
    const importMetadataStr = formData.get("importMetadata") as string;
    const importMetadata = importMetadataStr ? JSON.parse(importMetadataStr) : {};
    const files = formData.getAll("files") as File[];

    if (files.length === 0) {
      return NextResponse.json({ error: "No files provided" }, { status: 400 });
    }

    let conversationsImported = 0;
    let messagesImported = 0;
    let filesProcessed = 0;
    const errors: Array<{ file: string; error: string }> = [];

    const fbJsonGroups = new Map<string, Array<{ name: string; content: string }>>();

    for (const file of files) {
      let content: string;
      try {
        content = await file.text();
      } catch (e: any) {
        errors.push({ file: file.name, error: `Could not read file: ${e.message}` });
        continue;
      }

      const fileType = detectFileType(file.name, content);

      if (fileType === "facebook-json") {
        const relativePath = (file as any).webkitRelativePath || file.name;
        const dir = path.dirname(relativePath);
        const existing = fbJsonGroups.get(dir);
        if (existing) {
          existing.push({ name: file.name, content });
        } else {
          fbJsonGroups.set(dir, [{ name: file.name, content }]);
        }
        continue;
      }

      if (fileType === "unknown") {
        continue;
      }

      try {
        const relativePath = (file as any).webkitRelativePath || file.name;
        const dirParts = relativePath.split(/[/\\]/);
        let displayName = file.name;
        if (dirParts.length >= 2) {
          const parentDir = dirParts[dirParts.length - 2];
          displayName = `${parentDir}/${file.name}`;
        }

        const checksum = crypto.createHash("md5").update(content).digest("hex");
        const sourceId = uuidv4();

        await insertSource({
          id: sourceId,
          filename: displayName,
          file_path: `upload://${relativePath}`,
          file_type: fileType,
          file_size: file.size,
          checksum,
          metadata: JSON.stringify({ uploaded: true, relativePath, provenance: importMetadata }),
        });

        let conversations;
        switch (fileType) {
          case "facebook-html": {
            const conv = parseFacebookHtml(content, file.name, ownerName);
            if (dirParts.length >= 2) {
              const parentDir = dirParts[dirParts.length - 2];
              if (conv.title === "Unknown" || conv.title === file.name || conv.title === "Facebook") {
                conv.title = parentDir.replace(/_\d{10,}$/, "").replace(/_/g, " ");
              }
            }
            conversations = [conv];
            break;
          }
          case "sms-xml":
            conversations = parseSmsXml(content, file.name, ownerName);
            break;
          case "calls-xml":
            conversations = parseCallsXml(content, file.name, ownerName);
            break;
          case "facebook-txt":
            conversations = [parseFacebookTxt(content, file.name, ownerName)];
            break;
          default:
            errors.push({ file: file.name, error: `Unsupported file type: ${fileType}` });
            continue;
        }

        for (const conv of conversations) {
          if (conv.messages.length === 0) continue;
          const result = await importConversation(conv, sourceId, ownerName);
          conversationsImported += result.conversations;
          messagesImported += result.messages;
        }

        filesProcessed++;
      } catch (e: any) {
        errors.push({ file: file.name, error: e.message });
      }
    }

    for (const [dir, groupFiles] of fbJsonGroups) {
      try {
        const combined = parseFacebookJsonDirectory(groupFiles, dir, ownerName);
        const checksum = crypto.createHash("md5").update(dir).digest("hex");
        const sourceId = uuidv4();
        const dirName = dir.split(/[/\\]/).pop() || dir;
        const displayDir = dirName.replace(/_\d{10,}$/, "").replace(/_/g, " ");

        await insertSource({
          id: sourceId,
          filename: displayDir || dir,
          file_path: `upload://${dir}`,
          file_type: "facebook-json",
          file_size: groupFiles.reduce((sum, f) => sum + f.content.length, 0),
          checksum,
          metadata: JSON.stringify({ uploaded: true, fileCount: groupFiles.length, provenance: importMetadata }),
        });

        if (combined.messages.length > 0) {
          const result = await importConversation(combined, sourceId, ownerName);
          conversationsImported += result.conversations;
          messagesImported += result.messages;
        }

        filesProcessed += groupFiles.length;
      } catch (e: any) {
        errors.push({ file: dir, error: e.message });
      }
    }

    return NextResponse.json({
      success: true,
      stats: { filesProcessed, conversationsImported, messagesImported },
      errors,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

async function importConversation(
  conv: any,
  sourceId: string,
  ownerName: string
) {
  const convId = uuidv4();
  const participantIds = new Map<string, string>();

  for (const name of conv.participants) {
    const pid = uuidv4();
    participantIds.set(name, pid);
    await insertParticipant({
      id: pid,
      display_name: name,
      is_owner: name === ownerName ? 1 : 0,
    });
  }

  const firstMsg = conv.messages[0];
  const lastMsg = conv.messages[conv.messages.length - 1];

  await insertConversation({
    id: convId,
    title: conv.title,
    platform: conv.platform,
    source_id: sourceId,
    message_count: conv.messages.length,
    first_message_at: firstMsg.timestamp.toISOString(),
    last_message_at: lastMsg.timestamp.toISOString(),
    metadata: JSON.stringify(conv.metadata || {}),
  });

  const db = await getDb();
  for (const name of conv.participants) {
    const pid = participantIds.get(name)!;
    db.run(
      `INSERT OR IGNORE INTO conversation_participants (conversation_id, participant_id) VALUES (?, ?)`,
      [convId, pid]
    );
  }

  const dbMessages = conv.messages.map((msg: any, index: number) => {
    let senderId = participantIds.get(msg.senderName);
    if (!senderId) {
      senderId = uuidv4();
      participantIds.set(msg.senderName, senderId);
    }
    return {
      id: uuidv4(),
      conversation_id: convId,
      sender_id: senderId,
      content: msg.content,
      timestamp: msg.timestamp.toISOString(),
      timestamp_ms: msg.timestampMs,
      message_type: msg.messageType,
      is_incoming: msg.isIncoming ? 1 : 0,
      platform: msg.platform,
      source_id: sourceId,
      source_index: index,
      metadata: JSON.stringify({ ...(msg.metadata || {}), media: msg.media }),
    };
  });

  const BATCH_SIZE = 500;
  for (let i = 0; i < dbMessages.length; i += BATCH_SIZE) {
    await insertMessages(dbMessages.slice(i, i + BATCH_SIZE));
  }

  return { conversations: 1, messages: dbMessages.length };
}
