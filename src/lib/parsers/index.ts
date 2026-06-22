import { ParsedConversation } from "@/types/message";
import { parseFacebookJson, parseFacebookJsonDirectory } from "./facebook-json";
import { parseFacebookHtml, parseFacebookHtmlDirectory } from "./facebook-html";
import { parseSmsXml, parseCallsXml } from "./sms-xml";
import { parseFacebookTxt } from "./facebook-txt";
import fs from "fs";
import path from "path";

export type FileType = "facebook-json" | "facebook-html" | "facebook-txt" | "sms-xml" | "calls-xml" | "unknown";

export function detectFileType(filePath: string, content?: string): FileType {
  const ext = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath).toLowerCase();

  if (ext === ".json") {
    if (content) {
      try {
        const data = JSON.parse(content);
        if (data.participants && data.messages) return "facebook-json";
      } catch { /* not valid json */ }
    }
    return "facebook-json";
  }

  if (ext === ".xml") {
    if (basename.startsWith("sms")) return "sms-xml";
    if (basename.startsWith("calls") || basename.startsWith("call")) return "calls-xml";
    if (content) {
      if (content.includes("<smses")) return "sms-xml";
      if (content.includes("<calls")) return "calls-xml";
    }
    return "sms-xml";
  }

  if (ext === ".txt") {
    return "facebook-txt";
  }

  if (ext === ".html" || ext === ".htm") {
    return "facebook-html";
  }

  return "unknown";
}

export interface ImportResult {
  conversations: ParsedConversation[];
  errors: Array<{ file: string; error: string }>;
  stats: {
    filesProcessed: number;
    conversationsFound: number;
    totalMessages: number;
  };
}

export async function parseFile(
  filePath: string,
  ownerName: string
): Promise<{ conversations: ParsedConversation[]; errors: string[] }> {
  const errors: string[] = [];
  const conversations: ParsedConversation[] = [];

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const fileType = detectFileType(filePath, content);

    switch (fileType) {
      case "facebook-json": {
        const conv = parseFacebookJson(content, filePath, ownerName);
        conversations.push(conv);
        break;
      }
      case "sms-xml": {
        const convs = parseSmsXml(content, filePath, ownerName);
        conversations.push(...convs);
        break;
      }
      case "calls-xml": {
        const convs = parseCallsXml(content, filePath, ownerName);
        conversations.push(...convs);
        break;
      }
      case "facebook-txt": {
        const conv = parseFacebookTxt(content, filePath, ownerName);
        conversations.push(conv);
        break;
      }
      case "facebook-html": {
        const conv = parseFacebookHtml(content, filePath, ownerName);
        conversations.push(conv);
        break;
      }
      default:
        errors.push(`Unknown file type: ${filePath}`);
    }
  } catch (e: any) {
    errors.push(`Failed to parse ${filePath}: ${e.message}`);
  }

  return { conversations, errors };
}

export async function parseDirectory(
  dirPath: string,
  ownerName: string
): Promise<ImportResult> {
  const result: ImportResult = {
    conversations: [],
    errors: [],
    stats: { filesProcessed: 0, conversationsFound: 0, totalMessages: 0 },
  };

  if (!fs.existsSync(dirPath)) {
    result.errors.push({ file: dirPath, error: "Directory does not exist" });
    return result;
  }

  const stat = fs.statSync(dirPath);

  if (stat.isFile()) {
    const { conversations, errors } = await parseFile(dirPath, ownerName);
    result.stats.filesProcessed = 1;
    result.conversations.push(...conversations);
    for (const e of errors) result.errors.push({ file: dirPath, error: e });
    result.stats.conversationsFound = result.conversations.length;
    result.stats.totalMessages = result.conversations.reduce((sum, c) => sum + c.messages.length, 0);
    return result;
  }

  const entries = fs.readdirSync(dirPath);

  const jsonFiles = entries.filter((e) => e.endsWith(".json") && !e.startsWith("."));
  if (jsonFiles.length > 0) {
    const hasFbJsonPattern = jsonFiles.some(
      (f) => f.match(/\.json$/) && !f.startsWith(".")
    );

    const firstJson = fs.readFileSync(path.join(dirPath, jsonFiles[0]), "utf-8");
    try {
      const data = JSON.parse(firstJson);
      if (data.participants && data.messages) {
        const files = jsonFiles.map((name) => ({
          name,
          content: fs.readFileSync(path.join(dirPath, name), "utf-8"),
        }));
        const conv = parseFacebookJsonDirectory(files, dirPath, ownerName);
        result.conversations.push(conv);
        result.stats.filesProcessed += jsonFiles.length;
      }
    } catch {
      // not FB JSON, process individually
    }
  }

  const htmlFiles = entries.filter((e) => /\.html?$/i.test(e) && /^message_\d+\.html?$/i.test(e));
  if (htmlFiles.length > 0) {
    try {
      const files = htmlFiles.map((name) => ({
        name,
        content: fs.readFileSync(path.join(dirPath, name), "utf-8"),
      }));
      const conv = parseFacebookHtmlDirectory(files, dirPath, ownerName);
      result.conversations.push(conv);
      result.stats.filesProcessed += htmlFiles.length;
    } catch (e: any) {
      result.errors.push({ file: dirPath, error: `HTML parse error: ${e.message}` });
    }
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry);
    const ext = path.extname(entry).toLowerCase();

    if ([".xml", ".txt"].includes(ext)) {
      const { conversations, errors } = await parseFile(fullPath, ownerName);
      result.stats.filesProcessed++;
      result.conversations.push(...conversations);
      for (const e of errors) result.errors.push({ file: fullPath, error: e });
    }

    if (ext === ".zip") {
      try {
        const zipResult = await parseZipFile(fullPath, ownerName);
        result.conversations.push(...zipResult.conversations);
        result.errors.push(...zipResult.errors);
        result.stats.filesProcessed += zipResult.stats.filesProcessed;
      } catch (e: any) {
        result.errors.push({ file: fullPath, error: `ZIP error: ${e.message}` });
      }
    }
  }

  result.stats.conversationsFound = result.conversations.length;
  result.stats.totalMessages = result.conversations.reduce((sum, c) => sum + c.messages.length, 0);
  return result;
}

async function parseZipFile(
  zipPath: string,
  ownerName: string
): Promise<ImportResult> {
  const result: ImportResult = {
    conversations: [],
    errors: [],
    stats: { filesProcessed: 0, conversationsFound: 0, totalMessages: 0 },
  };

  try {
    const AdmZip = (await import("adm-zip")).default;
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();

    const fbJsonGroups = new Map<string, Array<{ name: string; content: string }>>();

    for (const entry of entries) {
      if (entry.isDirectory) continue;

      const ext = path.extname(entry.entryName).toLowerCase();
      if (![".json", ".xml", ".txt"].includes(ext)) continue;

      const content = entry.getData().toString("utf-8");
      const fileType = detectFileType(entry.entryName, content);

      if (fileType === "facebook-json") {
        const dir = path.dirname(entry.entryName);
        const existing = fbJsonGroups.get(dir);
        if (existing) {
          existing.push({ name: path.basename(entry.entryName), content });
        } else {
          fbJsonGroups.set(dir, [{ name: path.basename(entry.entryName), content }]);
        }
        result.stats.filesProcessed++;
        continue;
      }

      try {
        switch (fileType) {
          case "sms-xml": {
            const convs = parseSmsXml(content, `${zipPath}!${entry.entryName}`, ownerName);
            result.conversations.push(...convs);
            break;
          }
          case "calls-xml": {
            const convs = parseCallsXml(content, `${zipPath}!${entry.entryName}`, ownerName);
            result.conversations.push(...convs);
            break;
          }
          case "facebook-txt": {
            const conv = parseFacebookTxt(content, `${zipPath}!${entry.entryName}`, ownerName);
            result.conversations.push(conv);
            break;
          }
        }
        result.stats.filesProcessed++;
      } catch (e: any) {
        result.errors.push({ file: `${zipPath}!${entry.entryName}`, error: e.message });
      }
    }

    for (const [dir, files] of fbJsonGroups) {
      try {
        const conv = parseFacebookJsonDirectory(files, `${zipPath}!${dir}`, ownerName);
        result.conversations.push(conv);
      } catch (e: any) {
        result.errors.push({ file: `${zipPath}!${dir}`, error: e.message });
      }
    }
  } catch (e: any) {
    result.errors.push({ file: zipPath, error: `Failed to open ZIP: ${e.message}` });
  }

  result.stats.conversationsFound = result.conversations.length;
  result.stats.totalMessages = result.conversations.reduce((sum, c) => sum + c.messages.length, 0);
  return result;
}

export async function scanForFiles(
  dirPath: string,
  recursive = true,
  maxDepth = 5
): Promise<Array<{ path: string; type: FileType; size: number }>> {
  const files: Array<{ path: string; type: FileType; size: number }> = [];

  function scan(dir: string, depth: number) {
    if (depth > maxDepth) return;
    if (!fs.existsSync(dir)) return;

    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "node_modules") continue;
      const fullPath = path.join(dir, entry);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory() && recursive) {
        scan(fullPath, depth + 1);
        continue;
      }

      const ext = path.extname(entry).toLowerCase();
      if ([".json", ".xml", ".txt", ".html", ".htm", ".zip"].includes(ext)) {
        const type = ext === ".zip" ? "unknown" as FileType : detectFileType(fullPath);
        files.push({ path: fullPath, type, size: stat.size });
      }
    }
  }

  scan(dirPath, 0);
  return files;
}
