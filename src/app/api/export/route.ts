import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";

// Resolve a media file on disk for a given source directory, mirroring /api/media.
function resolveMediaPath(sourceDir: string, filename: string, mediaType: string): string | null {
  const subdirs = mediaType === "image" ? ["photos", "gifs", "stickers"]
    : mediaType === "video" ? ["videos"]
    : mediaType === "audio" ? ["audio"]
    : ["photos", "gifs", "stickers", "videos", "audio", "files"];
  for (const sub of subdirs) {
    const candidate = path.join(sourceDir, sub, filename);
    if (fs.existsSync(candidate)) return candidate;
  }
  const direct = path.join(sourceDir, filename);
  if (fs.existsSync(direct)) return direct;
  return null;
}

function rowsToObjects(result: any): any[] {
  if (!result || !result[0]) return [];
  const { columns, values } = result[0];
  return values.map((row: any[]) => {
    const obj: any = {};
    columns.forEach((col: string, i: number) => { obj[col] = row[i]; });
    return obj;
  });
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
  });
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Extract human-readable media references from a message's metadata JSON.
function getMediaRefs(metadata: string | null): Array<{ type: string; filename: string }> {
  if (!metadata) return [];
  try {
    const obj = JSON.parse(metadata);
    if (!obj?.media || !Array.isArray(obj.media)) return [];
    return obj.media
      .filter((m: any) => m && (m.filename || m.type))
      .map((m: any) => ({ type: m.type || "file", filename: m.filename || "" }));
  } catch {
    return [];
  }
}

function mediaLabel(refs: Array<{ type: string; filename: string }>): string {
  return refs
    .map((m) => m.filename ? `[${m.type}: ${m.filename}]` : `[${m.type}]`)
    .join(" ");
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { type, format, includeProvenance, includeTimestamps, includeBatesNumbers, batesPrefix, batesStart } = body;
    const includeMedia = body.includeMedia !== false; // default on
    const embedMedia = body.embedMedia === true && format === "html"; // bundle real files into a ZIP

    const db = await getDb();
    let messages: any[] = [];

    if (type === "bookmarks") {
      const bookmarkIds = body.bookmarkIds as string[];
      if (bookmarkIds?.length) {
        const placeholders = bookmarkIds.map(() => "?").join(",");
        const result = db.exec(
          `SELECT m.*, p.display_name as sender_name, c.title as conversation_title, c.platform as conv_platform
           FROM bookmarks b
           JOIN messages m ON b.message_id = m.id
           LEFT JOIN participants p ON m.sender_id = p.id
           LEFT JOIN conversations c ON m.conversation_id = c.id
           WHERE b.id IN (${placeholders})
           ORDER BY m.timestamp ASC`,
          bookmarkIds
        );
        messages = rowsToObjects(result);
      } else {
        const result = db.exec(
          `SELECT m.*, p.display_name as sender_name, c.title as conversation_title, c.platform as conv_platform
           FROM bookmarks b
           JOIN messages m ON b.message_id = m.id
           LEFT JOIN participants p ON m.sender_id = p.id
           LEFT JOIN conversations c ON m.conversation_id = c.id
           ORDER BY m.timestamp ASC`
        );
        messages = rowsToObjects(result);
      }
    } else {
      const conversationIds = body.conversationIds as string[];
      if (!conversationIds?.length) {
        return NextResponse.json({ error: "No conversations selected" }, { status: 400 });
      }
      const filterSender = (body.sender as string) || "";
      const filterDateFrom = (body.dateFrom as string) || "";
      const filterDateTo = (body.dateTo as string) || "";

      const placeholders = conversationIds.map(() => "?").join(",");
      let where = `WHERE m.conversation_id IN (${placeholders})`;
      const queryParams: any[] = [...conversationIds];

      if (filterSender) {
        where += ` AND p.display_name = ?`;
        queryParams.push(filterSender);
      }
      if (filterDateFrom) {
        where += ` AND m.timestamp >= ?`;
        queryParams.push(filterDateFrom);
      }
      if (filterDateTo) {
        where += ` AND m.timestamp <= ?`;
        queryParams.push(filterDateTo);
      }

      const result = db.exec(
        `SELECT m.*, p.display_name as sender_name, c.title as conversation_title, c.platform as conv_platform
         FROM messages m
         LEFT JOIN participants p ON m.sender_id = p.id
         LEFT JOIN conversations c ON m.conversation_id = c.id
         ${where}
         ORDER BY m.conversation_id, m.timestamp ASC`,
        queryParams
      );
      messages = rowsToObjects(result);
    }

    let batesCounter = batesStart || 1;

    if (format === "csv") {
      const header = includeMedia
        ? "Bates,Timestamp,Sender,Content,Media,Platform,Conversation\n"
        : "Bates,Timestamp,Sender,Content,Platform,Conversation\n";
      const rows = messages.map((m) => {
        const bates = includeBatesNumbers ? `${batesPrefix}-${(batesCounter++).toString().padStart(4, "0")}` : "";
        const ts = includeTimestamps ? formatTimestamp(m.timestamp) : "";
        const content = (m.content || "").replace(/"/g, '""').replace(/\n/g, " ");
        if (includeMedia) {
          const media = mediaLabel(getMediaRefs(m.metadata)).replace(/"/g, '""');
          return `"${bates}","${ts}","${m.sender_name || ""}","${content}","${media}","${m.platform || ""}","${m.conversation_title || ""}"`;
        }
        return `"${bates}","${ts}","${m.sender_name || ""}","${content}","${m.platform || ""}","${m.conversation_title || ""}"`;
      }).join("\n");

      return new Response(header + rows, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="CourtThread_Export.csv"`,
        },
      });
    }

    if (format === "txt") {
      let output = "COURT EVIDENCE EXPORT\n";
      output += `Generated: ${new Date().toISOString()}\n`;
      output += "=".repeat(60) + "\n\n";

      let currentConv = "";
      for (const m of messages) {
        if (m.conversation_title !== currentConv) {
          currentConv = m.conversation_title || "Untitled";
          output += "\n" + "-".repeat(60) + "\n";
          output += `CONVERSATION: ${currentConv} (${m.conv_platform || m.platform})\n`;
          output += "-".repeat(60) + "\n\n";
        }
        const bates = includeBatesNumbers ? `[${batesPrefix}-${(batesCounter++).toString().padStart(4, "0")}] ` : "";
        const ts = includeTimestamps ? `[${formatTimestamp(m.timestamp)}] ` : "";
        const mediaRefs = includeMedia ? getMediaRefs(m.metadata) : [];
        const mediaStr = mediaRefs.length ? (m.content ? " " : "") + mediaLabel(mediaRefs) : "";
        const text = m.content || (mediaRefs.length ? "" : "[media]");
        output += `${bates}${ts}${m.sender_name || "Unknown"}: ${text}${mediaStr}\n`;
      }

      if (includeProvenance) {
        output += "\n" + "=".repeat(60) + "\n";
        output += `Extracted using CourtThread™ ${new Date().getFullYear()}\n`;
        output += `Export date: ${new Date().toISOString()}\n`;
        output += `Total messages: ${messages.length}\n`;
      }

      return new Response(output, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": `attachment; filename="CourtThread_Export.txt"`,
        },
      });
    }

    // For media embedding: map each source to its on-disk directory (skip upload:// sources).
    const sourceDirs = new Map<string, string | null>();
    if (embedMedia) {
      const srcIds = Array.from(new Set(messages.map((m) => m.source_id).filter(Boolean)));
      for (const sid of srcIds) {
        try {
          const r = db.exec(`SELECT file_path FROM sources WHERE id = '${String(sid).replace(/'/g, "''")}'`);
          const fp = r[0]?.values[0]?.[0] as string | undefined;
          if (fp && !fp.startsWith("upload://") && fs.existsSync(fp)) {
            sourceDirs.set(sid, fs.statSync(fp).isDirectory() ? fp : path.dirname(fp));
          } else {
            sourceDirs.set(sid, null);
          }
        } catch { sourceDirs.set(sid, null); }
      }
    }
    // Collected media files to bundle into the ZIP: zipName -> absolute disk path
    const bundledMedia = new Map<string, string>();
    let mediaMissing = 0;

    // HTML format (default)
    let html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>CourtThread Evidence Export</title>
<style>
  body { font-family: 'Segoe UI', system-ui, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; color: #1a1a1a; }
  .header { border-bottom: 2px solid #333; padding-bottom: 12px; margin-bottom: 20px; }
  .header h1 { font-size: 18px; margin: 0; }
  .header p { font-size: 11px; color: #666; margin: 4px 0 0; }
  .conversation-header { background: #f0f0f0; padding: 8px 12px; margin: 16px 0 8px; border-left: 3px solid #333; font-weight: 600; font-size: 13px; }
  .message { padding: 4px 0; font-size: 13px; line-height: 1.5; page-break-inside: avoid; }
  .message .bates { color: #999; font-size: 10px; font-family: monospace; margin-right: 4px; }
  .message .time { color: #888; font-size: 11px; }
  .message .sender { font-weight: 600; }
  .message .incoming .sender { color: #333; }
  .message .outgoing .sender { color: #0066cc; }
  .message .content { margin-left: 8px; }
  .message .media-ref { color: #8a6d00; background: #fff4cc; padding: 0 4px; border-radius: 3px; font-size: 11px; font-family: monospace; }
  .message img.media { max-width: 320px; max-height: 320px; display: block; margin: 4px 0 4px 8px; border: 1px solid #ddd; }
  .message video.media, .message audio.media { max-width: 320px; display: block; margin: 4px 0 4px 8px; }
  .provenance { border-top: 2px solid #333; margin-top: 30px; padding-top: 12px; font-size: 10px; color: #666; }
  @media print { body { font-size: 11px; } .message { font-size: 11px; } }
</style>
</head>
<body>
<div class="header">
  <h1>Court Evidence — Message Export</h1>
  <p>Generated: ${new Date().toLocaleString()}</p>
  <p>Total messages: ${messages.length}</p>
</div>
`;

    let currentConv = "";
    for (const m of messages) {
      if (m.conversation_title !== currentConv) {
        currentConv = m.conversation_title || "Untitled";
        html += `<div class="conversation-header">${escapeHtml(currentConv)} (${escapeHtml(m.conv_platform || m.platform)})</div>\n`;
      }

      const bates = includeBatesNumbers
        ? `<span class="bates">${batesPrefix}-${(batesCounter++).toString().padStart(4, "0")}</span>`
        : "";
      const ts = includeTimestamps
        ? `<span class="time">[${formatTimestamp(m.timestamp)}]</span> `
        : "";
      const direction = m.is_incoming ? "incoming" : "outgoing";
      const mediaRefs = includeMedia ? getMediaRefs(m.metadata) : [];
      const baseContent = m.content || (mediaRefs.length ? "" : "[media]");
      let content = escapeHtml(baseContent);
      if (mediaRefs.length) {
        const parts: string[] = [];
        for (const mm of mediaRefs) {
          let embedded = false;
          if (embedMedia && mm.filename) {
            const dir = sourceDirs.get(m.source_id);
            if (dir) {
              const diskPath = resolveMediaPath(dir, mm.filename, mm.type);
              if (diskPath) {
                const zipName = `media/${mm.filename}`;
                bundledMedia.set(zipName, diskPath);
                if (mm.type === "image" || mm.type === "sticker" || mm.type === "gif") {
                  parts.push(`<img class="media" src="${zipName}" alt="${escapeHtml(mm.filename)}">`);
                } else if (mm.type === "video") {
                  parts.push(`<video class="media" controls src="${zipName}"></video>`);
                } else if (mm.type === "audio") {
                  parts.push(`<audio class="media" controls src="${zipName}"></audio>`);
                } else {
                  parts.push(`<a href="${zipName}">${escapeHtml(mm.filename)}</a>`);
                }
                embedded = true;
              } else {
                mediaMissing++;
              }
            }
          }
          if (!embedded) {
            parts.push(`<span class="media-ref">[${escapeHtml(mm.type)}${mm.filename ? ": " + escapeHtml(mm.filename) : ""}]</span>`);
          }
        }
        content += (baseContent ? " " : "") + parts.join(" ");
      }

      html += `<div class="message ${direction}">${bates}${ts}<span class="sender">${escapeHtml(m.sender_name || "Unknown")}:</span> <span class="content">${content}</span></div>\n`;
    }

    if (includeProvenance) {
      html += `
<div class="provenance">
  <p>Extracted using CourtThread&trade; ${new Date().getFullYear()}</p>
  <p>Export date: ${new Date().toISOString()}</p>
  <p>Total messages exported: ${messages.length}</p>`;
      if (embedMedia) {
        html += `
  <p>Media files bundled: ${bundledMedia.size}${mediaMissing ? ` (${mediaMissing} referenced file(s) not found on disk)` : ""}</p>`;
      }
      html += `
  <p>This document was generated from electronic records imported into CourtThread for the purpose of litigation.</p>
</div>`;
    }

    html += `\n</body>\n</html>`;

    // If we bundled real media files, return a ZIP containing the HTML + media/ folder.
    if (embedMedia && bundledMedia.size > 0) {
      const zip = new AdmZip();
      zip.addFile("exhibit.html", Buffer.from(html, "utf-8"));
      for (const [zipName, diskPath] of bundledMedia) {
        try {
          zip.addFile(zipName, fs.readFileSync(diskPath));
        } catch { /* skip unreadable file */ }
      }
      const zipBuffer = zip.toBuffer();
      return new Response(new Uint8Array(zipBuffer), {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="CourtThread_Export.zip"`,
        },
      });
    }

    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `attachment; filename="CourtThread_Export.html"`,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
