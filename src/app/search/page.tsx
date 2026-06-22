"use client";

import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { PatternBuilder } from "@/components/search/PatternBuilder";
import { DateTimePicker } from "@/components/DateTimePicker";
import { cleanSourceName } from "@/lib/sourceName";

interface SearchResult {
  id: string;
  content: string;
  sender_name: string;
  timestamp: string;
  conversation_id: string;
  conversation_title: string;
  platform: string;
  is_incoming: number;
  context: Array<{
    id: string;
    content: string | null;
    sender_name: string;
    timestamp: string;
    is_incoming: number;
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
  type: "source" | "participant" | "platform" | "conversation" | "sender";
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

function SearchPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState<SearchMode>("contains");
  const [matchCase, setMatchCase] = useState(false);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [contextLines, setContextLines] = useState(3);
  const [contextMode, setContextMode] = useState<ContextMode>("time");
  const [contextCustom, setContextCustom] = useState(false);
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
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
  const resultsEndRef = useRef<HTMLDivElement>(null);

  // Scope state
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [selectedSources, setSelectedSources] = useState<Set<string>>(new Set());
  const [selectedPlatforms, setSelectedPlatforms] = useState<Set<string>>(new Set());
  const [selectedParticipants, setSelectedParticipants] = useState<ParticipantRow[]>([]);
  const [selectedConversations, setSelectedConversations] = useState<Set<string>>(new Set());
  const [senderOptions, setSenderOptions] = useState<string[]>([]);
  const [selectedSenders, setSelectedSenders] = useState<Set<string>>(new Set());

  // Dropdowns
  const [sourceDropdownOpen, setSourceDropdownOpen] = useState(false);
  const [convDropdownOpen, setConvDropdownOpen] = useState(false);
  const [senderDropdownOpen, setSenderDropdownOpen] = useState(false);
  const [convSearchText, setConvSearchText] = useState("");
  const [availableConversations, setAvailableConversations] = useState<ConversationRow[]>([]);
  const [participantQuery, setParticipantQuery] = useState("");
  const [participantSuggestions, setParticipantSuggestions] = useState<ParticipantRow[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const suggestRef = useRef<HTMLDivElement>(null);
  const sourceDropRef = useRef<HTMLDivElement>(null);
  const convDropRef = useRef<HTMLDivElement>(null);
  const senderDropRef = useRef<HTMLDivElement>(null);

  const [allPlatforms, setAllPlatforms] = useState<string[]>([]);
  const restoredRef = useRef(false);

  const cameFromConversationRef = useRef(false);

  // Decide initial state on mount: a conversation-scoped search starts fresh;
  // otherwise restore the saved session so navigating away and back is lossless.
  useEffect(() => {
    const convId = searchParams.get("conversationId");
    if (convId) {
      // Fresh scoped search — discard any stale saved filters
      cameFromConversationRef.current = true;
      restoredRef.current = true; // prevent default "select all sources" from clobbering
      try { sessionStorage.removeItem('courtthread_search'); } catch {}
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
      return;
    }
    // No conversation param — restore saved session
    try {
      const saved = sessionStorage.getItem('courtthread_search');
      if (saved) {
        const s = JSON.parse(saved);
        if (s.query) setQuery(s.query);
        if (s.searchMode) setSearchMode(s.searchMode);
        if (s.matchCase !== undefined) setMatchCase(s.matchCase);
        if (s.dateFrom) setDateFrom(s.dateFrom);
        if (s.dateTo) setDateTo(s.dateTo);
        if (s.contextLines !== undefined) setContextLines(s.contextLines);
        if (s.contextMode) setContextMode(s.contextMode);
        if (s.sortOrder) setSortOrder(s.sortOrder);
        if (s.selectedSources) setSelectedSources(new Set(s.selectedSources));
        if (s.selectedSenders) setSelectedSenders(new Set(s.selectedSenders));
        if (s.senderOptions) setSenderOptions(s.senderOptions);
        if (s.selectedConversations) setSelectedConversations(new Set(s.selectedConversations));
        if (s.selectedPlatforms) setSelectedPlatforms(new Set(s.selectedPlatforms));
        if (s.results) setResults(s.results);
        if (s.total !== undefined) setTotal(s.total);
        if (s.page) setPage(s.page);
        if (s.hasMoreResults !== undefined) setHasMoreResults(s.hasMoreResults);
        if (s.expandedResults) setExpandedResults(new Set(s.expandedResults));
        restoredRef.current = true;
      }
    } catch {}
  }, []);

  useEffect(() => {
    fetch("/api/sources").then((r) => r.json()).then((d) => {
      const srcs = d.sources || [];
      setSources(srcs);
      // Default to ALL imports selected (boxes checked) so the UI honestly reflects
      // what would be searched. Skip only when coming from a specific conversation
      // (which selects that conversation's source) — but always backfill an empty
      // selection, even after a restore that didn't carry a source selection.
      if (!cameFromConversationRef.current) {
        setSelectedSources((prev) => prev.size > 0 ? prev : new Set(srcs.map((s: SourceRow) => s.id)));
      }
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
      return;
    }
    const promises = Array.from(selectedSources).map((srcId) =>
      fetch(`/api/conversations?sourceId=${srcId}&limit=500`).then((r) => r.json())
    );
    Promise.all(promises).then((results) => {
      const all = results.flatMap((r) => r.conversations || []);
      setAvailableConversations(all);
    }).catch(() => {});
  }, [selectedSources]);

  const searchParticipants = useCallback(async (q: string) => {
    if (q.length < 3) { setParticipantSuggestions([]); return; }
    try {
      const params = new URLSearchParams({ q });
      if (selectedSources.size > 0) {
        params.set("sourceId", Array.from(selectedSources)[0]);
      }
      const res = await fetch(`/api/participants?${params}`);
      const data = await res.json();
      const already = new Set(selectedParticipants.map((p) => p.display_name + (p.phone_number || "")));
      setParticipantSuggestions(
        (data.participants || []).filter((p: ParticipantRow) => !already.has(p.display_name + (p.phone_number || "")))
      );
      setShowSuggestions(true);
    } catch { /* ignore */ }
  }, [selectedSources, selectedParticipants]);

  useEffect(() => {
    const timer = setTimeout(() => searchParticipants(participantQuery), 200);
    return () => clearTimeout(timer);
  }, [participantQuery, searchParticipants]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (suggestRef.current && !suggestRef.current.contains(e.target as Node)) setShowSuggestions(false);
      if (sourceDropRef.current && !sourceDropRef.current.contains(e.target as Node)) setSourceDropdownOpen(false);
      if (convDropRef.current && !convDropRef.current.contains(e.target as Node)) setConvDropdownOpen(false);
      if (senderDropRef.current && !senderDropRef.current.contains(e.target as Node)) setSenderDropdownOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function addParticipant(p: ParticipantRow) {
    setSelectedParticipants((prev) => [...prev, p]);
    setParticipantQuery("");
    setShowSuggestions(false);
  }

  function removeParticipant(idx: number) {
    setSelectedParticipants((prev) => prev.filter((_, i) => i !== idx));
  }

  function toggleSource(id: string) {
    setSelectedSources((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
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
    ...Array.from(selectedConversations).map((id) => {
      const conv = availableConversations.find((c) => c.id === id);
      return { type: "conversation" as const, id, label: conv?.title || conv?.participant_names || id, detail: conv?.platform };
    }),
    ...Array.from(selectedSenders).map((name) => ({
      type: "sender" as const, id: name, label: `from: ${name}`,
    })),
  ];

  function removeChip(chip: ScopeChip) {
    if (chip.type === "source") toggleSource(chip.id);
    else if (chip.type === "platform") togglePlatform(chip.id);
    else if (chip.type === "conversation") toggleConversation(chip.id);
    else if (chip.type === "sender") toggleSender(chip.id);
    else {
      const idx = selectedParticipants.findIndex((p) => p.id === chip.id);
      if (idx >= 0) removeParticipant(idx);
    }
  }

  function clearAllScope() {
    // Reset to the default state: all imports selected, everything else cleared.
    setSelectedSources(new Set(sources.map((s) => s.id)));
    setSelectedPlatforms(new Set());
    setSelectedParticipants([]);
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
    setSelectedPlatforms(new Set());
    setSelectedSources(new Set(sources.map((s) => s.id)));
    setConvSearchText("");
    // Context is a filter too — reset it to the default.
    setContextMode("time");
    setContextLines(3);
    setContextCustom(false);
    setSearchMode("contains");
    setMatchCase(false);
    hasSearchedRef.current = false;
    // Drop the ?conversationId= (and any other) param so the conversation scope
    // doesn't re-apply on a remount, and clear cached state.
    cameFromConversationRef.current = false;
    restoredRef.current = true; // we are now in an explicit cleared state
    try { sessionStorage.removeItem('courtthread_search'); } catch {}
    if (searchParams.toString()) router.replace(pathname, { scroll: false });
  }

  const filteredConversations = availableConversations.filter((c) => {
    if (!convSearchText.trim()) return true;
    const q = convSearchText.toLowerCase();
    return (c.title || "").toLowerCase().includes(q)
      || (c.participant_names || "").toLowerCase().includes(q);
  });

  async function handleSearch(searchPage = 1, append = false) {
    const trimmed = query.trim();
    const hasOtherFilter = !!(dateFrom || dateTo || selectedSenders.size > 0
      || selectedConversations.size > 0 || selectedParticipants.length > 0
      || selectedPlatforms.size > 0);
    // Allow a query-less search if any other filter is set; otherwise need a term.
    if (!trimmed && !hasOtherFilter) {
      setError("Enter a search term, or apply a date/sender/conversation filter to browse messages.");
      setResults(null);
      return;
    }
    // An empty source selection means the user deselected every import — nothing to search.
    if (sources.length > 0 && selectedSources.size === 0) {
      setError("No imports selected. Choose at least one import (or conversation) to search.");
      setResults(null);
      return;
    }
    // Only block a keyword search that targets the ENTIRE corpus (all imports, nothing
    // else narrowed). Selecting a specific import, conversation, participant, or sender
    // is enough scope on its own.
    const narrowed =
      (sources.length > 0 && selectedSources.size < sources.length) ||
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
        const escaped = effectiveQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
        dateTo: dateTo || undefined,
        contextLines,
        contextMode,
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
      try {
        sessionStorage.setItem('courtthread_search', JSON.stringify({
          query, searchMode, matchCase, dateFrom, dateTo,
          contextLines, contextMode, sortOrder,
          selectedSources: Array.from(selectedSources),
          selectedSenders: Array.from(selectedSenders),
          senderOptions,
          selectedConversations: Array.from(selectedConversations),
          selectedPlatforms: Array.from(selectedPlatforms),
          results: newResults, total: data.total, page: searchPage,
          hasMoreResults: newHasMore,
          expandedResults: Array.from(expandedResults),
        }));
      } catch {}
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

  // Re-run the search whenever ANY filter changes after a first search — not just
  // when the query box is non-empty. A query-less filter search is valid too.
  useEffect(() => {
    if (!hasSearchedRef.current) return;
    if (autoSearchTimerRef.current) clearTimeout(autoSearchTimerRef.current);
    autoSearchTimerRef.current = setTimeout(() => {
      handleSearch(1);
    }, 400);
    return () => { if (autoSearchTimerRef.current) clearTimeout(autoSearchTimerRef.current); };
  }, [matchCase, dateFrom, dateTo, contextLines, contextMode, sortOrder, searchMode,
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

  // Open the full conversation scrolled to this message, with the message and the
  // search term highlighted (same highlight as the result card).
  function showInConversation(result: SearchResult) {
    const params = new URLSearchParams({ messageId: result.id });
    if (query.trim()) params.set("q", query.trim());
    window.open(`/conversations/${result.conversation_id}?${params}`, "_blank");
  }

  // Export search results (all loaded, or a single one) with their context, and
  // with the matched term highlighted to match the on-screen result.
  async function exportResults(single?: SearchResult) {
    setExporting(true);
    try {
      let toExport: SearchResult[];
      if (single) {
        toExport = [single];
      } else if (results && results.length >= total) {
        toExport = results;
      } else {
        // Not all results are loaded — fetch the full set (with context) first.
        const full = await fetchAllResultsForExport();
        toExport = full || results || [];
      }
      const payload = toExport.map((r) => ({
        id: r.id,
        content: r.content,
        sender_name: r.sender_name,
        timestamp: r.timestamp,
        conversation_title: r.conversation_title,
        platform: r.platform,
        context: r.context,
      }));
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "searchResults",
          format: "html",
          query: query.trim(),
          matchCase,
          includeTimestamps: true,
          includeProvenance: true,
          includeContext: true,
          results: payload,
        }),
      });
      if (!res.ok) {
        const e = await res.json();
        setError(e.error || "Export failed");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `CourtThread_Search_${single ? "result" : "results"}.html`;
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
        const escaped = effectiveQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        switch (searchMode) {
          case "starts_with": effectiveQuery = `\\b${escaped}`; break;
          case "ends_with": effectiveQuery = `${escaped}\\b`; break;
          case "whole_word": effectiveQuery = `\\b${escaped}\\b`; break;
          default: effectiveQuery = escaped; break;
        }
      }
      const body: any = {
        query: effectiveQuery, useRegex: true, matchCase,
        dateFrom: dateFrom || undefined, dateTo: dateTo || undefined,
        contextLines, contextMode, sortOrder, page: 1, limit: 100000,
      };
      if (selectedSources.size > 0) body.sourceIds = Array.from(selectedSources);
      if (selectedPlatforms.size > 0) body.platforms = Array.from(selectedPlatforms);
      if (selectedSenders.size > 0) body.senderNames = Array.from(selectedSenders);
      const convIds = new Set<string>();
      for (const p of selectedParticipants) for (const c of p.conversations) convIds.add(c.id);
      for (const cid of selectedConversations) convIds.add(cid);
      if (convIds.size > 0) body.conversationIds = Array.from(convIds);
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
              placeholder={searchMode === "regex" ? "Enter regex pattern..." : "Search messages..."}
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
          {/* Source dropdown */}
          <div className="relative" ref={sourceDropRef}>
            <button
              onClick={() => setSourceDropdownOpen(!sourceDropdownOpen)}
              className={`px-3 py-1.5 rounded-lg border text-sm flex items-center gap-2 transition ${
                selectedSources.size > 0
                  ? "border-purple-500 bg-purple-500/10 text-purple-300"
                  : "border-[var(--border)] hover:border-[var(--primary)]/50"
              }`}
            >
              <span>{sourceLabel}</span>
              <span className="text-[var(--muted-foreground)] text-xs">{sourceDropdownOpen ? "▲" : "▼"}</span>
            </button>

            {sourceDropdownOpen && (
              <div className="absolute z-30 top-full left-0 mt-1 w-80 rounded-lg border border-[var(--border)] bg-[var(--card)] shadow-xl max-h-72 overflow-y-auto">
                {sources.length === 0 ? (
                  <p className="p-3 text-sm text-[var(--muted-foreground)]">No data imported yet</p>
                ) : (
                  <>
                    <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
                      <button
                        onClick={() => { setSelectedSources(new Set(sources.map(s => s.id))); }}
                        className="text-xs text-[var(--primary)] hover:underline"
                      >Select all</button>
                      <button
                        onClick={() => { setSelectedSources(new Set()); setSelectedConversations(new Set()); }}
                        className="text-xs text-[var(--muted-foreground)] hover:underline"
                      >Deselect all</button>
                    </div>
                    {sources.map((src) => (
                      <button key={src.id} onClick={() => toggleSource(src.id)}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-[var(--secondary)]/50 transition flex items-center gap-2"
                      >
                        <span className={`w-4 h-4 rounded border flex items-center justify-center text-xs ${
                          selectedSources.has(src.id) ? "border-purple-500 bg-purple-500 text-white" : "border-[var(--border)]"
                        }`}>
                          {selectedSources.has(src.id) && "✓"}
                        </span>
                        <span className="flex-1 truncate" title={src.filename}>{cleanSourceName(src.filename)}</span>
                        <span className="text-[10px] text-[var(--muted-foreground)] shrink-0">
                          {(src.message_count || 0).toLocaleString()} msgs
                        </span>
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>

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

          {/* Conversation dropdown */}
          {selectedSources.size > 0 && availableConversations.length > 0 && (
            <div className="relative" ref={convDropRef}>
              <button
                onClick={() => setConvDropdownOpen(!convDropdownOpen)}
                className={`px-3 py-1.5 rounded-lg border text-sm flex items-center gap-2 transition ${
                  selectedConversations.size > 0
                    ? "border-cyan-500 bg-cyan-500/10 text-cyan-300"
                    : "border-[var(--border)] hover:border-[var(--primary)]/50"
                }`}
              >
                <span>
                  {selectedConversations.size === 0
                    ? "All conversations"
                    : `${selectedConversations.size} conversation${selectedConversations.size !== 1 ? "s" : ""}`}
                </span>
                <span className="text-[var(--muted-foreground)] text-xs">{convDropdownOpen ? "▲" : "▼"}</span>
              </button>

              {convDropdownOpen && (
                <div className="absolute z-30 top-full left-0 mt-1 w-96 rounded-lg border border-[var(--border)] bg-[var(--card)] shadow-xl">
                  <div className="p-2 border-b border-[var(--border)]">
                    <input
                      type="text"
                      value={convSearchText}
                      onChange={(e) => setConvSearchText(e.target.value)}
                      placeholder="Search conversations..."
                      className="w-full px-2.5 py-1.5 rounded border border-[var(--border)] bg-[var(--background)] text-sm"
                      autoFocus
                    />
                  </div>
                  <div className="max-h-60 overflow-y-auto">
                    <button
                      onClick={() => setSelectedConversations(new Set())}
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-[var(--secondary)]/50 transition flex items-center gap-2 ${
                        selectedConversations.size === 0 ? "text-[var(--primary)]" : ""
                      }`}
                    >
                      <span className={`w-4 h-4 rounded border flex items-center justify-center text-xs ${
                        selectedConversations.size === 0 ? "border-[var(--primary)] bg-[var(--primary)] text-white" : "border-[var(--border)]"
                      }`}>
                        {selectedConversations.size === 0 && "✓"}
                      </span>
                      Search entire import
                    </button>
                    {filteredConversations.map((conv) => (
                      <button key={conv.id} onClick={() => toggleConversation(conv.id)}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-[var(--secondary)]/50 transition flex items-center gap-2"
                      >
                        <span className={`w-4 h-4 shrink-0 rounded border flex items-center justify-center text-xs ${
                          selectedConversations.has(conv.id) ? "border-cyan-500 bg-cyan-500 text-white" : "border-[var(--border)]"
                        }`}>
                          {selectedConversations.has(conv.id) && "✓"}
                        </span>
                        <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] ${PLATFORM_COLORS[conv.platform] || PLATFORM_COLORS.default}`}>
                          {conv.platform}
                        </span>
                        <span className="flex-1 truncate">{conv.title || conv.participant_names || "Untitled"}</span>
                        <span className="text-[10px] text-[var(--muted-foreground)] shrink-0">
                          {(conv.message_count || 0).toLocaleString()}
                        </span>
                      </button>
                    ))}
                    {filteredConversations.length === 0 && convSearchText && (
                      <p className="p-3 text-sm text-[var(--muted-foreground)]">No matching conversations</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

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

          {/* Participant search */}
          <div className="relative" ref={suggestRef}>
            <input
              type="text"
              value={participantQuery}
              onChange={(e) => setParticipantQuery(e.target.value)}
              placeholder="Search person..."
              className="w-44 px-3 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--background)] text-sm"
            />
            {showSuggestions && participantSuggestions.length > 0 && (
              <div className="absolute z-30 top-full left-0 mt-1 w-72 rounded-lg border border-[var(--border)] bg-[var(--card)] shadow-xl max-h-60 overflow-y-auto">
                {participantSuggestions.map((p, i) => (
                  <button key={i} onClick={() => addParticipant(p)}
                    className="w-full text-left px-3 py-2 hover:bg-[var(--secondary)]/50 transition flex items-center justify-between"
                  >
                    <div>
                      <span className="text-sm font-medium">{p.display_name}</span>
                      {p.phone_number && (
                        <span className="text-xs text-[var(--muted-foreground)] ml-2">{p.phone_number}</span>
                      )}
                    </div>
                    <div className="flex gap-1">
                      {p.platforms.map((plat) => (
                        <span key={plat} className={`text-[10px] px-1.5 py-0.5 rounded ${PLATFORM_COLORS[plat] || PLATFORM_COLORS.default}`}>
                          {plat}
                        </span>
                      ))}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
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
                  <option value="1">± 1 {contextMode === "time" ? "min" : "msg"}</option>
                  <option value="3">± 3 {contextMode === "time" ? "min" : "msgs"}</option>
                  <option value="5">± 5 {contextMode === "time" ? "min" : "msgs"}</option>
                  <option value="10">± 10 {contextMode === "time" ? "min" : "msgs"}</option>
                  <option value="20">± 20 {contextMode === "time" ? "min" : "msgs"}</option>
                  <option value="30">± 30 {contextMode === "time" ? "min" : "msgs"}</option>
                  <option value="60">± 60 {contextMode === "time" ? "min" : "msgs"}</option>
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
            <select value={sortOrder} onChange={(e) => setSortOrder(e.target.value as "asc" | "desc")}
              className="px-2 py-1 rounded border border-[var(--border)] bg-[var(--background)] text-sm">
              <option value="desc">Newest first</option>
              <option value="asc">Oldest first</option>
            </select>
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
              {results.length > 0 && (
                <button onClick={() => exportResults()} disabled={exporting}
                  className="px-3 py-1.5 rounded-lg bg-[var(--primary)] text-white text-xs font-medium hover:opacity-90 transition disabled:opacity-50"
                  title="Export all results with context as an HTML exhibit">
                  {exporting ? "Exporting…" : `Export ${total} result${total !== 1 ? "s" : ""}`}
                </button>
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
                <div key={result.id} className="rounded-lg border border-[var(--border)] bg-[var(--card)] overflow-hidden">
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
                      <button type="button" onClick={() => exportResults(result)} disabled={exporting}
                        className="text-xs text-[var(--primary)] hover:underline disabled:opacity-50"
                        title="Export this result with its context">
                        Export
                      </button>
                    </div>
                  </div>

                  {isExpanded && result.context.length > 1 ? (
                    <div className="p-3 space-y-1">
                      {result.context.map((ctx) => {
                        const isMatch = ctx.id === result.id;
                        return (
                          <div key={ctx.id} className={`px-3 py-1.5 rounded text-sm ${isMatch ? "bg-amber-400/10 border border-amber-400/30" : "opacity-70"}`}>
                            <span className="font-medium text-xs text-[var(--muted-foreground)]">{ctx.sender_name}</span>
                            <span className="text-xs text-[var(--muted-foreground)] ml-2">{formatTime(ctx.timestamp)}</span>
                            <p className="mt-0.5">
                              {isMatch && ctx.content ? highlightMatch(ctx.content, query, matchCase) : ctx.content || "[media]"}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="p-4">
                      <p className="text-xs text-[var(--muted-foreground)] mb-1">{result.sender_name}</p>
                      <p className="text-sm">{highlightMatch(result.content, query, matchCase)}</p>
                    </div>
                  )}
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

      {results === null && !error && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-8 text-center text-[var(--muted-foreground)]">
          <p className="mb-3">Enter a search term to find messages.</p>
          {sources.length > 0 && selectedSources.size === 0 && (
            <p className="text-xs font-medium text-amber-500">No imports selected — pick at least one import (or a conversation) to search.</p>
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
