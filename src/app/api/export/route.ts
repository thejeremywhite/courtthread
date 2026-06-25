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
  const mon = d.toLocaleString("en-US", { month: "short" }).toUpperCase();
  const day = d.getDate();
  const yr = d.getFullYear();
  let hr = d.getHours() % 12 || 12;
  const min = String(d.getMinutes()).padStart(2, '0');
  const ampm = d.getHours() >= 12 ? 'P.M.' : 'A.M.';
  return `${mon} ${day}, ${yr} AT ${hr}:${min} ${ampm}`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Messenger call-log card — SHARED by every export path (conversation loop, search print
// blob, and the HTML/MHTML bubble format) so the call card can never be missing from one.
// Every Facebook call here is a VIDEO call (Jeremy never makes audio calls): a logged
// duration of 0m 0s = a missed video call (subtitle shows the call's clock time); any other
// duration = an answered video call (subtitle shows a human duration). Direction places the
// card left (with the sender avatar) or right, like a message bubble.
function buildCallRow(m: any, isOut: boolean, extra: string = ""): string {
  const durRaw = (m.content || '').replace(/^call\s*(?:duration|info)\s*:\s*/i, '').trim();
  const dm = durRaw.match(/(\d+)\s*m\s*(\d+)\s*s/i);
  const totalSecs = dm ? (parseInt(dm[1], 10) * 60 + parseInt(dm[2], 10)) : (durRaw === '' ? 0 : -1);
  const missed = totalSecs === 0 || /missed/i.test(m.content || '');
  const title = missed ? 'Missed video call' : 'Video call';
  let sub: string;
  if (missed) sub = new Date(m.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  else if (totalSecs > 0) {
    if (totalSecs < 60) sub = `${totalSecs} ${totalSecs === 1 ? 'sec' : 'secs'}`;
    else { const hr = Math.floor(totalSecs / 3600); const mn = Math.floor((totalSecs % 3600) / 60); sub = (hr > 0 ? `${hr} ${hr === 1 ? 'hr' : 'hrs'} ` : '') + `${mn} ${mn === 1 ? 'min' : 'mins'}`; }
  } else sub = durRaw;
  const camSvg = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>`;
  const camMissedSvg = `<svg viewBox="0 0 24 24"><rect x="2.5" y="6.5" width="12" height="11" rx="2.6" fill="#fff"/><path d="M16.5 11 L22 7.2 V16.8 L16.5 13 Z" fill="#fff"/><path d="M5.7 9.8 L11.3 15.4 M11.3 9.8 L5.7 15.4" stroke="#fa3e3e" stroke-width="2.2" stroke-linecap="round" fill="none"/></svg>`;
  const ico = missed ? camMissedSvg : camSvg;
  return `<div class="msg-row ${isOut ? 'msg-out' : 'msg-in'}" data-ts="${m.timestamp}">`
    + (!isOut ? `<img class="sender-avatar" src="/phone-chrome/profile.png" alt="" onerror="this.style.display='none'">` : '')
    + `<div class="msg-col call-col"><div class="call-card">`
    + `<div class="call-head"><span class="call-ico${missed ? ' call-ico-missed' : ''}">${ico}</span>`
    + `<span class="call-meta"><span class="call-title">${escapeHtml(title)}</span><span class="call-dur">${escapeHtml(sub)}</span></span></div>`
    + `<div class="call-back">Call back</div></div>${extra}</div></div>\n`;
}

// Escape HTML, then wrap matches of `term` in <mark> — same highlight as the search UI.
function escapeAndHighlight(text: string, term: string, matchCase: boolean): string {
  const escaped = escapeHtml(text);
  if (!term) return escaped;
  try {
    const safeTerm = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(${safeTerm})`, matchCase ? "g" : "gi");
    return escaped.replace(re, '<mark>$1</mark>');
  } catch {
    return escaped;
  }
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
    const subFormat: string = body.subFormat || format || "html";
    const includeMedia = body.includeMedia !== false; // default on
    const embedMedia = body.embedMedia === true && (format === "html" || subFormat === "mhtml");
    const bundleMedia = body.bundleMedia === true;
    const inlineMedia = body.inlineMedia === true && format === "html"; // live <img> tags (for print/PDF)
    const viewMode: string = body.viewMode || "desktop";
    const themeMode: string = body.theme || "light";
    const maxWidth = viewMode === "mobile" ? "412px" : viewMode === "tablet" ? "800px" : "100%";
    const isDark = themeMode === "dark";

    const db = await getDb();

    const FB_MESSENGER_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAAB3RJTUUH4wUJExktKVPrMgAAAAJiS0dEAP+Hj8y/AAAAx0lEQVR42n3LsUpCYRiA4W8SZ6WmwmjxGqIgmtwDB5fwCoQgkKBuwLWpZm/gjG6tx83xtLg1lRQKNoRPaPwYlj3ryxuJEw8KMzOFe8fxk4rMpkwl5aonfylUY8nANoNlbvhPI/QlC7kPwEQX9MNY0opQN8JQTQeMQ3qyWFHWVLJvCubhBUztKWkqx4oM8Bpy0HFgiJF6hJYkDzegawKYyy0kt2HXm23e7USEtm3a8U3Pb58uI3Fm06OjWHPo2Z1T565cu1Bbty8r7oMp62N1aQAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAxOS0wNS0xMFQwMjoyNTo0NS0wNzowMC7bZsEAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMTktMDUtMTBUMDI6MjU6NDUtMDc6MDBfht59AAAAAElFTkSuQmCC';

    function lookupSourceInfo(sourceIds: string[]): {
      filePath: string; fileType: string; importedAt: string;
      dateObtained: string; platforms: string; exportMethods: string;
      wasModified: string; sourceDescription: string;
    } | null {
      for (const sid of sourceIds) {
        try {
          const r = db.exec(`SELECT file_path, file_type, imported_at, metadata FROM sources WHERE id = '${String(sid).replace(/'/g, "''")}'`);
          if (r[0]?.values[0]) {
            const fp = r[0].values[0][0] as string || '';
            const ft = r[0].values[0][1] as string || '';
            const ia = r[0].values[0][2] as string || '';
            const meta = r[0].values[0][3] as string || '{}';
            let localPath = fp;
            let dateObtained = '', platforms = '', exportMethods = '', wasModified = '', sourceDescription = '';
            try {
              const m = JSON.parse(meta);
              if (m.localMediaPath) localPath = m.localMediaPath;
              const p = m.provenance || {};
              if (p.dateObtained) dateObtained = p.dateObtained;
              if (p.platforms) platforms = Array.isArray(p.platforms) ? p.platforms.join(', ') : String(p.platforms);
              if (p.exportMethods) exportMethods = Array.isArray(p.exportMethods) ? p.exportMethods.join(', ') : String(p.exportMethods);
              if (p.wasModified) wasModified = p.wasModified;
              if (p.sourceDescription) sourceDescription = p.sourceDescription;
            } catch {}
            return { filePath: localPath, fileType: ft, importedAt: ia, dateObtained, platforms, exportMethods, wasModified, sourceDescription };
          }
        } catch {}
      }
      return null;
    }

    function buildUnifiedHeader(convTitle: string, msgCount: number, msgs: any[], info: ReturnType<typeof lookupSourceInfo>): string {
      const fileTypeLabel = info?.fileType === 'facebook-json' ? 'Facebook JSON export' : info?.fileType === 'facebook-html' ? 'Facebook HTML export' : info?.fileType || '';
      let dateRange = '';
      if (msgs.length > 0) {
        const first = new Date(msgs[0].timestamp);
        const last = new Date(msgs[msgs.length - 1].timestamp);
        const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        dateRange = `${fmt(first)} - ${fmt(last)}`;
      }
      const rightParts: string[] = [];
      if (fileTypeLabel) rightParts.push(escapeHtml(fileTypeLabel));
      if (dateRange) rightParts.push(escapeHtml(dateRange));
      const rightHtml = rightParts.length ? ` &nbsp;&middot;&nbsp; ${rightParts.join(' &middot; ')}` : '';
      return `<div class="ct-header"><span class="ct-hdr-title">${escapeHtml(convTitle)}${rightHtml}</span></div>\n`;
    }

    function buildUnifiedFooter(info: ReturnType<typeof lookupSourceInfo>): string {
      const srcPath = info?.filePath || '';
      const showPath = srcPath && !srcPath.startsWith('upload://');
      if (!showPath) return '';
      return `<div class="ct-footer">${escapeHtml(srcPath)}</div>`;
    }

    // Status-bar clock: "right now" shifted by a random offset within ±3 hours, computed
    // ONCE per export so every phone shows the same plausible time.
    const chromeTime = new Date(Date.now() + Math.round((Math.random() * 6 - 3) * 3600000));
    const chromeTimeStr = `${chromeTime.getHours() % 12 || 12}:${String(chromeTime.getMinutes()).padStart(2, '0')}`;

    function buildPhoneChromeTop(convTitle: string, dark: boolean): string {
      const bg = dark ? '#000' : '#fff';
      const c = dark ? '#fff' : '#000';
      const subC = dark ? '#aaa' : '#555';
      const h = chromeTime.getHours() % 12 || 12;
      const mm = String(chromeTime.getMinutes()).padStart(2, '0');
      return `<div class="phone-chrome-top" style="background:${bg};color:${c}"><div class="phone-statusbar"><span style="font-weight:700">${h}:${mm}</span><span class="status-icons"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${subC}" stroke-width="2"><path d="M2 20h.01M7 20v-4M12 20v-8M17 20v-12M22 20V8"/></svg> <svg width="16" height="14" viewBox="0 0 24 24" fill="none" stroke="${subC}" stroke-width="2"><path d="M5 12.55a11 11 0 0 1 14 0M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01"/></svg> <span style="font-size:10px;border:1.5px solid ${subC};border-radius:3px;padding:0 3px;font-weight:600">90</span></span></div><div class="messenger-hdr"><span class="mhdr-back">←</span><div class="mhdr-avatar"></div><span class="mhdr-name">${escapeHtml(convTitle)}</span><span class="mhdr-info">i</span></div></div>`;
    }

    function buildPhoneChromeBottom(dark: boolean): string {
      const bg = dark ? '#000' : '#fff';
      const c = dark ? '#fff' : '#000';
      const ic = '#a855f7';
      const inputBg = dark ? '#303030' : '#f0f0f0';
      const inputBorder = dark ? '#444' : '#ddd';
      const fc = dark ? '#888' : '#999';
      const navBg = dark ? '#000' : '#fff';
      const navC = dark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.35)';
      return `<div class="phone-chrome-bottom" style="background:${bg}"><div class="messenger-input-bar"><span class="mib-icon" style="color:${ic}"><svg width="22" height="22" viewBox="0 0 24 24" fill="${ic}"><circle cx="12" cy="12" r="10" fill="none" stroke="${ic}" stroke-width="2"/><path d="M12 8v8M8 12h8" stroke="${ic}" stroke-width="2"/></svg></span><span class="mib-icon" style="color:${ic}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="${ic}" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5" fill="${ic}"/><path d="M21 15l-5-5L5 21"/></svg></span><span class="mib-icon" style="color:${ic}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="${ic}" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5" fill="${ic}"/><path d="M21 15l-5-5L5 21"/></svg></span><span class="mib-icon" style="color:${ic}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="${ic}" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/></svg></span><div class="mib-field" style="background:${inputBg};border:1px solid ${inputBorder};color:${fc}">Message</div><span class="mib-icon" style="color:${ic}; font-size:22px">\u{1F642}</span><span class="mib-icon" style="font-size:22px">\u{1F44D}</span></div><div class="phone-navbar" style="background:${navBg}"><span style="color:${navC};font-weight:700;font-size:16px;letter-spacing:2px">|||</span><span class="nav-circle" style="border-color:${navC}"></span><span style="color:${navC};font-size:18px;font-weight:300">‹</span></div></div>`;
    }

    function buildPrintToolbar(title?: string): string {
      const hdrDefault = title || '';
      return `<div class="print-toolbar">
<label>Layout: <select id="nup" onchange="setNup(parseInt(this.value))">
<option value="1">1-up (single)</option>
<option value="2">2-up (side by side)</option>
<option value="4">4-up (compact)</option>
</select></label>
<button id="tb-view-toggle" class="tb-btn" style="background:#444;color:#eee" onclick="cycleView()" title="Cycle Mobile / Tablet / Desktop">View: <span id="tb-view-label">${viewMode === 'tablet' ? 'Tablet' : viewMode === 'desktop' ? 'Desktop' : 'Mobile'}</span></button>
<select id="tb-view" style="display:none" onchange="applyViewMode();_saveSettings()">
<option value="mobile"${viewMode === 'mobile' || !viewMode ? ' selected' : ''}>Mobile (412px)</option>
<option value="tablet"${viewMode === 'tablet' ? ' selected' : ''}>Tablet (800px)</option>
<option value="desktop"${viewMode === 'desktop' ? ' selected' : ''}>Desktop</option>
</select>
<button id="tb-theme-toggle" class="tb-btn" style="background:#444;color:#eee;display:inline-flex;align-items:center;gap:6px" onclick="toggleTheme()" title="Toggle light/dark"><span id="tb-theme-icon">${isDark ? '\u{1F319}' : '☀️'}</span><span id="tb-theme-label">${isDark ? 'Dark' : 'Light'}</span></button>
<select id="tb-theme" style="display:none" onchange="applyTheme(this.value);_saveSettings()">
<option value="light"${!isDark ? ' selected' : ''}>Light</option>
<option value="dark"${isDark ? ' selected' : ''}>Dark</option>
</select>
<button class="tb-btn" style="background:#444;color:#eee" onclick="openPageSetup()">Page Setup</button>
<span id="ctx-controls" style="display:inline-flex;align-items:center;gap:4px;color:#ccc;font-size:12px"><strong style="font-weight:600;margin-right:2px">Context</strong> Before: <button class="tb-btn" style="background:#444;color:#eee;padding:2px 8px;font-size:14px;font-weight:700" onclick="adjustCtx('before',-1)" title="Fewer messages before each match">−</button><span id="ctx-before" style="min-width:18px;text-align:center">0</span><button class="tb-btn" style="background:#444;color:#eee;padding:2px 8px;font-size:14px;font-weight:700" onclick="adjustCtx('before',1)" title="More messages before each match">+</button> After: <button class="tb-btn" style="background:#444;color:#eee;padding:2px 8px;font-size:14px;font-weight:700" onclick="adjustCtx('after',-1)" title="Fewer messages after each match">−</button><span id="ctx-after" style="min-width:18px;text-align:center">0</span><button class="tb-btn" style="background:#444;color:#eee;padding:2px 8px;font-size:14px;font-weight:700" onclick="adjustCtx('after',1)" title="More messages after each match">+</button></span>
<label>From: <input type="date" id="tb-from" onchange="filterByDate()" class="tb-input"></label>
<label>To: <input type="date" id="tb-to" onchange="filterByDate()" class="tb-input"></label>
<button class="tb-btn tb-print" onclick="window.print()">Print</button>
</div>
<div id="page-setup-dialog" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;z-index:200;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px)">
<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:#1e1e1e;border:1px solid #444;border-radius:12px;padding:24px;width:480px;max-height:80vh;overflow-y:auto;color:#eee;font-size:13px">
<h3 style="margin:0 0 16px;font-size:16px;font-weight:600;color:#fff">Page Setup</h3>
<div style="margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid #333">
<h4 style="margin:0 0 8px;font-size:13px;color:#aaa;text-transform:uppercase;letter-spacing:1px">Header</h4>
<label style="display:block;margin-bottom:6px">Text: <input type="text" id="ps-hdr-text" oninput="_refreshAvatarPreview()" style="width:100%;padding:6px 8px;background:#2a2a2a;border:1px solid #555;border-radius:4px;color:#eee;font-size:13px;margin-top:2px" value="${escapeHtml(hdrDefault)}"></label>
<div style="font-size:11px;color:#888;margin:-2px 0 4px">This also names the phone's chat header and selects the matching profile photo (e.g. "Jessica Arsenault" → her photo, "Waylon White" → his).</div>
<div style="display:flex;align-items:center;gap:10px;margin-top:8px">
<img id="ps-avatar-preview" alt="" style="width:38px;height:38px;border-radius:50%;object-fit:cover;background:#333;border:1px solid #555;flex-shrink:0">
<label style="font-size:12px;cursor:pointer;color:#7db4ff;text-decoration:underline">Upload profile photo<input type="file" id="ps-avatar-file" accept="image/*" onchange="_onAvatarFile(this)" style="display:none"></label>
<button type="button" onclick="_clearAvatar()" style="font-size:11px;padding:3px 8px;border-radius:4px;border:1px solid #555;background:#333;color:#aaa;cursor:pointer">Reset</button>
</div>
<div id="ps-avatar-note" style="font-size:11px;color:#888;margin-top:4px"></div>
<div style="display:flex;gap:12px;margin-top:8px">
<label style="flex:1">Font size (px): <input type="number" id="ps-hdr-size" min="6" max="96" step="1" value="12" style="width:100%;padding:4px 6px;background:#2a2a2a;border:1px solid #555;border-radius:4px;color:#eee;margin-top:2px"></label>
<label style="flex:1">Font: <select id="ps-hdr-font" style="width:100%;padding:4px 6px;background:#2a2a2a;border:1px solid #555;border-radius:4px;color:#eee;margin-top:2px">
<option value="inherit">Default (Segoe UI)</option><option value="'Times New Roman',serif">Times New Roman</option><option value="'Courier New',monospace">Courier New</option><option value="Arial,sans-serif">Arial</option><option value="Georgia,serif">Georgia</option>
</select></label>
<label style="flex:1">Weight: <select id="ps-hdr-weight" style="width:100%;padding:4px 6px;background:#2a2a2a;border:1px solid #555;border-radius:4px;color:#eee;margin-top:2px">
<option value="400">Normal</option><option value="500" selected>Medium</option><option value="600">Semi-bold</option><option value="700">Bold</option>
</select></label>
<label style="flex:1">Align: <select id="ps-hdr-align" style="width:100%;padding:4px 6px;background:#2a2a2a;border:1px solid #555;border-radius:4px;color:#eee;margin-top:2px">
<option value="left">Left</option><option value="center" selected>Center</option><option value="right">Right</option>
</select></label>
</div>
<label style="display:block;margin-top:8px">Distance from top: <input type="range" id="ps-hdr-dist" min="0" max="120" value="14" style="width:100%;margin-top:2px"><span id="ps-hdr-dist-val">14px</span></label>
</div>
<div style="margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid #333">
<h4 style="margin:0 0 8px;font-size:13px;color:#aaa;text-transform:uppercase;letter-spacing:1px">Footer</h4>
<label style="display:block;margin-bottom:6px">Text: <input type="text" id="ps-ftr-text" style="width:100%;padding:6px 8px;background:#2a2a2a;border:1px solid #555;border-radius:4px;color:#eee;font-size:13px;margin-top:2px" value=""></label>
<div style="display:flex;gap:12px;margin-top:8px">
<label style="flex:1">Font size (px): <input type="number" id="ps-ftr-size" min="6" max="96" step="1" value="10" style="width:100%;padding:4px 6px;background:#2a2a2a;border:1px solid #555;border-radius:4px;color:#eee;margin-top:2px"></label>
<label style="flex:1">Font: <select id="ps-ftr-font" style="width:100%;padding:4px 6px;background:#2a2a2a;border:1px solid #555;border-radius:4px;color:#eee;margin-top:2px">
<option value="inherit">Default (Segoe UI)</option><option value="'Times New Roman',serif">Times New Roman</option><option value="'Courier New',monospace">Courier New</option><option value="Arial,sans-serif">Arial</option><option value="Georgia,serif">Georgia</option>
</select></label>
<label style="flex:1">Weight: <select id="ps-ftr-weight" style="width:100%;padding:4px 6px;background:#2a2a2a;border:1px solid #555;border-radius:4px;color:#eee;margin-top:2px">
<option value="400" selected>Normal</option><option value="500">Medium</option><option value="600">Semi-bold</option><option value="700">Bold</option>
</select></label>
<label style="flex:1">Align: <select id="ps-ftr-align" style="width:100%;padding:4px 6px;background:#2a2a2a;border:1px solid #555;border-radius:4px;color:#eee;margin-top:2px">
<option value="left">Left</option><option value="center" selected>Center</option><option value="right">Right</option>
</select></label>
</div>
<label style="display:block;margin-top:8px">Distance from bottom: <input type="range" id="ps-ftr-dist" min="0" max="120" value="14" style="width:100%;margin-top:2px"><span id="ps-ftr-dist-val">14px</span></label>
<label style="display:flex;align-items:center;gap:8px;margin-top:10px"><input type="checkbox" id="ps-pagenum" checked> Show page numbers (bottom-right)</label>
<label style="display:block;margin-top:6px">Page number font size (px): <input type="number" id="ps-pagenum-size" min="6" max="48" step="1" value="9" style="width:90px;padding:4px 6px;background:#2a2a2a;border:1px solid #555;border-radius:4px;color:#eee;margin-top:2px"></label>
</div>
<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
<button onclick="closePageSetup()" style="padding:8px 16px;border-radius:6px;border:1px solid #555;background:#333;color:#eee;cursor:pointer;font-size:13px">Cancel</button>
<button onclick="applyPageSetup()" style="padding:8px 16px;border-radius:6px;border:none;background:#3578E5;color:#fff;cursor:pointer;font-size:13px;font-weight:600">Apply</button>
</div>
</div>
</div>
<script>
window._chromeTimeStr=${JSON.stringify(chromeTimeStr)};
// Phone-chat header identity. The chrome PNG has "Jessica Arsenault" + her photo baked in,
// so that is the default. The chat name FOLLOWS the Page Setup header text (which itself
// defaults to the source conversation's title); the avatar is matched FROM that name via a
// small name->photo table below. applyNup draws cover-patch name/photo overlays + swaps the
// in-chat avatars only when the name/photo differs from the baked-in default.
window._chromeName='Jessica Arsenault';
var _serverHtml=null;
var _curNup=1;
var _ctxBefore=0;var _ctxAfter=0;
var _viewSizes={mobile:412,tablet:800,desktop:1040};
// Name -> profile photo table: each person's avatar, used for the chat-header photo AND the
// little avatars beside their messages. Matched against the header name. Extend as needed.
var _AVATAR_DB=[{re:/jessica/i,src:'/phone-chrome/profile.png'},{re:/waylon/i,src:'/phone-chrome/profile-waylon.png'}];
// User-uploaded photos, saved by name in localStorage so they persist across every export
// in this browser (key = lowercased name -> downscaled data URL).
var _AVATAR_KEY='ct_blob_avatars_v1';
function _norm(n){return (n||'').trim().toLowerCase()}
function _loadAvatarDB(){try{return JSON.parse(localStorage.getItem(_AVATAR_KEY)||'{}')||{}}catch(e){return {}}}
function _saveAvatarDB(db){try{localStorage.setItem(_AVATAR_KEY,JSON.stringify(db))}catch(e){alert('Could not save the photo (storage may be full).')}}
function _hasBuiltinAvatar(name){for(var i=0;i<_AVATAR_DB.length;i++){if(_AVATAR_DB[i].re.test(name||''))return true}return false}
// Resolve a name to a photo: built-in people first, then a photo uploaded under that name,
// else the default (the chrome PNG's baked-in Jessica photo).
function _avatarFor(name){
  for(var i=0;i<_AVATAR_DB.length;i++){if(_AVATAR_DB[i].re.test(name||''))return _AVATAR_DB[i].src}
  var db=_loadAvatarDB();var k=_norm(name);if(k&&db[k])return db[k];
  return '/phone-chrome/profile.png';
}
// Page Setup avatar preview + upload (uploaded photos are cropped to a square, downscaled,
// and stored by name; reused automatically on future exports of any chat with that name).
function _refreshAvatarPreview(){
  var nm=(_val('ps-hdr-text')||window._chromeName||'');
  var img=document.getElementById('ps-avatar-preview');if(img)img.src=_avatarFor(nm);
  var note=document.getElementById('ps-avatar-note');if(!note)return;
  if(_hasBuiltinAvatar(nm))note.textContent='Using the built-in photo for this name.';
  else if(_loadAvatarDB()[_norm(nm)])note.textContent='Using your uploaded photo for "'+nm+'" (saved for future exports).';
  else note.textContent='No photo matches "'+nm+'". Upload one and it will be saved for this name.';
}
function _onAvatarFile(input){
  var f=input.files&&input.files[0];if(!f)return;
  var rd=new FileReader();
  rd.onload=function(){
    var im=new Image();
    im.onload=function(){
      var S=256,cv=document.createElement('canvas');cv.width=S;cv.height=S;
      var ctx=cv.getContext('2d');
      var s=Math.min(im.width,im.height),sx=(im.width-s)/2,sy=(im.height-s)/2;
      ctx.drawImage(im,sx,sy,s,s,0,0,S,S);
      var nm=(_val('ps-hdr-text')||window._chromeName||'');
      if(!nm){alert('Type the name in the Header text first, then upload.');return}
      var db=_loadAvatarDB();db[_norm(nm)]=cv.toDataURL('image/jpeg',0.9);_saveAvatarDB(db);
      window._chromeName=nm;_refreshAvatarPreview();_rebuildLayout();
    };
    im.onerror=function(){alert('Could not read that image file.')};
    im.src=rd.result;
  };
  rd.readAsDataURL(f);
  input.value='';
}
function _clearAvatar(){
  var nm=(_val('ps-hdr-text')||window._chromeName||'');
  var db=_loadAvatarDB();if(db[_norm(nm)]){delete db[_norm(nm)];_saveAvatarDB(db)}
  _refreshAvatarPreview();_rebuildLayout();
}

function _isDark(){return document.getElementById('tb-theme').value==='dark'}
function _getViewW(){var s=document.getElementById('tb-view');return _viewSizes[s?s.value:'mobile']||412}
// Client-side mirror of the server formatTimestamp() — "OCT 24, 2023 AT 10:11 A.M."
function _fmtTs(iso){
  var d=new Date(iso);
  var mon=d.toLocaleString('en-US',{month:'short'}).toUpperCase();
  var hr=d.getHours()%12||12;var min=('0'+d.getMinutes()).slice(-2);
  var ap=d.getHours()>=12?'P.M.':'A.M.';
  return mon+' '+d.getDate()+', '+d.getFullYear()+' AT '+hr+':'+min+' '+ap;
}

function _colorize(root,d){
  root.querySelectorAll('.bubble-out').forEach(function(b){b.style.background='linear-gradient(160deg,#2a8bff 0%,#3b6ef5 45%,#6a5cf0 100%)'});
  root.querySelectorAll('.bubble-in').forEach(function(b){b.style.background=d?'#303030':'#ffffff';b.style.color=d?'#ededed':'#0a0a0a'});
  root.querySelectorAll('.bubble-call').forEach(function(b){b.style.background=d?'#303030':'#ffffff';b.style.color=d?'#a1a1aa':'#4a4d52'});
  root.querySelectorAll('.call-card').forEach(function(b){b.style.background=d?'#303030':'#ffffff';b.style.color=d?'#ededed':'#050505'});
  root.querySelectorAll('.call-ico:not(.call-ico-missed)').forEach(function(e){e.style.background=d?'#5b5d63':'#c8cdd4'});
  root.querySelectorAll('.call-dur').forEach(function(e){e.style.color=d?'#b0b3b8':'#65676b'});
  root.querySelectorAll('.call-back').forEach(function(e){e.style.background=d?'#4a4c51':'#e4e6eb';e.style.color=d?'#e4e6eb':'#050505'});
  root.querySelectorAll('.sender-name').forEach(function(e){e.style.color=d?'#a1a1aa':'#65676b'});
  root.querySelectorAll('.date-label').forEach(function(e){e.style.color=d?'#a1a1aa':'#65676b'});
}

function _restoreOriginal(){
  var thread=document.querySelector('.thread');
  if(!thread)return null;
  if(!_serverHtml)_serverHtml=thread.innerHTML;
  thread.innerHTML=_serverHtml;
  return thread;
}

function applyTheme(v){
  _restoreOriginal();
  var d=v==='dark';
  var bezel=document.querySelector('.thread-bezel');
  var thread=document.querySelector('.thread');
  if(bezel){bezel.style.background='transparent';bezel.style.border='none'}
  if(thread){thread.style.background=d?'#000':'#fff';thread.style.color=d?'#ededed':'#0a0a0a'}
  _colorize(thread||document,d);
  _updateChrome(d);
  // keep the toggle button label/icon in sync with the active theme
  var ti=document.getElementById('tb-theme-icon');if(ti)ti.textContent=d?'\u{1F319}':'☀️';
  var tl=document.getElementById('tb-theme-label');if(tl)tl.textContent=d?'Dark':'Light';
  _serverHtml=thread.innerHTML;
  _rebuildLayout();
}
function toggleTheme(){
  var sel=document.getElementById('tb-theme');
  if(!sel)return;
  sel.value=sel.value==='dark'?'light':'dark';
  applyTheme(sel.value);
  _saveSettings();
}
function setNup(n){
  // Wait for images so re-pagination measures real heights (consistent across n-up).
  _whenImagesReady(function(){applyNup(n)});
  _saveSettings();
}
function cycleView(){
  var sel=document.getElementById('tb-view');
  if(!sel)return;
  var order=['mobile','tablet','desktop'];
  var i=order.indexOf(sel.value);
  sel.value=order[(i+1)%order.length];
  var lbl=document.getElementById('tb-view-label');
  if(lbl)lbl.textContent=sel.value.charAt(0).toUpperCase()+sel.value.slice(1);
  applyViewMode();
  _saveSettings();
}
function _updateChrome(d){
  var tops=document.querySelectorAll('.phone-chrome-top');
  tops.forEach(function(el){el.style.background=d?'#000':'#fff';el.style.color=d?'#fff':'#000'});
  var bots=document.querySelectorAll('.phone-chrome-bottom');
  bots.forEach(function(el){el.style.background=d?'#000':'#fff'});
  document.querySelectorAll('.mib-field').forEach(function(el){el.style.background=d?'#303030':'#f0f0f0';el.style.borderColor=d?'#444':'#ddd';el.style.color=d?'#888':'#999'});
  document.querySelectorAll('.phone-navbar').forEach(function(el){el.style.background=d?'#000':'#fff'});
  document.querySelectorAll('.nav-circle').forEach(function(el){el.style.borderColor=d?'rgba(255,255,255,0.4)':'rgba(0,0,0,0.35)'});
  document.querySelectorAll('.phone-navbar span:not(.nav-circle)').forEach(function(el){el.style.color=d?'rgba(255,255,255,0.4)':'rgba(0,0,0,0.35)'});
}

function applyViewMode(){_whenImagesReady(_rebuildLayout)}

function _rebuildLayout(){
  if(_curNup>1){applyNup(_curNup)}else{applyNup(1)}
}

function _paginate(){
  var RATIO=2340/1080;
  var thread=document.querySelector('.thread');
  if(!thread)return[];
  if(!_serverHtml)_serverHtml=thread.innerHTML;
  thread.innerHTML=_serverHtml;
  // The blob is ALWAYS the mobile Messenger phone. Paginate at a fixed 412px reference
  // so the page count is identical regardless of n-up / view-mode display size.
  var REF=412;
  var refH=Math.round(REF*RATIO);
  var viewW=REF;
  // Chrome PNG: top graphics end at 10.6%, bottom graphics start at 87.8% (measured
  // from the template's transparent region). Pad to those lines so messages live in
  // the safe zone and never sit under the header.
  var padTop=Math.round(refH*0.108);
  var padBot=Math.round(refH*0.122);
  var usableH=refH-padTop-padBot;
  // Only filtered-in rows participate (respect the date filter).
  var children=Array.from(thread.children).filter(function(c){return c.style.display!=='none'});
  // The measurer must match the rendered viewport's CSS exactly or it mis-measures and
  // clips messages: it carries the .phone-viewport class (so em padding, bubble sizing,
  // and media max-heights are identical), uses the 16.5px reference font (matching
  // applyNup), and 10px side padding like the real content area.
  var measurer=document.createElement('div');
  measurer.className='phone-viewport';
  measurer.style.cssText='position:absolute;left:-9999px;top:0;width:'+viewW+'px;padding:0 10px;font-size:16.5px;overflow:visible;visibility:hidden;border:none;box-shadow:none;background:none;word-break:break-word;overflow-wrap:break-word';
  measurer.style.fontFamily="'Roboto','Segoe UI',Arial,sans-serif"; // must match .phone-viewport (NOT thread) or measurement mis-sizes
  document.body.appendChild(measurer);
  function h(el){measurer.innerHTML='';measurer.appendChild(el.cloneNode(true));return measurer.scrollHeight}
  function isSepEl(el){return el.classList&&el.classList.contains('date-sep')}
  // Greedy fill: pack each page until a message crosses the bottom safe-zone line.
  // That boundary message is ALLOWED to bleed under the footer chrome (clipped) and is
  // then REPEATED in full at the top of the next page (like overlapping screenshots).
  // pendingOverlap is materialised only when a real next message follows, so we never
  // emit a trailing page that just re-shows the last message.
  var pages=[];var cur=[];var curH=0;var lastSep=null;var pendingOverlap=null;
  for(var i=0;i<children.length;i++){
    var el=children[i];
    var sep=isSepEl(el);
    var eh=h(el);
    if(sep){
      // A timestamp must never be the last thing on a page (orphan). If it can't fit,
      // start a new page so it sits above its messages.
      if(curH+eh>usableH&&cur.length>0){pages.push(cur);cur=[];curH=0;}
      if(pendingOverlap&&cur.length===0){for(var a=0;a<pendingOverlap.length;a++){var pc=pendingOverlap[a].cloneNode(true);cur.push(pc);curH+=h(pc);}pendingOverlap=null;}
      lastSep=el;
      cur.push(el.cloneNode(true));curH+=eh;
      continue;
    }
    // Flush any carried-over (duplicate) boundary message at the very top of a fresh page.
    if(pendingOverlap&&cur.length===0){for(var b=0;b<pendingOverlap.length;b++){var pc2=pendingOverlap[b].cloneNode(true);cur.push(pc2);curH+=h(pc2);}pendingOverlap=null;}
    cur.push(el.cloneNode(true));curH+=eh;
    if(curH>usableH){
      pages.push(cur);
      // Repeat ONLY the boundary message itself at the top of the next page. We do NOT
      // carry the group's timestamp — it belongs to the first message of the group and
      // re-showing it above a mid-group continuation mis-labels it (e.g. my 12:26 above
      // her 12:27 message). A continuation simply shows no timestamp.
      pendingOverlap=[el];
      cur=[];curH=0;
    }
  }
  if(cur.length>0)pages.push(cur);
  document.body.removeChild(measurer);
  // NOTE: we deliberately do NOT force a timestamp at the top of every page. Timestamps
  // appear only at real gaps (Messenger-style); a continuation page simply starts with
  // a message and no timestamp, which is what real scrolled screenshots look like.
  return pages;
}
function applyNup(n){
  _curNup=n;
  if(document.body)document.body.className=document.body.className.replace(/\bnup-\d+\b/,'nup-'+n);
  var RATIO=2340/1080;
  var bezel=document.querySelector('.thread-bezel');
  var thread=document.querySelector('.thread');
  if(!thread)return;
  var d=_isDark();
  var innerBg=d?'#000':'#fff';
  var innerColor=d?'#ededed':'#0a0a0a';
  // Chat-header name (from Page Setup) + its matched avatar (from the name->photo table).
  var _chromeNm=window._chromeName||'Jessica Arsenault';
  var _chromeAv=_avatarFor(_chromeNm);
  var pages=_paginate();
  var bezelChTop=bezel?bezel.querySelector(':scope > .phone-chrome-top'):null;
  var bezelChBot=bezel?bezel.querySelector(':scope > .phone-chrome-bottom'):null;
  if(bezelChTop)bezelChTop.style.display='none';
  if(bezelChBot)bezelChBot.style.display='none';
  // The blob is ALWAYS the mobile phone with chrome. Fixed phone widths (px == print
  // inches @96dpi): 1-up & 2-up share 3.5in, 4-up is 2in. View mode (mobile/tablet/
  // desktop) only scales the on-screen preview via a zoom on .thread (print resets it).
  var REF=412;
  var perRow=(n===1?1:2);
  // Sizes (px == print inches @96dpi, aspect 2340/1080 preserved):
  //  1-up & 2-up share 3.5in wide (1-up centered, 2-up two side-by-side per page).
  //  4-up ~1.93in wide / 4.18in tall so 2 rows (=4 phones) reliably fit one page.
  var phoneW=(n===4?185:336);
  var phoneH=Math.round(phoneW*RATIO);
  var fontSize=Math.round(16.5*(phoneW/REF)*10)/10;
  var bgImg=d?'/phone-chrome/dark.png':'/phone-chrome/light.png';
  // Full wallpaper (pastel/dark swirl) behind the messages. The crisp chrome overlay
  // (bgImg) still sits on top; messages render over the swirl, between the two.
  var bgFull=d?'/phone-chrome/bg-dark.png':'/phone-chrome/bg-light.png';
  var padTop=Math.round(phoneH*0.108);
  var padBot=Math.round(phoneH*0.122);
  // View mode scales the ON-SCREEN preview only (Tablet/Desktop = larger, easier to
  // read). PRINT ignores this (@media print sets .thread zoom:1) so paper output stays
  // a fixed physical size regardless of the chosen view.
  var viewMul=({mobile:1,tablet:1.3,desktop:1.6})[(document.getElementById('tb-view')||{}).value]||1;
  if(bezel){bezel.style.maxWidth='none';bezel.style.padding='0';bezel.style.background='transparent';bezel.style.borderRadius='0';bezel.style.boxShadow='none';bezel.style.border='none'}
  thread.style.maxWidth='none';thread.style.border='none';thread.style.borderRadius='0';thread.style.padding='0';thread.style.background='transparent';thread.style.overflow='visible';thread.style.zoom=String(viewMul);thread.style.display='flex';thread.style.justifyContent='center';
  thread.innerHTML='';

  // Provenance lives in the table's <thead>/<tfoot>. Chrome's print engine repeats a
  // table-header-group / table-footer-group on EVERY page AND reserves its vertical space
  // in the flow — so the phones start BELOW the header and end ABOVE the footer instead
  // of sliding under a position:fixed band (the old overlap bug). The hidden
  // .ct-header/.ct-footer divs stay the editable source of truth (Page Setup edits them);
  // we copy their text + styling into the table groups here.
  var table=document.createElement('table');
  table.className='phone-table';
  function _provCell(src,cls){
    var td=document.createElement('td');
    td.className='pt-prov '+cls;td.colSpan=perRow;
    if(src){
      td.textContent=src.textContent;
      var st=src.style;
      if(st.fontSize)td.style.fontSize=st.fontSize;
      if(st.fontFamily)td.style.fontFamily=st.fontFamily;
      if(st.fontWeight)td.style.fontWeight=st.fontWeight;
      if(st.textAlign)td.style.textAlign=st.textAlign;
    }
    return td;
  }
  var _srcHdr=document.querySelector('.ct-header .ct-hdr-title');
  var _srcFtr=document.querySelector('.ct-footer');
  if(_srcHdr&&_srcHdr.textContent.trim()){
    var thead=document.createElement('thead');var htr=document.createElement('tr');
    var hcell=_provCell(_srcHdr,'pt-prov-hdr');
    if(_srcHdr.style.paddingBottom)hcell.style.paddingBottom=_srcHdr.style.paddingBottom;
    htr.appendChild(hcell);thead.appendChild(htr);table.appendChild(thead);
  }
  var tbody=document.createElement('tbody');
  var tr=document.createElement('tr');var inRow=0;
  for(var p=0;p<pages.length;p++){
    // Layering: solid base (pv) -> messages (content) -> chrome PNG overlay on top, so
    // overflow slides BEHIND the header/footer chrome instead of over it.
    var pv=document.createElement('div');
    pv.className='phone-viewport';
    pv.style.cssText='position:relative;display:block;background:'+innerBg+' url('+bgFull+') center/100% 100% no-repeat;color:'+innerColor+';border:1px solid #9a9a9a;border-radius:0;box-shadow:0 2px 10px rgba(0,0,0,0.3);width:'+phoneW+'px;height:'+phoneH+'px;overflow:hidden;font-size:'+fontSize+'px;word-break:break-word;overflow-wrap:break-word;-webkit-print-color-adjust:exact;print-color-adjust:exact';
    var content=document.createElement('div');
    content.style.cssText='position:absolute;top:0;left:0;right:0;bottom:0;z-index:1;overflow:hidden;padding:'+padTop+'px 10px '+padBot+'px;color:'+innerColor+';background:transparent;box-sizing:border-box';
    for(var m=0;m<pages[p].length;m++){content.appendChild(pages[p][m].cloneNode(true))}
    // Swap the in-chat sender/call avatars to the matched person (the source rows are
    // restored from _serverHtml each rebuild, so do it here on the clones).
    if(_chromeAv&&_chromeAv!=='/phone-chrome/profile.png'){
      content.querySelectorAll('.sender-avatar').forEach(function(im){im.src=_chromeAv});
    }
    pv.appendChild(content);
    var overlay=document.createElement('div');
    overlay.className='phone-chrome-overlay';
    overlay.style.cssText='position:absolute;top:0;left:0;width:100%;height:100%;z-index:5;background:url('+bgImg+') center/100% 100% no-repeat;pointer-events:none;-webkit-print-color-adjust:exact;print-color-adjust:exact';
    pv.appendChild(overlay);
    // Messenger's scroll-to-bottom down-arrow, centered just above the input bar.
    // Shown on EVERY viewport (the exported content is always old/scrolled-up, never
    // within a few messages of the live bottom where it would hide).
    var arrow=document.createElement('img');
    arrow.className='scroll-arrow';
    arrow.src=d?'/phone-chrome/layer1.png':'/phone-chrome/layer1-light.png';
    arrow.style.cssText='position:absolute;left:50%;transform:translateX(-50%);bottom:'+Math.round(phoneH*0.135)+'px;width:'+Math.round(phoneW*0.1)+'px;height:auto;z-index:6;pointer-events:none;-webkit-print-color-adjust:exact;print-color-adjust:exact';
    arrow.setAttribute('alt','');
    arrow.onerror=function(){this.style.display='none'};
    pv.appendChild(arrow);
    // Live status-bar clock painted over the PNG's baked-in time. The status-bar bg is a
    // flat colour, so a matching patch fully hides the original number; Roboto bold in the
    // same grey/white matches Android Messenger.
    if(window._chromeTimeStr){
      var clk=document.createElement('div');
      clk.textContent=window._chromeTimeStr;
      clk.style.cssText='position:absolute;z-index:7;left:'+(phoneW*0.026)+'px;top:'+(phoneH*0.0091)+'px;width:'+(phoneW*0.14)+'px;height:'+(phoneH*0.025)+'px;background:'+(d?'#000':'rgb(242,250,253)')+';display:flex;align-items:center;justify-content:flex-start;white-space:nowrap;overflow:visible;padding-left:'+(phoneW*0.009)+'px;font-family:Roboto,Arial,sans-serif;font-weight:700;font-size:'+(phoneH*0.0163)+'px;line-height:1;color:'+(d?'#ededed':'#45484a')+';-webkit-print-color-adjust:exact;print-color-adjust:exact';
      pv.appendChild(clk);
    }
    // Custom chat name / avatar — drawn over the PNG's baked-in (Jessica) header only when
    // a different person is chosen, so the default stays pixel-perfect. The header bg is a
    // flat colour (light rgb(242,250,253) / dark #000) so the name cover-patch is seamless.
    if(_chromeAv&&_chromeAv!=='/phone-chrome/profile.png'){
      var avD=phoneW*0.095;
      var av=document.createElement('img');
      av.src=_chromeAv;av.setAttribute('alt','');
      av.style.cssText='position:absolute;z-index:7;left:'+(phoneW*0.1954-avD/2)+'px;top:'+(phoneH*0.0752-avD/2)+'px;width:'+avD+'px;height:'+avD+'px;border-radius:50%;object-fit:cover;-webkit-print-color-adjust:exact;print-color-adjust:exact';
      av.onerror=function(){this.style.display='none'};
      pv.appendChild(av);
    }
    if(_chromeNm&&_chromeNm!=='Jessica Arsenault'){
      var nm=document.createElement('div');
      nm.textContent=_chromeNm;
      nm.style.cssText='position:absolute;z-index:7;left:'+(phoneW*0.252)+'px;top:'+(phoneH*0.0521)+'px;width:'+(phoneW*0.613)+'px;height:'+(phoneH*0.047)+'px;background:'+(d?'#000':'rgb(242,250,253)')+';display:flex;align-items:center;justify-content:flex-start;white-space:nowrap;overflow:hidden;padding-left:'+(phoneW*0.0193)+'px;font-family:Roboto,Arial,sans-serif;font-weight:700;font-size:'+(phoneH*0.0251)+'px;line-height:1;color:'+(d?'#ffffff':'#050505')+';-webkit-print-color-adjust:exact;print-color-adjust:exact';
      pv.appendChild(nm);
    }
    var td=document.createElement('td');td.className='pt-cell';td.appendChild(pv);
    tr.appendChild(td);inRow++;
    if(inRow===perRow){tbody.appendChild(tr);tr=document.createElement('tr');inRow=0}
  }
  if(inRow>0){while(inRow<perRow){var etd=document.createElement('td');etd.className='pt-cell';tr.appendChild(etd);inRow++}tbody.appendChild(tr)}
  table.appendChild(tbody);
  if(_srcFtr&&_srcFtr.textContent.trim()){
    var tfoot=document.createElement('tfoot');var ftr2=document.createElement('tr');
    var fcell=_provCell(_srcFtr,'pt-prov-ftr');
    if(_srcFtr.style.paddingTop)fcell.style.paddingTop=_srcFtr.style.paddingTop;
    ftr2.appendChild(fcell);tfoot.appendChild(ftr2);table.appendChild(tfoot);
  }
  thread.appendChild(table);
}

function filterByDate(){
  var thread=document.querySelector('.thread');
  if(!thread)return;
  if(!_serverHtml)_serverHtml=thread.innerHTML;
  thread.innerHTML=_serverHtml;
  var f=document.getElementById('tb-from').value,t=document.getElementById('tb-to').value;
  if(f||t){
    var fromLocal=f?new Date(f+'T00:00:00'):null;
    var toLocal=t?(function(){var te=new Date(t+'T00:00:00');te.setDate(te.getDate()+1);return te})():null;
    thread.querySelectorAll('.msg-row,.call-row').forEach(function(r){var ts=r.getAttribute('data-ts');if(!ts){r.style.display='';return}var dd=new Date(ts);var show=true;if(fromLocal&&dd<fromLocal)show=false;if(toLocal&&dd>=toLocal)show=false;r.style.display=show?'':'none'});
    thread.querySelectorAll('.date-sep').forEach(function(s){var ts=s.getAttribute('data-ts');if(!ts)return;var dd=new Date(ts);var show=true;if(fromLocal&&dd<fromLocal)show=false;if(toLocal&&dd>=toLocal)show=false;s.style.display=show?'':'none'});
  }
  _serverHtml=thread.innerHTML;
  _rebuildLayout();
}

var _ctxBusy=false;
function adjustCtx(which,delta){
  if(which==='before')_ctxBefore=Math.max(0,_ctxBefore+delta);
  else _ctxAfter=Math.max(0,_ctxAfter+delta);
  var b=document.getElementById('ctx-before');if(b)b.textContent=_ctxBefore;
  var a=document.getElementById('ctx-after');if(a)a.textContent=_ctxAfter;
  var payload=window._exportPayload;
  if(!payload)return;                 // context only applies to search-result exports
  if(_ctxBusy)return; _ctxBusy=true;
  payload.contextBefore=_ctxBefore;
  payload.contextAfter=_ctxAfter;
  _saveSettings();
  fetch('/api/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}).then(function(r){return r.text()}).then(function(html){
    var parser=new DOMParser();
    var doc=parser.parseFromString(html,'text/html');
    var newThread=doc.querySelector('.thread');
    var curThread=document.querySelector('.thread');
    if(newThread&&curThread){
      curThread.innerHTML=newThread.innerHTML;
      // Re-apply the active theme colours to the freshly-fetched messages, otherwise
      // the new bubbles fall back to default CSS (the "bubble colour changed" bug).
      var d=_isDark();
      _colorize(curThread,d);
      _serverHtml=curThread.innerHTML;
      _rebuildLayout();
    }
    _ctxBusy=false;
  }).catch(function(){_ctxBusy=false});
}

function updateHeader(text){
  var hdr=document.querySelector('.ct-header .ct-hdr-title');
  if(hdr&&text)hdr.textContent=text;
}

function openPageSetup(){
  var dlg=document.getElementById('page-setup-dialog');
  if(!dlg)return;
  var hdr=document.querySelector('.ct-header .ct-hdr-title');
  var ftr=document.querySelector('.ct-footer');
  var hdrInput=document.getElementById('ps-hdr-text');
  var ftrInput=document.getElementById('ps-ftr-text');
  if(hdrInput&&hdr)hdrInput.value=hdr.textContent||'';
  if(ftrInput&&ftr)ftrInput.value=ftr.textContent||'';
  _refreshAvatarPreview();
  dlg.style.display='flex';
}
function closePageSetup(){
  var dlg=document.getElementById('page-setup-dialog');
  if(dlg)dlg.style.display='none';
}
// Click any photo to enlarge it in a full-screen lightbox (click again to close).
document.addEventListener('click',function(e){
  var t=e.target;
  if(t&&t.tagName==='IMG'&&t.classList&&t.classList.contains('media')){
    var ov=document.createElement('div');
    ov.className='no-print';
    ov.style.cssText='position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.92);display:flex;align-items:center;justify-content:center;cursor:zoom-out';
    var big=document.createElement('img');big.src=t.src;big.style.cssText='max-width:96vw;max-height:96vh;object-fit:contain;box-shadow:0 4px 30px rgba(0,0,0,0.6)';
    ov.appendChild(big);ov.addEventListener('click',function(){ov.remove()});
    document.body.appendChild(ov);
  }
});
// Page numbers via the CSS @page bottom-right margin box (Chrome print). Toggled by
// injecting/clearing a stylesheet (default ON).
function _applyPageNum(){
  var s=document.getElementById('pagenum-style');
  if(!s){s=document.createElement('style');s.id='pagenum-style';document.head.appendChild(s)}
  s.textContent=(window._showPageNum!==false)?'@media print{@page{@bottom-right{content:counter(page);font-size:9px;color:#555;margin:0}}}':'';
}
function applyPageSetup(silent){
  var hdrText=document.getElementById('ps-hdr-text');
  var hdrSize=document.getElementById('ps-hdr-size');
  var hdrFont=document.getElementById('ps-hdr-font');
  var hdrWeight=document.getElementById('ps-hdr-weight');
  var hdrDist=document.getElementById('ps-hdr-dist');
  var ftrText=document.getElementById('ps-ftr-text');
  var ftrSize=document.getElementById('ps-ftr-size');
  var ftrFont=document.getElementById('ps-ftr-font');
  var ftrWeight=document.getElementById('ps-ftr-weight');
  var ftrDist=document.getElementById('ps-ftr-dist');
  var hdrAlign=document.getElementById('ps-hdr-align');
  var ftrAlign=document.getElementById('ps-ftr-align');
  var hdr=document.querySelector('.ct-header .ct-hdr-title');
  var ftr=document.querySelector('.ct-footer');
  if(hdr&&hdrText&&hdrText.value){hdr.textContent=hdrText.value}
  function pxv(el){var n=el?parseInt(el.value,10):NaN;return isNaN(n)?'':n+'px'}
  if(hdr){
    if(hdrSize&&pxv(hdrSize))hdr.style.fontSize=pxv(hdrSize);
    if(hdrFont)hdr.style.fontFamily=hdrFont.value;
    if(hdrWeight)hdr.style.fontWeight=hdrWeight.value;
    if(hdrAlign)hdr.style.textAlign=hdrAlign.value;
    // "distance from top" = the GAP between the header and the phone below it, so the
    // header never touches the viewport. Stored as paddingBottom on the header cell.
    if(hdrDist)hdr.style.paddingBottom=parseInt(hdrDist.value,10)+'px';
  }
  if(ftr&&ftrText&&ftrText.value)ftr.textContent=ftrText.value;
  if(ftr){
    if(ftrSize&&pxv(ftrSize))ftr.style.fontSize=pxv(ftrSize);
    if(ftrFont)ftr.style.fontFamily=ftrFont.value;
    if(ftrWeight)ftr.style.fontWeight=ftrWeight.value;
    if(ftrAlign)ftr.style.textAlign=ftrAlign.value;
    // "distance from bottom" = the GAP between the phone and the footer.
    if(ftrDist)ftr.style.paddingTop=parseInt(ftrDist.value,10)+'px';
  }
  var pn=document.getElementById('ps-pagenum');
  window._showPageNum=pn?pn.checked:true;
  var pns=document.getElementById('ps-pagenum-size');
  window._pageNumSize=pns?(parseInt(pns.value,10)||9):9;
  _applyPageNum();
  // Phone chat-header name follows the header text; its photo is matched from that name
  // (built-in people first, then any photo uploaded + saved under that name).
  window._chromeName=(hdrText&&hdrText.value.trim())?hdrText.value.trim():'Jessica Arsenault';
  // The provenance is mirrored into the print table's thead/tfoot, so rebuild to apply.
  _rebuildLayout();
  // silent === true when re-applying saved settings on load; otherwise persist + close.
  if(silent!==true){_saveGlobalPrefs();_saveSettings();closePageSetup()}
}

// Wire up range slider labels
document.querySelectorAll('#ps-hdr-dist,#ps-ftr-dist').forEach(function(r){
  r.addEventListener('input',function(){
    var lbl=document.getElementById(r.id+'-val');
    if(lbl)lbl.textContent=r.value+'px';
  });
});

// --- Settings persistence, keyed PER DOCUMENT ---
// The blob page must not reset on refresh, but a brand-new export (different
// conversation / date range / search) must start from the settings chosen on its
// SOURCE page (e.g. the search page's Light/Dark). We key localStorage to a hash of
// this document's identity: same export -> restore everything; new export -> nothing
// saved yet, so the server-rendered (source) values stand.
var _SKEY=null;
function _docKey(){
  var h=document.querySelector('.ct-hdr-title');
  var base=(h?h.textContent:document.title)+'|'+document.querySelectorAll('.msg-row').length;
  var hash=0;for(var i=0;i<base.length;i++){hash=((hash<<5)-hash+base.charCodeAt(i))|0}
  return 'ct_blob_'+hash;
}
function _val(id){var e=document.getElementById(id);return e?e.value:''}
// GLOBAL page-setup preferences (font/size/weight/align/distance + page numbers).
// These stick across ALL chats — a setting you apply stays applied everywhere. The
// header/footer TEXT itself is per-document (the provenance), handled separately.
var _GKEY='ct_blob_pagesetup_v1';
function _saveGlobalPrefs(){
  try{
    var g={
      hdrSize:_val('ps-hdr-size'),hdrFont:_val('ps-hdr-font'),hdrWeight:_val('ps-hdr-weight'),hdrAlign:_val('ps-hdr-align'),hdrDist:_val('ps-hdr-dist'),
      ftrSize:_val('ps-ftr-size'),ftrFont:_val('ps-ftr-font'),ftrWeight:_val('ps-ftr-weight'),ftrAlign:_val('ps-ftr-align'),ftrDist:_val('ps-ftr-dist'),
      pagenum:(document.getElementById('ps-pagenum')||{}).checked
    };
    localStorage.setItem(_GKEY,JSON.stringify(g));
  }catch(e){}
}
function _loadGlobalPrefs(){try{var r=localStorage.getItem(_GKEY);return r?JSON.parse(r):null}catch(e){return null}}
function _applyGlobalPrefs(){
  var g=_loadGlobalPrefs();if(!g)return;
  function setv(id,v){var e=document.getElementById(id);if(e&&v!=null&&v!=='')e.value=v}
  setv('ps-hdr-size',g.hdrSize);setv('ps-hdr-font',g.hdrFont);setv('ps-hdr-weight',g.hdrWeight);setv('ps-hdr-align',g.hdrAlign);setv('ps-hdr-dist',g.hdrDist);
  setv('ps-ftr-size',g.ftrSize);setv('ps-ftr-font',g.ftrFont);setv('ps-ftr-weight',g.ftrWeight);setv('ps-ftr-align',g.ftrAlign);setv('ps-ftr-dist',g.ftrDist);
  var pn=document.getElementById('ps-pagenum');if(pn&&typeof g.pagenum==='boolean')pn.checked=g.pagenum;
}
function _saveSettings(){
  try{
    if(!_SKEY)_SKEY=_docKey();
    var s={
      nup:_curNup,
      view:_val('tb-view'),theme:_val('tb-theme'),from:_val('tb-from'),to:_val('tb-to'),
      ctxBefore:_ctxBefore,ctxAfter:_ctxAfter,
      ps:{hdrText:_val('ps-hdr-text'),ftrText:_val('ps-ftr-text')}
    };
    localStorage.setItem(_SKEY,JSON.stringify(s));
  }catch(e){}
}
function _loadSettings(){
  try{
    if(!_SKEY)_SKEY=_docKey();
    var raw=localStorage.getItem(_SKEY);if(!raw)return null;
    return JSON.parse(raw);
  }catch(e){return null}
}

// Re-run a function once every image in the thread has finished loading, so
// pagination measures real heights (deterministic — no alternating layout on refresh).
function _whenImagesReady(cb){
  // Gate on web-fonts too: pagination measures inside .phone-viewport (Roboto), so Roboto
  // must be loaded before we measure or the page would over/under-pack. fonts.load() forces
  // the actual files to download (they aren't "used" until applyNup builds the viewports).
  var _cb=cb;
  cb=function(){
    if(document.fonts&&document.fonts.load){
      Promise.all([document.fonts.load("400 16px Roboto"),document.fonts.load("500 16px Roboto"),document.fonts.load("700 16px Roboto")]).then(_cb,_cb);
    }else{_cb()}
  };
  var thread=document.querySelector('.thread');
  if(!thread){cb();return}
  var imgs=Array.prototype.slice.call(thread.querySelectorAll('img'));
  var pending=imgs.filter(function(im){return !im.complete||im.naturalHeight===0});
  if(pending.length===0){cb();return}
  var done=0,fired=false;
  function one(){done++;if(done>=pending.length&&!fired){fired=true;cb()}}
  pending.forEach(function(im){
    im.addEventListener('load',one);
    im.addEventListener('error',one);
  });
  // Safety net in case some image never resolves.
  setTimeout(function(){if(!fired){fired=true;cb()}},4000);
}

function _initLayout(){
  // Restore settings saved for THIS document (same conversation + range). For a NEW
  // export nothing is saved, so the server-rendered (source-page) values stand — that
  // keeps the search page's Light/Dark + date range authoritative on first open.
  var s=_loadSettings();
  if(s){
    if(s.view&&document.getElementById('tb-view'))document.getElementById('tb-view').value=s.view;
    if(s.theme&&document.getElementById('tb-theme'))document.getElementById('tb-theme').value=s.theme;
    if(s.from&&document.getElementById('tb-from'))document.getElementById('tb-from').value=s.from;
    if(s.to&&document.getElementById('tb-to'))document.getElementById('tb-to').value=s.to;
    // NOTE: context before/after is NOT restored from per-doc storage — it always
    // re-initialises from the search's own context (below) every time you open the blob.
    if(s.ps){
      // Per-document persists only the header/footer TEXT (the provenance). Styling is
      // global (applied below) so an applied font/size sticks across every chat.
      var ps=s.ps;
      function setv(id,v){var e=document.getElementById(id);if(e&&v!=null&&v!=='')e.value=v}
      setv('ps-hdr-text',ps.hdrText);setv('ps-ftr-text',ps.ftrText);
    }
  }
  // Global page-setup styling (font/size/weight/align/distance/page-numbers) — sticks
  // across all chats.
  _applyGlobalPrefs();
  // Context before/after ALWAYS re-initialises from the search's own context count
  // (computed server-side from the result set) every time the blob opens — so the
  // controls match what the search page was showing, and the user adjusts from there.
  _ctxBefore=(typeof window._initCtxBefore==='number')?window._initCtxBefore:0;
  _ctxAfter=(typeof window._initCtxAfter==='number')?window._initCtxAfter:0;
  var cbEl=document.getElementById('ctx-before');if(cbEl)cbEl.textContent=_ctxBefore;
  var caEl=document.getElementById('ctx-after');if(caEl)caEl.textContent=_ctxAfter;
  // Context (before/after) only applies to search-result exports — hide the controls
  // for a whole-conversation export where every message is already present.
  if(!window._exportPayload){var cx=document.getElementById('ctx-controls');if(cx)cx.style.display='none'}
  _whenImagesReady(function(){
    if(s&&s.theme){applyTheme(s.theme)}
    applyPageSetup(true);      // apply global + per-doc page setup (header/footer styling)
    // The results already carry the search's context baked in, so no re-fetch is needed
    // on open — just lay out. The +/- buttons re-fetch when the user changes the count.
    // Default layout: 2-up when the content spans more than one page (side-by-side
    // saves paper); 1-up for a single page. An explicit saved choice always wins.
    var startNup;
    if(s&&typeof s.nup==='number'){startNup=s.nup}
    else{startNup=_paginate().length>1?2:1}
    _curNup=startNup;
    var nupSel=document.getElementById('nup');if(nupSel)nupSel.value=String(startNup);
    if(s&&(s.from||s.to)){filterByDate();return}
    applyNup(startNup);
  });
}

document.addEventListener('DOMContentLoaded',_initLayout);
</script>`;
    }

    function buildDocTitle(convTitle: string, msgs: any[]): string {
      const parts = [convTitle];
      if (msgs.length > 0) {
        const first = new Date(msgs[0].timestamp);
        const last = new Date(msgs[msgs.length - 1].timestamp);
        const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        parts.push(`${fmt(first)} - ${fmt(last)}`);
      }
      return parts.join(' - ');
    }

    function buildFileName(convTitle: string, msgs: any[], ext: string, searchTerm?: string): string {
      const safeName = (convTitle || 'Messages').replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, '_');
      const parts = [safeName];
      if (searchTerm) parts.push(searchTerm.substring(0, 30).replace(/[^a-zA-Z0-9]/g, '_'));
      if (msgs.length > 0) {
        const first = new Date(msgs[0].timestamp);
        const last = new Date(msgs[msgs.length - 1].timestamp);
        const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        parts.push(`${fmt(first)} - ${fmt(last)}`);
      }
      return `${parts.join(' - ')}.${ext}`;
    }

    const bodyBg = isDark ? "#0a0a0a" : "#ffffff";
    const bodyColor = isDark ? "#ededed" : "#0a0a0a";
    const headerBorder = isDark ? "#27272a" : "#e4e4e7";
    const hdrTitleColor = isDark ? "#ededed" : "#0a0a0a";
    const hdrMetaColor = isDark ? "#a1a1aa" : "#71717a";
    const footerColor = isDark ? "#a1a1aa" : "#71717a";
    const dateLine = isDark ? "#27272a" : "#e4e4e7";
    const dateLabel = isDark ? "#a1a1aa" : "#65676b";
    const senderColor = isDark ? "#a1a1aa" : "#65676b";
    // Light grays near white read PINK on Jeremy's monitor. A COOL-biased (blue-leaning)
    // gray reads neutral. Light mode uses a lighter cool gray; dark mode stays #303030.
    // On the swirl wallpaper Messenger uses WHITE incoming bubbles in light mode
    // (dark gray in dark mode).
    const bubbleIn = isDark ? "#303030" : "#ffffff";
    const bubbleInColor = isDark ? "#ededed" : "#0a0a0a";
    const bubbleCallBg = isDark ? "#303030" : "#ffffff";
    const bubbleCallColor = isDark ? "#a1a1aa" : "#4a4d52";
    const timeColor = isDark ? "#71717a" : "#8d949e";
    const mediaRefBg = isDark ? "#3a3500" : "#fff4cc";
    const mediaRefColor = isDark ? "#d4b800" : "#8a6d00";

    const threadBorder = isDark ? '#555' : '#bbb';
    const UNIFIED_CSS = `@font-face{font-family:'Roboto';font-style:normal;font-weight:400;font-display:block;src:url('/fonts/roboto-latin-400-normal.woff2') format('woff2')}
@font-face{font-family:'Roboto';font-style:normal;font-weight:500;font-display:block;src:url('/fonts/roboto-latin-500-normal.woff2') format('woff2')}
@font-face{font-family:'Roboto';font-style:normal;font-weight:700;font-display:block;src:url('/fonts/roboto-latin-700-normal.woff2') format('woff2')}
*{box-sizing:border-box}
body{font-family:'Segoe UI','Helvetica Neue',Arial,sans-serif;font-size:13px;margin:0 auto;padding:20px;color:#333;background:#f0f0f0}
@media(prefers-color-scheme:dark){body{background:#1a1a1a;color:#ddd}}
.thread-bezel{padding:0;margin:0 auto;max-width:${viewMode === "mobile" ? "412px" : viewMode === "tablet" ? "800px" : "100%"};background:transparent;border:none;border-radius:0;box-shadow:0 2px 12px rgba(0,0,0,0.3)}
.thread{padding:16px;padding-top:20px;margin:0;border:none;border-radius:0;overflow:hidden;background:${isDark ? '#000' : '#fff'};color:${bodyColor}}
.ct-header{display:flex;justify-content:space-between;align-items:baseline;padding:8px 12px;font-size:12px;font-weight:500;color:${isDark ? '#ccc' : '#333'};max-width:${viewMode === "mobile" ? "432px" : viewMode === "tablet" ? "820px" : "1060px"};margin:0 auto}.ct-footer{display:block;padding:6px 12px;font-size:10px;color:${isDark ? '#999' : '#555'};max-width:${viewMode === "mobile" ? "432px" : viewMode === "tablet" ? "820px" : "1060px"};margin:0 auto}.has-toolbar .ct-header{display:none}.has-toolbar .ct-footer{display:none}
.date-sep{text-align:center;margin:20px 0 12px}.date-line{display:none}.date-label{font-size:13px;color:${dateLabel};font-weight:500;white-space:nowrap;letter-spacing:0.3px}
.msg-row{display:flex;margin-bottom:4px;align-items:flex-end}.msg-out{justify-content:flex-end}.msg-in{justify-content:flex-start}.msg-col{max-width:70%;word-break:break-word;overflow-wrap:break-word}
.sender-avatar{width:1.1em;height:1.1em;border-radius:50%;margin-right:0.4em;flex-shrink:0;object-fit:cover;align-self:flex-end;margin-bottom:0.1em}
.avatar-spacer{width:1.1em;margin-right:0.4em;flex-shrink:0}
.sender-name{font-size:12px;color:${senderColor};margin:0 0 2px 48px}
.bubble-out{padding:10px 14px;border-radius:18px;background:linear-gradient(160deg,#2a8bff 0%,#3b6ef5 45%,#6a5cf0 100%);color:#fff}.bubble-in{padding:10px 14px;border-radius:18px;background:${bubbleIn};color:${bubbleInColor}}
.bubble-call{display:inline-block;padding:4px 12px;border-radius:16px;background:${bubbleCallBg};color:${bubbleCallColor};font-size:12px;margin:2px auto}
.call-row{display:flex;justify-content:center;margin-bottom:4px}
/* Messenger call-log card: round icon + title + subtitle (call time when missed,
   duration when answered) + a "Call back" button. Rendered inside a normal msg-row,
   so direction places it left (with avatar) / right just like a message bubble. */
.call-card{display:inline-block;min-width:11.5em;max-width:300px;padding:12px 14px;border-radius:18px;background:${bubbleIn};color:${bubbleInColor}}
.call-head{display:flex;align-items:center;gap:10px}
.call-ico{width:36px;height:36px;border-radius:50%;background:${isDark ? '#5b5d63' : '#c8cdd4'};color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0}
.call-ico-missed{background:#fa3e3e;color:#fff}
.call-ico svg{width:58%;height:58%;display:block}
.call-meta{display:flex;flex-direction:column;line-height:1.2;min-width:0}
.call-title{font-size:15px;font-weight:600}
.call-dur{font-size:13px;color:${isDark ? '#b0b3b8' : '#65676b'}}
.call-back{margin-top:10px;text-align:center;padding:8px;border-radius:8px;background:${isDark ? '#4a4c51' : '#e4e6eb'};color:${isDark ? '#e4e6eb' : '#050505'};font-size:14px;font-weight:600}
.phone-viewport .call-col{max-width:78%}
.phone-viewport .call-card{width:16.8em;padding:0.65em 0.78em;border-radius:0.7em}
.phone-viewport .call-head{gap:0.9em}
.phone-viewport .call-ico{width:2.05em;height:2.05em}
.phone-viewport .call-title{font-size:1.15em}
.phone-viewport .call-dur{font-size:0.72em}
.phone-viewport .call-back{margin-top:1em;padding:0.55em;border-radius:0.5em;font-size:1.1em}
.msg-text{font-size:15px;font-weight:500;white-space:pre-wrap;word-break:break-word;margin:0}
.msg-time{font-size:10px;color:${timeColor};margin:2px 0 0 12px;display:none}.msg-time-out{text-align:right;margin-right:12px;margin-left:0;display:none}
.bates{font-size:10px;color:#999;font-family:monospace;margin-left:12px}
.media-only img,.media-only video{max-width:100%;max-height:280px;border-radius:12px;display:block;margin-top:4px}
img.media{max-width:100%;max-height:280px;border-radius:12px;display:block;margin-top:4px}
video.media{max-width:100%;max-height:280px;border-radius:12px;display:block;margin-top:4px}
audio.media{width:100%;display:block;margin:4px 0}
.media-ref{color:${mediaRefColor};background:${mediaRefBg};padding:0 4px;border-radius:3px;font-size:11px;font-family:monospace}
.print-toolbar{position:fixed;top:0;left:0;right:0;z-index:100;display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:8px 16px;background:rgba(20,20,20,0.95);border-bottom:1px solid #333;backdrop-filter:blur(8px)}
.print-toolbar label{color:#ccc;font-size:12px}.print-toolbar select{padding:4px 8px;border-radius:4px;border:1px solid #555;background:#222;color:#eee;font-size:12px}
.print-toolbar .tb-btn{padding:6px 16px;border-radius:6px;border:none;cursor:pointer;font-size:13px;font-weight:600}
.print-toolbar .tb-print{background:#3578E5;color:#fff}.print-toolbar .tb-print:hover{background:#2d6ad4}
.phone-grid{display:flex;flex-wrap:wrap;justify-content:center;gap:16px;padding:16px}
/* Phone layout table: phones in tbody rows; provenance in thead/tfoot (hidden on
   screen, shown + repeated per page in print). */
.phone-table{margin:0 auto;border-collapse:separate;border-spacing:16px}
.phone-table thead,.phone-table tfoot{display:none}
.pt-cell{vertical-align:top;text-align:center;padding:0}
.phone-viewport{border:none;border-radius:0;overflow:hidden;box-shadow:0 1px 6px rgba(0,0,0,0.3);flex-shrink:0;font-family:'Roboto','Segoe UI',Arial,sans-serif}
.phone-viewport *{box-sizing:border-box;max-width:100%}
.phone-viewport .msg-row{margin-bottom:0.267em}
.phone-viewport .msg-col{max-width:70%;word-break:break-word;overflow-wrap:break-word}
.phone-viewport .bubble-out,.phone-viewport .bubble-in{padding:0.667em 0.933em;border-radius:1.2em;word-break:break-word;overflow-wrap:break-word}
/* Message text is ALWAYS left-aligned — the cell's text-align:center (which centres the
   phone column + the provenance) must never cascade into the bubbles. */
.phone-viewport .bubble-in,.phone-viewport .bubble-out,.phone-viewport .bubble-call,.phone-viewport .msg-text,.phone-viewport .call-card,.phone-viewport .call-title,.phone-viewport .call-dur{text-align:left}
.phone-viewport .sender-name{font-size:0.8em;margin:0 0 0.133em 3.2em}
.phone-viewport .msg-time{font-size:0.667em;opacity:0.7}
.phone-viewport .msg-text{font-size:inherit}
.phone-viewport .date-sep{margin:1.33em 0 0.8em}
.phone-viewport .date-label{font-size:0.867em;letter-spacing:0.02em}
.phone-viewport img.media{max-width:100%;max-height:18.67em;border-radius:0.8em;cursor:zoom-in}
/* Video is LOCKED at 18.67em tall (its original size — never shrink it). Height is FIXED
   (not max-height) so pagination measures the same whether or not the frame has loaded;
   width:auto preserves the real aspect ratio (no crop/distort) and max-width caps overflow. */
.phone-viewport video.media{height:18.67em;width:auto;max-width:100%;object-fit:contain;border-radius:0.8em;background:#000}
.phone-row{display:flex;justify-content:center;gap:16px;page-break-after:always;page-break-inside:avoid;padding:8px 0;margin:0 auto}
.thread-bezel{display:flex;flex-direction:column}.thread{flex:1;min-height:0}
.phone-chrome-top,.phone-chrome-bottom{flex-shrink:0}
.phone-statusbar{display:flex;justify-content:space-between;align-items:center;padding:6px 16px 2px;font-size:11px;font-weight:600}
.messenger-hdr{display:flex;align-items:center;padding:8px 12px;gap:10px}
.mhdr-back{font-size:20px;font-weight:300;text-decoration:none}
.mhdr-avatar{width:34px;height:34px;border-radius:50%;background:#666;flex-shrink:0}
.mhdr-name{flex:1;font-weight:700;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mhdr-info{width:24px;height:24px;border-radius:50%;background:#0866ff;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;font-style:italic;flex-shrink:0}
.phone-chrome-bottom{margin-top:auto}
.messenger-input-bar{display:flex;align-items:center;gap:6px;padding:6px 10px}
.mib-icon{font-size:18px}
.mib-field{flex:1;padding:7px 12px;border-radius:20px;font-size:14px}
.phone-navbar{display:flex;justify-content:space-around;align-items:center;padding:8px 0 6px}
.phone-navbar span{opacity:0.4;font-size:14px}
.nav-circle{width:14px;height:14px;border:2px solid;border-radius:50%;display:inline-block;opacity:0.4}
@media print{
@page{size:letter portrait;margin:0.5in 0.45in}
body{font-size:11px;padding:0;margin:0;background:#fff!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;color-adjust:exact;overflow-x:hidden}
.print-toolbar{display:none!important}
/* Provenance rides in the table's thead/tfoot so Chrome repeats it on every page AND
   reserves its vertical space (phones can't slide under it). The standalone
   .ct-header/.ct-footer divs are the editable source only — hidden on paper. */
.ct-header,.ct-footer,.has-toolbar .ct-header,.has-toolbar .ct-footer{display:none!important}
.phone-table thead{display:table-header-group}
.phone-table tfoot{display:table-footer-group}
.pt-prov{text-align:center;background:#fff;color:#000;font-size:11px;font-weight:500;padding:0.04in 0.1in 0.16in;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.pt-prov-ftr{font-size:9px;color:#333;font-weight:400;word-break:break-all;padding:0.16in 0.1in 0.04in}
.thread-bezel{display:block!important;max-width:none!important;padding:0;margin:0;box-shadow:none!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;color-adjust:exact}
.thread{display:block!important;padding:0;margin:0;overflow:visible;max-width:none!important;background:transparent!important;zoom:1!important}
.phone-table{margin:0 auto;border-collapse:separate;border-spacing:0.2in 0.18in;width:auto}
.phone-table tbody tr{page-break-inside:avoid;break-inside:avoid}
.pt-cell{vertical-align:top;text-align:center;padding:0;page-break-inside:avoid;break-inside:avoid}
.phone-viewport{box-shadow:none!important}
.phone-viewport,.phone-viewport *,.bubble-in,.bubble-out,.phone-viewport div{-webkit-print-color-adjust:exact;print-color-adjust:exact;color-adjust:exact}
}`;

    if (type === "searchResults") {
      const results: any[] = body.results || [];
      const term: string = body.query || "";
      const mc: boolean = body.matchCase === true;
      const includeContext: boolean = body.includeContext !== false;
      // Separate before/after counts (fall back to the legacy single contextLines).
      const legacyCtx: number = body.contextLines || 0;
      const contextBefore: number = body.contextBefore != null ? body.contextBefore : legacyCtx;
      const contextAfter: number = body.contextAfter != null ? body.contextAfter : legacyCtx;
      const contextLines: number = Math.max(contextBefore, contextAfter);
      const subFormat: string = body.subFormat || format || "html";
      const shouldEmbedMedia: boolean = body.embedMedia === true;
      const shouldBundleMedia: boolean = body.bundleMedia === true;
      const originalSource: boolean = body.originalSource === true;
      const ts = (iso: string) => formatTimestamp(iso);
      const fbTimestamp = (iso: string) => formatTimestamp(iso);

      if (contextBefore > 0 || contextAfter > 0) {
        for (const r of results) {
          if (!r.conversation_id && !r.source_id) continue;
          try {
            const safeId = String(r.id).replace(/'/g, "''");
            // Use the numeric timestamp_ms column for ordering/bounds — string timestamp
            // comparisons are fragile across formats. Fall back to a computed epoch.
            const tms = r.timestamp_ms != null ? Number(r.timestamp_ms) : new Date(r.timestamp).getTime();
            // sender_name is NOT a column on messages — it comes from participants.
            // (The previous query selected it directly and threw, which the catch
            // silently swallowed → empty context. Join participants like the search API.)
            const convClause = `m.conversation_id = (SELECT conversation_id FROM messages WHERE id = '${safeId}')`;
            const sel = `SELECT m.id, m.content, p.display_name as sender_name, m.timestamp, m.is_incoming, m.source_id, m.metadata, m.message_type FROM messages m LEFT JOIN participants p ON m.sender_id = p.id`;
            // "before" includes the hit itself (<=), so +1; "after" is strictly later.
            const before = db.exec(`${sel} WHERE ${convClause} AND m.timestamp_ms <= ${tms} ORDER BY m.timestamp_ms DESC LIMIT ${contextBefore + 1}`);
            const after = db.exec(`${sel} WHERE ${convClause} AND m.timestamp_ms > ${tms} ORDER BY m.timestamp_ms ASC LIMIT ${contextAfter}`);
            const ctx: any[] = [];
            const addRows = (rows: any) => { if (!rows[0]?.values) return; for (const v of rows[0].values) { ctx.push({ id: v[0], content: v[1], sender_name: v[2], timestamp: v[3], is_incoming: v[4], source_id: v[5], metadata: v[6], message_type: v[7] }); } };
            addRows(before);
            addRows(after);
            ctx.sort((a: any, b: any) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
            r.context = ctx;
          } catch { /* skip */ }
        }
      }

      // Default the blob's Before/After controls to the context ALREADY present in the
      // results (the search's own context), so the page lands there and adjusts from it.
      let initCtxBefore = 0, initCtxAfter = 0;
      for (const r of results) {
        if (!Array.isArray(r.context) || r.context.length <= 1) continue;
        const hitIdx = r.context.findIndex((c: any) => c.id === r.id);
        if (hitIdx < 0) continue;
        initCtxBefore = Math.max(initCtxBefore, hitIdx);
        initCtxAfter = Math.max(initCtxAfter, r.context.length - 1 - hitIdx);
      }

      function flattenMessages(results: any[]): any[] {
        const seen = new Set<string>();
        const msgs: any[] = [];
        for (const r of results) {
          const ctxList = includeContext && Array.isArray(r.context) && r.context.length > 1
            ? r.context : [r];
          for (const c of ctxList) {
            if (seen.has(c.id)) continue;
            seen.add(c.id);
            msgs.push({ ...c, isMatch: c.id === r.id, conversation_title: r.conversation_title });
          }
        }
        msgs.sort((a: any, b: any) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        return msgs;
      }

      const srcDirCache = new Map<string, string | null>();

      function resolveSourceDir(sourceId: string): string | null {
        if (!sourceId) return null;
        if (srcDirCache.has(sourceId)) return srcDirCache.get(sourceId)!;
        const safeId = String(sourceId).replace(/'/g, "''");
        try {
          const r = db.exec(`SELECT file_path, metadata FROM sources WHERE id = '${safeId}'`);
          const fp = r[0]?.values[0]?.[0] as string | undefined;
          const metadataStr = r[0]?.values[0]?.[1] as string | undefined;
          if (!fp) { srcDirCache.set(sourceId, null); return null; }

          if (metadataStr) {
            try {
              const meta = JSON.parse(metadataStr);
              if (meta.localMediaPath) {
                try {
                  const dir = fs.statSync(meta.localMediaPath).isDirectory()
                    ? meta.localMediaPath : path.dirname(meta.localMediaPath);
                  srcDirCache.set(sourceId, dir);
                  return dir;
                } catch {}
              }
            } catch {}
          }

          if (fp.startsWith("upload://")) {
            const convResult = db.exec(
              `SELECT DISTINCT s.file_path FROM conversations c
               JOIN conversations c2 ON c.title = c2.title AND c.platform = c2.platform
               JOIN sources s ON c2.source_id = s.id
               WHERE c.source_id = '${safeId}'
                 AND s.file_path NOT LIKE 'upload://%'
               LIMIT 1`
            );
            const fallback = convResult[0]?.values[0]?.[0] as string | undefined;
            if (fallback) {
              try {
                const dir = fs.statSync(fallback).isDirectory() ? fallback : path.dirname(fallback);
                srcDirCache.set(sourceId, dir);
                return dir;
              } catch {}
            }
            const uploadRel = fp.replace("upload://", "");
            const folderName = uploadRel.split(/[/\\]/)[0];
            if (folderName) {
              const allSources = db.exec(`SELECT file_path FROM sources WHERE file_path NOT LIKE 'upload://%'`);
              for (const row of (allSources[0]?.values || [])) {
                const sp = row[0] as string;
                try {
                  const spDir = fs.statSync(sp).isDirectory() ? sp : path.dirname(sp);
                  if (path.basename(spDir) === folderName) { srcDirCache.set(sourceId, spDir); return spDir; }
                  const candidate = path.join(path.dirname(spDir), folderName);
                  if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) { srcDirCache.set(sourceId, candidate); return candidate; }
                } catch {}
              }
            }
          } else if (fs.existsSync(fp)) {
            const dir = fs.statSync(fp).isDirectory() ? fp : path.dirname(fp);
            srcDirCache.set(sourceId, dir);
            return dir;
          }
        } catch {}
        srcDirCache.set(sourceId, null);
        return null;
      }

      function getMimeType(filename: string): string {
        const ext = (filename.split('.').pop() || '').toLowerCase();
        const map: Record<string, string> = {
          jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
          webp: 'image/webp', svg: 'image/svg+xml', mp4: 'video/mp4', webm: 'video/webm',
          mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
        };
        return map[ext] || 'application/octet-stream';
      }

      function mediaToDataUri(sourceId: string, filename: string, mediaType: string): string | null {
        const dir = resolveSourceDir(sourceId);
        if (!dir) return null;
        const diskPath = resolveMediaPath(dir, filename, mediaType);
        if (!diskPath) return null;
        try {
          const buf = fs.readFileSync(diskPath);
          return `data:${getMimeType(filename)};base64,${buf.toString('base64')}`;
        } catch { return null; }
      }

      // (shared functions moved to top level above)

      function buildFbHeader(convTitle: string, allMsgs: any[]): string {
        const sourceIds = [...new Set(allMsgs.map((m: any) => m.source_id).filter(Boolean))];
        const info = lookupSourceInfo(sourceIds);
        return buildUnifiedHeader(convTitle, allMsgs.length, allMsgs, info);
      }

      function buildFbFooter(allMsgs: any[]): string {
        const sourceIds = [...new Set(allMsgs.map((m: any) => m.source_id).filter(Boolean))];
        const info = lookupSourceInfo(sourceIds);
        return buildUnifiedFooter(info);
      }

      function renderMediaForFbFormat(metadata: string | null, sourceId: string, embed: boolean, mhtmlMode: boolean): string {
        const refs = getMediaRefs(metadata);
        if (refs.length === 0) return '';
        const parts: string[] = [];
        for (const mm of refs) {
          if (mm.filename) {
            if (embed) {
              const dataUri = mediaToDataUri(sourceId, mm.filename, mm.type);
              if (dataUri) {
                if (mm.type === 'image' || mm.type === 'sticker' || mm.type === 'gif') {
                  parts.push(`<a target="_blank" href="${dataUri}"><img src="${dataUri}" class="_a6_o _3-96" /></a>`);
                } else if (mm.type === 'video') {
                  parts.push(`<video class="_a6_o _3-96" controls src="${dataUri}"></video>`);
                } else if (mm.type === 'audio') {
                  parts.push(`<audio style="width:100%;display:block;margin:4px 0;" controls src="${dataUri}"></audio>`);
                }
                continue;
              }
            } else if (mhtmlMode) {
              if (mm.type === 'image' || mm.type === 'sticker' || mm.type === 'gif') {
                parts.push(`<a target="_blank" href="${escapeHtml(mm.filename)}"><img src="${escapeHtml(mm.filename)}" class="_a6_o _3-96" /></a>`);
              } else if (mm.type === 'video') {
                parts.push(`<video class="_a6_o _3-96" controls src="${escapeHtml(mm.filename)}"></video>`);
              } else if (mm.type === 'audio') {
                parts.push(`<audio style="width:100%;display:block;margin:4px 0;" controls src="${escapeHtml(mm.filename)}"></audio>`);
              }
              continue;
            }
          }
          parts.push(`<div style="color:#8d949e;font-size:11px;padding:4px 0;">[${escapeHtml(mm.type)}${mm.filename ? ': ' + escapeHtml(mm.filename) : ''}]</div>`);
        }
        return parts.join('');
      }

      function renderMediaForBundle(metadata: string | null, sourceId: string, bundledFiles: Map<string, string>): string {
        const refs = getMediaRefs(metadata);
        if (refs.length === 0) return '';
        const parts: string[] = [];
        for (const mm of refs) {
          if (mm.filename) {
            const dir = resolveSourceDir(sourceId);
            if (dir) {
              const diskPath = resolveMediaPath(dir, mm.filename, mm.type);
              if (diskPath) {
                const zipName = `media/${mm.filename}`;
                bundledFiles.set(zipName, diskPath);
                if (mm.type === 'image' || mm.type === 'sticker' || mm.type === 'gif') {
                  parts.push(`<a target="_blank" href="${zipName}"><img src="${zipName}" class="_a6_o _3-96" /></a>`);
                } else if (mm.type === 'video') {
                  parts.push(`<video class="_a6_o _3-96" controls src="${zipName}"></video>`);
                } else if (mm.type === 'audio') {
                  parts.push(`<audio style="width:100%;display:block;margin:4px 0;" controls src="${zipName}"></audio>`);
                }
                continue;
              }
            }
          }
          parts.push(`<div style="color:#8d949e;font-size:11px;padding:4px 0;">[${escapeHtml(mm.type)}${mm.filename ? ': ' + escapeHtml(mm.filename) : ''}]</div>`);
        }
        return parts.join('');
      }

      function buildBubbleMessagesHtml(allMsgs: any[], embedMedia: boolean, mhtmlMode: boolean, bundledFiles?: Map<string, string>): string {
        let html = '';
        let pSender = '';
        let pTime = 0;
        for (const m of allMsgs) {
          const isOut = !m.is_incoming;
          const curSender = m.sender_name || 'Unknown';
          const curTime = new Date(m.timestamp).getTime();
          const curDay = new Date(m.timestamp).toDateString();
          const prevDay = pTime ? new Date(pTime).toDateString() : '';
          const showHeader = (m.message_type === 'call') || (curTime - pTime > 300000) || curDay !== prevDay || pTime === 0;
          const showSender = !isOut && (curSender !== pSender || showHeader);
          const content = escapeHtml(m.content || '');
          let mediaHtml: string;
          if (bundledFiles) {
            mediaHtml = renderMediaForBundle(m.metadata, m.source_id, bundledFiles);
          } else {
            mediaHtml = renderMediaForFbFormat(m.metadata, m.source_id, embedMedia, mhtmlMode);
          }

          const hasOnlyMedia = !content && mediaHtml;
          const bubbleClass = isOut ? 'bubble-out' : 'bubble-in';

          if (showHeader) html += `<div class="date-sep" data-ts="${m.timestamp}"><span class="date-label">${fbTimestamp(m.timestamp)}</span></div>`;
          if (m.message_type === 'call') { html += buildCallRow(m, isOut); pSender = curSender; pTime = curTime; continue; }
          if (showSender) html += `<p class="sender-name">${escapeHtml(curSender)}</p>`;
          html += `<div>`;
          html += `<div class="msg-row ${isOut ? 'msg-out' : 'msg-in'}" data-ts="${m.timestamp}">`;
          html += `<div class="msg-col">`;
          if (hasOnlyMedia) {
            html += `<div class="media-only">${mediaHtml}</div>`;
          } else {
            html += `<div class="${bubbleClass}">`;
            if (content) html += `<p class="msg-text">${content}</p>`;
            if (mediaHtml) html += mediaHtml;
            html += `</div>`;
          }
          html += `</div></div></div>\n`;
          pSender = curSender;
          pTime = curTime;
        }
        return html;
      }

      // Search-results PRINT path — must match the conversation blob exactly:
      // no sender name (1-on-1 chat), avatar beside the LAST incoming message of a
      // group, 20-min/new-day timestamp grouping, and class="media" so the
      // phone-viewport scaling CSS applies (photos shrink proportionally with n-up).
      function buildBubblePrintHtml(allMsgs: any[]): string {
        let html = '';
        let pTime = 0;
        for (let mi = 0; mi < allMsgs.length; mi++) {
          const m = allMsgs[mi];
          const isOut = !m.is_incoming;
          const curSender = m.sender_name || 'Unknown';
          const curTime = new Date(m.timestamp).getTime();
          const curDay = new Date(m.timestamp).toDateString();
          const prevDay = pTime ? new Date(pTime).toDateString() : '';
          const showHeader = (m.message_type === 'call') || (curTime - pTime > 1200000) || curDay !== prevDay || pTime === 0;
          const nextMsg = mi + 1 < allMsgs.length ? allMsgs[mi + 1] : null;
          const isLastInGroup = !isOut && (!nextMsg || nextMsg.sender_name !== curSender || nextMsg.is_incoming !== m.is_incoming || (new Date(nextMsg.timestamp).getTime() - curTime > 1200000));
          const content = escapeHtml(m.content || '');
          const refs = getMediaRefs(m.metadata);
          let mediaHtml = '';
          for (const mm of refs) {
            if (mm.filename) {
              const url = `/api/media?sourceId=${encodeURIComponent(m.source_id)}&filename=${encodeURIComponent(mm.filename)}&type=${encodeURIComponent(mm.type)}`;
              if (mm.type === 'image' || mm.type === 'sticker' || mm.type === 'gif') {
                mediaHtml += `<img class="media" src="${url}" />`;
              } else if (mm.type === 'video') {
                mediaHtml += `<video class="media" controls src="${url}"></video>`;
              } else if (mm.type === 'audio') {
                mediaHtml += `<audio class="media" controls src="${url}"></audio>`;
              }
            }
          }

          const hasOnlyMedia = !content && mediaHtml;
          const bubbleClass = isOut ? 'bubble-out' : 'bubble-in';

          if (showHeader) html += `<div class="date-sep" data-ts="${m.timestamp}"><span class="date-label">${fbTimestamp(m.timestamp)}</span></div>`;
          if (m.message_type === 'call') { html += buildCallRow(m, isOut); pTime = curTime; continue; }
          html += `<div class="msg-row ${isOut ? 'msg-out' : 'msg-in'}" data-ts="${m.timestamp}">`;
          if (!isOut && isLastInGroup) {
            html += `<img class="sender-avatar" src="/phone-chrome/profile.png" alt="" onerror="this.style.display='none'">`;
          } else if (!isOut) {
            html += `<div class="avatar-spacer"></div>`;
          }
          html += `<div class="msg-col">`;
          if (hasOnlyMedia) {
            html += `<div class="media-only">${mediaHtml}</div>`;
          } else {
            html += `<div class="${bubbleClass}">`;
            if (content) html += `<p class="msg-text">${content}</p>`;
            if (mediaHtml) html += mediaHtml;
            html += `</div>`;
          }
          html += `</div></div>\n`;
          pTime = curTime;
        }
        return html;
      }



      function buildFullFbHtml(allMsgs: any[], embedMedia: boolean, mhtmlMode: boolean, bundledFiles?: Map<string, string>): string {
        const convTitle = results[0]?.conversation_title || 'Messages';
        const pageTitle = buildDocTitle(convTitle, allMsgs);

        let html = `<!DOCTYPE html><html><head>`;
        html += `<meta charset="utf-8" />\n`;
        html += `<style>${UNIFIED_CSS}</style>\n`;
        html += `<title>${escapeHtml(pageTitle)}</title>`;
        html += `</head><body>`;
        html += buildFbHeader(convTitle, allMsgs);
        html += `<div class="thread-bezel">`;
        html += buildPhoneChromeTop(convTitle, isDark);
        html += `<div class="thread">`;
        html += buildBubbleMessagesHtml(allMsgs, embedMedia, mhtmlMode, bundledFiles);
        html += `</div>`;
        html += buildPhoneChromeBottom(isDark);
        html += `</div>`;
        html += buildFbFooter(allMsgs);
        html += `</body></html>`;
        return html;
      }

      // --- CSV FORMAT ---
      if (subFormat === "csv") {
        const allMsgs = flattenMessages(results);
        const header = "Timestamp,Sender,Content,Media,Platform,Conversation\n";
        const rows = allMsgs.map((m: any) => {
          const content = (m.content || '').replace(/"/g, '""').replace(/\n/g, ' ');
          const media = mediaLabel(getMediaRefs(m.metadata)).replace(/"/g, '""');
          return `"${ts(m.timestamp)}","${(m.sender_name || '').replace(/"/g, '""')}","${content}","${media}","${m.platform || ''}","${(m.conversation_title || '').replace(/"/g, '""')}"`;
        }).join('\n');
        const csvName = buildFileName(results[0]?.conversation_title || 'Search_Results', allMsgs, 'csv', term);
        return new Response(header + rows, {
          headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${csvName}"` },
        });
      }

      // --- PLAIN TEXT FORMAT ---
      if (subFormat === "txt") {
        const allMsgs = flattenMessages(results);
        let output = `${results[0]?.conversation_title || 'Messages'}\n`;
        output += `Generated: ${new Date().toISOString()}\n`;
        if (term) output += `Search term: ${term}\n`;
        output += `Results: ${results.length}\n`;
        output += "=".repeat(60) + "\n\n";
        for (const m of allMsgs) {
          const mediaRefs = getMediaRefs(m.metadata);
          const mediaStr = mediaRefs.length ? " " + mediaLabel(mediaRefs) : "";
          output += `[${ts(m.timestamp)}] ${m.sender_name || "Unknown"}: ${m.content || "[media]"}${mediaStr}\n`;
        }
        const txtName = buildFileName(results[0]?.conversation_title || 'Search_Results', allMsgs, 'txt', term);
        return new Response(output, {
          headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename="${txtName}"` },
        });
      }

      // --- PRINT FORMAT (media via /api/media URLs for browser rendering) ---
      if (subFormat === "print") {
        const allMsgs = flattenMessages(results);
        const convTitle = results[0]?.conversation_title || 'Messages';
        const pageTitle = buildDocTitle(convTitle, allMsgs);

        let html = `<!DOCTYPE html><html><head><meta charset="utf-8">`;
        html += `<style>${UNIFIED_CSS}</style>`;
        html += `<title>${escapeHtml(pageTitle)}</title>`;
        html += `</head><body class="nup-1 has-toolbar" style="padding-top:48px">`;
        html += buildPrintToolbar(convTitle);
        html += buildFbHeader(convTitle, allMsgs);
        html += `<div class="thread-bezel">`;
        html += buildPhoneChromeTop(convTitle, isDark);
        html += `<div class="thread">`;
        html += buildBubblePrintHtml(allMsgs);
        html += `</div>`;
        html += buildPhoneChromeBottom(isDark);
        html += `</div>`;
        html += buildFbFooter(allMsgs);
        const exportPayload = { type: body.type, format: body.format, subFormat: body.subFormat, query: body.query, matchCase: body.matchCase, includeTimestamps, includeProvenance: body.includeProvenance, includeContext: true, viewMode, theme: themeMode, results: body.results, contextBefore: body.contextBefore || 0, contextAfter: body.contextAfter || 0, inlineMedia: body.inlineMedia };
        html += `<script>window._exportPayload=${JSON.stringify(exportPayload).replace(/<\//g, '<\\/')};window._initCtxBefore=${initCtxBefore};window._initCtxAfter=${initCtxAfter}<\/script>`;
        html += `</body></html>`;
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // --- ORIGINAL SOURCE HTML FORMAT (Facebook-style, no embedded media) ---
      if (originalSource) {
        const allMsgs = flattenMessages(results);
        const html = buildFullFbHtml(allMsgs, false, false);
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8", "Content-Disposition": `attachment; filename="${buildFileName(results[0]?.conversation_title || 'Messages', allMsgs, 'html', term)}"` },
        });
      }

      // --- HTML FORMATS (standalone / ZIP / MHTML) ---
      const allMsgs = flattenMessages(results);

      // --- MHTML FORMAT ---
      if (subFormat === "mhtml") {
        const html = buildFullFbHtml(allMsgs, false, true);
        const boundary = '----=_NextPart_' + Date.now().toString(36);
        let mhtml = `MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="${boundary}"\r\n\r\n`;
        mhtml += `--${boundary}\r\nContent-Type: text/html; charset="utf-8"\r\nContent-Location: exhibit.html\r\n\r\n`;
        mhtml += html + '\r\n';

        const embeddedFiles = new Set<string>();
        for (const m of allMsgs) {
          for (const mm of getMediaRefs(m.metadata)) {
            if (!mm.filename || embeddedFiles.has(mm.filename)) continue;
            const dir = resolveSourceDir(m.source_id);
            if (!dir) continue;
            const diskPath = resolveMediaPath(dir, mm.filename, mm.type);
            if (!diskPath) continue;
            try {
              const buf = fs.readFileSync(diskPath);
              embeddedFiles.add(mm.filename);
              mhtml += `--${boundary}\r\nContent-Type: ${getMimeType(mm.filename)}\r\nContent-Transfer-Encoding: base64\r\nContent-Location: ${mm.filename}\r\n\r\n`;
              const b64 = buf.toString('base64');
              for (let i = 0; i < b64.length; i += 76) {
                mhtml += b64.substring(i, i + 76) + '\r\n';
              }
            } catch {}
          }
        }
        mhtml += `--${boundary}--\r\n`;

        return new Response(mhtml, {
          headers: {
            "Content-Type": "message/rfc822",
            "Content-Disposition": `attachment; filename="${buildFileName(results[0]?.conversation_title || 'Messages', allMsgs, 'mhtml', term)}"`,
          },
        });
      }

      // --- ZIP FORMAT (HTML + media folder) ---
      if (shouldBundleMedia) {
        const bundledFiles = new Map<string, string>();
        const html = buildFullFbHtml(allMsgs, false, false, bundledFiles);
        if (bundledFiles.size > 0) {
          const zip = new AdmZip();
          zip.addFile("exhibit.html", Buffer.from(html, "utf-8"));
          for (const [zipName, diskPath] of bundledFiles) {
            try { zip.addFile(zipName, fs.readFileSync(diskPath)); } catch {}
          }
          return new Response(new Uint8Array(zip.toBuffer()), {
            headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${buildFileName(results[0]?.conversation_title || 'Messages', allMsgs, 'zip', term)}"` },
          });
        }
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8", "Content-Disposition": `attachment; filename="${buildFileName(results[0]?.conversation_title || 'Messages', allMsgs, 'html', term)}"` },
        });
      }

      // --- STANDALONE HTML (default, with embedded media as data URIs) ---
      const html = buildFullFbHtml(allMsgs, true, false);
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Content-Disposition": `attachment; filename="${buildFileName(results[0]?.conversation_title || 'Messages', allMsgs, 'html', term)}"` },
      });
    }

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
    const convTitles = [...new Set(messages.map(m => m.conversation_title || "Untitled").filter(Boolean))];
    const headerTitle = convTitles.length === 1 ? convTitles[0] : `${convTitles.length} Conversations`;

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
          "Content-Disposition": `attachment; filename="${buildFileName(headerTitle, messages, 'csv')}"`,
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
          "Content-Disposition": `attachment; filename="${buildFileName(headerTitle, messages, 'txt')}"`,
        },
      });
    }

    // For media embedding: map each source to its on-disk directory.
    const sourceDirs = new Map<string, string | null>();
    if (embedMedia || inlineMedia || bundleMedia || subFormat === "mhtml") {
      const srcIds = Array.from(new Set(messages.map((m) => m.source_id).filter(Boolean)));
      for (const sid of srcIds) {
        try {
          const r = db.exec(`SELECT file_path, metadata FROM sources WHERE id = '${String(sid).replace(/'/g, "''")}'`);
          const fp = r[0]?.values[0]?.[0] as string | undefined;
          const metaStr = r[0]?.values[0]?.[1] as string | undefined;
          let resolved: string | null = null;
          if (metaStr) {
            try {
              const meta = JSON.parse(metaStr);
              if (meta.localMediaPath) {
                try {
                  resolved = fs.statSync(meta.localMediaPath).isDirectory()
                    ? meta.localMediaPath : path.dirname(meta.localMediaPath);
                } catch {}
              }
            } catch {}
          }
          if (!resolved && fp && !fp.startsWith("upload://")) {
            try {
              if (fs.existsSync(fp)) {
                resolved = fs.statSync(fp).isDirectory() ? fp : path.dirname(fp);
              }
            } catch {}
          }
          sourceDirs.set(sid, resolved);
        } catch { sourceDirs.set(sid, null); }
      }
    }
    // Collected media files to bundle into the ZIP: zipName -> absolute disk path
    const bundledMedia = new Map<string, string>();
    let mediaMissing = 0;

    // BUBBLE_CSS replaced by UNIFIED_CSS (defined above)

    const convSourceIds = [...new Set(messages.map(m => m.source_id).filter(Boolean))];
    const convInfo = lookupSourceInfo(convSourceIds);

    const pageTitle = buildDocTitle(headerTitle, messages);

    let html = `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${escapeHtml(pageTitle)}</title>\n<style>${UNIFIED_CSS}</style>\n</head>\n<body class="nup-1${inlineMedia ? ' has-toolbar' : ''}"${inlineMedia ? ' style="padding-top:48px"' : ''}>\n`;
    if (inlineMedia) {
      html += buildPrintToolbar(headerTitle);
    }
    html += buildUnifiedHeader(headerTitle, messages.length, messages, convInfo);
    html += `<div class="thread-bezel">`;
    html += buildPhoneChromeTop(headerTitle, isDark);
    html += `<div class="thread">\n`;

    let currentConv = "";
    let lastDate = "";
    let prevSender = "";
    let prevTime = 0;
    for (let mi = 0; mi < messages.length; mi++) {
      const m = messages[mi];
      if (m.conversation_title !== currentConv) {
        currentConv = m.conversation_title || "Untitled";
        lastDate = "";
        prevSender = "";
        prevTime = 0;
        if (convTitles.length > 1) {
          html += `<div class="ct-hdr-row" style="margin-top:24px;padding-top:12px;border-top:1px solid #dadde1"><div class="ct-hdr-icon"><svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.04 2 11c0 2.83 1.4 5.35 3.59 7.01V22l3.6-1.98c.96.27 1.98.41 3.01.41 5.52 0 10-4.04 10-9S17.52 2 12 2z"/></svg></div><div><div class="ct-hdr-title">${escapeHtml(currentConv)}</div><div class="ct-hdr-meta">${escapeHtml(m.conv_platform || m.platform)}</div></div></div>\n`;
        }
      }

      const msgDate = new Date(m.timestamp).toDateString();
      if (msgDate !== lastDate) {
        lastDate = msgDate;
        prevSender = "";
        prevTime = 0;
      }

      const isOut = !m.is_incoming;
      const isCall = m.message_type === "call";
      const isSystem = m.message_type === "system";
      const mediaRefs = includeMedia ? getMediaRefs(m.metadata) : [];
      const batesLabel = includeBatesNumbers ? `<span class="bates">${batesPrefix}-${(batesCounter++).toString().padStart(4, "0")}</span>` : "";

      const curSender = m.sender_name || 'Unknown';
      const curTime = new Date(m.timestamp).getTime();
      const timeDiff = curTime - prevTime;
      const curDay = new Date(m.timestamp).toDateString();
      const prevDay = prevTime ? new Date(prevTime).toDateString() : '';
      // Messenger shows a centered timestamp on a new day, after a significant (>20 min)
      // gap, and ALWAYS above a call log entry — but NOT on every message or every
      // sender change.
      const showHeader = includeTimestamps && (isCall || timeDiff > 1200000 || curDay !== prevDay || prevTime === 0);
      const nextMsg = mi + 1 < messages.length ? messages[mi + 1] : null;
      // Avatar sits next to the LAST incoming message of a run: next msg is outgoing,
      // a different sender, or far enough apart to start a new group.
      const isLastInGroup = !isOut && (!nextMsg || nextMsg.sender_name !== curSender || nextMsg.is_incoming !== m.is_incoming || (new Date(nextMsg.timestamp).getTime() - curTime > 1200000));

      if (showHeader) {
        html += `<div class="date-sep" data-ts="${m.timestamp}"><span class="date-label">${escapeHtml(formatTimestamp(m.timestamp))}</span></div>\n`;
      }

      if (isCall) {
        html += buildCallRow(m, isOut, batesLabel);
        prevSender = curSender;
        prevTime = curTime;
        continue;
      }
      if (isSystem) {
        html += `<div class="call-row" data-ts="${m.timestamp}"><span class="bubble-call">${escapeHtml(m.content || '')}${batesLabel}</span></div>\n`;
        prevSender = curSender;
        prevTime = curTime;
        continue;
      }

      let mediaHtml = '';
      if (mediaRefs.length > 0) {
        for (const mm of mediaRefs) {
          let embedded = false;
          if ((embedMedia || bundleMedia || subFormat === "mhtml") && mm.filename) {
            const dir = sourceDirs.get(m.source_id);
            if (dir) {
              const diskPath = resolveMediaPath(dir, mm.filename, mm.type);
              if (diskPath) {
                const zipName = `media/${mm.filename}`;
                bundledMedia.set(zipName, diskPath);
                const src = subFormat === "mhtml" ? mm.filename : zipName;
                if (mm.type === 'image' || mm.type === 'sticker' || mm.type === 'gif') {
                  mediaHtml += `<img class="media" src="${src}" alt="${escapeHtml(mm.filename)}">`;
                } else if (mm.type === 'video') {
                  mediaHtml += `<video class="media" controls src="${src}"></video>`;
                } else if (mm.type === 'audio') {
                  mediaHtml += `<audio class="media" controls src="${src}"></audio>`;
                }
                embedded = true;
              } else { mediaMissing++; }
            }
          }
          if (!embedded && inlineMedia && mm.filename) {
            const dir = sourceDirs.get(m.source_id);
            if (dir && resolveMediaPath(dir, mm.filename, mm.type)) {
              const src = `/api/media?sourceId=${encodeURIComponent(m.source_id)}&filename=${encodeURIComponent(mm.filename)}&type=${encodeURIComponent(mm.type)}`;
              if (mm.type === 'image' || mm.type === 'sticker' || mm.type === 'gif') {
                mediaHtml += `<img class="media" src="${src}" alt="${escapeHtml(mm.filename)}">`;
              } else if (mm.type === 'video') {
                mediaHtml += `<video class="media" controls src="${src}"></video>`;
              } else if (mm.type === 'audio') {
                mediaHtml += `<audio class="media" controls src="${src}"></audio>`;
              }
              embedded = true;
            }
          }
          if (!embedded) {
            mediaHtml += `<span class="media-ref">[${escapeHtml(mm.type)}${mm.filename ? ': ' + escapeHtml(mm.filename) : ''}]</span> `;
          }
        }
      }

      const baseContent = m.content || '';
      const contentText = escapeHtml(baseContent);
      const hasOnlyMedia = !baseContent && mediaHtml;
      const bubbleClass = isOut ? 'bubble-out' : 'bubble-in';

      // NOTE: one-on-one chat — no sender name is rendered (Messenger only shows names
      // in group chats). The avatar identifies the incoming sender instead.

      html += `<div class="msg-row ${isOut ? 'msg-out' : 'msg-in'}" data-ts="${m.timestamp}">`;
      if (!isOut && isLastInGroup) {
        html += `<img class="sender-avatar" src="/phone-chrome/profile.png" alt="" onerror="this.style.display='none'">`;
      } else if (!isOut) {
        html += `<div class="avatar-spacer"></div>`;
      }
      html += `<div class="msg-col">`;
      if (hasOnlyMedia) {
        html += `<div class="media-only">${mediaHtml}</div>`;
      } else {
        html += `<div class="${bubbleClass}">`;
        if (contentText) html += `<p class="msg-text">${contentText}</p>`;
        if (mediaHtml) html += mediaHtml;
        html += `</div>`;
      }
      if (batesLabel) html += batesLabel;
      html += `</div></div>\n`;
      prevSender = curSender;
      prevTime = curTime;
    }

    html += `</div>`;
    html += buildPhoneChromeBottom(isDark);
    html += `</div>\n`;
    if (includeProvenance) {
      html += buildUnifiedFooter(convInfo);
    }

    html += `\n</body>\n</html>`;

    // --- MHTML FORMAT ---
    if (subFormat === "mhtml") {
      const mimeMap: Record<string, string> = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
        webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm',
        mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
      };
      const boundary = '----=_NextPart_' + Date.now().toString(36);
      let mhtml = `MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="${boundary}"\r\n\r\n`;
      mhtml += `--${boundary}\r\nContent-Type: text/html; charset="utf-8"\r\nContent-Location: exhibit.html\r\n\r\n`;
      mhtml += html + '\r\n';

      const embeddedFiles = new Set<string>();
      for (const m of messages) {
        for (const mm of getMediaRefs(m.metadata)) {
          if (!mm.filename || embeddedFiles.has(mm.filename)) continue;
          const dir = sourceDirs.get(m.source_id);
          if (!dir) continue;
          const diskPath = resolveMediaPath(dir, mm.filename, mm.type);
          if (!diskPath) continue;
          try {
            const buf = fs.readFileSync(diskPath);
            embeddedFiles.add(mm.filename);
            const ext = (mm.filename.split('.').pop() || '').toLowerCase();
            const mime = mimeMap[ext] || 'application/octet-stream';
            mhtml += `--${boundary}\r\nContent-Type: ${mime}\r\nContent-Transfer-Encoding: base64\r\nContent-Location: ${mm.filename}\r\n\r\n`;
            const b64 = buf.toString('base64');
            for (let i = 0; i < b64.length; i += 76) {
              mhtml += b64.substring(i, i + 76) + '\r\n';
            }
          } catch {}
        }
      }
      mhtml += `--${boundary}--\r\n`;

      return new Response(mhtml, {
        headers: {
          "Content-Type": "message/rfc822",
          "Content-Disposition": `attachment; filename="${buildFileName(headerTitle, messages, 'mhtml')}"`,
        },
      });
    }

    // --- ZIP FORMAT (HTML + media folder) ---
    if (bundleMedia || (embedMedia && bundledMedia.size > 0)) {
      const zip = new AdmZip();
      zip.addFile("exhibit.html", Buffer.from(html, "utf-8"));
      if (bundleMedia && bundledMedia.size === 0) {
        for (const m of messages) {
          for (const mm of getMediaRefs(m.metadata)) {
            if (!mm.filename) continue;
            const dir = sourceDirs.get(m.source_id);
            if (!dir) continue;
            const diskPath = resolveMediaPath(dir, mm.filename, mm.type);
            if (diskPath && !bundledMedia.has(`media/${mm.filename}`)) {
              bundledMedia.set(`media/${mm.filename}`, diskPath);
            }
          }
        }
      }
      for (const [zipName, diskPath] of bundledMedia) {
        try {
          zip.addFile(zipName, fs.readFileSync(diskPath));
        } catch { /* skip unreadable file */ }
      }
      if (bundledMedia.size > 0) {
        const zipBuffer = zip.toBuffer();
        return new Response(new Uint8Array(zipBuffer), {
          headers: {
            "Content-Type": "application/zip",
            "Content-Disposition": `attachment; filename="${buildFileName(headerTitle, messages, 'zip')}"`,
          },
        });
      }
    }

    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `attachment; filename="${buildFileName(headerTitle, messages, 'html')}"`,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
