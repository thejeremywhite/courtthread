"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";

interface Bookmark {
  id: string;
  message_id: string;
  conversation_id: string;
  note: string | null;
  content: string | null;
  timestamp: string;
  is_incoming: number;
  sender_name: string;
  conversation_title: string;
  platform: string;
}

interface ContextMsg {
  id: string;
  content: string | null;
  sender_name: string;
  timestamp: string;
}

const PLATFORM_COLORS: Record<string, string> = {
  facebook: "bg-blue-500/20 text-blue-400",
  sms: "bg-green-500/20 text-green-400",
  call: "bg-amber-500/20 text-amber-400",
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
  });
}

export default function BookmarksPage() {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Record<string, ContextMsg[] | "loading">>({});

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/bookmarks")
      .then((r) => r.json())
      .then((d) => setBookmarks(d.bookmarks || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function removeBookmark(b: Bookmark) {
    try {
      await fetch("/api/bookmarks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId: b.message_id, conversationId: b.conversation_id }),
      });
      setBookmarks((prev) => prev.filter((x) => x.message_id !== b.message_id));
    } catch { /* ignore */ }
  }

  async function toggleContext(b: Bookmark) {
    if (expanded[b.id]) {
      setExpanded((prev) => { const n = { ...prev }; delete n[b.id]; return n; });
      return;
    }
    setExpanded((prev) => ({ ...prev, [b.id]: "loading" }));
    try {
      const res = await fetch(`/api/conversations/${b.conversation_id}/messages?anchor=${b.message_id}&limit=6`);
      const data = await res.json();
      setExpanded((prev) => ({ ...prev, [b.id]: data.messages || [] }));
    } catch {
      setExpanded((prev) => ({ ...prev, [b.id]: [] }));
    }
  }

  const filtered = bookmarks.filter((b) => {
    if (!filter.trim()) return true;
    const q = filter.toLowerCase();
    return (b.content || "").toLowerCase().includes(q)
      || (b.sender_name || "").toLowerCase().includes(q)
      || (b.conversation_title || "").toLowerCase().includes(q);
  });

  // Group by conversation
  const groups = new Map<string, Bookmark[]>();
  for (const b of filtered) {
    const arr = groups.get(b.conversation_id) || [];
    arr.push(b);
    groups.set(b.conversation_id, arr);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-3xl font-bold">Bookmarks</h1>
        {bookmarks.length > 0 && (
          <Link href="/export?tab=bookmarks"
            className="px-3 py-1.5 rounded-lg bg-[var(--primary)] text-white text-sm font-medium hover:opacity-90 transition">
            Export bookmarks
          </Link>
        )}
      </div>
      <p className="text-[var(--muted-foreground)] mb-4">
        {bookmarks.length} bookmarked message{bookmarks.length !== 1 ? "s" : ""} for evidence
      </p>

      {bookmarks.length > 0 && (
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter bookmarks by text, sender, or conversation..."
          className="w-full px-4 py-2 mb-5 rounded-lg border border-[var(--border)] bg-[var(--background)] text-sm"
        />
      )}

      {loading ? (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-8 text-center text-[var(--muted-foreground)]">
          Loading bookmarks...
        </div>
      ) : bookmarks.length === 0 ? (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-8 text-center">
          <p className="text-4xl mb-2">⭐</p>
          <p className="font-medium mb-1">No bookmarks yet</p>
          <p className="text-sm text-[var(--muted-foreground)]">
            Open a conversation or search, then click the ☆ Bookmark button on any message to flag it as evidence.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-8 text-center text-[var(--muted-foreground)]">
          No bookmarks match &quot;{filter}&quot;.
        </div>
      ) : (
        <div className="space-y-5">
          {Array.from(groups.entries()).map(([convId, items]) => (
            <div key={convId} className="rounded-lg border border-[var(--border)] bg-[var(--card)] overflow-hidden">
              <div className="px-4 py-2 border-b border-[var(--border)] bg-[var(--secondary)]/30 flex items-center gap-2">
                <span className={`px-2 py-0.5 rounded text-xs ${PLATFORM_COLORS[items[0].platform] || "bg-[var(--secondary)]"}`}>
                  {items[0].platform}
                </span>
                <Link href={`/conversations/${convId}`} target="_blank" rel="noopener noreferrer"
                  className="text-sm font-semibold text-[var(--primary)] hover:underline">
                  {items[0].conversation_title || "Untitled"}
                </Link>
                <span className="text-xs text-[var(--muted-foreground)]">({items.length})</span>
              </div>
              <div className="divide-y divide-[var(--border)]/50">
                {items.map((b) => {
                  const ctx = expanded[b.id];
                  return (
                    <div key={b.id} className="px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-xs text-[var(--muted-foreground)] mb-0.5">
                            {b.sender_name} &middot; {formatTime(b.timestamp)}
                          </p>
                          <p className="text-sm whitespace-pre-wrap break-words">{b.content || "[media]"}</p>
                          {b.note && <p className="text-xs text-amber-400 mt-1">Note: {b.note}</p>}
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0 text-xs">
                          <button onClick={() => toggleContext(b)} className="text-[var(--primary)] hover:underline">
                            {ctx ? "Hide context" : "Show context"}
                          </button>
                          <a href={`/conversations/${b.conversation_id}?messageId=${b.message_id}`}
                            target="_blank" rel="noopener noreferrer"
                            className="text-[var(--primary)] hover:underline">
                            In conversation
                          </a>
                          <button onClick={() => removeBookmark(b)} className="text-[var(--destructive)] hover:underline">
                            Remove
                          </button>
                        </div>
                      </div>

                      {ctx === "loading" && (
                        <p className="text-xs text-[var(--muted-foreground)] mt-2">Loading context...</p>
                      )}
                      {Array.isArray(ctx) && ctx.length > 0 && (
                        <div className="mt-2 pl-3 border-l-2 border-[var(--border)] space-y-1">
                          {ctx.map((c) => {
                            const isMatch = c.id === b.message_id;
                            return (
                              <div key={c.id} className={`text-sm px-2 py-1 rounded ${isMatch ? "bg-amber-400/10 border border-amber-400/30" : "opacity-70"}`}>
                                <span className="text-xs font-medium text-[var(--muted-foreground)]">{c.sender_name}</span>
                                <span className="text-xs text-[var(--muted-foreground)] ml-2">{formatTime(c.timestamp)}</span>
                                <p>{c.content || "[media]"}</p>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
