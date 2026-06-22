"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { useParams, useSearchParams, useRouter, usePathname } from "next/navigation";
import { MessageThread } from "./MessageThread";
import { DateTimePicker } from "@/components/DateTimePicker";

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

  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [totalMessages, setTotalMessages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<"forward" | "backward">("forward");
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
    if (filterSender) params.set("sender", filterSender);
    if (filterDateFrom) params.set("dateFrom", filterDateFrom);
    if (filterDateTo) params.set("dateTo", filterDateTo);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [filterSender, filterDateFrom, filterDateTo, highlightMessageId, highlightTerm, pathname]);

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

  const loadMessages = useCallback(async (cursor?: string, direction?: "forward" | "backward", anchorId?: string) => {
    const dir = direction || sortDirection;
    if (cursor) setLoadingMore(true); else setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "200", direction: dir });
      if (cursor) params.set("cursor", cursor);
      else if (anchorId) params.set("anchor", anchorId);
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
    // If we arrived targeting a specific message and no filter is active, jump to it.
    const useAnchor = highlightMessageId && !filterSender && !filterDateFrom && !filterDateTo;
    loadMessages(undefined, sortDirection, useAnchor ? highlightMessageId : undefined);
  }, [sortDirection, filterSender, filterDateFrom, filterDateTo, highlightMessageId]);

  useEffect(() => {
    if (!scrolledToHighlight && highlightMessageId && messages.length > 0) {
      const found = messages.find(m => m.id === highlightMessageId);
      if (found) {
        setTimeout(() => {
          highlightRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
          setScrolledToHighlight(true);
        }, 100);
      }
    }
  }, [messages, highlightMessageId, scrolledToHighlight]);

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
    setSortDirection(prev => prev === "forward" ? "backward" : "forward");
  }

  const filteredMessages = messages;

  const bookmarkCount = bookmarkedIds.size;

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
        <Link href="/conversations" className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition">
          &larr; Back
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold truncate">{conversation?.title || "Untitled"}</h1>
          <p className="text-sm text-[var(--muted-foreground)]">
            {conversation?.participant_names} &middot; {totalMessages.toLocaleString()} messages &middot; {conversation?.platform}
            {bookmarkCount > 0 && (
              <span className="text-amber-400 ml-2">★ {bookmarkCount} bookmarked</span>
            )}
          </p>
        </div>
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
        <Link href={`/export?conversationId=${id}${filterSender ? `&sender=${encodeURIComponent(filterSender)}` : ""}${filterDateFrom ? `&dateFrom=${encodeURIComponent(filterDateFrom)}` : ""}${filterDateTo ? `&dateTo=${encodeURIComponent(filterDateTo)}` : ""}`}
          className="px-3 py-1.5 rounded-lg border border-[var(--border)] text-sm text-[var(--muted-foreground)] hover:border-[var(--primary)]/50 transition">
          Export{filterSender || filterDateFrom || filterDateTo ? ` (${totalMessages.toLocaleString()} filtered)` : ""}
        </Link>
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

      <MessageThread
        messages={filteredMessages}
        platform={conversation?.platform || "facebook"}
        sourceId={conversation?.source_id || ""}
        bookmarkedIds={bookmarkedIds}
        onToggleBookmark={handleToggleBookmark}
        highlightText={highlightTerm}
        highlightMessageId={highlightMessageId}
        highlightRef={highlightRef}
      />

      <div ref={observerRef} className="h-10 flex items-center justify-center mt-2">
        {loadingMore && <span className="text-sm text-[var(--muted-foreground)]">Loading more messages...</span>}
        {!hasMore && messages.length > 0 && (
          <span className="text-xs text-[var(--muted-foreground)]">End of conversation</span>
        )}
      </div>
    </div>
  );
}
