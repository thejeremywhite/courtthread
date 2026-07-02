"use client";

import { useState, useEffect, useRef, Suspense } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { PatternBuilder } from "@/components/search/PatternBuilder";
import { DateTimePicker } from "@/components/DateTimePicker";
import { MessageThread, ThreadViewport, ViewModeToggle, useViewMode, useThemeMode, getThemeVars } from "@/app/conversations/[id]/MessageThread";
import { cleanSourceName } from "@/lib/sourceName";
import { ImportPicker } from "@/components/ImportPicker";
import { PersonSearch, type PersonSuggestion } from "@/components/PersonSearch";

interface SearchResult {
  id: string;
  content: string;
  sender_name: string;
  timestamp: string;
  message_type: string;
  conversation_id: string;
  conversation_title: string;
  platform: string;
  is_incoming: number;
  source_id: string;
  metadata: string | null;
  context: Array<{
    id: string;
    content: string | null;
    sender_name: string;
    timestamp: string;
    message_type: string;
    is_incoming: number;
    source_id: string;
    metadata: string | null;
    platform: string;
  }>;
}

interface SourceRow {
  id: string;
  filename: string;
  file_type: string;
  conversation_count: number;
  message_count: number;
}

interface ParticipantRow {
  id: string;
  display_name: string;
  phone_number: string | null;
  is_owner: number;
  platforms: string[];
  conversations: Array<{ id: string; title: string; platform: string }>;
}

interface ConversationRow {
  id: string;
  title: string | null;
  platform: string;
  message_count: number;
  participant_names: string | null;
}

interface ScopeChip {
  type: "source" | "participant" | "exclude-participant" | "platform" | "conversation" | "sender";
  id: string;
  label: string;
  detail?: string;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
  });
}

// If a "To" date was picked with no time (local midnight), treat it as the END of
// that day so a single-day range (e.g. From Jun 26 / To Jun 26) includes the whole day.
function toInclusiveEnd(iso: string): string {
  if (!iso) return iso;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0) {
    d.setHours(23, 59, 59, 999);
    return d.toISOString();
  }
  return iso;
}

function highlightMatch(text: string, query: string, caseSensitive: boolean): React.ReactNode {
  if (!query || !text) return text;
  try {
    const flags = caseSensitive ? "g" : "gi";
    const re = new RegExp(`(${escapeRegex(query)})`, flags);
    const parts = text.split(re);
    return parts.map((part, i) =>
      re.test(part) ? (
        <mark key={i} className="bg-amber-400/40 text-inherit rounded px-0.5">{part}</mark>
      ) : part
    );
  } catch { return text; }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PLATFORM_COLORS: Record<string, string> = {
  facebook: "bg-blue-500/20 text-blue-400",
  sms: "bg-green-500/20 text-green-400",
  default: "bg-[var(--secondary)] text-[var(--muted-foreground)]",
};

type SearchMode = "contains" | "starts_with" | "ends_with" | "whole_word" | "regex";
type ContextMode = "time" | "messages";
type ContextDirection = "both" | "before" | "after";
type ExportFormat = "print" | "html" | "html-zip" | "mhtml" | "html-original" | "csv" | "txt";

function parseMedia(metadata: string | null): Array<{ type: string; filename: string }> {
  if (!metadata) return [];
  try {
    const obj = JSON.parse(metadata);
    return (obj?.media || []).filter((m: any) => m && m.filename);
  } catch { return []; }
}

function InlineMedia({ metadata, sourceId }: { metadata: string | null; sourceId: string }) {
  const [errors, setErrors] = useState<Set<string>>(new Set());
  const items = parseMedia(metadata);
  if (items.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 mt-1">
      {items.map((m, i) => {
        const url = `/api/media?sourceId=${encodeURIComponent(sourceId)}&filename=${encodeURIComponent(m.filename)}&type=${encodeURIComponent(m.type)}`;
        if ((m.type === "image" || m.type === "sticker" || m.type === "gif") && !errors.has(m.filename)) {
          return (
            <a key={i} href={url} target="_blank" rel="noopener noreferrer">
              <img src={url} alt={m.filename}
                onError={() => setErrors(prev => new Set(prev).add(m.filename))}
                className="rounded max-w-[200px] max-h-[200px] object-contain border border-[var(--border)] hover:ring-2 hover:ring-[var(--primary)] transition"
                loading="lazy" />
            </a>
          );
        }
        if (errors.has(m.filename)) {
          return <span key={i} className="text-xs px-2 py-1 rounded bg-[var(--secondary)] text-[var(--muted-foreground)]">[Image: {m.filename}]</span>;
        }
        if (m.type === "video") {
          return <video key={i} src={url} className="rounded max-w-[200px] max-h-[200px] border border-[var(--border)]" controls preload="metadata" />;
        }
        if (m.type === "audio") {
          return <audio key={i} controls preload="metadata" className="w-48"><source src={url} /></audio>;
        }
        return <span key={i} className="text-xs opacity-70">[{m.type}: {m.filename}]</span>;
      })}
    </div>
  );
}

function ExportDropdown({ onAction, disabled, label, light }: {
  onAction: (format: ExportFormat) => void;
  disabled: boolean;
  label: string;
  light?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [goUp, setGoUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const handleToggle = () => {
    if (!open && ref.current) {
      const rect = ref.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      setGoUp(spaceBelow < 280);
    }
    setOpen(!open);
  };

  const menuBg = light ? "bg-white border-[#dadde1]" : "bg-[#1e1e1e] border-[#333]";
  const menuItem = light ? "text-[#1c1e21] hover:bg-[#f0f2f5]" : "text-[#e0e0e0] hover:bg-[#333]";
  const menuDivider = light ? "border-[#dadde1]" : "border-[#333]";
  const menuLabel = light ? "text-[#65676b]" : "text-[#999]";

  return (
    <div className="relative inline-block" ref={ref}>
      <button onClick={handleToggle} disabled={disabled}
        className="px-3 py-1.5 rounded-lg bg-[var(--primary)] text-white text-xs font-medium hover:opacity-90 transition disabled:opacity-50 flex items-center gap-1">
        {label} <span className="text-[10px]">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className={`absolute right-0 ${goUp ? 'bottom-full mb-1' : 'top-full mt-1'} w-56 rounded-lg border shadow-xl z-40 py-1 ${menuBg}`}>
          <button onClick={() => { onAction("print"); setOpen(false); }}
            className={`w-full text-left px-3 py-2 text-sm transition ${menuItem}`}>
            Print / Save as PDF
          </button>
          <div className={`border-t my-1 ${menuDivider}`} />
          <p className={`px-3 py-1 text-[10px] uppercase tracking-wider ${menuLabel}`}>Download as</p>
          <button onClick={() => { onAction("html"); setOpen(false); }}
            className={`w-full text-left px-3 py-2 text-sm transition ${menuItem}`}>
            HTML (standalone, media embedded)
          </button>
          <button onClick={() => { onAction("html-zip"); setOpen(false); }}
            className={`w-full text-left px-3 py-2 text-sm transition ${menuItem}`}>
            HTML + Media folder (ZIP)
          </button>
          <button onClick={() => { onAction("mhtml"); setOpen(false); }}
            className={`w-full text-left px-3 py-2 text-sm transition ${menuItem}`}>
            MHTML (single file)
          </button>
          <button onClick={() => { onAction("html-original"); setOpen(false); }}
            className={`w-full text-left px-3 py-2 text-sm transition ${menuItem}`}>
            HTML (original source format)
          </button>
          <div className={`border-t my-1 ${menuDivider}`} />
          <button onClick={() => { onAction("csv"); setOpen(false); }}
            className={`w-full text-left px-3 py-2 text-sm transition ${menuItem}`}>
            CSV (spreadsheet)
          </button>
          <button onClick={() => { onAction("txt"); setOpen(false); }}
            className={`w-full text-left px-3 py-2 text-sm transition ${menuItem}`}>
            Plain Text
          </button>
        </div>
      )}
    </div>
  );
}

// localStorage (not sessionStorage): filters should survive closing the tab, only
// resetting when the user explicitly clears them — "until the server is basically
// closed and restarted" per Jeremy.
const SEARCH_PREFS_KEY = "courtthread_search_prefs";

function SearchPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState<SearchMode>("contains");
  const [matchCase, setMatchCase] = useState(false);
  // Initialize to a constant so server and client render identically (no hydration
  // mismatch). The saved preference is loaded from localStorage AFTER mount.
  const [highlightMatches, setHighlightMatches] = useState(true);
  const highlightLoaded = useRef(false);
  useEffect(() => {
    const saved = localStorage.getItem("courtthread_highlightMatches");
    if (saved !== null) setHighlightMatches(saved === "true");
    highlightLoaded.current = true;
  }, []);
  useEffect(() => {
    // Don't write back until after the initial load, to avoid clobbering the saved value.
    if (highlightLoaded.current) localStorage.setItem("courtthread_highlightMatches", String(highlightMatches));
  }, [highlightMatches]);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  // Default context: by messages, +-5, both directions — matches how Jeremy actually
  // reads a thread (a fixed number of surrounding messages, not a time window).
  const [contextLines, setContextLines] = useState(5);
  const [contextMode, setContextMode] = useState<ContextMode>("messages");
  const [contextDirection, setContextDirection] = useState<ContextDirection>("both");
  const [contextCustom, setContextCustom] = useState(false);
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [viewMode, setViewMode] = useViewMode();
  const [themeMode, setThemeMode] = useThemeMode();
  const [showBuilder, setShowBuilder] = useState(false);
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [expandedResults, setExpandedResults] = useState<Set<string>>(new Set());
  const [hasMoreResults, setHasMoreResults] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [bookmarkedIds, setBookmarkedIds] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [formattedViewData, setFormattedViewData] = useState<SearchResult[] | null>(null);
  const resultsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!formattedViewData) return;
    const handleEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setFormattedViewData(null); };
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [formattedViewData]);

  // Scope state
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [selectedSources, setSelectedSources] = useState<Set<string>>(new Set());
  const [selectedPlatforms, setSelectedPlatforms] = useState<Set<string>>(new Set());
  const [selectedParticipants, setSelectedParticipants] = useState<ParticipantRow[]>([]);
  // Exempts whole conversations these people are part of (e.g. the "Facebook user"
  // placeholder or numeric-only unresolved names) from the search entirely.
  const [excludedParticipants, setExcludedParticipants] = useState<ParticipantRow[]>([]);
  const [selectedConversations, setSelectedConversations] = useState<Set<string>>(new Set());
  const [senderOptions, setSenderOptions] = useState<string[]>([]);
  const [selectedSenders, setSelectedSenders] = useState<Set<string>>(new Set());

  // Dropdowns
  const [senderDropdownOpen, setSenderDropdownOpen] = useState(false);
  const [availableConversations, setAvailableConversations] = useState<ConversationRow[]>([]);
  const senderDropRef = useRef<HTMLDivElement>(null);

  const [allPlatforms, setAllPlatforms] = useState<string[]>([]);
  const restoredRef = useRef(false);
  // Gates the auto-save effect below: don't write anything back to storage until this
  // mount-time restore has actually populated state, or the empty initial defaults would
  // clobber the saved prefs before they're even applied.
  const [prefsLoaded, setPrefsLoaded] = useState(false);

  const cameFromConversationRef = useRef(false);
  const clearedRef = useRef(false);

  // Decide initial state on mount: a conversation-scoped search starts fresh;
  // otherwise restore the saved session so navigating away and back is lossless.
  useEffect(() => {
    const convId = searchParams.get("conversationId");
    if (convId) {
      // Fresh scoped search — discard any stale saved filters
      cameFromConversationRef.current = true;
      restoredRef.current = true; // prevent default "select all sources" from clobbering
      try { localStorage.removeItem(SEARCH_PREFS_KEY); } catch {}
      setSelectedConversations(new Set([convId]));
      fetch(`/api/conversations/${convId}`).then(r => r.json()).then(d => {
        if (d.source_id) setSelectedSources(new Set([d.source_id]));
        if (d.participants) setSenderOptions(d.participants);
        setAvailableConversations(prev => {
          if (prev.some(c => c.id === convId)) return prev;
          return [...prev, {
            id: convId,
            title: d.title || d.participant_names || "Untitled",
            platform: d.platform || "",
            message_count: d.message_count || 0,
            participant_names: d.participant_names || null,
          }];
        });
      }).catch(() => {});
      setPrefsLoaded(true);
      return;
    }
    // No conversation param — restore saved session (localStorage: survives closing the
    // tab, only cleared explicitly via "Clear all filters" or the server restarting).
    try {
      const saved = localStorage.getItem(SEARCH_PREFS_KEY);
      if (saved) {
        const s = JSON.parse(saved);
        if (s.query) setQuery(s.query);
        if (s.searchMode) setSearchMode(s.searchMode);
        if (s.matchCase !== undefined) setMatchCase(s.matchCase);
        if (s.dateFrom) setDateFrom(s.dateFrom);
        if (s.dateTo) setDateTo(s.dateTo);
        if (s.contextLines !== undefined) setContextLines(s.contextLines);
        if (s.contextMode) setContextMode(s.contextMode);
        if (s.contextDirection) setContextDirection(s.contextDirection);
        if (s.sortOrder) setSortOrder(s.sortOrder);
        if (s.selectedSources) setSelectedSources(new Set(s.selectedSources));
        if (s.selectedSenders) setSelectedSenders(new Set(s.selectedSenders));
        if (s.senderOptions) setSenderOptions(s.senderOptions);
        if (s.selectedConversations) setSelectedConversations(new Set(s.selectedConversations));
        if (s.selectedPlatforms) setSelectedPlatforms(new Set(s.selectedPlatforms));
        if (s.selectedParticipants) setSelectedParticipants(s.selectedParticipants);
        if (s.excludedParticipants) setExcludedParticipants(s.excludedParticipants);
        if (s.results) setResults(s.results);
        if (s.total !== undefined) setTotal(s.total);
        if (s.page) setPage(s.page);
        if (s.hasMoreResults !== undefined) setHasMoreResults(s.hasMoreResults);
        if (s.expandedResults) setExpandedResults(new Set(s.expandedResults));
        restoredRef.current = true;
      }
    } catch {}
    setPrefsLoaded(true);
  }, []);

  // Single auto-save: fires on ANY tracked filter/result change (not just after a
  // completed search), so toggling a button, picking a person, or narrowing scope is
  // remembered even if the user navigates away before hitting Search again.
  useEffect(() => {
    if (!prefsLoaded) return;
    try {
      localStorage.setItem(SEARCH_PREFS_KEY, JSON.stringify({
        query, searchMode, matchCase, dateFrom, dateTo,
        contextLines, contextMode, contextDirection, sortOrder,
        selectedSources: Array.from(selectedSources),
        selectedSenders: Array.from(selectedSenders),
        senderOptions,
        selectedConversations: Array.from(selectedConversations),
        selectedPlatforms: Array.from(selectedPlatforms),
        selectedParticipants,
        excludedParticipants,
        results, total, page, hasMoreResults,
        expandedResults: Array.from(expandedResults),
      }));
    } catch { /* storage full or unavailable — non-fatal */ }
  }, [prefsLoaded, query, searchMode, matchCase, dateFrom, dateTo,
      contextLines, contextMode, contextDirection, sortOrder,
      selectedSources, selectedSenders, senderOptions, selectedConversations,
      selectedPlatforms, selectedParticipants, excludedParticipants,
      results, total, page, hasMoreResults, expandedResults]);

  useEffect(() => {
    fetch("/api/sources").then((r) => r.json()).then((d) => {
      const srcs = d.sources || [];
      setSources(srcs);
      // Do NOT auto-select imports. Selection is explicit: the page loads with
      // nothing selected (or whatever the restored session / conversation scope set),
      // and the user picks what to search. A refresh must not re-select everything.
      // PRUNE the restored selection against the LIVE import list: after a delete or
      // re-import the saved ids no longer exist, which left ghost scopes like a raw
      // UUID chip / "1 import (0 msgs)" filtering every search down to nothing.
      const liveIds = new Set(srcs.map((s: SourceRow) => s.id));
      setSelectedSources((prev) => {
        const kept = new Set([...prev].filter((id) => liveIds.has(id)));
        if (kept.size !== prev.size) setSelectedConversations(new Set());
        return kept.size === prev.size ? prev : kept;
      });
    }).catch(() => {});
    fetch("/api/conversations?limit=0").then((r) => r.json()).then((d) => {
      if (d.platforms) setAllPlatforms(d.platforms);
    }).catch(() => {});
    fetch("/api/bookmarks").then((r) => r.json()).then((d) => {
      const ids = new Set<string>();
      for (const b of d.bookmarks || []) ids.add(b.message_id);
      setBookmarkedIds(ids);
    }).catch(() => {});
  }, []);

  // Populate the sender options from the participants of the scoped conversation(s)
  useEffect(() => {
    if (cameFromConversationRef.current) return; // handled by the mount fetch above
    if (selectedConversations.size === 0) return;
    Promise.all(
      Array.from(selectedConversations).map((cid) =>
        fetch(`/api/conversations/${cid}`).then((r) => r.json()).catch(() => null)
      )
    ).then((convs) => {
      const names = new Set<string>();
      for (const c of convs) {
        if (c?.participants) for (const n of c.participants) names.add(n);
      }
      if (names.size > 0) setSenderOptions(Array.from(names).sort());
    }).catch(() => {});
  }, [selectedConversations]);

  useEffect(() => {
    if (selectedSources.size === 0) {
      setAvailableConversations([]);
      setSelectedConversations((prev) => (prev.size === 0 ? prev : new Set()));
      return;
    }
    const promises = Array.from(selectedSources).map((srcId) =>
      fetch(`/api/conversations?sourceId=${srcId}&limit=500`).then((r) => r.json())
    );
    Promise.all(promises).then((results) => {
      const all = results.flatMap((r) => r.conversations || []);
      setAvailableConversations(all);
      // Drop any selected conversations that don't belong to the now-selected imports,
      // so switching imports doesn't leave a stale conversation filter that returns nothing.
      const validIds = new Set(all.map((c: ConversationRow) => c.id));
      setSelectedConversations((prev) => {
        if (prev.size === 0) return prev;
        const pruned = new Set(Array.from(prev).filter((id) => validIds.has(id)));
        return pruned.size === prev.size ? prev : pruned;
      });
    }).catch(() => {});
  }, [selectedSources]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (senderDropRef.current && !senderDropRef.current.contains(e.target as Node)) setSenderDropdownOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function addParticipant(p: PersonSuggestion) {
    setSelectedParticipants((prev) => prev.some((x) => x.id === p.id) ? prev : [...prev, p]);
    setExcludedParticipants((prev) => prev.filter((x) => x.id !== p.id));
  }

  function removeParticipant(idx: number) {
    setSelectedParticipants((prev) => prev.filter((_, i) => i !== idx));
  }

  function addExcludedParticipant(p: PersonSuggestion) {
    setExcludedParticipants((prev) => prev.some((x) => x.id === p.id) ? prev : [...prev, p]);
    setSelectedParticipants((prev) => prev.filter((x) => x.id !== p.id));
  }

  function removeExcludedParticipant(idx: number) {
    setExcludedParticipants((prev) => prev.filter((_, i) => i !== idx));
  }

  function togglePlatform(p: string) {
    setSelectedPlatforms((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p); else next.add(p);
      return next;
    });
  }

  function toggleConversation(id: string) {
    setSelectedConversations((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleSender(name: string) {
    setSelectedSenders((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }

  // All-imports-selected is the DEFAULT (not a filter), so don't render a chip per
  // source in that case — only show source chips when narrowed to a subset.
  const allSrcSelected = sources.length > 0 && selectedSources.size === sources.length;
  const scopeChips: ScopeChip[] = [
    ...(allSrcSelected ? [] : Array.from(selectedSources).map((id) => {
      const src = sources.find((s) => s.id === id);
      return { type: "source" as const, id, label: src ? cleanSourceName(src.filename) : id, detail: `${src?.message_count || 0} msgs` };
    })),
    ...Array.from(selectedPlatforms).map((p) => ({
      type: "platform" as const, id: p, label: p,
    })),
    ...selectedParticipants.map((p) => ({
      type: "participant" as const, id: p.id, label: p.display_name,
      detail: p.phone_number || p.platforms.join(", "),
    })),
    ...excludedParticipants.map((p) => ({
      type: "exclude-participant" as const, id: p.id, label: `exclude: ${p.display_name}`,
      detail: p.phone_number || p.platforms.join(", "),
    })),
    ...Array.from(selectedConversations).map((id) => {
      const conv = availableConversations.find((c) => c.id === id);
      return { type: "conversation" as const, id, label: conv?.title || conv?.participant_names || id, detail: conv?.platform };
    }),
    ...Array.from(selectedSenders).map((name) => ({
      type: "sender" as const, id: name, label: `from: ${name}`,
    })),
  ];

  function removeChip(chip: ScopeChip) {
    if (chip.type === "source") setSelectedSources((prev) => { const next = new Set(prev); if (next.has(chip.id)) next.delete(chip.id); else next.add(chip.id); return next; });
    else if (chip.type === "platform") togglePlatform(chip.id);
    else if (chip.type === "conversation") toggleConversation(chip.id);
    else if (chip.type === "sender") toggleSender(chip.id);
    else if (chip.type === "exclude-participant") {
      const idx = excludedParticipants.findIndex((p) => p.id === chip.id);
      if (idx >= 0) removeExcludedParticipant(idx);
    } else {
      const idx = selectedParticipants.findIndex((p) => p.id === chip.id);
      if (idx >= 0) removeParticipant(idx);
    }
  }

  function clearAllScope() {
    // Clear all scope selections — nothing stays selected.
    clearedRef.current = true;
    setSelectedSources(new Set());
    setSelectedPlatforms(new Set());
    setSelectedParticipants([]);
    setExcludedParticipants([]);
    setSelectedConversations(new Set());
    setSelectedSenders(new Set());
  }

  function clearSearch() {
    setQuery("");
    setResults(null);
    setTotal(0);
    setPage(1);
    setError(null);
    setExpandedResults(new Set());
    setDateFrom("");
    setDateTo("");
    setSelectedSenders(new Set());
    setSelectedConversations(new Set());
    setSelectedParticipants([]);
    setExcludedParticipants([]);
    setSelectedPlatforms(new Set());
    // Clear means CLEAR: deselect every import too. Nothing stays selected.
    setSelectedSources(new Set());
    setContextMode("messages");
    setContextDirection("both");
    setContextLines(5);
    setContextCustom(false);
    setSearchMode("contains");
    setMatchCase(false);
    hasSearchedRef.current = false;
    // Stop the default "select all imports" effect from re-filling the selection,
    // and drop any ?conversationId= so it can't re-seed on a remount.
    cameFromConversationRef.current = false;
    clearedRef.current = true;
    restoredRef.current = true;
    try { localStorage.removeItem(SEARCH_PREFS_KEY); } catch {}
    if (searchParams.toString()) router.replace(pathname, { scroll: false });
  }

  async function handleSearch(searchPage = 1, append = false) {
    const trimmed = query.trim();
    const hasScope = selectedSources.size > 0 || selectedConversations.size > 0
      || selectedParticipants.length > 0 || selectedSenders.size > 0
      || selectedPlatforms.size > 0 || !!dateFrom || !!dateTo;
    if (!trimmed && !hasScope) {
      setError("Enter a search term, or select an import/conversation/person to browse messages.");
      setResults(null);
      return;
    }
    // Block only when NOTHING at all is scoped (imports exist but none chosen, and no
    // conversation / person / sender / date either). Picking any one of those is enough
    // scope to browse — an empty search box then acts as a wildcard over that scope.
    if (sources.length > 0 && selectedSources.size === 0
        && selectedConversations.size === 0 && selectedParticipants.length === 0
        && selectedSenders.size === 0 && !dateFrom && !dateTo) {
      setError("Select at least one import, conversation, or person to browse — an empty search box then shows everything in that scope.");
      setResults(null);
      return;
    }
    // Only block a keyword search that targets the ENTIRE corpus (all imports, nothing
    // else narrowed). Selecting a specific import, conversation, participant, or sender
    // is enough scope on its own.
    const narrowed =
      selectedSources.size > 0 ||
      selectedConversations.size > 0 ||
      selectedParticipants.length > 0 ||
      selectedSenders.size > 0 ||
      !!dateFrom || !!dateTo;
    if (trimmed && !narrowed) {
      setError("Narrow your search first — pick specific import(s), a conversation, or a person. Searching every import at once isn't supported.");
      setResults(null);
      return;
    }
    if (append) setLoadingMore(true); else setSearching(true);
    if (!append) setError(null);
    setPage(searchPage);

    try {
      let effectiveQuery = trimmed;
      const isRegex = searchMode === "regex";

      if (trimmed && !isRegex) {
        // Treat "*" as a glob wildcard (any run of characters). Everything else —
        // including "?" — is escaped so it matches literally (e.g. "really?").
        const escaped = effectiveQuery
          .split("*")
          .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*");
        switch (searchMode) {
          case "starts_with": effectiveQuery = `\\b${escaped}`; break;
          case "ends_with": effectiveQuery = `${escaped}\\b`; break;
          case "whole_word": effectiveQuery = `\\b${escaped}\\b`; break;
          default: effectiveQuery = escaped; break;
        }
      }

      const body: any = {
        query: effectiveQuery,
        useRegex: true,
        matchCase,
        dateFrom: dateFrom || undefined,
        dateTo: toInclusiveEnd(dateTo) || undefined,
        contextLines,
        contextMode,
        contextDirection,
        sortOrder,
        page: searchPage,
        limit: 50,
      };

      if (selectedSources.size > 0) body.sourceIds = Array.from(selectedSources);
      if (selectedPlatforms.size > 0) body.platforms = Array.from(selectedPlatforms);
      if (selectedSenders.size > 0) body.senderNames = Array.from(selectedSenders);

      const convIds = new Set<string>();
      for (const p of selectedParticipants) {
        for (const c of p.conversations) convIds.add(c.id);
      }
      for (const cid of selectedConversations) convIds.add(cid);
      if (convIds.size > 0) body.conversationIds = Array.from(convIds);
      if (excludedParticipants.length > 0) body.excludeParticipantIds = excludedParticipants.map((p) => p.id);

      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const newResults = append && results ? [...results, ...data.results] : data.results;
      const newHasMore = searchPage * 50 < data.total;
      setResults(newResults);
      setTotal(data.total);
      setHasMoreResults(newHasMore);
      // Persistence is handled by the single auto-save effect (fires whenever results/
      // total/hasMoreResults change, right after these setters above take effect).
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSearching(false);
      setLoadingMore(false);
    }
  }

  const hasSearchedRef = useRef(false);
  const autoSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  if (results !== null) hasSearchedRef.current = true;

  // After session restore, suppress auto-re-search for a tick so filter setters
  // don't each trigger a redundant search that clears the restored results.
  const suppressAutoSearchRef = useRef(restoredRef.current);
  useEffect(() => {
    if (suppressAutoSearchRef.current) {
      const t = setTimeout(() => { suppressAutoSearchRef.current = false; }, 800);
      return () => clearTimeout(t);
    }
  }, []);

  // Re-run the search whenever ANY filter changes after a first search — not just
  // when the query box is non-empty. A query-less filter search is valid too.
  useEffect(() => {
    if (!hasSearchedRef.current) return;
    if (suppressAutoSearchRef.current) return;
    if (autoSearchTimerRef.current) clearTimeout(autoSearchTimerRef.current);
    autoSearchTimerRef.current = setTimeout(() => {
      handleSearch(1);
    }, 400);
    return () => { if (autoSearchTimerRef.current) clearTimeout(autoSearchTimerRef.current); };
  }, [matchCase, dateFrom, dateTo, contextLines, contextMode, contextDirection, sortOrder, searchMode,
      selectedSources.size, selectedPlatforms.size, selectedParticipants.length,
      selectedConversations.size, selectedSenders.size]);

  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && hasMoreResults && !loadingMore && !searching) {
        handleSearch(page + 1, true);
      }
    }, { threshold: 0.1 });
    if (resultsEndRef.current) observer.observe(resultsEndRef.current);
    return () => observer.disconnect();
  }, [hasMoreResults, loadingMore, searching, page]);

  function toggleExpand(id: string) {
    setExpandedResults((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function toggleResultBookmark(result: SearchResult) {
    try {
      const res = await fetch("/api/bookmarks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId: result.id, conversationId: result.conversation_id }),
      });
      const data = await res.json();
      setBookmarkedIds((prev) => {
        const next = new Set(prev);
        if (data.bookmarked) next.add(result.id); else next.delete(result.id);
        return next;
      });
    } catch { /* ignore */ }
  }

  async function toggleResultBookmarkById(messageId: string) {
    const match = results?.find(r => r.id === messageId || r.context.some(c => c.id === messageId));
    if (match) {
      try {
        const res = await fetch("/api/bookmarks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messageId, conversationId: match.conversation_id }),
        });
        const data = await res.json();
        setBookmarkedIds((prev) => {
          const next = new Set(prev);
          if (data.bookmarked) next.add(messageId); else next.delete(messageId);
          return next;
        });
      } catch { /* ignore */ }
    }
  }

  // Open the full conversation scrolled to this message, with the message and the
  // search term highlighted (same highlight as the result card).
  function showInConversation(result: SearchResult) {
    const params = new URLSearchParams({ messageId: result.id });
    if (query.trim()) params.set("q", query.trim());
    window.open(`/conversations/${result.conversation_id}?${params}`, "_blank");
  }

  async function getExportData(single?: SearchResult): Promise<SearchResult[]> {
    if (single) return [single];
    if (results && results.length >= total) return results;
    return (await fetchAllResultsForExport()) || results || [];
  }

  function buildPayload(toExport: SearchResult[]) {
    return toExport.map((r) => ({
      id: r.id,
      content: r.content,
      sender_name: r.sender_name,
      timestamp: r.timestamp,
      conversation_title: r.conversation_title,
      platform: r.platform,
      is_incoming: r.is_incoming,
      source_id: r.source_id,
      metadata: r.metadata,
      context: r.context,
    }));
  }


  async function handlePrint(single?: SearchResult) {
    const toExport = await getExportData(single);
    const payload = buildPayload(toExport);
    if (payload.length === 0) return;

    try {
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "searchResults",
          format: "html",
          subFormat: "print",
          query: highlightMatches ? query.trim() : "",
          matchCase,
          includeTimestamps: true,
          includeProvenance: true,
          includeContext: true,
          viewMode,
          theme: themeMode,
          results: payload,
        }),
      });
      if (!res.ok) { console.error("Export failed:", res.status, await res.text()); alert("Export failed: " + res.status); return; }
      let html = await res.text();
      html = html.replace(/<head>/i, `<head><base href="${location.origin}/">`);
      const blob = new Blob([html], { type: "text/html" });
      const blobUrl = URL.createObjectURL(blob);
      const w = window.open(blobUrl, "_blank");
      if (!w) { alert("Pop-up blocked — allow pop-ups for print preview."); return; }
    } catch (e: any) { console.error("Print error:", e); alert("Print error: " + (e?.message || e)); }
  }

  async function openFormattedView(single?: SearchResult) {
    if (single) {
      setFormattedViewData([single]);
      return;
    }
    const allResults = await getExportData();
    setFormattedViewData(allResults);
  }

  async function handleExportAction(format: ExportFormat, single?: SearchResult) {
    if (format === "print") {
      handlePrint(single);
      return;
    }
    setExporting(true);
    try {
      const toExport = await getExportData(single);
      const payload = buildPayload(toExport);
      const apiFormat = format === "html-zip" ? "html" : format === "mhtml" ? "html" : format === "html-original" ? "html" : format;
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "searchResults",
          format: apiFormat,
          subFormat: format,
          query: highlightMatches ? query.trim() : "",
          matchCase,
          includeTimestamps: true,
          includeProvenance: true,
          includeContext: true,
          embedMedia: format === "html" || format === "mhtml",
          bundleMedia: format === "html-zip",
          originalSource: format === "html-original",
          viewMode,
          theme: themeMode,
          results: payload,
        }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({ error: "Export failed" }));
        setError(e.error || "Export failed");
        return;
      }
      const blob = await res.blob();
      const ext = format === "csv" ? "csv" : format === "txt" ? "txt" : format === "html-zip" ? "zip" : format === "mhtml" ? "mhtml" : "html";
      const cd = res.headers.get("content-disposition");
      const fileName = cd?.match(/filename="([^"]+)"/)?.[1]
        || `${(single?.conversation_title || results?.[0]?.conversation_title || "Search_Results").replace(/[^a-zA-Z0-9 _-]/g, "").replace(/\s+/g, "_")}.${ext}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setExporting(false);
    }
  }

  async function fetchAllResultsForExport(): Promise<SearchResult[] | null> {
    try {
      const trimmed = query.trim();
      let effectiveQuery = trimmed;
      const isRegex = searchMode === "regex";
      if (trimmed && !isRegex) {
        // Treat "*" as a glob wildcard (any run of characters). Everything else —
        // including "?" — is escaped so it matches literally (e.g. "really?").
        const escaped = effectiveQuery
          .split("*")
          .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*");
        switch (searchMode) {
          case "starts_with": effectiveQuery = `\\b${escaped}`; break;
          case "ends_with": effectiveQuery = `${escaped}\\b`; break;
          case "whole_word": effectiveQuery = `\\b${escaped}\\b`; break;
          default: effectiveQuery = escaped; break;
        }
      }
      const body: any = {
        query: effectiveQuery, useRegex: true, matchCase,
        dateFrom: dateFrom || undefined, dateTo: toInclusiveEnd(dateTo) || undefined,
        contextLines, contextMode, contextDirection, sortOrder, page: 1, limit: 100000,
      };
      if (selectedSources.size > 0) body.sourceIds = Array.from(selectedSources);
      if (selectedPlatforms.size > 0) body.platforms = Array.from(selectedPlatforms);
      if (selectedSenders.size > 0) body.senderNames = Array.from(selectedSenders);
      const convIds = new Set<string>();
      for (const p of selectedParticipants) for (const c of p.conversations) convIds.add(c.id);
      for (const cid of selectedConversations) convIds.add(cid);
      if (convIds.size > 0) body.conversationIds = Array.from(convIds);
      if (excludedParticipants.length > 0) body.excludeParticipantIds = excludedParticipants.map((p) => p.id);
      const res = await fetch("/api/search", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      return data.results;
    } catch {
      return null;
    }
  }

  const totalMsgCount = sources.reduce((sum, s) => sum + (s.message_count || 0), 0);
  // Honest count: only what is actually selected (no "empty = all" fallback).
  const selectedMsgCount = sources.filter((s) => selectedSources.has(s.id)).reduce((sum, s) => sum + (s.message_count || 0), 0);

  const allSourcesSelected = sources.length > 0 && selectedSources.size === sources.length;
  const sourceLabel = (() => {
    if (sources.length === 0) return "No imports";
    if (selectedSources.size === 0) return "No imports selected";
    if (allSourcesSelected) return `All imports (${sources.length} sources, ${totalMsgCount.toLocaleString()} msgs)`;
    if (selectedSources.size === 1) {
      const src = sources.find((s) => s.id === Array.from(selectedSources)[0]);
      return `${src ? cleanSourceName(src.filename) : "1 import"} (${(src?.message_count || 0).toLocaleString()} msgs)`;
    }
    return `${selectedSources.size} of ${sources.length} imports (${selectedMsgCount.toLocaleString()} msgs)`;
  })();

  const sourceNames = sources.filter(s => selectedSources.has(s.id)).map(s => cleanSourceName(s.filename));

  return (
    <div>
      <h1 className="text-3xl font-bold mb-4">Search</h1>

      {/* Search box */}
      <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 mb-4">
        <div className="flex gap-3 mb-3">
          <div className="flex-1 relative">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch(1)}
              placeholder={searchMode === "regex" ? "Enter regex pattern..." : "Search messages (use * as a wildcard)..."}
              className="w-full px-4 py-2 pr-8 rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)]"
            />
            {(query || results !== null) && (
              <button onClick={clearSearch}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)] hover:text-[var(--foreground)] text-lg"
                title="Clear search">
                &times;
              </button>
            )}
          </div>
          <button
            onClick={() => handleSearch(1)}
            disabled={searching}
            className="px-6 py-2 rounded-lg bg-[var(--primary)] text-white font-medium hover:opacity-90 transition disabled:opacity-50"
          >
            {searching ? "..." : "Search"}
          </button>
          <button
            onClick={clearSearch}
            className="px-5 py-2 rounded-lg border-2 border-[var(--destructive)] text-[var(--destructive)] font-semibold hover:bg-[var(--destructive)]/10 transition"
            title="Clear the search term and ALL filters (dates, senders, scope)"
          >
            Clear all filters
          </button>
        </div>

        {/* Search mode buttons */}
        <div className="flex flex-wrap gap-2 mb-3">
          {([
            { key: "contains" as const, label: "Contains" },
            { key: "starts_with" as const, label: "Starts with" },
            { key: "ends_with" as const, label: "Ends with" },
            { key: "whole_word" as const, label: "Whole word" },
            { key: "regex" as const, label: "Regex" },
          ]).map((m) => (
            <button key={m.key} onClick={() => {
              setSearchMode(m.key);
              if (m.key !== "regex") setShowBuilder(false);
            }}
              className={`px-3 py-1 rounded-full text-xs font-medium transition ${
                searchMode === m.key
                  ? "bg-[var(--primary)] text-white"
                  : "bg-[var(--secondary)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              }`}>
              {m.label}
            </button>
          ))}

          <span className="border-l border-[var(--border)] mx-1" />

          <button onClick={() => setMatchCase(!matchCase)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition ${
              matchCase
                ? "bg-amber-500/20 text-amber-400 ring-1 ring-amber-500/50"
                : "bg-[var(--secondary)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            }`}>
            Match case
          </button>

          <button onClick={() => setHighlightMatches(!highlightMatches)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition ${
              highlightMatches
                ? "bg-amber-500/20 text-amber-400 ring-1 ring-amber-500/50"
                : "bg-[var(--secondary)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            }`}
            title="Highlight search term matches in results, exports, and prints">
            Highlight
          </button>

          {searchMode === "regex" && (
            <button onClick={() => setShowBuilder(!showBuilder)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition ${
                showBuilder
                  ? "bg-purple-500/20 text-purple-400 ring-1 ring-purple-500/50"
                  : "bg-[var(--secondary)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              }`}>
              {showBuilder ? "Hide Builder" : "Pattern Builder"}
            </button>
          )}
        </div>

        {/* Scope row */}
        <div className="flex flex-wrap gap-3 items-start mb-3">
          {/* Source dropdown (searchable by import name or participant) */}
          <ImportPicker
            sources={sources}
            selected={selectedSources}
            onChange={(ids) => { setSelectedSources(ids); if (ids.size === 0) setSelectedConversations(new Set()); }}
            multi
            label={sourceLabel}
          />

          {/* Platform pills */}
          {allPlatforms.length > 1 && (
            <div className="flex gap-1.5 items-center">
              {allPlatforms.map((p) => (
                <button key={p} onClick={() => togglePlatform(p)}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium transition ${
                    selectedPlatforms.has(p)
                      ? (PLATFORM_COLORS[p] || PLATFORM_COLORS.default) + " ring-1 ring-current"
                      : "bg-[var(--secondary)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  }`}
                >
                  {p === "facebook" ? "Facebook" : p === "sms" ? "SMS" : p}
                </button>
              ))}
            </div>
          )}

          {/* Search person (include) — replaces the old "All conversations" browse dropdown.
              Picking a person scopes search to their conversation(s); the underlying
              selectedConversations state (e.g. from a ?conversationId= link) still works
              and still shows as a removable chip below, it's just no longer manually
              browsable from a dropdown here. */}
          <PersonSearch
            placeholder="Search person..."
            sourceId={selectedSources.size === 1 ? Array.from(selectedSources)[0] : undefined}
            excludeIds={new Set(excludedParticipants.map((p) => p.id))}
            onSelect={addParticipant}
            className="w-52"
          />

          {/* Sender (who said the word) dropdown — appears when a conversation is in scope */}
          {senderOptions.length > 0 && (
            <div className="relative" ref={senderDropRef}>
              <button
                onClick={() => setSenderDropdownOpen(!senderDropdownOpen)}
                className={`px-3 py-1.5 rounded-lg border text-sm flex items-center gap-2 transition ${
                  selectedSenders.size > 0
                    ? "border-orange-500 bg-orange-500/10 text-orange-300"
                    : "border-[var(--border)] hover:border-[var(--primary)]/50"
                }`}
              >
                <span>
                  {selectedSenders.size === 0
                    ? "Anyone said it"
                    : selectedSenders.size === 1
                      ? `Said by ${Array.from(selectedSenders)[0]}`
                      : `Said by ${selectedSenders.size} people`}
                </span>
                <span className="text-[var(--muted-foreground)] text-xs">{senderDropdownOpen ? "▲" : "▼"}</span>
              </button>

              {senderDropdownOpen && (
                <div className="absolute z-30 top-full left-0 mt-1 w-72 rounded-lg border border-[var(--border)] bg-[var(--card)] shadow-xl max-h-72 overflow-y-auto">
                  <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
                    <span className="text-[10px] uppercase tracking-wider text-[var(--muted-foreground)]">Said by</span>
                    {selectedSenders.size > 0 && (
                      <button onClick={() => setSelectedSenders(new Set())}
                        className="text-xs text-[var(--muted-foreground)] hover:underline">Anyone</button>
                    )}
                  </div>
                  {senderOptions.map((name) => (
                    <button key={name} onClick={() => toggleSender(name)}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-[var(--secondary)]/50 transition flex items-center gap-2"
                    >
                      <span className={`w-4 h-4 shrink-0 rounded border flex items-center justify-center text-xs ${
                        selectedSenders.has(name) ? "border-orange-500 bg-orange-500 text-white" : "border-[var(--border)]"
                      }`}>
                        {selectedSenders.has(name) && "✓"}
                      </span>
                      <span className="flex-1 truncate">{name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Exclude person — exempts whole conversations this person is part of (e.g.
              the "Facebook user" placeholder, or numeric-only unresolved names). */}
          <PersonSearch
            placeholder="Exclude person..."
            sourceId={selectedSources.size === 1 ? Array.from(selectedSources)[0] : undefined}
            excludeIds={new Set(selectedParticipants.map((p) => p.id))}
            onSelect={addExcludedParticipant}
            className="w-52"
          />
        </div>

        {/* Active scope chips */}
        {scopeChips.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-3">
            {scopeChips.map((chip, i) => (
              <span key={`${chip.type}-${chip.id}-${i}`}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                  chip.type === "source" ? "bg-purple-500/20 text-purple-400" :
                  chip.type === "platform" ? (PLATFORM_COLORS[chip.id] || PLATFORM_COLORS.default) :
                  chip.type === "conversation" ? "bg-cyan-500/20 text-cyan-400" :
                  chip.type === "sender" ? "bg-amber-500/20 text-amber-400" :
                  chip.type === "exclude-participant" ? "bg-red-500/20 text-red-400" :
                  "bg-orange-500/20 text-orange-400"
                }`}
              >
                {chip.label}
                <button onClick={() => removeChip(chip)} className="ml-0.5 hover:text-[var(--destructive)]">&times;</button>
              </span>
            ))}
            <button onClick={clearAllScope} className="text-[10px] text-[var(--destructive)] hover:underline self-center ml-1">
              Clear
            </button>
          </div>
        )}

        {/* Date, context, sort */}
        <div className="flex flex-wrap gap-4 items-end text-sm">
          <div className="w-52">
            <DateTimePicker value={dateFrom} onChange={setDateFrom} label="From" placeholder="Start date..." />
          </div>
          <div className="w-52">
            <DateTimePicker value={dateTo} onChange={setDateTo} label="To" placeholder="End date..." />
          </div>

          <div className="flex items-end gap-2">
            <div>
              <label className="text-[10px] text-[var(--muted-foreground)] uppercase tracking-wider mb-1 block" title="How much surrounding context to show for each result. By time shows messages within X minutes before/after; by messages shows X messages before/after.">
                Context
              </label>
              <div className="flex gap-1 items-center">
                <select value={contextMode} onChange={(e) => setContextMode(e.target.value as ContextMode)}
                  className="px-1.5 py-1 rounded border border-[var(--border)] bg-[var(--background)] text-sm">
                  <option value="time">By time</option>
                  <option value="messages">By messages</option>
                </select>
                <select value={contextDirection} onChange={(e) => setContextDirection(e.target.value as ContextDirection)}
                  className="px-1.5 py-1 rounded border border-[var(--border)] bg-[var(--background)] text-sm"
                  title="Context direction: before & after, before only, or after only">
                  <option value="both">± before & after</option>
                  <option value="before">− before only</option>
                  <option value="after">+ after only</option>
                </select>
                <select
                  value={contextCustom ? "custom" : String(contextLines)}
                  onChange={(e) => {
                    if (e.target.value === "custom") {
                      setContextCustom(true);
                    } else {
                      setContextCustom(false);
                      setContextLines(parseInt(e.target.value));
                    }
                  }}
                  className="px-1.5 py-1 rounded border border-[var(--border)] bg-[var(--background)] text-sm">
                  <option value="0">None</option>
                  <option value="1">{contextDirection === "both" ? "±" : contextDirection === "before" ? "−" : "+"} 1 {contextMode === "time" ? "min" : "msg"}</option>
                  <option value="3">{contextDirection === "both" ? "±" : contextDirection === "before" ? "−" : "+"} 3 {contextMode === "time" ? "min" : "msgs"}</option>
                  <option value="5">{contextDirection === "both" ? "±" : contextDirection === "before" ? "−" : "+"} 5 {contextMode === "time" ? "min" : "msgs"}</option>
                  <option value="10">{contextDirection === "both" ? "±" : contextDirection === "before" ? "−" : "+"} 10 {contextMode === "time" ? "min" : "msgs"}</option>
                  <option value="20">{contextDirection === "both" ? "±" : contextDirection === "before" ? "−" : "+"} 20 {contextMode === "time" ? "min" : "msgs"}</option>
                  <option value="30">{contextDirection === "both" ? "±" : contextDirection === "before" ? "−" : "+"} 30 {contextMode === "time" ? "min" : "msgs"}</option>
                  <option value="60">{contextDirection === "both" ? "±" : contextDirection === "before" ? "−" : "+"} 60 {contextMode === "time" ? "min" : "msgs"}</option>
                  <option value="custom">Custom…</option>
                </select>
                {contextCustom && (
                  <input
                    type="number"
                    min={0}
                    value={contextLines}
                    onChange={(e) => setContextLines(Math.max(0, parseInt(e.target.value) || 0))}
                    className="w-16 px-1.5 py-1 rounded border border-[var(--border)] bg-[var(--background)] text-sm"
                    title={`Custom ${contextMode === "time" ? "minutes" : "messages"} before/after`}
                    placeholder="#"
                  />
                )}
              </div>
            </div>
          </div>

          <div>
            <label className="text-[10px] text-[var(--muted-foreground)] uppercase tracking-wider mb-1 block">Sort</label>
            <button
              onClick={() => setSortOrder((prev) => (prev === "desc" ? "asc" : "desc"))}
              className="px-3 py-1 rounded border border-[var(--border)] text-sm text-[var(--muted-foreground)] hover:border-[var(--primary)]/50 transition"
              title="Click to switch sort order"
            >
              {sortOrder === "desc" ? "Newest first" : "Oldest first"}
            </button>
          </div>
        </div>
      </div>

      {showBuilder && searchMode === "regex" && (
        <div className="mb-4">
          <PatternBuilder
            initialQuery={query}
            onApply={(pattern) => {
              setQuery(pattern);
              setShowBuilder(false);
            }}
          />
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-[var(--destructive)] bg-[var(--destructive)]/10 p-4 mb-6">
          <p className="text-[var(--destructive)]">{error}</p>
        </div>
      )}

      {results !== null && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <p className="text-[var(--muted-foreground)]">
              {total} result{total !== 1 ? "s" : ""}{query.trim() && (<> for{" "}
              <span className="text-[var(--foreground)] font-medium">
                {searchMode === "regex" ? `/${query}/` : `"${query}"`}
              </span></>)}
              {scopeChips.length > 0 && (
                <span className="text-xs ml-2">
                  (filtered by {scopeChips.length} scope{scopeChips.length !== 1 ? "s" : ""})
                </span>
              )}
            </p>
            <div className="flex items-center gap-3">
              <ViewModeToggle mode={viewMode} onChange={setViewMode} theme={themeMode} onThemeChange={setThemeMode} />
              {results.length > 0 && (
                <>
                  <button onClick={() => openFormattedView()}
                    className="px-3 py-1.5 rounded-lg border border-[var(--border)] text-xs font-medium hover:bg-[var(--secondary)] transition"
                    title="View all results in conversation format">
                    View Formatted
                  </button>
                  <ExportDropdown
                    label={exporting ? "Exporting..." : `Export ${total} result${total !== 1 ? "s" : ""}`}
                    disabled={exporting}
                    onAction={(fmt) => handleExportAction(fmt)}
                  />
                </>
              )}
              <span className="text-xs text-[var(--muted-foreground)]">
                {sortOrder === "desc" ? "Newest first" : "Oldest first"}
              </span>
            </div>
          </div>

          <div className="space-y-3">
            {results.map((result) => {
              const isExpanded = expandedResults.has(result.id);
              const platformClass = PLATFORM_COLORS[result.platform] || PLATFORM_COLORS.default;
              return (
                <div key={result.id} className="rounded-lg border border-[var(--border)] bg-[var(--card)]">
                  <div className="px-4 py-2 border-b border-[var(--border)] bg-[var(--secondary)]/30 flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm">
                      <span className={`px-2 py-0.5 rounded text-xs ${platformClass}`}>{result.platform}</span>
                      <a href={`/conversations/${result.conversation_id}`} target="_blank" rel="noopener noreferrer"
                        className="text-[var(--primary)] hover:underline" title="Open full conversation in new tab"
                        onClick={(e) => e.stopPropagation()}>
                        {result.conversation_title || "Untitled"}
                      </a>
                      <span className="text-[var(--muted-foreground)]">{formatTime(result.timestamp)}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      {contextLines > 0 && (
                        <button type="button" onClick={() => toggleExpand(result.id)}
                          className="text-xs text-[var(--primary)] hover:underline">
                          {isExpanded ? "Hide context" : result.context.length > 1 ? `Show context (${result.context.length} msgs)` : "Show context"}
                        </button>
                      )}
                      <button type="button" onClick={() => openFormattedView(result)}
                        className="text-xs text-[var(--primary)] hover:underline" title="View in conversation format with media">
                        View formatted
                      </button>
                      <button type="button" onClick={() => showInConversation(result)}
                        className="text-xs text-[var(--primary)] hover:underline" title="Open the full conversation at this message in a new tab">
                        Show in conversation
                      </button>
                      <button type="button" onClick={() => toggleResultBookmark(result)}
                        className={`text-xs flex items-center gap-1 hover:underline ${bookmarkedIds.has(result.id) ? "text-amber-400" : "text-[var(--muted-foreground)] hover:text-amber-400"}`}
                        title={bookmarkedIds.has(result.id) ? "Remove bookmark" : "Bookmark this message"}>
                        <span className="text-base leading-none">{bookmarkedIds.has(result.id) ? "★" : "☆"}</span>
                        {bookmarkedIds.has(result.id) ? "Bookmarked" : "Bookmark"}
                      </button>
                      <ExportDropdown
                        label="Export"
                        disabled={exporting}
                        onAction={(fmt) => handleExportAction(fmt, result)}
                      />
                    </div>
                  </div>

                  <ThreadViewport theme={themeMode} viewMode={viewMode} className="my-3">
                    <MessageThread
                      messages={isExpanded && result.context.length > 1 ? result.context : [result]}
                      platform={result.platform || "facebook"}
                      sourceId={result.source_id || ""}
                      conversationId={result.conversation_id}
                      bookmarkedIds={bookmarkedIds}
                      onToggleBookmark={toggleResultBookmarkById}
                      highlightText={highlightMatches ? query : undefined}
                      highlightMessageId={isExpanded && result.context.length > 1 ? result.id : undefined}
                      className="p-4"
                      viewMode={viewMode}
                    />
                  </ThreadViewport>
                </div>
              );
            })}
          </div>

          <div ref={resultsEndRef} className="h-10 flex items-center justify-center mt-4">
            {loadingMore && <span className="text-sm text-[var(--muted-foreground)]">Loading more...</span>}
            {!hasMoreResults && results && results.length > 0 && (
              <span className="text-xs text-[var(--muted-foreground)]">All {total} results loaded</span>
            )}
          </div>
        </div>
      )}

      {/* Formatted View Modal */}
      {formattedViewData && (() => {
        const allMsgs: Array<{ id: string; content: string | null; sender_name: string; timestamp: string; message_type: string; is_incoming: number; source_id: string; metadata: string | null; platform: string }> = [];
        const matchIds = new Set<string>();
        const seen = new Set<string>();
        for (const r of formattedViewData) {
          matchIds.add(r.id);
          const ctxList = r.context.length > 1 ? r.context : [{
            id: r.id, content: r.content, sender_name: r.sender_name, timestamp: r.timestamp,
            is_incoming: r.is_incoming, source_id: r.source_id, metadata: r.metadata, platform: r.platform,
          }];
          for (const c of ctxList) {
            if (seen.has(c.id)) continue;
            seen.add(c.id);
            allMsgs.push({ ...c, message_type: "text" });
          }
        }
        allMsgs.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        const convTitle = formattedViewData[0]?.conversation_title || "Messages";
        const plat = formattedViewData[0]?.platform || "facebook";
        const firstSourceId = formattedViewData[0]?.source_id || "";
        const firstConversationId = formattedViewData[0]?.conversation_id || "";
        const highlightMsgId = formattedViewData.length === 1 ? formattedViewData[0].id : undefined;

        const sysDark = typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;

        const pageBg = sysDark ? '#1a1a1a' : '#f0f0f0';
        const chromeText = sysDark ? '#ededed' : '#0a0a0a';
        const chromeBg = sysDark ? '#141414' : '#e5e5e5';
        const chromeBorder = sysDark ? '#27272a' : '#d1d5db';
        const chromeMuted = sysDark ? '#a1a1aa' : '#6b7280';

        return (
          <div className="fixed inset-0 z-50 flex flex-col"
            style={{ background: pageBg, color: chromeText }}>
            <div className="border-b px-4 py-3 flex items-center justify-between shrink-0"
              style={{ background: chromeBg, borderColor: chromeBorder, color: chromeText }}>
              <div className="flex items-center gap-3">
                <button onClick={() => setFormattedViewData(null)}
                  className="hover:opacity-80 text-sm"
                  style={{ color: chromeMuted }}>
                  &larr; Back
                </button>
                <h2 className="font-semibold text-sm" style={{ color: chromeText }}>
                  {formattedViewData.length === 1
                    ? convTitle
                    : `${formattedViewData.length} Search Results`}
                </h2>
              </div>
              <div className="flex items-center gap-2">
                <ViewModeToggle mode={viewMode} onChange={setViewMode} theme={themeMode} onThemeChange={setThemeMode} />
                <button onClick={() => handlePrint(formattedViewData.length === 1 ? formattedViewData[0] : undefined)}
                  className="px-3 py-1.5 rounded-lg border text-xs font-medium hover:opacity-80 transition"
                  style={{ borderColor: chromeBorder, color: chromeText }}>
                  Print
                </button>
                <ExportDropdown
                  label="Export"
                  disabled={exporting}
                  onAction={(fmt) => handleExportAction(fmt, formattedViewData.length === 1 ? formattedViewData[0] : undefined)}
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-6"
              style={{ backgroundColor: pageBg }}>
              <ThreadViewport theme={themeMode} viewMode={viewMode}>
                <MessageThread
                  messages={allMsgs}
                  platform={plat}
                  sourceId={firstSourceId}
                  conversationId={firstConversationId}
                  bookmarkedIds={bookmarkedIds}
                  onToggleBookmark={toggleResultBookmarkById}
                  highlightText={highlightMatches ? query : undefined}
                  highlightMessageId={highlightMsgId}
                  className="p-4"
                  viewMode={viewMode}
                />
              </ThreadViewport>
            </div>
          </div>
        );
      })()}

      {results === null && !error && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-8 text-center text-[var(--muted-foreground)]">
          <p className="mb-3">Enter a search term, or just pick an import / conversation / person and hit Search to browse everything in it (an empty box is treated as a wildcard).</p>
          {sources.length > 0 && selectedSources.size === 0 && selectedConversations.size === 0 && selectedParticipants.length === 0 && selectedSenders.size === 0 && (
            <p className="text-xs font-medium text-amber-500">Nothing selected yet — pick an import, conversation, or person to browse.</p>
          )}
          {sources.length > 0 && selectedSources.size > 0 && (
            <div className="text-xs space-y-1">
              <p className="font-medium text-[var(--foreground)]">
                Searching {allSourcesSelected ? `all ${sources.length}` : `${selectedSources.size} of ${sources.length}`} imports ({selectedMsgCount.toLocaleString()} messages):
              </p>
              {sourceNames.map((name, i) => (
                <p key={i}>{name}</p>
              ))}
            </div>
          )}
          {sources.length === 0 && (
            <p className="text-xs">No data imported yet. <a href="/import" className="text-[var(--primary)] hover:underline">Import files</a> to get started.</p>
          )}
        </div>
      )}
    </div>
  );
}

export default function SearchPage() {
  return (
    <Suspense fallback={<div className="animate-pulse"><h1 className="text-3xl font-bold mb-2">Search</h1><p className="text-[var(--muted-foreground)]">Loading...</p></div>}>
      <SearchPageInner />
    </Suspense>
  );
}
