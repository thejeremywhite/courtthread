"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { DateTimePicker } from "@/components/DateTimePicker";
import { ImportPicker } from "@/components/ImportPicker";

interface ConversationRow {
  id: string;
  title: string | null;
  platform: string;
  source_id: string;
  message_count: number;
  first_message_at: string | null;
  last_message_at: string | null;
  participant_names: string | null;
}

interface SourceRow {
  id: string;
  filename: string;
}

const PLATFORM_COLORS: Record<string, string> = {
  facebook: "bg-blue-500 text-white",
  sms: "bg-green-500 text-white",
  call: "bg-amber-600 text-white",
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export default function ConversationsPage() {
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [initialLoad, setInitialLoad] = useState(true);

  const [searchQuery, setSearchQuery] = useState("");
  const [platformFilter, setPlatformFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [sortOrder, setSortOrder] = useState<"newest" | "oldest">("newest");

  useEffect(() => {
    try { const v = localStorage.getItem("courtthread_convlist_sort") as "newest" | "oldest"; if (v) setSortOrder(v); } catch {}
  }, []);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [showDateFilter, setShowDateFilter] = useState(false);
  const [platforms, setPlatforms] = useState<string[]>([]);
  const [sources, setSources] = useState<SourceRow[]>([]);

  const observerRef = useRef<HTMLDivElement>(null);

  const loadConversations = useCallback(async (cursor?: string, append = false) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      if (searchQuery.length >= 2) params.set("q", searchQuery);
      if (platformFilter) params.set("platform", platformFilter);
      if (sourceFilter) params.set("sourceId", sourceFilter);
      params.set("sort", sortOrder);
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);

      const res = await fetch(`/api/conversations?${params}`);
      const data = await res.json();
      if (res.ok) {
        setConversations(prev => append ? [...prev, ...data.conversations] : data.conversations);
        setTotal(data.total);
        setNextCursor(data.nextCursor);
        if (data.platforms) setPlatforms(data.platforms);
      }
    } catch { /* ignore */ }
    setLoading(false);
    setInitialLoad(false);
  }, [searchQuery, platformFilter, sourceFilter, sortOrder, dateFrom, dateTo]);

  useEffect(() => {
    fetch("/api/sources").then(r => r.json()).then(d => setSources(d.sources || [])).catch(() => {});
  }, []);

  useEffect(() => {
    setConversations([]);
    setNextCursor(null);
    loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && nextCursor && !loading) {
        loadConversations(nextCursor, true);
      }
    }, { threshold: 0.1 });

    if (observerRef.current) observer.observe(observerRef.current);
    return () => observer.disconnect();
  }, [nextCursor, loading, loadConversations]);

  function handleSearchChange(value: string) {
    setSearchQuery(value);
  }

  async function handleDeleteConversation(convId: string, label: string) {
    if (!confirm(`Delete the conversation "${label}" and all its messages? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/conversations/${convId}`, { method: "DELETE" });
      if (res.ok) {
        setConversations((prev) => prev.filter((c) => c.id !== convId));
        setTotal((t) => Math.max(0, t - 1));
      }
    } catch { /* ignore */ }
  }

  return (
    <div>
      <h1 className="text-3xl font-bold mb-2">Conversations</h1>
      <p className="text-[var(--muted-foreground)] mb-4">
        {total} conversation{total !== 1 ? "s" : ""}
      </p>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4 items-center">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder="Search by participant name or conversation title..."
          className="flex-1 min-w-[200px] px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--background)] text-sm"
        />
        <select value={platformFilter} onChange={(e) => setPlatformFilter(e.target.value)}
          className="px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--background)] text-sm">
          <option value="">All platforms</option>
          {platforms.map(p => <option key={p} value={p}>{p === "facebook" ? "Facebook" : p === "sms" ? "SMS" : p}</option>)}
        </select>
        <ImportPicker
          sources={sources}
          selected={sourceFilter ? new Set([sourceFilter]) : new Set()}
          onChange={(ids) => setSourceFilter(ids.size ? [...ids][0] : "")}
          multi={false}
          placeholder="All sources"
        />
        <select value={sortOrder} onChange={(e) => { const v = e.target.value as "newest" | "oldest"; setSortOrder(v); try { localStorage.setItem("courtthread_convlist_sort", v); } catch {} }}
          className="px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--background)] text-sm">
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
        <button
          onClick={() => setShowDateFilter(!showDateFilter)}
          className={`px-3 py-2 rounded-lg border text-sm transition ${
            showDateFilter || dateFrom || dateTo
              ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary)]"
              : "border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--primary)]/50"
          }`}
        >
          {dateFrom || dateTo ? "Date filtered" : "Date range"}
        </button>
      </div>

      {showDateFilter && (
        <div className="flex flex-wrap gap-3 items-end mb-4 rounded-lg border border-[var(--border)] bg-[var(--card)] p-3">
          <div className="w-52">
            <DateTimePicker value={dateFrom} onChange={setDateFrom} label="From" placeholder="Start date..." />
          </div>
          <div className="w-52">
            <DateTimePicker value={dateTo} onChange={setDateTo} label="To" placeholder="End date..." />
          </div>
          {(dateFrom || dateTo) && (
            <button onClick={() => { setDateFrom(""); setDateTo(""); }}
              className="text-xs text-[var(--destructive)] hover:underline self-center">
              Clear dates
            </button>
          )}
        </div>
      )}

      {initialLoad ? (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-8 text-center text-[var(--muted-foreground)]">
          Loading...
        </div>
      ) : conversations.length === 0 ? (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-8 text-center text-[var(--muted-foreground)]">
          {searchQuery || platformFilter || sourceFilter || dateFrom || dateTo
            ? "No conversations match your filters."
            : <>No conversations imported yet. Go to <a href="/import" className="text-[var(--primary)] underline">Import</a> to get started.</>}
        </div>
      ) : (
        <div className="space-y-2">
          {conversations.map((conv) => (
            <div key={conv.id} className="group relative rounded-lg border border-[var(--border)] bg-[var(--card)] hover:border-[var(--primary)] transition">
              <Link href={`/conversations/${conv.id}`} className="block p-4">
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0 pr-16">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`px-2 py-0.5 rounded text-xs ${PLATFORM_COLORS[conv.platform] || "bg-gray-500 text-white"}`}>
                        {conv.platform}
                      </span>
                      <h3 className="font-semibold truncate">{conv.title || "Untitled"}</h3>
                    </div>
                    {conv.participant_names && (
                      <p className="text-sm text-[var(--muted-foreground)] truncate">{conv.participant_names}</p>
                    )}
                  </div>
                  <div className="text-right text-sm shrink-0 ml-4">
                    <p className="font-medium">{(conv.message_count || 0).toLocaleString()} msgs</p>
                    <p className="text-[var(--muted-foreground)] text-xs">
                      {formatDate(conv.first_message_at)} — {formatDate(conv.last_message_at)}
                    </p>
                  </div>
                </div>
              </Link>
              <button
                onClick={() => handleDeleteConversation(conv.id, conv.title || conv.participant_names || "Untitled")}
                className="absolute top-2 right-2 text-xs text-[var(--destructive)] opacity-0 group-hover:opacity-100 transition hover:underline px-2 py-1"
                title="Delete this conversation">
                Delete
              </button>
            </div>
          ))}

          <div ref={observerRef} className="h-10 flex items-center justify-center">
            {loading && <span className="text-sm text-[var(--muted-foreground)]">Loading more...</span>}
          </div>
        </div>
      )}
    </div>
  );
}
