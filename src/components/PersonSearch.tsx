"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface PersonSuggestion {
  id: string;
  display_name: string;
  phone_number: string | null;
  is_owner: number;
  platforms: string[];
  conversations: Array<{ id: string; title: string; platform: string }>;
}

interface PersonSearchProps {
  placeholder: string;
  // Narrows suggestions to people within this import / conversation. Omit both to
  // search every participant in the database.
  sourceId?: string;
  conversationId?: string;
  // Suggestions already selected elsewhere (e.g. the OTHER box's picks) are hidden so
  // the same person can't be added to both include and exclude at once.
  excludeIds?: Set<string>;
  onSelect: (person: PersonSuggestion) => void;
  className?: string;
}

// Shared typeahead: type a few letters of a name (or phone number), pick from a dropdown
// of matching participants. Used for both "include" and "exclude" person filters on
// Search, Media, and Conversations — same suggestion mechanism as the Search page's
// original person box, now reusable everywhere.
export function PersonSearch({ placeholder, sourceId, conversationId, excludeIds, onSelect, className }: PersonSearchProps) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<PersonSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const search = useCallback(async (q: string) => {
    // A conversation-scoped list is small — show it as soon as the box is focused, even
    // before typing. An import-wide or unscoped search still requires a few characters
    // to avoid dumping every participant in the database.
    const minLen = conversationId ? 0 : 3;
    if (q.length < minLen) { setSuggestions([]); return; }
    try {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (conversationId) params.set("conversationId", conversationId);
      else if (sourceId) params.set("sourceId", sourceId);
      const res = await fetch(`/api/participants?${params}`);
      const data = await res.json();
      const list: PersonSuggestion[] = (data.participants || []).filter(
        (p: PersonSuggestion) => !excludeIds?.has(p.id)
      );
      setSuggestions(list);
      setOpen(true);
    } catch { /* ignore */ }
  }, [sourceId, conversationId, excludeIds]);

  useEffect(() => {
    const t = setTimeout(() => search(query), 200);
    return () => clearTimeout(t);
  }, [query, search]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  return (
    <div className={`relative ${className || ""}`} ref={rootRef}>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => { if (suggestions.length > 0 || conversationId) search(query); }}
        placeholder={placeholder}
        className="w-full px-3 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--background)] text-sm"
      />
      {open && suggestions.length > 0 && (
        <div className="absolute z-40 top-full left-0 mt-1 w-64 max-h-72 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--card)] shadow-xl">
          {suggestions.map((p) => (
            <button
              key={p.id}
              onClick={() => { onSelect(p); setQuery(""); setSuggestions([]); setOpen(false); }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-[var(--secondary)]/50 transition"
            >
              <span className="block truncate">{p.display_name}</span>
              <span className="block text-[10px] text-[var(--muted-foreground)] truncate">
                {p.conversations.length} conversation{p.conversations.length !== 1 ? "s" : ""}
                {p.phone_number ? ` · ${p.phone_number}` : ""}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Small removable chip for a selected include/exclude person — consistent look across
// the three pages that use PersonSearch. Labeled explicitly (not just colored) so it's
// unambiguous at a glance which it is.
export function PersonChip({ person, onRemove, tone = "primary", label }: {
  person: PersonSuggestion;
  onRemove: () => void;
  tone?: "primary" | "destructive";
  label?: string; // overrides the default Include/Exclude prefix (e.g. "Sent by")
}) {
  const toneClass = tone === "destructive"
    ? "bg-red-500/10 text-red-400 border-red-500/30"
    : "bg-[var(--primary)]/10 text-[var(--primary)] border-[var(--primary)]/30";
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs border ${toneClass}`}>
      <span className="font-semibold uppercase tracking-wide text-[10px] opacity-80">
        {label ?? (tone === "destructive" ? "Exclude" : "Include")}
      </span>
      {person.display_name}
      <button onClick={onRemove} className="hover:opacity-70" title="Remove">×</button>
    </span>
  );
}
