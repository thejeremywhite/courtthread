"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

interface DashboardData {
  conversations: number;
  messages: number;
  participants: number;
  sources: number;
  bookmarks: number;
  recentConversations: Array<{
    id: string;
    title: string | null;
    platform: string;
    message_count: number;
    participant_names: string | null;
    last_message_at: string | null;
  }>;
  recentSources: Array<{
    id: string;
    filename: string;
    file_type: string;
    imported_at: string;
    message_count: number;
  }>;
}

function formatDate(iso: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);

  useEffect(() => {
    fetch("/api/dashboard").then((r) => r.json()).then(setData).catch(() => {});
  }, []);

  if (!data) {
    return (
      <div className="animate-pulse">
        <h1 className="text-3xl font-bold mb-2">CourtThread</h1>
        <p className="text-[var(--muted-foreground)]">Loading...</p>
      </div>
    );
  }

  const stats = [
    { label: "Conversations", value: data.conversations, href: "/conversations", color: "text-blue-400" },
    { label: "Messages", value: data.messages, href: "/search", color: "text-green-400" },
    { label: "Participants", value: data.participants, href: "/conversations", color: "text-purple-400" },
    { label: "Sources", value: data.sources, href: "/import", color: "text-cyan-400" },
    { label: "Bookmarks", value: data.bookmarks, href: "/export", color: "text-amber-400" },
  ];

  return (
    <div>
      <h1 className="text-3xl font-bold mb-1">CourtThread</h1>
      <p className="text-[var(--muted-foreground)] mb-6">Message thread viewer for court evidence</p>

      {/* Stats — all clickable */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-8">
        {stats.map((s) => (
          <Link key={s.label} href={s.href}
            className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 hover:border-[var(--primary)]/50 transition group">
            <p className="text-xs text-[var(--muted-foreground)] group-hover:text-[var(--foreground)] transition">{s.label}</p>
            <p className={`text-2xl font-bold mt-1 ${s.color}`}>{s.value.toLocaleString()}</p>
          </Link>
        ))}
      </div>

      {data.messages === 0 ? (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-8 text-center">
          <h2 className="text-xl font-semibold mb-2">Get Started</h2>
          <p className="text-[var(--muted-foreground)] mb-4">
            Import your message files to begin searching and formatting threads for court use.
          </p>
          <Link href="/import"
            className="inline-block px-6 py-2 rounded-lg bg-[var(--primary)] text-white font-medium hover:opacity-90 transition">
            Import Files
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Recent conversations */}
          <div className="rounded-lg border border-[var(--border)] bg-[var(--card)]">
            <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between">
              <h2 className="text-sm font-semibold">Recent Conversations</h2>
              <Link href="/conversations" className="text-xs text-[var(--primary)] hover:underline">View all</Link>
            </div>
            <div className="divide-y divide-[var(--border)]/50">
              {data.recentConversations.map((conv) => (
                <Link key={conv.id} href={`/conversations/${conv.id}`}
                  className="block px-4 py-3 hover:bg-[var(--secondary)]/30 transition">
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-sm font-medium truncate">{conv.title || conv.participant_names || "Untitled"}</span>
                    <span className="text-[10px] text-[var(--muted-foreground)] shrink-0 ml-2">
                      {conv.message_count.toLocaleString()} msgs
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                      conv.platform === "facebook" ? "bg-blue-500/20 text-blue-400" :
                      conv.platform === "sms" ? "bg-green-500/20 text-green-400" :
                      "bg-[var(--secondary)]"
                    }`}>{conv.platform}</span>
                    {conv.participant_names && <span className="truncate">{conv.participant_names}</span>}
                    {conv.last_message_at && <span className="shrink-0">{formatDate(conv.last_message_at)}</span>}
                  </div>
                </Link>
              ))}
            </div>
          </div>

          {/* Recent sources */}
          <div className="rounded-lg border border-[var(--border)] bg-[var(--card)]">
            <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between">
              <h2 className="text-sm font-semibold">Imported Sources</h2>
              <Link href="/import" className="text-xs text-[var(--primary)] hover:underline">Import more</Link>
            </div>
            <div className="divide-y divide-[var(--border)]/50">
              {data.recentSources.map((src) => (
                <div key={src.id} className="px-4 py-3">
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-sm font-medium truncate">{src.filename}</span>
                    <span className="text-[10px] text-[var(--muted-foreground)] shrink-0 ml-2">
                      {src.message_count.toLocaleString()} msgs
                    </span>
                  </div>
                  <div className="text-xs text-[var(--muted-foreground)]">
                    {src.file_type} &middot; {formatDate(src.imported_at)}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Quick actions */}
          <div className="lg:col-span-2 grid grid-cols-2 md:grid-cols-4 gap-3">
            <Link href="/search" className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 hover:border-[var(--primary)]/50 transition text-center">
              <p className="text-2xl mb-1">🔍</p>
              <p className="text-sm font-medium">Search Messages</p>
            </Link>
            <Link href="/import" className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 hover:border-[var(--primary)]/50 transition text-center">
              <p className="text-2xl mb-1">📥</p>
              <p className="text-sm font-medium">Import Files</p>
            </Link>
            <Link href="/export" className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 hover:border-[var(--primary)]/50 transition text-center">
              <p className="text-2xl mb-1">📤</p>
              <p className="text-sm font-medium">Export Evidence</p>
            </Link>
            <Link href="/export?tab=bookmarks" className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 hover:border-[var(--primary)]/50 transition text-center">
              <p className="text-2xl mb-1">⭐</p>
              <p className="text-sm font-medium">{data.bookmarks} Bookmarks</p>
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
