"use client";

import { useState, useEffect, useCallback, useRef, Suspense, memo } from "react";
import { useSearchParams } from "next/navigation";
import { DateTimePicker } from "@/components/DateTimePicker";
import { ImportPicker } from "@/components/ImportPicker";
import { PersonSearch, PersonChip, type PersonSuggestion } from "@/components/PersonSearch";

interface MediaItem {
  media_id: string;
  media_type: string;
  original_filename: string | null;
  local_path: string;
  mime_type: string | null;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  message_id: string;
  content: string | null;
  timestamp: string;
  conversation_id: string;
  source_id: string;
  is_incoming: number;
  sender_name: string;
  conversation_title: string | null;
  // Set by /api/media/browse: true = file confirmed absent on disk (render as missing,
  // do NOT request it); undefined = unknown (request normally).
  missing?: boolean;
}

interface SourceRow {
  id: string;
  filename: string;
  file_type: string;
  conversation_count: number;
  message_count: number;
}

interface ConversationRow {
  id: string;
  title: string | null;
  platform: string;
  message_count: number;
  participant_names: string | null;
}

const PLATFORM_COLORS: Record<string, string> = {
  facebook: "bg-blue-500/20 text-blue-400",
  sms: "bg-green-500/20 text-green-400",
  default: "bg-[var(--secondary)] text-[var(--muted-foreground)]",
};

const MEDIA_TYPE_OPTIONS = [
  { value: "image", label: "Images" },
  { value: "video", label: "Videos" },
  { value: "audio", label: "Audio" },
  { value: "sticker", label: "Stickers" },
  { value: "gif", label: "GIFs" },
];

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
  });
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
}

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

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const MediaThumbnail = memo(function MediaThumbnail({
  item,
  mediaUrl,
  hideMissing,
  sizeClass,
  onFailed,
  onClickImage,
  onShowInConversation,
}: {
  item: MediaItem;
  mediaUrl: string;
  hideMissing: boolean;
  sizeClass: string;
  onFailed: (mediaId: string) => void;
  onClickImage: (item: MediaItem) => void;
  onShowInConversation: (item: MediaItem) => void;
}) {
  // Browse pre-marks files confirmed absent on disk: render them as missing WITHOUT ever
  // requesting them (doomed 404s used to clog the browser's connection pool and made the
  // sidebar nav hang while the grid loaded).
  const [failed, setFailed] = useState(item.missing === true);

  const isVideo = item.media_type === "video";
  const isAudio = item.media_type === "audio";
  const isVisual = !isVideo && !isAudio;

  useEffect(() => {
    if (item.missing === true) onFailed(item.media_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // HEAD-probe videos only when browse couldn't determine existence (missing undefined).
    if (!isVideo || failed || item.missing !== undefined) return;
    fetch(mediaUrl, { method: "HEAD" }).then(r => {
      if (!r.ok) { setFailed(true); onFailed(item.media_id); }
    }).catch(() => { setFailed(true); onFailed(item.media_id); });
  }, [mediaUrl, isVideo]);

  if (hideMissing && failed) return null;

  const handleError = () => { setFailed(true); onFailed(item.media_id); };

  return (
    <div className={`inline-block ${sizeClass} align-top animate-[fadeIn_0.15s_ease-in]`}>
      <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] overflow-hidden group hover:border-[var(--primary)] transition">
        <div
          className="relative w-full bg-black cursor-pointer"
          style={{ paddingBottom: "100%" }}
          onClick={() => !isAudio && !failed ? onClickImage(item) : undefined}
        >
          {isVisual && !failed && (
            <img
              src={mediaUrl}
              alt={item.original_filename || "media"}
              className="absolute inset-0 w-full h-full object-contain"
              loading="lazy"
              onError={handleError}
            />
          )}
          {isVisual && failed && (
            <div className="absolute inset-0 flex items-center justify-center text-[var(--muted-foreground)] text-xs">
              [{item.media_type === "sticker" ? "Sticker" : item.media_type === "gif" ? "GIF" : "Image"} not found]
            </div>
          )}
          {isVideo && !failed && (
            <video
              src={mediaUrl}
              className="absolute inset-0 w-full h-full object-contain pointer-events-none"
              preload="metadata"
            />
          )}
          {isVideo && failed && (
            <div className="absolute inset-0 flex items-center justify-center text-[var(--muted-foreground)] text-xs">
              [Video not found]
            </div>
          )}
          {isAudio && !failed && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-[var(--muted-foreground)]">
              <span className="text-3xl">🎵</span>
              <audio src={mediaUrl} controls preload="metadata" className="w-[90%]" onError={handleError} />
            </div>
          )}
          {isAudio && failed && (
            <div className="absolute inset-0 flex items-center justify-center text-[var(--muted-foreground)] text-xs">
              [Audio not found]
            </div>
          )}
          {item.duration_seconds != null && item.duration_seconds > 0 && !failed && (
            <span className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/70 text-white text-xs">
              {formatDuration(item.duration_seconds)}
            </span>
          )}
          {item.media_type === "gif" && !failed && (
            <span className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-black/70 text-white text-xs font-medium">
              GIF
            </span>
          )}
          {item.media_type === "sticker" && !failed && (
            <span className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-purple-500/80 text-white text-xs font-medium">
              Sticker
            </span>
          )}
          {isVideo && !failed && (
            <>
              <span className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-black/70 text-white text-xs font-medium">
                Video
              </span>
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="w-12 h-12 rounded-full bg-black/50 flex items-center justify-center group-hover:bg-black/70 transition">
                  <svg className="w-6 h-6 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                </div>
              </div>
            </>
          )}
        </div>
        <div className="px-2 py-1.5">
          <p className="text-xs text-[var(--muted-foreground)] truncate">
            {formatTime(item.timestamp)}
          </p>
          <p className="text-xs truncate">
            <span className="font-medium">{item.sender_name}</span>
            {item.conversation_title && (
              <span className="text-[var(--muted-foreground)]"> in {item.conversation_title}</span>
            )}
          </p>
          {item.content && (
            <p className="text-xs text-[var(--muted-foreground)] truncate mt-0.5" title={item.content}>
              {item.content}
            </p>
          )}
          <button
            onClick={() => onShowInConversation(item)}
            className="text-xs text-[var(--primary)] hover:underline mt-1"
          >
            Show in conversation
          </button>
        </div>
      </div>
    </div>
  );
});

const MEDIA_PREFS_KEY = "courtthread_media_prefs";

function loadMediaPrefs(): Record<string, any> {
  try {
    const raw = localStorage.getItem(MEDIA_PREFS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveMediaPrefs(prefs: Record<string, any>) {
  try { localStorage.setItem(MEDIA_PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
}

function MediaGalleryInner() {
  const searchParams = useSearchParams();
  const cameFromConversationRef = useRef(false);

  const [prefsLoaded, setPrefsLoaded] = useState(false);

  const [sources, setSources] = useState<SourceRow[]>([]);
  const [selectedSources, setSelectedSources] = useState<Set<string>>(new Set());
  const [selectedConversations, setSelectedConversations] = useState<Set<string>>(new Set());
  const [selectedSenders, setSelectedSenders] = useState<Set<string>>(new Set());
  // Picked via "Search person" — tracked SEPARATELY from selectedConversations (the manual
  // Conversations-dropdown checkboxes) so there's a dedicated, removable chip and picking a
  // person never silently merges into / gets confused with a manual selection.
  const [includedParticipants, setIncludedParticipants] = useState<PersonSuggestion[]>([]);
  // Exempts whole conversations these people are part of (e.g. the "Facebook user"
  // placeholder or numeric-only unresolved names) from the media grid entirely.
  const [excludedParticipants, setExcludedParticipants] = useState<PersonSuggestion[]>([]);
  const [selectedPlatforms, setSelectedPlatforms] = useState<Set<string>>(new Set());
  const [selectedMediaTypes, setSelectedMediaTypes] = useState<Set<string>>(new Set());
  const [senderOptions, setSenderOptions] = useState<string[]>([]);
  const [allPlatforms, setAllPlatforms] = useState<string[]>([]);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [thumbSize, setThumbSize] = useState<"small" | "medium" | "large" | "xlarge">("medium");
  // Defaults: NOT grouped by date, missing media HIDDEN — per Jeremy's preference.
  const [groupByDate, setGroupByDate] = useState(false);
  const [hideMissing, setHideMissing] = useState(true);

  useEffect(() => {
    // Arriving from a conversation's "Media" button: start fresh, scoped to just that
    // conversation, instead of restoring whatever was previously browsed (same pattern
    // as Search's conversationId handling).
    const convId = searchParams.get("conversationId");
    if (convId) {
      cameFromConversationRef.current = true;
      setSelectedConversations(new Set([convId]));
      fetch(`/api/conversations/${convId}`).then((r) => r.json()).then((d) => {
        if (d.source_id) setSelectedSources(new Set([d.source_id]));
        setAvailableConversations((prev) => {
          if (prev.some((c) => c.id === convId)) return prev;
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
    const saved = loadMediaPrefs();
    if (saved.sources?.length) setSelectedSources(new Set(saved.sources));
    if (saved.conversations?.length) setSelectedConversations(new Set(saved.conversations));
    if (saved.senders?.length) setSelectedSenders(new Set(saved.senders));
    if (saved.includedParticipants?.length) setIncludedParticipants(saved.includedParticipants);
    if (saved.excludedParticipants?.length) setExcludedParticipants(saved.excludedParticipants);
    if (saved.platforms?.length) setSelectedPlatforms(new Set(saved.platforms));
    if (saved.mediaTypes?.length) setSelectedMediaTypes(new Set(saved.mediaTypes));
    if (saved.dateFrom) setDateFrom(saved.dateFrom);
    if (saved.dateTo) setDateTo(saved.dateTo);
    if (saved.sortOrder) setSortOrder(saved.sortOrder);
    if (saved.thumbSize) setThumbSize(saved.thumbSize);
    if (saved.groupByDate !== undefined) setGroupByDate(saved.groupByDate);
    if (saved.hideMissing !== undefined) setHideMissing(saved.hideMissing);
    if (saved.convSearchText) setConvSearchText(saved.convSearchText);
    setPrefsLoaded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [failedCount, setFailedCount] = useState(0);
  const failedCountRef = useRef(0);
  const failedIdsRef = useRef<Set<string>>(new Set());
  const failedFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [availableConversations, setAvailableConversations] = useState<ConversationRow[]>([]);
  const [convSearchText, setConvSearchText] = useState("");

  const [convDropdownOpen, setConvDropdownOpen] = useState(false);
  const [senderDropdownOpen, setSenderDropdownOpen] = useState(false);
  const [mediaTypeDropdownOpen, setMediaTypeDropdownOpen] = useState(false);
  const convDropRef = useRef<HTMLDivElement>(null);
  const senderDropRef = useRef<HTMLDivElement>(null);
  const mediaTypeDropRef = useRef<HTMLDivElement>(null);

  const [items, setItems] = useState<MediaItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const observerRef = useRef<HTMLDivElement>(null);
  const hasSearchedRef = useRef(false);

  const [lightboxItem, setLightboxItem] = useState<MediaItem | null>(null);

  useEffect(() => {
    if (!prefsLoaded) return;
    saveMediaPrefs({
      sources: Array.from(selectedSources),
      conversations: Array.from(selectedConversations),
      senders: Array.from(selectedSenders),
      includedParticipants,
      excludedParticipants,
      platforms: Array.from(selectedPlatforms),
      mediaTypes: Array.from(selectedMediaTypes),
      dateFrom,
      dateTo,
      sortOrder,
      thumbSize,
      groupByDate,
      hideMissing,
      convSearchText,
    });
  }, [prefsLoaded, selectedSources, selectedConversations, includedParticipants, selectedSenders, excludedParticipants,
      selectedPlatforms, selectedMediaTypes, dateFrom, dateTo, sortOrder, thumbSize, groupByDate,
      hideMissing, convSearchText]);

  // Lightbox keyboard nav + load-ahead is defined lower (it needs loadMedia).

  // Preload nearby images for smooth lightbox navigation
  useEffect(() => {
    if (!lightboxItem) return;
    const currentIdx = items.findIndex(i => i.media_id === lightboxItem.media_id);
    const toPreload: string[] = [];
    for (let i = currentIdx - 2; i <= currentIdx + 5; i++) {
      if (i >= 0 && i < items.length && i !== currentIdx) {
        const it = items[i];
        if (it.media_type !== "video" && it.media_type !== "audio" && !failedIdsRef.current.has(it.media_id)) {
          toPreload.push(getMediaUrl(it));
        }
      }
    }
    for (const url of toPreload) {
      const img = new Image();
      img.src = url;
    }
  }, [lightboxItem, items]);

  useEffect(() => {
    fetch("/api/sources").then((r) => r.json()).then((d) => {
      // Exclude sources whose every conversation is just a redundant copy of one already
      // present in an earlier import (see is_duplicate_source in getSources) — otherwise
      // the same import shows up twice in the picker, doubling media counts for no new data.
      const srcList: SourceRow[] = (d.sources || []).filter((s: any) => !s.is_duplicate_source);
      setSources(srcList);
      const validIds = new Set(srcList.map((s) => s.id));
      setSelectedSources((prev) => {
        const pruned = new Set(Array.from(prev).filter((id) => validIds.has(id)));
        return pruned.size === prev.size ? prev : pruned;
      });
    }).catch(() => {});
    fetch("/api/conversations?limit=0").then((r) => r.json()).then((d) => {
      if (d.platforms) setAllPlatforms(d.platforms);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (selectedSources.size === 0) {
      // Arriving from a conversation link: selectedConversations is already seeded, but
      // its source is still being looked up asynchronously (selectedSources is briefly
      // empty during that window) — don't let this effect race in and clear it first.
      if (cameFromConversationRef.current) return;
      setAvailableConversations([]);
      setSelectedConversations((prev) => (prev.size === 0 ? prev : new Set()));
      return;
    }
    cameFromConversationRef.current = false;
    const promises = Array.from(selectedSources).map((srcId) =>
      fetch(`/api/conversations?sourceId=${srcId}&limit=500`).then((r) => r.json())
    );
    Promise.all(promises).then((results) => {
      const all = results.flatMap((r) => r.conversations || []);
      setAvailableConversations(all);
      const validIds = new Set(all.map((c: ConversationRow) => c.id));
      setSelectedConversations((prev) => {
        if (prev.size === 0) return prev;
        const pruned = new Set(Array.from(prev).filter((id) => validIds.has(id)));
        return pruned.size === prev.size ? prev : pruned;
      });
    }).catch(() => {});
  }, [selectedSources]);

  useEffect(() => {
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
    function handleClick(e: MouseEvent) {
      if (convDropRef.current && !convDropRef.current.contains(e.target as Node)) setConvDropdownOpen(false);
      if (senderDropRef.current && !senderDropRef.current.contains(e.target as Node)) setSenderDropdownOpen(false);
      if (mediaTypeDropRef.current && !mediaTypeDropRef.current.contains(e.target as Node)) setMediaTypeDropdownOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const PAGE_SIZE = 50;
  const prefetchRef = useRef<{ page: number; items: any[]; total: number } | null>(null);
  const prefetchingRef = useRef(false);

  function buildRequestBody(forPage: number) {
    const body: any = { sortOrder, page: forPage, limit: PAGE_SIZE };
    // Server-side: skip files confirmed absent so every returned page is full of REAL,
    // renderable media. (Client-side hiding of whole pages left the viewport empty and
    // the auto-loader chained through the entire catalog "incessantly".)
    if (hideMissing) body.hideMissing = true;
    if (selectedSources.size > 0) body.sourceIds = Array.from(selectedSources);
    // Union of the manual Conversations-dropdown checkboxes AND every included person's
    // conversations (kept as separate state so each has its own removable chip).
    const includeConvIds = new Set(selectedConversations);
    for (const p of includedParticipants) for (const c of p.conversations) includeConvIds.add(c.id);
    if (includeConvIds.size > 0) body.conversationIds = Array.from(includeConvIds);
    if (selectedSenders.size > 0) body.senderNames = Array.from(selectedSenders);
    // Resolve each excluded PERSON to conversation ids (not participant ids): one display
    // name like "Facebook user" can be a separate participant row per import, so a name-
    // level or single-id lookup would miss all but one of them.
    if (excludedParticipants.length > 0) {
      const excludeConvIds = new Set<string>();
      for (const p of excludedParticipants) for (const c of p.conversations) excludeConvIds.add(c.id);
      if (excludeConvIds.size > 0) body.excludeConversationIds = Array.from(excludeConvIds);
    }
    if (selectedPlatforms.size > 0) body.platforms = Array.from(selectedPlatforms);
    if (selectedMediaTypes.size > 0) body.mediaTypes = Array.from(selectedMediaTypes);
    if (dateFrom) body.dateFrom = dateFrom;
    if (dateTo) body.dateTo = toInclusiveEnd(dateTo);
    return body;
  }

  async function prefetchNext(nextPage: number, totalItems: number) {
    if (prefetchingRef.current) return;
    if (nextPage * PAGE_SIZE >= totalItems) return;
    prefetchingRef.current = true;
    try {
      const res = await fetch("/api/media/browse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildRequestBody(nextPage + 1)),
      });
      const data = await res.json();
      if (res.ok) {
        prefetchRef.current = { page: nextPage + 1, items: data.items, total: data.total };
      }
    } catch { /* prefetch failure is non-fatal */ }
    prefetchingRef.current = false;
  }

  const loadMedia = useCallback(async (loadPage = 1, append = false) => {
    const hasScope = selectedSources.size > 0 || selectedConversations.size > 0
      || includedParticipants.length > 0 || selectedSenders.size > 0 || selectedPlatforms.size > 0
      || !!dateFrom || !!dateTo;

    if (!hasScope) {
      setError("Select at least one filter to browse media.");
      setItems([]);
      setTotal(0);
      return;
    }

    if (append) setLoadingMore(true); else {
      setLoading(true);
      failedCountRef.current = 0;
      failedIdsRef.current = new Set();
      setFailedCount(0);
      prefetchRef.current = null;
    }
    setError(null);

    try {
      // If we have prefetched data for this page, use it instantly
      if (append && prefetchRef.current && prefetchRef.current.page === loadPage) {
        const pf = prefetchRef.current;
        prefetchRef.current = null;
        setItems(prev => [...prev, ...pf.items]);
        setTotal(pf.total);
        setPage(loadPage);
        const more = loadPage * PAGE_SIZE < pf.total;
        setHasMore(more);
        setLoadingMore(false);
        if (more) prefetchNext(loadPage, pf.total);
        return;
      }

      const res = await fetch("/api/media/browse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildRequestBody(loadPage)),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      if (append) {
        setItems(prev => [...prev, ...data.items]);
      } else {
        setItems(data.items);
      }
      setTotal(data.total);
      setPage(loadPage);
      const more = loadPage * PAGE_SIZE < data.total;
      setHasMore(more);
      hasSearchedRef.current = true;
      if (more) prefetchNext(loadPage, data.total);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [selectedSources, selectedConversations, includedParticipants, selectedSenders, excludedParticipants,
      selectedPlatforms, selectedMediaTypes, dateFrom, dateTo, sortOrder, hideMissing]);

  // Auto-search when any filter changes (incl. Hide missing - it's server-side now)
  useEffect(() => {
    const hasScope = selectedSources.size > 0 || selectedConversations.size > 0
      || includedParticipants.length > 0 || selectedSenders.size > 0 || selectedPlatforms.size > 0
      || !!dateFrom || !!dateTo;
    if (!hasScope) return;
    setPage(1);
    loadMedia(1);
  }, [selectedSources, selectedConversations, includedParticipants, selectedSenders, excludedParticipants,
      selectedPlatforms, selectedMediaTypes, dateFrom, dateTo, sortOrder, hideMissing]);

  // HARD CAP on pages loaded without a real user scroll: a runaway chain once appended
  // the whole catalog and froze the tab under thousands of DOM nodes. Scrolling resets it.
  const autoChainRef = useRef(0);
  useEffect(() => {
    const onScroll = () => { autoChainRef.current = 0; };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const el = observerRef.current;
    if (!el) return;
    const maybeLoad = () => {
      if (!hasMore || loading || loadingMore || !hasSearchedRef.current) return;
      if (autoChainRef.current >= 3) return; // wait for a real scroll before continuing
      const rect = el.getBoundingClientRect();
      if (rect.top < window.innerHeight + 400) {
        autoChainRef.current += 1;
        loadMedia(page + 1, true);
      }
    };
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) maybeLoad();
    }, { threshold: 0.1, rootMargin: "400px" });
    observer.observe(el);
    // A finished load re-runs this effect. If the sentinel is STILL in view (fast loads,
    // or hideMissing hid the new rows), no new intersection event will ever come — check
    // directly and chain the next page. loading/loadingMore/hasMore gate the recursion.
    maybeLoad();
    // Belt-and-braces: intersection events can be missed while the user rests at the
    // bottom (Jeremy: "it just sits there until I scroll up and back down"). A cheap
    // periodic visibility re-check guarantees the next page loads — capped above.
    const tick = setInterval(maybeLoad, 700);
    return () => { observer.disconnect(); clearInterval(tick); };
  }, [hasMore, loading, loadingMore, page, loadMedia]);

  // --- Lightbox navigation with load-ahead ---------------------------------
  // Arrowing forward pulls in the next page as it nears the end, so the preview keeps
  // going through the whole set (and the grid keeps filling in behind it) instead of
  // freezing at the last loaded picture.
  const pendingAdvanceRef = useRef<string | null>(null);
  const nextUsableFrom = useCallback((fromIdx: number, dir: 1 | -1) => {
    for (let i = fromIdx + dir; i >= 0 && i < items.length; i += dir) {
      const it = items[i];
      if (it.media_type === "audio") continue;
      if (hideMissing && failedIdsRef.current.has(it.media_id)) continue;
      return i;
    }
    return -1;
  }, [items, hideMissing]);

  const goLightbox = useCallback((dir: 1 | -1) => {
    if (!lightboxItem) return;
    const idx = items.findIndex(i => i.media_id === lightboxItem.media_id);
    if (idx < 0) return;
    const nextIdx = nextUsableFrom(idx, dir);
    // Keep loading ahead (like continuous scroll) whenever we're within a page's reach of
    // the end. autoChainRef reset = treat arrowing as user activity, past the idle cap.
    if (dir === 1 && hasMore && !loadingMore && (nextIdx < 0 || nextIdx >= items.length - 8)) {
      autoChainRef.current = 0;
      loadMedia(page + 1, true);
    }
    if (nextIdx >= 0) setLightboxItem(items[nextIdx]);
    else if (dir === 1 && hasMore) pendingAdvanceRef.current = lightboxItem.media_id; // advance when it arrives
  }, [lightboxItem, items, hasMore, loadingMore, page, loadMedia, nextUsableFrom]);

  // Complete a pending forward-advance once the next page has appended.
  useEffect(() => {
    const pid = pendingAdvanceRef.current;
    if (!pid) return;
    const idx = items.findIndex(i => i.media_id === pid);
    if (idx < 0) { if (!hasMore) pendingAdvanceRef.current = null; return; }
    const nextIdx = nextUsableFrom(idx, 1);
    if (nextIdx >= 0) { pendingAdvanceRef.current = null; setLightboxItem(items[nextIdx]); }
    else if (!hasMore) pendingAdvanceRef.current = null;
  }, [items, hasMore, nextUsableFrom]);

  // Keyboard nav for the lightbox (here so it can trigger load-ahead via goLightbox).
  useEffect(() => {
    if (!lightboxItem) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") { setLightboxItem(null); return; }
      if (e.key === "ArrowLeft") { e.preventDefault(); goLightbox(-1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); goLightbox(1); }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [lightboxItem, goLightbox]);

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

  // Picking a person broadens scope to include all their conversations (mirrors Search's
  // include-participant); excluding removes any conversation involving that person entirely.
  // Both are kept as their OWN chip lists (not merged into selectedConversations) so there's
  // a visible, individually-removable indicator for each pick.
  function addIncludedPerson(p: PersonSuggestion) {
    setIncludedParticipants((prev) => prev.some((x) => x.id === p.id) ? prev : [...prev, p]);
    setExcludedParticipants((prev) => prev.filter((x) => x.id !== p.id));
  }

  function removeIncludedPerson(id: string) {
    setIncludedParticipants((prev) => prev.filter((x) => x.id !== id));
  }

  function addExcludedPerson(p: PersonSuggestion) {
    setExcludedParticipants((prev) => prev.some((x) => x.id === p.id) ? prev : [...prev, p]);
    setIncludedParticipants((prev) => prev.filter((x) => x.id !== p.id));
  }

  function removeExcludedPerson(id: string) {
    setExcludedParticipants((prev) => prev.filter((x) => x.id !== id));
  }

  function togglePlatform(p: string) {
    setSelectedPlatforms((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p); else next.add(p);
      return next;
    });
  }

  function toggleMediaType(t: string) {
    setSelectedMediaTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t); else next.add(t);
      return next;
    });
  }

  function clearAll() {
    setSelectedSources(new Set());
    setSelectedConversations(new Set());
    setSelectedSenders(new Set());
    setIncludedParticipants([]);
    setExcludedParticipants([]);
    setSelectedPlatforms(new Set());
    setSelectedMediaTypes(new Set());
    setDateFrom("");
    setDateTo("");
    setItems([]);
    setTotal(0);
    setError(null);
    failedCountRef.current = 0;
    failedIdsRef.current = new Set();
    setFailedCount(0);
    hasSearchedRef.current = false;
  }

  const handleClickImage = useCallback((item: MediaItem) => setLightboxItem(item), []);
  const handleShowInConversation = useCallback((item: MediaItem) => {
    // New tab — preserve the gallery's scroll/filters/preview (same as the lightbox link).
    window.open(`/conversations/${item.conversation_id}?messageId=${item.message_id}`, "_blank", "noopener");
  }, []);

  const handleMediaFailed = useCallback((mediaId: string) => {
    if (!failedIdsRef.current.has(mediaId)) {
      failedIdsRef.current.add(mediaId);
      failedCountRef.current += 1;
      if (!failedFlushTimer.current) {
        failedFlushTimer.current = setTimeout(() => {
          setFailedCount(failedCountRef.current);
          failedFlushTimer.current = null;
        }, 200);
      }
    }
  }, []);

  function getMediaUrl(item: MediaItem): string {
    const filename = item.original_filename || item.local_path.split(/[/\\]/).pop() || "";
    return `/api/media?sourceId=${encodeURIComponent(item.source_id)}&filename=${encodeURIComponent(filename)}&type=${item.media_type}`;
  }

  function showInConversation(item: MediaItem) {
    // Open in a NEW TAB so the media gallery (scroll position, filters, the open preview)
    // is preserved — going back in the same tab lost the user's place entirely.
    window.open(`/conversations/${item.conversation_id}?messageId=${item.message_id}`, "_blank", "noopener");
  }

  const filteredConversations = availableConversations.filter((c) => {
    if (!convSearchText.trim()) return true;
    const q = convSearchText.toLowerCase();
    return (c.title || "").toLowerCase().includes(q)
      || (c.participant_names || "").toLowerCase().includes(q);
  });

  const thumbWidthClass: Record<string, string> = {
    small: "w-[calc(10%-8px)] mx-[4px] mb-2",
    medium: "w-[calc(16.666%-10px)] mx-[5px] mb-3",
    large: "w-[calc(25%-12px)] mx-[6px] mb-4",
    xlarge: "w-[calc(50%-12px)] mx-[6px] mb-4",
  };

  function getDateKey(iso: string): string {
    return new Date(iso).toLocaleDateString("en-CA");
  }

  const groupedItems: Array<{ type: "date"; date: string } | { type: "media"; item: MediaItem }> = [];
  let lastDate = "";
  for (const item of items) {
    if (groupByDate) {
      const dk = getDateKey(item.timestamp);
      if (dk !== lastDate) {
        groupedItems.push({ type: "date", date: item.timestamp });
        lastDate = dk;
      }
    }
    groupedItems.push({ type: "media", item });
  }

  return (
    <div>
      <h1 className="text-3xl font-bold mb-2">Media Gallery</h1>
      <p className="text-[var(--muted-foreground)] mb-4">
        Browse photos, videos, and other media from your imported conversations.
      </p>

      {/* Filters */}
      <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 mb-4 space-y-3">
        <div className="flex flex-wrap gap-3 items-start">
          {/* Source dropdown (searchable by import name or participant) */}
          <ImportPicker sources={sources} selected={selectedSources} onChange={setSelectedSources} multi placeholder="Imports" />

          {/* Conversation dropdown — hidden once locked to exactly one conversation
              (nothing left to pick; use "Clear all" to broaden back out). */}
          {availableConversations.length > 0 && selectedConversations.size !== 1 && (
            <div className="relative" ref={convDropRef}>
              <button
                onClick={() => setConvDropdownOpen(!convDropdownOpen)}
                className={`px-3 py-2 rounded-lg border text-sm transition min-w-[160px] text-left ${
                  selectedConversations.size > 0
                    ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary)]"
                    : "border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--primary)]/50"
                }`}
              >
                {selectedConversations.size === 0 ? "Conversations" : `${selectedConversations.size} conv.`}
                <span className="ml-2 opacity-60">▾</span>
              </button>
              {convDropdownOpen && (
                <div className="absolute z-50 mt-1 w-80 max-h-64 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--card)] shadow-lg p-2">
                  <input
                    type="text" value={convSearchText} onChange={(e) => setConvSearchText(e.target.value)}
                    placeholder="Filter conversations..."
                    className="w-full mb-2 px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--background)] text-sm"
                  />
                  {filteredConversations.map((c) => (
                    <label key={c.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[var(--secondary)] cursor-pointer text-sm">
                      <input type="checkbox" checked={selectedConversations.has(c.id)} onChange={() => toggleConversation(c.id)} className="rounded" />
                      <span className="truncate flex-1">{c.title || c.participant_names || "Untitled"}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Sender dropdown */}
          {senderOptions.length > 0 && (
            <div className="relative" ref={senderDropRef}>
              <button
                onClick={() => setSenderDropdownOpen(!senderDropdownOpen)}
                className={`px-3 py-2 rounded-lg border text-sm transition min-w-[120px] text-left ${
                  selectedSenders.size > 0
                    ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary)]"
                    : "border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--primary)]/50"
                }`}
              >
                {selectedSenders.size === 0 ? "Sender" : `${selectedSenders.size} sender${selectedSenders.size > 1 ? "s" : ""}`}
                <span className="ml-2 opacity-60">▾</span>
              </button>
              {senderDropdownOpen && (
                <div className="absolute z-50 mt-1 w-60 max-h-48 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--card)] shadow-lg p-2">
                  {senderOptions.map((name) => (
                    <label key={name} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[var(--secondary)] cursor-pointer text-sm">
                      <input type="checkbox" checked={selectedSenders.has(name)} onChange={() => toggleSender(name)} className="rounded" />
                      <span className="truncate">{name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Search person (include) — broadens scope to that person's conversations */}
          <PersonSearch
            placeholder="Search person..."
            sourceId={selectedSources.size === 1 ? Array.from(selectedSources)[0] : undefined}
            conversationId={selectedConversations.size === 1 ? Array.from(selectedConversations)[0] : undefined}
            excludeIds={new Set([...includedParticipants, ...excludedParticipants].map((p) => p.id))}
            onSelect={addIncludedPerson}
            className="w-44"
          />

          {/* Exclude person — exempts whole conversations this person is part of (e.g. the
              "Facebook user" placeholder, or numeric-only unresolved names). */}
          <PersonSearch
            placeholder="Exclude person..."
            sourceId={selectedSources.size === 1 ? Array.from(selectedSources)[0] : undefined}
            conversationId={selectedConversations.size === 1 ? Array.from(selectedConversations)[0] : undefined}
            excludeIds={new Set([...includedParticipants, ...excludedParticipants].map((p) => p.id))}
            onSelect={addExcludedPerson}
            className="w-44"
          />

          {/* Platform dropdown */}
          {allPlatforms.length > 1 && (
            <select
              value={selectedPlatforms.size === 1 ? Array.from(selectedPlatforms)[0] : ""}
              onChange={(e) => setSelectedPlatforms(e.target.value ? new Set([e.target.value]) : new Set())}
              className="px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--background)] text-sm"
            >
              <option value="">All platforms</option>
              {allPlatforms.map(p => <option key={p} value={p}>{p === "facebook" ? "Facebook" : p === "sms" ? "SMS" : p}</option>)}
            </select>
          )}

          {/* Media type dropdown */}
          <div className="relative" ref={mediaTypeDropRef}>
            <button
              onClick={() => setMediaTypeDropdownOpen(!mediaTypeDropdownOpen)}
              className={`px-3 py-2 rounded-lg border text-sm transition min-w-[120px] text-left ${
                selectedMediaTypes.size > 0
                  ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary)]"
                  : "border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--primary)]/50"
              }`}
            >
              {selectedMediaTypes.size === 0 ? "All media" : `${selectedMediaTypes.size} type${selectedMediaTypes.size > 1 ? "s" : ""}`}
              <span className="ml-2 opacity-60">▾</span>
            </button>
            {mediaTypeDropdownOpen && (
              <div className="absolute z-50 mt-1 w-48 rounded-lg border border-[var(--border)] bg-[var(--card)] shadow-lg p-2">
                {MEDIA_TYPE_OPTIONS.map((opt) => (
                  <label key={opt.value} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[var(--secondary)] cursor-pointer text-sm">
                    <input type="checkbox" checked={selectedMediaTypes.has(opt.value)} onChange={() => toggleMediaType(opt.value)} className="rounded" />
                    <span>{opt.label}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <select
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value as "asc" | "desc")}
            className="px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--background)] text-sm"
          >
            <option value="desc">Newest first</option>
            <option value="asc">Oldest first</option>
          </select>

          <select
            value={thumbSize}
            onChange={(e) => setThumbSize(e.target.value as typeof thumbSize)}
            className="px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--background)] text-sm"
          >
            <option value="small">Small</option>
            <option value="medium">Medium</option>
            <option value="large">Large</option>
            <option value="xlarge">Extra large</option>
          </select>

          <button
            onClick={() => setGroupByDate(!groupByDate)}
            className={`px-3 py-2 rounded-lg border text-sm transition ${
              groupByDate
                ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary)]"
                : "border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--primary)]/50"
            }`}
          >
            Group by date
          </button>

          <button
            onClick={() => setHideMissing(!hideMissing)}
            className={`px-3 py-2 rounded-lg border text-sm transition ${
              hideMissing
                ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary)]"
                : "border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--primary)]/50"
            }`}
          >
            {hideMissing ? "Hiding missing" : "Hide missing media"}
          </button>
        </div>

        {/* Included / excluded people */}
        {(includedParticipants.length > 0 || excludedParticipants.length > 0) && (
          <div className="flex flex-wrap gap-1.5">
            {includedParticipants.map((p) => (
              <PersonChip key={p.id} person={p} onRemove={() => removeIncludedPerson(p.id)} />
            ))}
            {excludedParticipants.map((p) => (
              <PersonChip key={p.id} person={p} tone="destructive" onRemove={() => removeExcludedPerson(p.id)} />
            ))}
          </div>
        )}

        {/* Date range */}
        <div className="flex flex-wrap gap-3 items-end">
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

        {/* Action buttons */}
        <div className="flex gap-3">
          <button onClick={clearAll}
            className="px-4 py-2 rounded-lg border border-[var(--border)] text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
            Clear all
          </button>
          {total > 0 && (
            <span className="self-center text-sm text-[var(--muted-foreground)]">
              {total.toLocaleString()} media item{total !== 1 ? "s" : ""}
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-[var(--destructive)]/30 bg-[var(--destructive)]/10 p-3 mb-4 text-sm text-[var(--destructive)]">
          {error}
        </div>
      )}

      {/* Gallery grid */}
      {items.length > 0 ? (
        <div>
          {groupedItems.map((entry, idx) => {
            if (entry.type === "date") {
              return (
                <div key={`date-${idx}`} className="flex items-center gap-4 my-4">
                  <div className="flex-1 h-px bg-[var(--border)]" />
                  <span className="text-xs text-[var(--muted-foreground)] font-medium">{formatDate(entry.date)}</span>
                  <div className="flex-1 h-px bg-[var(--border)]" />
                </div>
              );
            }
            const item = entry.item;
            return (
              <MediaThumbnail
                key={`${item.media_id}_${idx}`}
                item={item}
                mediaUrl={getMediaUrl(item)}
                hideMissing={hideMissing}
                sizeClass={thumbWidthClass[thumbSize]}
                onFailed={handleMediaFailed}
                onClickImage={handleClickImage}
                onShowInConversation={handleShowInConversation}
              />
            );
          })}

          <div ref={observerRef} className="h-10 flex items-center justify-center clear-both">
            {loadingMore && <span className="text-sm text-[var(--muted-foreground)]">Loading more...</span>}
          </div>
        </div>
      ) : hasSearchedRef.current && !loading ? (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-8 text-center text-[var(--muted-foreground)]">
          No media found matching your filters.
        </div>
      ) : !hasSearchedRef.current && !loading ? (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-8 text-center text-[var(--muted-foreground)]">
          Select at least one filter above to browse media from your conversations.
        </div>
      ) : null}

      {/* Lightbox */}
      {lightboxItem && (() => {
        const currentIdx = items.findIndex(i => i.media_id === lightboxItem.media_id);
        const isLightboxVideo = lightboxItem.media_type === "video";
        const isUsable = (it: MediaItem) => {
          if (it.media_type === "audio") return false;
          if (hideMissing && failedIdsRef.current.has(it.media_id)) return false;
          return true;
        };
        let prevItem: MediaItem | null = null;
        for (let i = currentIdx - 1; i >= 0; i--) {
          if (isUsable(items[i])) { prevItem = items[i]; break; }
        }
        let nextItem: MediaItem | null = null;
        for (let i = currentIdx + 1; i < items.length; i++) {
          if (isUsable(items[i])) { nextItem = items[i]; break; }
        }
        return (
        <div
          className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center"
          onClick={() => setLightboxItem(null)}
        >
          {prevItem && (
            <button
              onClick={(e) => { e.stopPropagation(); goLightbox(-1); }}
              className="fixed left-4 top-1/2 -translate-y-1/2 z-[102] w-12 h-12 rounded-full bg-black/60 text-white text-2xl flex items-center justify-center hover:bg-black/80 transition"
            >
              ‹
            </button>
          )}
          {(nextItem || hasMore) && (
            <button
              onClick={(e) => { e.stopPropagation(); goLightbox(1); }}
              className="fixed right-4 top-1/2 -translate-y-1/2 z-[102] w-12 h-12 rounded-full bg-black/60 text-white text-2xl flex items-center justify-center hover:bg-black/80 transition"
            >
              ›
            </button>
          )}
          <div className="relative max-w-[85vw] max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
            {isLightboxVideo ? (
              <video
                key={lightboxItem.media_id}
                src={getMediaUrl(lightboxItem)}
                className="max-w-[85vw] max-h-[85vh] object-contain"
                controls
                autoPlay
              />
            ) : (
              <img
                src={getMediaUrl(lightboxItem)}
                alt={lightboxItem.original_filename || "media"}
                className="max-w-[85vw] max-h-[85vh] object-contain"
              />
            )}
            <div className="absolute bottom-0 left-0 right-0 bg-black/70 px-4 py-2 text-white text-sm">
              <p>{formatTime(lightboxItem.timestamp)} — <strong>{lightboxItem.sender_name}</strong></p>
              {lightboxItem.content && <p className="text-white/70 truncate">{lightboxItem.content}</p>}
              <div className="flex gap-3 mt-1">
                <button onClick={() => showInConversation(lightboxItem)} className="text-xs text-blue-400 hover:underline">
                  Show in conversation
                </button>
                <a href={getMediaUrl(lightboxItem)} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 hover:underline">
                  Open full size
                </a>
              </div>
            </div>
            <button
              onClick={() => setLightboxItem(null)}
              className="absolute top-2 right-2 w-8 h-8 rounded-full bg-black/50 text-white text-lg flex items-center justify-center hover:bg-black/70"
            >
              ×
            </button>
          </div>
        </div>
        );
      })()}
    </div>
  );
}

export default function MediaGalleryPage() {
  return (
    <Suspense fallback={<div className="text-center p-8 text-[var(--muted-foreground)]">Loading...</div>}>
      <MediaGalleryInner />
    </Suspense>
  );
}
