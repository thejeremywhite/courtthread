import { NextRequest, NextResponse } from "next/server";
import { parseFacebookJson, parseFacebookJsonDirectory } from "@/lib/parsers/facebook-json";
import { parseFacebookHtml, parseFacebookHtmlDirectory } from "@/lib/parsers/facebook-html";
import { parseSmsXml, parseCallsXml } from "@/lib/parsers/sms-xml";
import { parseFacebookTxt } from "@/lib/parsers/facebook-txt";
import { parseSmsThreadTxt } from "@/lib/parsers/sms-thread-txt";
import { detectFileType } from "@/lib/parsers";
import {
  insertSource,
  insertConversation,
  insertParticipant,
  insertMessages,
  deleteSource,
  detectAndApplyOwner,
} from "@/lib/db/queries";
import { getDb, scheduleSave } from "@/lib/db";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import path from "path";
import fs from "fs";

// Folders that hold message exports. CT_MEDIA_DIRS (semicolon-separated) first, then the
// known local locations. The media route uses the same list plus a drive-wide fallback.
function searchDirs(): string[] {
  const dirs = (process.env.CT_MEDIA_DIRS || "")
    .split(";").map((s) => s.trim()).filter(Boolean);
  dirs.push(
    "D:\\Storage Drive I Backup",
    "D:\\Storage Drive I Backup\\Trish FB",
    "D:\\Storage Drive I Backup\\Jeremy FB Messages",
    "H:\\OneDrive\\_Waylon Court\\_Supreme Court - Case Conference\\Messaging_Emails_Texts",
    "D:\\tmp\\fb_zips",
  );
  return dirs;
}

function extractMediaFilenames(conv: any): string[] {
  const filenames: string[] = [];
  for (const msg of conv.messages || []) {
    if (msg.media && Array.isArray(msg.media)) {
      for (const m of msg.media) {
        const fn = m.filename || (m.localPath || "").split(/[/\\]/).pop();
        if (fn && !filenames.includes(fn)) {
          filenames.push(fn);
          if (filenames.length >= 3) return filenames;
        }
      }
    }
  }
  return filenames;
}

async function setLocalMediaPath(sourceId: string, localPath: string) {
  const db = await getDb();
  const result = db.exec(`SELECT metadata FROM sources WHERE id = '${sourceId.replace(/'/g, "''")}'`);
  const existing = result[0]?.values[0]?.[0] as string | undefined;
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(existing || "{}"); } catch { /* fresh */ }
  meta.localMediaPath = localPath;
  db.run(`UPDATE sources SET metadata = ? WHERE id = ?`, [JSON.stringify(meta), sourceId]);
  scheduleSave();
}

async function autoLinkMediaPath(sourceId: string, uploadPath: string, mediaFilenames?: string[]) {
  const rawPath = uploadPath.replace("upload://", "");
  const folderName = rawPath.split(/[/\\]/).filter(Boolean).pop() || "";
  const mediaDirs = ["photos", "videos", "audio", "gifs", "stickers_used"];

  function hasMediaInDir(candidate: string): boolean {
    if (mediaFilenames && mediaFilenames.length > 0) {
      for (const fn of mediaFilenames) {
        for (const sub of mediaDirs) {
          if (fs.existsSync(path.join(candidate, sub, fn))) return true;
        }
        if (fs.existsSync(path.join(candidate, fn))) return true;
      }
      return false;
    }
    for (const sub of mediaDirs) {
      try {
        const subDir = path.join(candidate, sub);
        if (fs.existsSync(subDir) && fs.statSync(subDir).isDirectory()) return true;
      } catch { /* skip */ }
    }
    return false;
  }

  // ONLY the instant exact-path check here — <searchDir>\<rawPath> is this conversation's
  // own folder because the folder picker preserves the export's internal structure. Any
  // deeper hunt (recursive folder scan, drive search) is deferred to the media route's
  // lazy per-view resolver: doing it here meant an 8-deep crawl PER conversation, which
  // stalled large imports (hundreds of conversations x a big search tree).
  void folderName; void mediaFilenames; void hasMediaInDir;
  for (const sd of searchDirs()) {
    try {
      const direct = path.join(sd, rawPath);
      if (fs.existsSync(direct) && fs.statSync(direct).isDirectory() && hasMediaInDir(direct)) {
        await setLocalMediaPath(sourceId, direct);
        return;
      }
    } catch { /* skip */ }
  }
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const ownerName = (formData.get("ownerName") as string) || "Jeremy White";
    const caseId = (formData.get("caseId") as string) || null;
    const sectionId = (formData.get("sectionId") as string) || null;
    const importMetadataStr = formData.get("importMetadata") as string;
    const importMetadata = importMetadataStr ? JSON.parse(importMetadataStr) : {};
    const files = formData.getAll("files") as File[];

    if (files.length === 0) {
      return NextResponse.json({ error: "No files provided" }, { status: 400 });
    }

    let conversationsImported = 0;
    let messagesImported = 0;
    let filesProcessed = 0;
    let skippedEmpty = 0;
    const emptyFiles: string[] = [];
    const errors: Array<{ file: string; error: string }> = [];
    const importedSourceIds: string[] = []; // this batch — for owner auto-detection

    const fbJsonGroups = new Map<string, Array<{ name: string; content: string }>>();
    const fbHtmlGroups = new Map<string, Array<{ name: string; content: string }>>();

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

      if (fileType === "facebook-html") {
        const relativePath = (file as any).webkitRelativePath || file.name;
        const dir = path.dirname(relativePath);
        const existing = fbHtmlGroups.get(dir);
        if (existing) {
          existing.push({ name: file.name, content });
        } else {
          fbHtmlGroups.set(dir, [{ name: file.name, content }]);
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
          case_id: caseId,
          section_id: sectionId,
        });
        await autoLinkMediaPath(sourceId, `upload://${relativePath}`);

        let conversations;
        switch (fileType) {
          case "sms-xml":
            conversations = parseSmsXml(content, file.name, ownerName);
            break;
          case "calls-xml":
            conversations = parseCallsXml(content, file.name, ownerName);
            break;
          case "facebook-txt":
            conversations = [parseFacebookTxt(content, file.name, ownerName)];
            break;
          case "sms-thread-txt":
            conversations = [parseSmsThreadTxt(content, file.name, ownerName, file.name)];
            break;
          default:
            errors.push({ file: file.name, error: `Unsupported file type: ${fileType}` });
            continue;
        }

        let messagesForSource = 0;
        for (const conv of conversations) {
          if (conv.messages.length === 0) continue;
          const result = await importConversation(conv, sourceId, ownerName, caseId, sectionId);
          conversationsImported += result.conversations;
          messagesImported += result.messages;
          messagesForSource += result.messages;
        }

        // Don't leave behind an empty source row when a file yields no messages.
        if (messagesForSource === 0) {
          await deleteSource(sourceId);
          skippedEmpty++;
          emptyFiles.push(file.name);
        } else {
          importedSourceIds.push(sourceId);
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
        let displayDir = dirName.replace(/_\d{10,}$/, "").replace(/_/g, " ");
        if (!displayDir || displayDir === ".") {
          displayDir = combined.title || groupFiles[0]?.name || "JSON Import";
        }

        await insertSource({
          id: sourceId,
          filename: displayDir,
          file_path: `upload://${dir}`,
          file_type: "facebook-json",
          file_size: groupFiles.reduce((sum, f) => sum + f.content.length, 0),
          checksum,
          metadata: JSON.stringify({ uploaded: true, fileCount: groupFiles.length, provenance: importMetadata }),
          case_id: caseId,
          section_id: sectionId,
        });
        const mediaFilenames = extractMediaFilenames(combined);
        await autoLinkMediaPath(sourceId, `upload://${dir}`, mediaFilenames);

        if (combined.messages.length > 0) {
          const result = await importConversation(combined, sourceId, ownerName, caseId, sectionId);
          conversationsImported += result.conversations;
          messagesImported += result.messages;
          importedSourceIds.push(sourceId);
        } else {
          await deleteSource(sourceId);
          skippedEmpty++;
          emptyFiles.push(displayDir || dir);
        }

        filesProcessed += groupFiles.length;
      } catch (e: any) {
        errors.push({ file: dir, error: e.message });
      }
    }

    // Process grouped Facebook HTML files (combine message_1.html..N into one conversation)
    for (const [dir, groupFiles] of fbHtmlGroups) {
      try {
        const combined = parseFacebookHtmlDirectory(groupFiles, dir, ownerName);
        const checksum = crypto.createHash("md5").update(dir + groupFiles.length).digest("hex");
        const sourceId = uuidv4();
        const dirName = dir.split(/[/\\]/).pop() || dir;
        let displayDir = dirName.replace(/_\d{10,}$/, "").replace(/_/g, " ");
        if (!displayDir || displayDir === ".") {
          displayDir = combined.title || groupFiles[0]?.name || "HTML Import";
        }

        await insertSource({
          id: sourceId,
          filename: displayDir,
          file_path: `upload://${dir}`,
          file_type: "facebook-html",
          file_size: groupFiles.reduce((sum, f) => sum + f.content.length, 0),
          checksum,
          metadata: JSON.stringify({ uploaded: true, fileCount: groupFiles.length, provenance: importMetadata }),
          case_id: caseId,
          section_id: sectionId,
        });
        const htmlMediaFilenames = extractMediaFilenames(combined);
        await autoLinkMediaPath(sourceId, `upload://${dir}`, htmlMediaFilenames);

        if (combined.messages.length > 0) {
          const result = await importConversation(combined, sourceId, ownerName, caseId, sectionId);
          conversationsImported += result.conversations;
          messagesImported += result.messages;
          importedSourceIds.push(sourceId);
        } else {
          await deleteSource(sourceId);
          skippedEmpty++;
          emptyFiles.push(displayDir || dir);
        }

        filesProcessed += groupFiles.length;
      } catch (e: any) {
        errors.push({ file: dir, error: e.message });
      }
    }

    // Auto-detect the archive owner across this whole import and put their messages on
    // the right (the parse-time ownerName default can't know whose archive this is).
    const detectedOwner = await detectAndApplyOwner(importedSourceIds);

    return NextResponse.json({
      success: true,
      stats: { filesProcessed, conversationsImported, messagesImported, skippedEmpty },
      detectedOwner,
      emptyFiles,
      errors,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

async function importConversation(
  conv: any,
  sourceId: string,
  ownerName: string,
  caseId: string | null = null,
  sectionId: string | null = null
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
    case_id: caseId,
    section_id: sectionId,
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
