import { NextRequest, NextResponse } from "next/server";
import { parseFile, parseDirectory } from "@/lib/parsers";
import {
  insertSource,
  insertConversation,
  insertParticipant,
  insertMessages,
} from "@/lib/db/queries";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import fs from "fs";
import path from "path";

export async function POST(request: NextRequest) {
  try {
    const { path: importPath, ownerName = "Jeremy White", importMetadata } = await request.json();

    if (!importPath) {
      return NextResponse.json({ error: "Path is required" }, { status: 400 });
    }

    if (!fs.existsSync(importPath)) {
      return NextResponse.json({ error: "Path does not exist" }, { status: 400 });
    }

    const stat = fs.statSync(importPath);
    const isDir = stat.isDirectory();

    const sourceId = uuidv4();
    const checksum = isDir
      ? crypto.createHash("md5").update(importPath).digest("hex")
      : crypto.createHash("md5").update(fs.readFileSync(importPath)).digest("hex");

    await insertSource({
      id: sourceId,
      filename: path.basename(importPath),
      file_path: importPath,
      file_type: isDir ? "directory" : path.extname(importPath).slice(1),
      file_size: isDir ? 0 : stat.size,
      checksum,
      metadata: JSON.stringify({ imported_from: importPath, provenance: importMetadata || {} }),
    });

    let result;
    if (isDir) {
      result = await parseDirectory(importPath, ownerName);
    } else {
      const parseResult = await parseFile(importPath, ownerName);
      result = {
        conversations: parseResult.conversations,
        errors: parseResult.errors.map((e) => ({ file: importPath, error: e })),
        stats: {
          filesProcessed: 1,
          conversationsFound: parseResult.conversations.length,
          totalMessages: parseResult.conversations.reduce(
            (sum, c) => sum + c.messages.length,
            0
          ),
        },
      };
    }

    let conversationsImported = 0;
    let messagesImported = 0;

    for (const conv of result.conversations) {
      if (conv.messages.length === 0) continue;

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

      const { getDb } = await import("@/lib/db");
      const db = await getDb();
      for (const name of conv.participants) {
        const pid = participantIds.get(name)!;
        db.run(
          `INSERT OR IGNORE INTO conversation_participants (conversation_id, participant_id) VALUES (?, ?)`,
          [convId, pid]
        );
      }

      const dbMessages = conv.messages.map((msg, index) => {
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
          metadata: JSON.stringify({
            ...(msg.metadata || {}),
            media: msg.media,
          }),
        };
      });

      const BATCH_SIZE = 500;
      for (let i = 0; i < dbMessages.length; i += BATCH_SIZE) {
        const batch = dbMessages.slice(i, i + BATCH_SIZE);
        await insertMessages(batch);
      }

      conversationsImported++;
      messagesImported += dbMessages.length;
    }

    return NextResponse.json({
      success: true,
      stats: {
        filesProcessed: result.stats.filesProcessed,
        conversationsImported,
        messagesImported,
      },
      errors: result.errors,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message, stack: e.stack }, { status: 500 });
  }
}
