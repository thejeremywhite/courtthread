"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

interface BookmarkRow {
  id: string;
  message_id: string;
  conversation_id: string;
  note: string | null;
  created_at: string;
  content: string | null;
  timestamp: string;
  is_incoming: number;
  sender_name: string;
  conversation_title: string;
  platform: string;
}

interface ConversationRow {
  id: string;
  title: string | null;
  platform: string;
  message_count: number;
  participant_names: string | null;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
}

function ExportPageInner() {
  const searchParams = useSearchParams();
  const initialTab = searchParams.get("tab") === "bookmarks" ? "bookmarks" : "conversations";
  const preselectedConv = searchParams.get("conversationId") || "";
  const filterSender = searchParams.get("sender") || "";
  const filterDateFrom = searchParams.get("dateFrom") || "";
  const filterDateTo = searchParams.get("dateTo") || "";
  const hasFilter = !!(filterSender || filterDateFrom || filterDateTo);

  const [tab, setTab] = useState<"conversations" | "bookmarks">(initialTab);
  const [bookmarks, setBookmarks] = useState<BookmarkRow[]>([]);
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [selectedConvs, setSelectedConvs] = useState<Set<string>>(preselectedConv ? new Set([preselectedConv]) : new Set());
  const [selectedBookmarks, setSelectedBookmarks] = useState<Set<string>>(new Set());
  const [exportFormat, setExportFormat] = useState<"pdf" | "html" | "txt" | "csv">("html");
  const [includeProvenance, setIncludeProvenance] = useState(true);
  const [includeTimestamps, setIncludeTimestamps] = useState(true);
  const [includeMedia, setIncludeMedia] = useState(true);
  const [embedMedia, setEmbedMedia] = useState(false);
  const [includeBatesNumbers, setIncludeBatesNumbers] = useState(false);
  const [batesPrefix, setBatesPrefix] = useState("CT");
  const [batesStart, setBatesStart] = useState(1);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    fetch("/api/bookmarks").then((r) => r.json()).then((d) => setBookmarks(d.bookmarks || [])).catch(() => {});
    fetch("/api/conversations?limit=500").then((r) => r.json()).then((d) => setConversations(d.conversations || [])).catch(() => {});
  }, []);

  function toggleConv(id: string) {
    setSelectedConvs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleBookmark(id: string) {
    setSelectedBookmarks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function selectAllBookmarks() {
    if (selectedBookmarks.size === bookmarks.length) {
      setSelectedBookmarks(new Set());
    } else {
      setSelectedBookmarks(new Set(bookmarks.map((b) => b.id)));
    }
  }

  async function handleExport() {
    setExporting(true);
    try {
      const body = buildScopeBody({
        format: exportFormat,
        embedMedia: embedMedia && exportFormat === "html",
      });

      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errData = await res.json();
        alert(errData.error || "Export failed");
        return;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      // The server returns a ZIP when media is bundled; trust the blob's MIME type.
      const isZip = blob.type.includes("zip");
      const ext = isZip ? "zip" : exportFormat === "pdf" ? "pdf" : exportFormat === "csv" ? "csv" : exportFormat === "txt" ? "txt" : "html";
      a.download = `CourtThread_Export_${new Date().toISOString().slice(0, 10)}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e: any) {
      alert(e.message);
    } finally {
      setExporting(false);
    }
  }

  function buildScopeBody(extra: Record<string, unknown>) {
    const body: any = {
      includeProvenance,
      includeTimestamps,
      includeMedia,
      includeBatesNumbers,
      batesPrefix,
      batesStart,
      ...extra,
    };
    if (tab === "bookmarks") {
      body.bookmarkIds = selectedBookmarks.size > 0 ? Array.from(selectedBookmarks) : bookmarks.map((b) => b.id);
      body.type = "bookmarks";
    } else {
      body.conversationIds = Array.from(selectedConvs);
      body.type = "conversations";
      if (filterSender) body.sender = filterSender;
      if (filterDateFrom) body.dateFrom = filterDateFrom;
      if (filterDateTo) body.dateTo = filterDateTo;
    }
    return body;
  }

  // Open a print-formatted view in a new window and trigger the browser print
  // dialog (which can "Save as PDF"). Images render inline via the live media route.
  async function handlePrint() {
    setExporting(true);
    try {
      const body = buildScopeBody({ format: "html", inlineMedia: true, embedMedia: false });
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errData = await res.json();
        alert(errData.error || "Print export failed");
        return;
      }
      let html = await res.text();
      // Base tag so "/api/media" URLs resolve in the new window; auto-open print after load.
      const inject = `<base href="${location.origin}/"><script>window.addEventListener('load',function(){setTimeout(function(){window.print();},400);});<\/script>`;
      html = html.replace(/<head>/i, `<head>${inject}`);
      const w = window.open("", "_blank");
      if (!w) {
        alert("Pop-up blocked — allow pop-ups for this site to print / save as PDF.");
        return;
      }
      w.document.open();
      w.document.write(html);
      w.document.close();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setExporting(false);
    }
  }

  // Group bookmarks by conversation
  const bookmarksByConv = new Map<string, BookmarkRow[]>();
  for (const b of bookmarks) {
    const existing = bookmarksByConv.get(b.conversation_id) || [];
    existing.push(b);
    bookmarksByConv.set(b.conversation_id, existing);
  }

  return (
    <div>
      <h1 className="text-3xl font-bold mb-1">Export</h1>
      <p className="text-[var(--muted-foreground)] mb-6">
        Format and download message threads as court exhibits
      </p>

      {/* Tab selector */}
      <div className="flex gap-1 rounded-lg border border-[var(--border)] bg-[var(--card)] p-1 w-fit mb-6">
        <button onClick={() => setTab("conversations")}
          className={`px-4 py-2 rounded-md text-sm font-medium transition ${
            tab === "conversations" ? "bg-[var(--primary)] text-white" : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          }`}>
          Conversations
        </button>
        <button onClick={() => setTab("bookmarks")}
          className={`px-4 py-2 rounded-md text-sm font-medium transition ${
            tab === "bookmarks" ? "bg-[var(--primary)] text-white" : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          }`}>
          Bookmarks ({bookmarks.length})
        </button>
      </div>

      {/* Active filter banner */}
      {hasFilter && tab === "conversations" && (
        <div className="rounded-lg border border-[var(--primary)]/50 bg-[var(--primary)]/10 p-3 mb-6 flex items-center gap-3 flex-wrap">
          <span className="text-sm font-medium text-[var(--primary)]">Filtered export:</span>
          {filterSender && (
            <span className="text-xs px-2 py-1 rounded-full bg-[var(--primary)]/20 text-[var(--primary)]">
              Sender: {filterSender}
            </span>
          )}
          {filterDateFrom && (
            <span className="text-xs px-2 py-1 rounded-full bg-[var(--primary)]/20 text-[var(--primary)]">
              From: {formatTime(filterDateFrom)}
            </span>
          )}
          {filterDateTo && (
            <span className="text-xs px-2 py-1 rounded-full bg-[var(--primary)]/20 text-[var(--primary)]">
              To: {formatTime(filterDateTo)}
            </span>
          )}
          <span className="text-xs text-[var(--muted-foreground)]">
            Only messages matching these filters will be exported.
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: content selection */}
        <div className="lg:col-span-2">
          {tab === "conversations" ? (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--card)]">
              <div className="px-4 py-3 border-b border-[var(--border)]">
                <h2 className="text-sm font-semibold">
                  Select conversations to export
                  {selectedConvs.size > 0 && <span className="text-[var(--primary)] font-normal ml-2">({selectedConvs.size} selected)</span>}
                </h2>
              </div>
              {conversations.length === 0 ? (
                <div className="p-8 text-center text-[var(--muted-foreground)]">
                  <p className="mb-2">No conversations imported yet.</p>
                  <Link href="/import" className="text-[var(--primary)] hover:underline">Import files</Link>
                </div>
              ) : (
                <div className="divide-y divide-[var(--border)]/50 max-h-[60vh] overflow-y-auto">
                  {conversations.map((conv) => (
                    <button key={conv.id} onClick={() => toggleConv(conv.id)}
                      className="w-full text-left px-4 py-3 hover:bg-[var(--secondary)]/30 transition flex items-center gap-3">
                      <span className={`w-5 h-5 shrink-0 rounded border flex items-center justify-center text-xs ${
                        selectedConvs.has(conv.id) ? "border-[var(--primary)] bg-[var(--primary)] text-white" : "border-[var(--border)]"
                      }`}>
                        {selectedConvs.has(conv.id) && "✓"}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{conv.title || conv.participant_names || "Untitled"}</p>
                        <p className="text-xs text-[var(--muted-foreground)]">
                          {conv.platform} &middot; {conv.message_count.toLocaleString()} messages
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--card)]">
              <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between">
                <h2 className="text-sm font-semibold">
                  Bookmarked messages
                  {selectedBookmarks.size > 0 && <span className="text-[var(--primary)] font-normal ml-2">({selectedBookmarks.size} selected)</span>}
                </h2>
                {bookmarks.length > 0 && (
                  <button onClick={selectAllBookmarks} className="text-xs text-[var(--primary)] hover:underline">
                    {selectedBookmarks.size === bookmarks.length ? "Deselect all" : "Select all"}
                  </button>
                )}
              </div>
              {bookmarks.length === 0 ? (
                <div className="p-8 text-center text-[var(--muted-foreground)]">
                  <p className="mb-2">No bookmarks yet.</p>
                  <p className="text-sm">Open a conversation and click the ☆ icon on messages you want to include as evidence.</p>
                </div>
              ) : (
                <div className="divide-y divide-[var(--border)]/50 max-h-[60vh] overflow-y-auto">
                  {Array.from(bookmarksByConv.entries()).map(([convId, convBookmarks]) => (
                    <div key={convId}>
                      <div className="px-4 py-2 bg-[var(--secondary)]/30">
                        <Link href={`/conversations/${convId}`} className="text-xs font-semibold text-[var(--primary)] hover:underline">
                          {convBookmarks[0]?.conversation_title || "Untitled"} ({convBookmarks[0]?.platform})
                        </Link>
                      </div>
                      {convBookmarks.map((b) => (
                        <button key={b.id} onClick={() => toggleBookmark(b.id)}
                          className="w-full text-left px-4 py-2 hover:bg-[var(--secondary)]/20 transition flex items-start gap-3">
                          <span className={`w-4 h-4 mt-0.5 shrink-0 rounded border flex items-center justify-center text-[10px] ${
                            selectedBookmarks.has(b.id) ? "border-amber-500 bg-amber-500 text-white" : "border-[var(--border)]"
                          }`}>
                            {selectedBookmarks.has(b.id) && "✓"}
                          </span>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs text-[var(--muted-foreground)]">
                              {b.sender_name} &middot; {formatTime(b.timestamp)}
                            </p>
                            <p className="text-sm truncate">{b.content || "[media]"}</p>
                            {b.note && <p className="text-xs text-amber-400 mt-0.5">Note: {b.note}</p>}
                          </div>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right: export options */}
        <div className="space-y-4">
          <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
            <h3 className="text-sm font-semibold mb-3">Export Format</h3>
            <div className="grid grid-cols-2 gap-2">
              {([
                { key: "html" as const, label: "HTML", desc: "Formatted, printable" },
                { key: "txt" as const, label: "Plain Text", desc: "Simple text file" },
                { key: "csv" as const, label: "CSV", desc: "Spreadsheet format" },
                { key: "pdf" as const, label: "PDF", desc: "Coming soon", disabled: true },
              ]).map((f) => (
                <button key={f.key} onClick={() => !f.disabled && setExportFormat(f.key)}
                  disabled={f.disabled}
                  className={`text-left px-3 py-2 rounded border text-sm transition ${
                    exportFormat === f.key
                      ? "border-[var(--primary)] bg-[var(--primary)]/10"
                      : f.disabled
                        ? "border-[var(--border)] opacity-40 cursor-not-allowed"
                        : "border-[var(--border)] hover:border-[var(--primary)]/50"
                  }`}>
                  <div className="font-medium text-xs">{f.label}</div>
                  <div className="text-[10px] text-[var(--muted-foreground)]">{f.desc}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
            <h3 className="text-sm font-semibold mb-3">Options</h3>
            <div className="space-y-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={includeProvenance} onChange={(e) => setIncludeProvenance(e.target.checked)}
                  className="rounded" />
                <span className="text-sm">Include provenance footer</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={includeTimestamps} onChange={(e) => setIncludeTimestamps(e.target.checked)}
                  className="rounded" />
                <span className="text-sm">Include timestamps</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={includeMedia} onChange={(e) => setIncludeMedia(e.target.checked)}
                  className="rounded" />
                <span className="text-sm">Include media references</span>
              </label>
              <p className="text-[10px] text-[var(--muted-foreground)] pl-6 -mt-1">
                Lists attached photo/video/file names inline.
              </p>
              {exportFormat === "html" && (
                <>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={embedMedia} onChange={(e) => setEmbedMedia(e.target.checked)}
                      className="rounded" />
                    <span className="text-sm">Bundle actual media files (ZIP)</span>
                  </label>
                  <p className="text-[10px] text-[var(--muted-foreground)] pl-6 -mt-1">
                    HTML only. Downloads a ZIP with the exhibit + a media/ folder of the real photos/videos. Works for folder-imported sources; browser-uploaded sources only have references.
                  </p>
                </>
              )}
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={includeBatesNumbers} onChange={(e) => setIncludeBatesNumbers(e.target.checked)}
                  className="rounded" />
                <span className="text-sm">Bates numbering</span>
              </label>
              {includeBatesNumbers && (
                <div className="flex gap-2 pl-6">
                  <input type="text" value={batesPrefix} onChange={(e) => setBatesPrefix(e.target.value)}
                    placeholder="Prefix" className="w-16 px-2 py-1 rounded border border-[var(--border)] bg-[var(--background)] text-sm" />
                  <input type="number" value={batesStart} onChange={(e) => setBatesStart(parseInt(e.target.value) || 1)}
                    placeholder="Start" className="w-20 px-2 py-1 rounded border border-[var(--border)] bg-[var(--background)] text-sm" />
                  <span className="text-xs text-[var(--muted-foreground)] self-center">
                    e.g. {batesPrefix}-{batesStart.toString().padStart(4, "0")}
                  </span>
                </div>
              )}
            </div>
          </div>

          <button
            onClick={handleExport}
            disabled={exporting || (tab === "conversations" && selectedConvs.size === 0)}
            className="w-full px-6 py-3 rounded-lg bg-[var(--primary)] text-white font-semibold hover:opacity-90 transition disabled:opacity-50"
          >
            {exporting ? "Exporting..." : `Export ${tab === "bookmarks" ? "Bookmarks" : `${selectedConvs.size} Conversation${selectedConvs.size !== 1 ? "s" : ""}`}`}
          </button>

          <button
            onClick={handlePrint}
            disabled={exporting || (tab === "conversations" && selectedConvs.size === 0)}
            className="w-full px-6 py-2.5 rounded-lg border border-[var(--border)] font-medium hover:bg-[var(--secondary)] transition disabled:opacity-50"
            title="Open a print-formatted view; use your browser's print dialog to print or Save as PDF"
          >
            🖨️ Print / Save as PDF
          </button>

          <p className="text-[10px] text-[var(--muted-foreground)] text-center">
            Exported files include &quot;Extracted using CourtThread&trade;&quot; provenance footer.
            Print uses your browser&apos;s dialog (choose &quot;Save as PDF&quot; as the destination).
          </p>
        </div>
      </div>
    </div>
  );
}

export default function ExportPage() {
  return (
    <Suspense fallback={<div className="animate-pulse"><h1 className="text-3xl font-bold mb-2">Export</h1><p className="text-[var(--muted-foreground)]">Loading...</p></div>}>
      <ExportPageInner />
    </Suspense>
  );
}
