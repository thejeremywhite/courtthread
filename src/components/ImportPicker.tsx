"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cleanSourceName } from "@/lib/sourceName";

export interface ImportPickerSource {
  id: string;
  filename: string;
  message_count?: number;
  // Comma-separated participant display names across the import's conversations
  // (served by /api/sources). Lets a search for a person find their groups too.
  participant_names?: string;
}

interface ImportPickerProps {
  sources: ImportPickerSource[];
  selected: Set<string>;
  onChange: (ids: Set<string>) => void;
  multi?: boolean; // false = picking one import (radio behavior), true = checkboxes
  placeholder?: string; // button text when nothing is selected
  label?: string; // full override for the button text (e.g. with message counts)
}

// Case-insensitive token match against the import's name AND its participants:
// every typed word must appear somewhere in "<filename> <participants>".
function matches(s: ImportPickerSource, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${cleanSourceName(s.filename)} ${s.filename} ${s.participant_names || ""}`.toLowerCase();
  return q.split(/\s+/).every((tok) => hay.includes(tok));
}

// Participants that matched the query — shown under the import name so it's clear
// WHY a group chat surfaced for a person search.
function matchedParticipants(s: ImportPickerSource, query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q || !s.participant_names) return [];
  const toks = q.split(/\s+/);
  return s.participant_names
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n && toks.some((t) => n.toLowerCase().includes(t)))
    .slice(0, 3);
}

export function ImportPicker({ sources, selected, onChange, multi = true, placeholder = "Imports", label }: ImportPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // null = original (API) order; "desc"/"asc" = sorted by message count.
  const [sortBySize, setSortBySize] = useState<"desc" | "asc" | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  const filtered = useMemo(() => {
    const list = sources.filter((s) => matches(s, query));
    if (sortBySize) {
      list.sort((a, b) => {
        const diff = (b.message_count || 0) - (a.message_count || 0);
        return sortBySize === "desc" ? diff : -diff;
      });
    }
    return list;
  }, [sources, query, sortBySize]);

  function toggle(id: string) {
    if (multi) {
      const next = new Set(selected);
      if (next.has(id)) next.delete(id); else next.add(id);
      onChange(next);
    } else {
      onChange(selected.has(id) ? new Set() : new Set([id]));
      setOpen(false);
    }
  }

  const buttonText = label ?? (selected.size === 0
    ? placeholder
    : selected.size === 1
      ? cleanSourceName(sources.find((s) => selected.has(s.id))?.filename || "1 import")
      : `${selected.size} imports`);

  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={() => setOpen(!open)}
        className={`px-3 py-2 rounded-lg border text-sm transition min-w-[160px] max-w-[240px] text-left truncate ${
          selected.size > 0
            ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary)]"
            : "border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--primary)]/50"
        }`}
      >
        {buttonText}
        <span className="ml-2 opacity-60">▾</span>
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-96 rounded-lg border border-[var(--border)] bg-[var(--card)] shadow-lg p-2">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search imports or people…"
            className="w-full mb-2 px-3 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--background)] text-sm"
          />
          {multi && (
            <div className="flex items-center gap-2 mb-2 px-1">
              <button onClick={() => onChange(new Set([...selected, ...filtered.map((s) => s.id)]))}
                className="text-xs text-[var(--primary)] hover:underline">
                Select all{query ? " matching" : ""}
              </button>
              <button onClick={() => onChange(new Set())}
                className="text-xs text-[var(--destructive)] hover:underline">Deselect all</button>
              <button
                onClick={() => setSortBySize((prev) => (prev === "desc" ? "asc" : "desc"))}
                title="Sort by number of messages"
                className={`ml-auto text-xs flex items-center gap-0.5 hover:underline ${sortBySize ? "text-[var(--primary)]" : "text-[var(--muted-foreground)]"}`}
              >
                Sort {sortBySize === "asc" ? "↑" : sortBySize === "desc" ? "↓" : "↕"}
              </button>
            </div>
          )}
          <div className="max-h-64 overflow-y-auto">
            {filtered.length === 0 && (
              <div className="px-2 py-3 text-sm text-[var(--muted-foreground)]">No imports match “{query}”.</div>
            )}
            {filtered.map((s) => {
              const hits = matchedParticipants(s, query);
              return (
                <label key={s.id} className="flex items-start gap-2 px-2 py-1.5 rounded hover:bg-[var(--secondary)] cursor-pointer text-sm">
                  <input
                    type={multi ? "checkbox" : "radio"}
                    checked={selected.has(s.id)}
                    onChange={() => toggle(s.id)}
                    className="rounded mt-0.5"
                  />
                  <span className="flex-1 min-w-0">
                    <span className="block truncate">{cleanSourceName(s.filename)}</span>
                    {hits.length > 0 && (
                      <span className="block truncate text-xs text-[var(--primary)]">
                        {hits.join(", ")}
                      </span>
                    )}
                  </span>
                  {typeof s.message_count === "number" && (
                    <span className="text-xs text-[var(--muted-foreground)] shrink-0">{s.message_count} msgs</span>
                  )}
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
