"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { useParams, useSearchParams, useRouter, usePathname } from "next/navigation";
import { MessageThread, ThreadViewport, ViewModeToggle, useViewMode, useThemeMode, getThemeVars, type ViewMode, type ThemeMode } from "./MessageThread";
import { DateTimePicker } from "@/components/DateTimePicker";

type ExportFormat = "print" | "html" | "html-zip" | "mhtml" | "html-original" | "csv" | "txt";

function ConvExportDropdown({ onAction, disabled }: { onAction: (format: ExportFormat) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [goUp, setGoUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  const handleToggle = () => {
    if (!open && ref.current) {
      const rect = ref.current.getBoundingClientRect();
      setGoUp(window.innerHeight - rect.bottom < 280);
    }
    setOpen(!open);
  };
  return (
    <div className="relative inline-block" ref={ref}>
      <button onClick={handleToggle} disabled={disabled}
        className="px-3 py-1.5 rounded-lg border border-[var(--border)] text-sm text-[var(--muted-foreground)] hover:border-[var(--primary)]/50 transition disabled:opacity-50">
        {disabled ? "Exporting..." : "Export"} <span className="text-[10px]">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className={`absolute right-0 ${goUp ? 'bottom-full mb-1' : 'top-full mt-1'} w-56 rounded-lg border border-[var(--border)] bg-[var(--card)] shadow-xl z-40 py-1`}>
          <button onClick={() => { onAction("print"); setOpen(false); }}
            className="w-full text-left px-3 py-2 text-sm hover:bg-[var(--secondary)]/50 transition">
            Print / Save as PDF
          </button>
          <div className="border-t border-[var(--border)] my-1" />
          <p className="px-3 py-1 text-[10px] uppercase tracking-wider text-[var(--muted-foreground)]">Download as</p>
          <button onClick={() => { onAction("html"); setOpen(false); }}
            className="w-full text-left px-3 py-2 text-sm hover:bg-[var(--secondary)]/50 transition">
            HTML (standalone, media embedded)
          </button>
          <button onClick={() => { onAction("html-zip"); setOpen(false); }}
            className="w-full text-left px-3 py-2 text-sm hover:bg-[var(--secondary)]/50 transition">
            HTML + Media folder (ZIP)
          </button>
          <button onClick={() => { onAction("mhtml"); setOpen(false); }}
            className="w-full text-left px-3 py-2 text-sm hover:bg-[var(--secondary)]/50 transition">
            MHTML (single file)
          </button>
          <button onClick={() => { onAction("html-original"); setOpen(false); }}
            className="w-full text-left px-3 py-2 text-sm hover:bg-[var(--secondary)]/50 transition">
            HTML (original source format)
          </button>
          <div className="border-t border-[var(--border)] my-1" />
          <button onClick={() => { onAction("csv"); setOpen(false); }}
            className="w-full text-left px-3 py-2 text-sm hover:bg-[var(--secondary)]/50 transition">
            CSV (spreadsheet)
          </button>
          <button onClick={() => { onAction("txt"); setOpen(false); }}
            className="w-full text-left px-3 py-2 text-sm hover:bg-[var(--secondary)]/50 transition">
            Plain Text
          </button>
        </div>
      )}
    </div>
  );
}

interface Conversation {
  id: string;
  title: string | null;
  platform: string;
  source_id: string;
  message_count: number;
  first_message_at: string | null;
  last_message_at: string | null;
  participant_names: string | null;
}

interface Message {
  id: string;
  sender_name: string;
  content: string | null;
  timestamp: string;
  message_type: string;
  is_incoming: number;
  platform: string;
  source_id: string;
  metadata: string | null;
}

export default function ConversationPage() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const highlightMessageId = searchParams.get("messageId") || "";
  const highlightTerm = searchParams.get("q") || "";
  // Set when arriving from a date/filter-scoped search result (no single message to anchor
  // on) — outlines the whole matched range instead of one message, and anchors the initial
  // load to its start, WITHOUT truncating the thread the way filterDateFrom/To do.
  const highlightFrom = searchParams.get("highlightFrom") || "";
  const highlightTo = searchParams.get("highlightTo") || "";

  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [totalMessages, setTotalMessages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<"forward" | "backward">("forward");

  useEffect(() => {
    try { const v = localStorage.getItem("courtthread_conv_sort") as "forward" | "backward"; if (v) setSortDirection(v); } catch {}
  }, []);
  const observerRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const [scrolledToHighlight, setScrolledToHighlight] = useState(false);

  // Filters — initialized from URL so back-button restores them
  const [filterSender, setFilterSender] = useState(searchParams.get("sender") || "");
  const [filterDateFrom, setFilterDateFrom] = useState(searchParams.get("dateFrom") || "");
  const [filterDateTo, setFilterDateTo] = useState(searchParams.get("dateTo") || "");
  const [showFilters, setShowFilters] = useState(
    !!(searchParams.get("sender") || searchParams.get("dateFrom") || searchParams.get("dateTo"))
  );
  const [bookmarkedIds, setBookmarkedIds] = useState<Set<string>>(new Set());
  const [participants, setParticipants] = useState<string[]>([]);

  // Sync filter state to the URL so navigating away and back (browser back) restores it
  useEffect(() => {
    const params = new URLSearchParams();
    if (highlightMessageId) params.set("messageId", highlightMessageId);
    if (highlightTerm) params.set("q", highlightTerm);
    if (highlightFrom) params.set("highlightFrom", highlightFrom);
    if (highlightTo) params.set("highlightTo", highlightTo);
    if (filterSender) params.set("sender", filterSender);
    if (filterDateFrom) params.set("dateFrom", filterDateFrom);
    if (filterDateTo) params.set("dateTo", filterDateTo);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [filterSender, filterDateFrom, filterDateTo, highlightMessageId, highlightTerm, highlightFrom, highlightTo, pathname]);

  useEffect(() => {
    fetch(`/api/conversations/${id}`)
      .then((r) => r.json())
      .then((d) => {
        setConversation(d.conversation || d);
        if (d.participants) setParticipants(d.participants);
      })
      .catch(() => {});
    fetch(`/api/bookmarks?conversationId=${id}`)
      .then((r) => r.json())
      .then((d) => {
        const ids = new Set<string>();
        for (const b of d.bookmarks || []) ids.add(b.message_id);
        setBookmarkedIds(ids);
      })
      .catch(() => {});
  }, [id]);

  const loadMessages = useCallback(async (cursor?: string, direction?: "forward" | "backward", anchorId?: string, anchorTime?: string) => {
    const dir = direction || sortDirection;
    if (cursor) setLoadingMore(true); else setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "200", direction: dir });
      if (cursor) params.set("cursor", cursor);
      else if (anchorId) params.set("anchor", anchorId);
      else if (anchorTime) params.set("anchorTime", anchorTime);
      if (filterSender) params.set("sender", filterSender);
      if (filterDateFrom) params.set("dateFrom", filterDateFrom);
      if (filterDateTo) params.set("dateTo", filterDateTo);
      const res = await fetch(`/api/conversations/${id}/messages?${params}`);
      const data = await res.json();
      if (res.ok) {
        setMessages((prev) => cursor ? [...prev, ...data.messages] : data.messages);
        setTotalMessages(data.total);
        setHasMore(data.hasMore);
        setNextCursor(data.nextCursor);
      }
    } catch { /* ignore */ }
    setLoading(false);
    setLoadingMore(false);
  }, [id, sortDirection, filterSender, filterDateFrom, filterDateTo]);

  useEffect(() => {
    setMessages([]);
    setNextCursor(null);
    setScrolledToHighlight(false);
    // If we arrived targeting a specific message, or a date-range from a filtered search
    // result, and no truncating filter is active, jump straight there.
    const useAnchor = (highlightMessageId || highlightFrom) && !filterSender && !filterDateFrom && !filterDateTo;
    loadMessages(
      undefined, sortDirection,
      useAnchor && highlightMessageId ? highlightMessageId : undefined,
      useAnchor && !highlightMessageId && highlightFrom ? highlightFrom : undefined
    );
  }, [sortDirection, filterSender, filterDateFrom, filterDateTo, highlightMessageId, highlightFrom]);

  useEffect(() => {
    if (!scrolledToHighlight && (highlightMessageId || highlightFrom) && messages.length > 0) {
      const found = highlightMessageId
        ? messages.find(m => m.id === highlightMessageId)
        : messages.find(m => m.timestamp >= highlightFrom && (!highlightTo || m.timestamp <= highlightTo));
      if (found) {
        setScrolledToHighlight(true);
        const tryScroll = (attempts: number) => {
          requestAnimationFrame(() => {
            if (highlightRef.current) {
              highlightRef.current.scrollIntoView({ behavior: "instant", block: "center" });
              setTimeout(() => {
                if (highlightRef.current) {
                  highlightRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
                }
              }, 300);
            } else if (attempts > 0) {
              setTimeout(() => tryScroll(attempts - 1), 200);
            }
          });
        };
        setTimeout(() => tryScroll(15), 50);
      }
    }
  }, [messages, highlightMessageId, highlightFrom, highlightTo, scrolledToHighlight]);

  // Fires as the media lightbox arrows to a different message — scroll it into view so the
  // thread keeps pace with what's being previewed, instead of requiring "Show in
  // conversation" again. Graceful no-op if that message hasn't been loaded into the DOM yet
  // (e.g. still further down an un-scrolled infinite-load page).
  const scrollToMessage = useCallback((messageId: string) => {
    const el = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && hasMore && !loadingMore && nextCursor) {
        loadMessages(nextCursor);
      }
    }, { threshold: 0.1 });

    if (observerRef.current) observer.observe(observerRef.current);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, nextCursor, loadMessages]);

  async function handleToggleBookmark(messageId: string) {
    try {
      const res = await fetch("/api/bookmarks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId, conversationId: id }),
      });
      const data = await res.json();
      setBookmarkedIds((prev) => {
        const next = new Set(prev);
        if (data.bookmarked) next.add(messageId); else next.delete(messageId);
        return next;
      });
    } catch { /* ignore */ }
  }

  function toggleSort() {
    // Explicitly changing sort direction means "browse the whole conversation from the
    // true start/end now" — drop any message/date-range anchor from a prior "Show in
    // conversation" jump, or the anchored load kept re-centering on that same spot no
    // matter which direction was picked (this was a real, confusing bug: toggling
    // Newest/Oldest first always reopened at the same anchored message).
    if (highlightMessageId || highlightFrom) {
      const params = new URLSearchParams(searchParams.toString());
      params.delete("messageId");
      params.delete("q");
      params.delete("highlightFrom");
      params.delete("highlightTo");
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }
    setSortDirection(prev => {
      const next = prev === "forward" ? "backward" : "forward";
      try { localStorage.setItem("courtthread_conv_sort", next); } catch { /* ignore */ }
      return next;
    });
  }

  const filteredMessages = messages;

  const bookmarkCount = bookmarkedIds.size;
  const [viewMode, setViewMode] = useViewMode();
  const [themeMode, setThemeMode] = useThemeMode();

  const [exporting, setExporting] = useState(false);

  async function handleExportAction(format: ExportFormat) {
    if (format === "print") {
      setExporting(true);
      try {
        const body: Record<string, unknown> = {
          type: "conversations", conversationIds: [id], format: "html",
          inlineMedia: true, embedMedia: false, includeProvenance: true,
          includeTimestamps: true, includeMedia: true, viewMode, theme: themeMode,
        };
        if (filterSender) body.sender = filterSender;
        if (filterDateFrom) body.dateFrom = filterDateFrom;
        if (filterDateTo) body.dateTo = filterDateTo;
        const res = await fetch("/api/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (!res.ok) { alert((await res.json().catch(() => ({}))).error || "Export failed"); return; }
        let html = await res.text();
        html = html.replace(/<head>/i, `<head><base href="${location.origin}/">`);
        const w = window.open(URL.createObjectURL(new Blob([html], { type: "text/html" })), "_blank");
        if (!w) alert("Pop-up blocked — allow pop-ups to print.");
      } catch (e: any) { alert(e.message); }
      finally { setExporting(false); }
      return;
    }

    setExporting(true);
    try {
      const apiFormat = format === "html-zip" ? "html" : format === "mhtml" ? "html" : format === "html-original" ? "html" : format;
      const body: Record<string, unknown> = {
        type: "conversations", conversationIds: [id], format: apiFormat,
        subFormat: format, includeProvenance: true, includeTimestamps: true, includeMedia: true,
        viewMode, theme: themeMode,
        embedMedia: format === "html" || format === "mhtml",
        bundleMedia: format === "html-zip",
      };
      if (filterSender) body.sender = filterSender;
      if (filterDateFrom) body.dateFrom = filterDateFrom;
      if (filterDateTo) body.dateTo = filterDateTo;
      const res = await fetch("/api/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) { alert((await res.json().catch(() => ({}))).error || "Export failed"); return; }
      const blob = await res.blob();
      const ext = format === "csv" ? "csv" : format === "txt" ? "txt" : format === "html-zip" ? "zip" : format === "mhtml" ? "mhtml" : "html";
      const cd = res.headers.get("content-disposition");
      let fileName = cd?.match(/filename="([^"]+)"/)?.[1] || `${(conversation?.title || "Messages").replace(/[^a-zA-Z0-9 _-]/g, "").replace(/\s+/g, "_")}.${ext}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = fileName;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e: any) { alert(e.message); }
    finally { setExporting(false); }
  }

  if (loading) {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-8 text-center text-[var(--muted-foreground)]">
        Loading conversation...
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <button onClick={() => { if (window.history.length <= 1) { window.close(); } else { router.back(); } }} className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition">
          &larr; Back
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold truncate">{conversation?.title || "Untitled"}</h1>
          <p className="text-sm text-[var(--muted-foreground)]">
            {conversation?.participant_names} &middot; {totalMessages.toLocaleString()} messages &middot; {conversation?.platform}
            {bookmarkCount > 0 && (
              <span className="text-amber-400 ml-2">★ {bookmarkCount} bookmarked</span>
            )}
          </p>
        </div>
        <ViewModeToggle mode={viewMode} onChange={setViewMode} theme={themeMode} onThemeChange={setThemeMode} />
        <button
          onClick={toggleSort}
          className="px-3 py-1.5 rounded-lg border border-[var(--border)] text-sm text-[var(--muted-foreground)] hover:border-[var(--primary)]/50 transition"
          title={sortDirection === "forward" ? "Currently: oldest first" : "Currently: newest first"}
        >
          {sortDirection === "forward" ? "Oldest first" : "Newest first"}
        </button>
        <Link href={`/search?conversationId=${id}`}
          className="px-3 py-1.5 rounded-lg border border-[var(--border)] text-sm text-[var(--muted-foreground)] hover:border-[var(--primary)]/50 transition">
          Search
        </Link>
        <Link href={`/media?conversationId=${id}`}
          className="px-3 py-1.5 rounded-lg border border-[var(--border)] text-sm text-[var(--muted-foreground)] hover:border-[var(--primary)]/50 transition">
          Media
        </Link>
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`px-3 py-1.5 rounded-lg border text-sm transition ${
            showFilters || filterSender || filterDateFrom || filterDateTo
              ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary)]"
              : "border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--primary)]/50"
          }`}
        >
          {filterSender || filterDateFrom || filterDateTo ? "Filtered" : "Filter"}
        </button>
        <ConvExportDropdown
          onAction={handleExportAction}
          disabled={exporting}
        />
      </div>

      {/* Filter bar */}
      {showFilters && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3 mb-4">
          <div className="flex flex-wrap gap-3 items-end">
            <div className="w-48">
              <label className="text-[10px] text-[var(--muted-foreground)] uppercase tracking-wider mb-1 block">Sender</label>
              <select value={filterSender} onChange={(e) => setFilterSender(e.target.value)}
                className="w-full px-3 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--background)] text-sm">
                <option value="">All senders</option>
                {participants.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>
            <div className="w-52">
              <DateTimePicker value={filterDateFrom} onChange={setFilterDateFrom} label="From" placeholder="Start date..." />
            </div>
            <div className="w-52">
              <DateTimePicker value={filterDateTo} onChange={setFilterDateTo} label="To" placeholder="End date..." />
            </div>
            {(filterSender || filterDateFrom || filterDateTo) && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-[var(--muted-foreground)]">
                  {totalMessages.toLocaleString()} messages
                </span>
                <button onClick={() => { setFilterSender(""); setFilterDateFrom(""); setFilterDateTo(""); }}
                  className="text-xs text-[var(--destructive)] hover:underline">
                  Clear
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <ThreadViewport theme={themeMode} viewMode={viewMode}>
        <MessageThread
          messages={filteredMessages}
          platform={conversation?.platform || "facebook"}
          sourceId={conversation?.source_id || ""}
          conversationId={id}
          bookmarkedIds={bookmarkedIds}
          onToggleBookmark={handleToggleBookmark}
          highlightText={highlightTerm}
          highlightMessageId={highlightMessageId}
          highlightRange={highlightFrom ? { from: highlightFrom, to: highlightTo || highlightFrom } : undefined}
          highlightRef={highlightRef}
          className="p-4"
          viewMode={viewMode}
          onLightboxNavigate={scrollToMessage}
        />
      </ThreadViewport>

      <div ref={observerRef} className="h-10 flex items-center justify-center mt-2">
        {loadingMore && <span className="text-sm text-[var(--muted-foreground)]">Loading more messages...</span>}
        {!hasMore && messages.length > 0 && (
          <span className="text-xs text-[var(--muted-foreground)]">End of conversation</span>
        )}
      </div>
    </div>
  );
}
