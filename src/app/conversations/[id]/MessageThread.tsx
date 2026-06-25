"use client";

import { useState, useEffect, type RefObject } from "react";

export type ViewMode = "mobile" | "tablet" | "desktop";
export type ThemeMode = "light" | "dark";

const VIEW_MODE_WIDTHS: Record<ViewMode, string> = {
  mobile: "max-w-[375px]",
  tablet: "max-w-[768px]",
  desktop: "",
};

export function useViewMode(): [ViewMode, (mode: ViewMode) => void] {
  const [mode, setModeState] = useState<ViewMode>("desktop");
  useEffect(() => {
    try {
      const saved = localStorage.getItem("courtthread_view_mode") as ViewMode;
      if (saved && VIEW_MODE_WIDTHS[saved] !== undefined) setModeState(saved);
    } catch {}
  }, []);
  const setMode = (m: ViewMode) => {
    setModeState(m);
    try { localStorage.setItem("courtthread_view_mode", m); } catch {}
  };
  return [mode, setMode];
}

export function useThemeMode(): [ThemeMode, (mode: ThemeMode) => void] {
  const [mode, setModeState] = useState<ThemeMode>("dark");
  useEffect(() => {
    try {
      const saved = localStorage.getItem("courtthread_theme_mode") as ThemeMode;
      if (saved === "light" || saved === "dark") { setModeState(saved); return; }
    } catch {}
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: light)").matches) {
      setModeState("light");
    }
  }, []);
  const setMode = (m: ThemeMode) => {
    setModeState(m);
    try { localStorage.setItem("courtthread_theme_mode", m); } catch {}
  };
  return [mode, setMode];
}

export function getThemeVars(theme: ThemeMode): Record<string, string> {
  if (theme === "dark") return {
    '--background':'#000','--foreground':'#ededed','--card':'#000','--card-foreground':'#ededed',
    '--secondary':'#1e293b','--secondary-foreground':'#e2e8f0','--muted':'#1e1e1e','--muted-foreground':'#a1a1aa',
    '--border':'#27272a','--incoming-bg':'#303030','--fb-gray':'#3e4042','--sms-gray':'#3a3a3c',
    '--outgoing-fb-bg':'#0866ff','--outgoing-sms-bg':'#34c759',
    backgroundColor:'#000',color:'#ededed',
  };
  return {
    '--background':'#ffffff','--foreground':'#0a0a0a','--card':'#ffffff','--card-foreground':'#0a0a0a',
    '--secondary':'#f1f5f9','--secondary-foreground':'#1e293b','--muted':'#f4f4f5','--muted-foreground':'#71717a',
    '--border':'#e4e4e7','--incoming-bg':'#e5e5e5','--fb-gray':'#e5e5e5','--sms-gray':'#d4d4d8',
    '--outgoing-fb-bg':'#0866ff','--outgoing-sms-bg':'#34c759',
    backgroundColor:'#ffffff',color:'#0a0a0a',
  };
}

export function ThreadViewport({ theme, viewMode, children, className }: {
  theme: ThemeMode;
  viewMode: ViewMode;
  children: React.ReactNode;
  className?: string;
}) {
  const widthStyle = viewMode === "mobile" ? { maxWidth: 412 } : viewMode === "tablet" ? { maxWidth: 800 } : { maxWidth: 1040 };
  return (
    <div
      style={{ ...widthStyle, padding: 0, backgroundColor: 'transparent', border: 'none', borderRadius: 0, boxShadow: '0 2px 12px rgba(0,0,0,0.3)' }}
      className={`mx-auto ${className ?? ""}`}
    >
      <div
        style={{ ...getThemeVars(theme) as any, border: 'none', borderRadius: 0, overflow: 'hidden' }}
      >
        {children}
      </div>
    </div>
  );
}

export function ViewModeToggle({ mode, onChange, theme, onThemeChange }: {
  mode: ViewMode; onChange: (mode: ViewMode) => void;
  theme?: ThemeMode; onThemeChange?: (t: ThemeMode) => void;
}) {
  const modes: { key: ViewMode; label: string; icon: string }[] = [
    { key: "mobile", label: "Mobile", icon: "📱" },
    { key: "tablet", label: "Tablet", icon: "📋" },
    { key: "desktop", label: "Desktop", icon: "🖥" },
  ];
  return (
    <div className="flex items-center gap-1">
      <div className="flex rounded-lg border border-[var(--border)] overflow-hidden">
        {modes.map((m) => (
          <button key={m.key} onClick={() => onChange(m.key)}
            className={`px-2 py-1 text-xs transition ${
              mode === m.key
                ? "bg-[var(--primary)] text-white"
                : "text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--secondary)]"
            }`}
            title={m.label}>
            <span className="mr-1">{m.icon}</span>{m.label}
          </button>
        ))}
      </div>
      {onThemeChange && (
        <div className="flex rounded-lg border border-[var(--border)] overflow-hidden">
          <button onClick={() => onThemeChange("light")}
            className={`px-2 py-1 text-xs transition ${
              theme === "light"
                ? "bg-amber-400 text-black"
                : "text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--secondary)]"
            }`}
            title="Light theme">☀️</button>
          <button onClick={() => onThemeChange("dark")}
            className={`px-2 py-1 text-xs transition ${
              theme === "dark"
                ? "bg-slate-700 text-white"
                : "text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--secondary)]"
            }`}
            title="Dark theme">🌙</button>
        </div>
      )}
    </div>
  );
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

interface LightboxMedia {
  url: string;
  type: "image" | "video";
  filename: string;
  sender: string;
  timestamp: string;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
}

function DateSeparator({ date }: { date: string }) {
  const d = new Date(date);
  const label = d.toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
  return (
    <div className="flex items-center gap-4 my-4">
      <div className="flex-1 h-px bg-[var(--border)]" />
      <span className="text-xs text-[var(--muted-foreground)] font-medium">{label}</span>
      <div className="flex-1 h-px bg-[var(--border)]" />
    </div>
  );
}

function MediaAttachment({ media, sourceId, onLightbox }: { media: any; sourceId: string; onLightbox: (item: LightboxMedia) => void }) {
  const [imgError, setImgError] = useState(false);

  if (!media.filename) {
    return <span className="text-xs opacity-70">[{media.type}]</span>;
  }

  const mediaUrl = `/api/media?sourceId=${encodeURIComponent(sourceId)}&filename=${encodeURIComponent(media.filename)}&type=${media.type}`;

  if (media.type === "image" || media.type === "sticker" || media.type === "gif") {
    if (imgError) {
      return (
        <div className="mt-1 px-2 py-1 rounded bg-[var(--secondary)] text-xs text-[var(--muted-foreground)]">
          [Image: {media.filename}]
        </div>
      );
    }
    return (
      <img
        src={mediaUrl}
        alt={media.filename}
        onError={() => setImgError(true)}
        className="mt-1 rounded-xl max-w-full object-contain cursor-pointer"
        style={{ maxHeight: 280, borderRadius: 12 }}
        loading="lazy"
        onClick={() => onLightbox({ url: mediaUrl, type: "image", filename: media.filename, sender: "", timestamp: "" })}
      />
    );
  }

  if (media.type === "video") {
    return (
      <div
        className="mt-1 relative max-w-full bg-black cursor-pointer inline-block overflow-hidden"
        style={{ maxHeight: 280, borderRadius: 12 }}
        onClick={() => onLightbox({ url: mediaUrl, type: "video", filename: media.filename, sender: "", timestamp: "" })}
      >
        <video
          src={mediaUrl}
          className="max-w-full object-contain pointer-events-none"
          style={{ maxHeight: 280 }}
          preload="metadata"
        />
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-12 h-12 rounded-full bg-black/50 flex items-center justify-center hover:bg-black/70 transition">
            <svg className="w-6 h-6 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
          </div>
        </div>
      </div>
    );
  }

  if (media.type === "audio") {
    return (
      <audio controls preload="metadata" className="mt-1 w-full">
        <source src={mediaUrl} />
        [Audio: {media.filename}]
      </audio>
    );
  }

  return (
    <span className="text-xs opacity-70 block mt-1">
      [{media.type}: {media.filename}]
    </span>
  );
}

function TruncatedLink({ url, isOutgoing }: { url: string; isOutgoing: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const maxLen = 80;
  const needsTruncation = url.length > maxLen;
  const display = needsTruncation && !expanded ? url.slice(0, maxLen) + "..." : url;
  const linkColor = isOutgoing ? "text-blue-200 hover:text-white" : "text-blue-600 hover:text-blue-800";
  return (
    <>
      <a href={url} target="_blank" rel="noopener noreferrer" className={`${linkColor} underline break-all`}>{display}</a>
      {needsTruncation && (
        <button onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          className={`ml-1 text-[10px] ${isOutgoing ? "text-blue-200/70" : "text-blue-500/70"} hover:underline`}>
          {expanded ? "less" : "more"}
        </button>
      )}
    </>
  );
}

const URL_RE = /(https?:\/\/[^\s<>"{}|\\^`\[\]]+)/gi;

function linkifyContent(text: string, isOutgoing: boolean, highlightQuery?: string): React.ReactNode {
  if (!text) return text;
  const parts = text.split(URL_RE);
  const nodes: React.ReactNode[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    if (URL_RE.test(part)) {
      URL_RE.lastIndex = 0;
      nodes.push(<TruncatedLink key={i} url={part} isOutgoing={isOutgoing} />);
    } else if (highlightQuery) {
      nodes.push(<span key={i}>{highlightText(part, highlightQuery)}</span>);
    } else {
      nodes.push(part);
    }
  }
  URL_RE.lastIndex = 0;
  return nodes;
}

function highlightText(text: string, query: string): React.ReactNode {
  if (!query || !text) return text;
  try {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(${escaped})`, "gi");
    const parts = text.split(re);
    return parts.map((part, i) =>
      re.test(part) ? (
        <mark key={i} className="bg-amber-400/40 text-inherit rounded px-0.5">{part}</mark>
      ) : part
    );
  } catch { return text; }
}

function MessageBubble({
  message,
  platform,
  sourceId,
  isBookmarked,
  onToggleBookmark,
  searchHighlight,
  onLightbox,
}: {
  message: Message;
  platform: string;
  sourceId: string;
  isBookmarked: boolean;
  onToggleBookmark: () => void;
  searchHighlight?: string;
  onLightbox: (item: LightboxMedia) => void;
}) {
  const isOutgoing = !message.is_incoming;
  const isCall = message.message_type === "call";
  const isSystem = message.message_type === "system";

  if (isCall || isSystem) {
    return (
      <div className="flex justify-center my-2">
        <div className="px-3 py-1 rounded-full bg-[var(--secondary)] text-xs text-[var(--muted-foreground)]">
          {message.sender_name}: {message.content}
          <span className="ml-2 opacity-60">{formatTime(message.timestamp)}</span>
        </div>
      </div>
    );
  }

  let metadata: any = {};
  try { if (message.metadata) metadata = JSON.parse(message.metadata); } catch { /* ignore */ }

  const msgSourceId = message.source_id || sourceId;
  const bgClass = isOutgoing
    ? platform === "facebook" ? "text-white" : "bg-[var(--outgoing-sms-bg)] text-white"
    : "bg-[var(--incoming-bg)]";
  const outgoingGradient = isOutgoing && platform === "facebook" ? { background: 'linear-gradient(135deg, #0a84ff, #0866ff)' } : {};

  const hasMedia = metadata.media?.length > 0;
  const hasOnlyMedia = hasMedia && !message.content;
  const contentText = message.content?.replace(/\[image: [^\]]+\]/g, "").replace(/\[video: [^\]]+\]/g, "").replace(/\[audio: [^\]]+\]/g, "").trim();

  const handleLightbox = (item: LightboxMedia) => {
    onLightbox({ ...item, sender: message.sender_name, timestamp: message.timestamp });
  };

  return (
    <div className={`flex ${isOutgoing ? "justify-end" : "justify-start"} mb-1 group`}>
      <div className={`max-w-[70%] ${isOutgoing ? "items-end" : "items-start"}`}>
        <p className={`text-[var(--muted-foreground)] mb-0.5 ${isOutgoing ? "text-right mr-3" : "ml-3"}`} style={{ fontSize: 12, margin: isOutgoing ? '0 12px 2px 0' : '0 0 2px 12px' }}>{message.sender_name}</p>
        <div className="flex items-start gap-1.5">
          {isOutgoing && (
            <button onClick={onToggleBookmark}
              className={`mt-1.5 flex items-center gap-1 px-1.5 py-0.5 rounded-md transition shrink-0 ${
                isBookmarked
                  ? "opacity-100 text-amber-400 bg-amber-400/10"
                  : "opacity-0 group-hover:opacity-100 text-[var(--muted-foreground)] hover:text-amber-400 hover:bg-amber-400/10"
              }`}
              title={isBookmarked ? "Remove bookmark" : "Bookmark for evidence"}>
              <span className="text-xl leading-none">{isBookmarked ? "★" : "☆"}</span>
              <span className="text-[11px] font-medium">{isBookmarked ? "Bookmarked" : "Bookmark"}</span>
            </button>
          )}
          <div className={`rounded-[18px] ${hasOnlyMedia ? "bg-transparent" : bgClass} ${isBookmarked ? "ring-2 ring-amber-400" : ""}`} style={{ padding: hasOnlyMedia ? 0 : '10px 14px', ...outgoingGradient }}>
            {contentText && (
              <p className="whitespace-pre-wrap break-words" style={{ fontSize: 15, overflowWrap: "anywhere", margin: 0 }}>
                {linkifyContent(contentText, isOutgoing, searchHighlight)}
              </p>
            )}
            {hasMedia && metadata.media.map((m: any, i: number) => (
              <MediaAttachment key={i} media={m} sourceId={msgSourceId} onLightbox={handleLightbox} />
            ))}
          </div>
          {!isOutgoing && (
            <button onClick={onToggleBookmark}
              className={`mt-1.5 flex items-center gap-1 px-1.5 py-0.5 rounded-md transition shrink-0 ${
                isBookmarked
                  ? "opacity-100 text-amber-400 bg-amber-400/10"
                  : "opacity-0 group-hover:opacity-100 text-[var(--muted-foreground)] hover:text-amber-400 hover:bg-amber-400/10"
              }`}
              title={isBookmarked ? "Remove bookmark" : "Bookmark for evidence"}>
              <span className="text-xl leading-none">{isBookmarked ? "★" : "☆"}</span>
              <span className="text-[11px] font-medium">{isBookmarked ? "Bookmarked" : "Bookmark"}</span>
            </button>
          )}
        </div>
        <p className={`text-[10px] text-[var(--muted-foreground)] mt-0.5 ${isOutgoing ? "text-right mr-3" : "ml-3"}`}>
          {formatTime(message.timestamp)}
        </p>
        {metadata.reactions?.length > 0 && (
          <div className={`text-xs mt-0.5 ${isOutgoing ? "text-right mr-3" : "ml-3"}`}>
            {Array.isArray(metadata.reactions)
              ? metadata.reactions.map((r: any, i: number) => (
                  <span key={i} className="mr-1">{typeof r === "string" ? r : `${r.reaction} ${r.actor}`}</span>
                ))
              : null}
          </div>
        )}
      </div>
    </div>
  );
}

function MediaLightbox({ item, onClose }: { item: LightboxMedia; onClose: () => void }) {
  useEffect(() => {
    function handleKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center"
      onClick={onClose}
    >
      <div className="relative max-w-[85vw] max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
        {item.type === "video" ? (
          <video
            key={item.url}
            src={item.url}
            className="max-w-[85vw] max-h-[85vh] object-contain"
            controls
            autoPlay
          />
        ) : (
          <img
            src={item.url}
            alt={item.filename}
            className="max-w-[85vw] max-h-[85vh] object-contain"
          />
        )}
        <div className="absolute bottom-0 left-0 right-0 bg-black/70 px-4 py-2 text-white text-sm">
          <p>{formatTime(item.timestamp)} — <strong>{item.sender}</strong></p>
          <a href={item.url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 hover:underline">
            Open full size
          </a>
        </div>
        <button
          onClick={onClose}
          className="absolute top-2 right-2 w-8 h-8 rounded-full bg-black/50 text-white text-lg flex items-center justify-center hover:bg-black/70"
        >
          ×
        </button>
      </div>
    </div>
  );
}

export function MessageThread({
  messages,
  platform,
  sourceId,
  bookmarkedIds,
  onToggleBookmark,
  highlightText: searchHighlight,
  highlightMessageId,
  highlightRef,
  className,
  viewMode,
}: {
  messages: Message[];
  platform: string;
  sourceId: string;
  bookmarkedIds: Set<string>;
  onToggleBookmark: (messageId: string) => void;
  highlightText?: string;
  highlightMessageId?: string;
  highlightRef?: RefObject<HTMLDivElement | null>;
  className?: string;
  viewMode?: ViewMode;
}) {
  const [lightboxItem, setLightboxItem] = useState<LightboxMedia | null>(null);
  let lastDate = "";
  const widthClass = viewMode ? VIEW_MODE_WIDTHS[viewMode] : "";

  return (
    <div className={`${className ?? "rounded-lg border border-[var(--border)] bg-[var(--card)] p-4"} ${widthClass} mx-auto overflow-hidden`}>
      {messages.map((msg) => {
        const msgDate = new Date(msg.timestamp).toDateString();
        const showDateSep = msgDate !== lastDate;
        lastDate = msgDate;
        const isHighlighted = highlightMessageId === msg.id;
        return (
          <div key={msg.id}
            ref={isHighlighted ? highlightRef : undefined}
            className={isHighlighted ? "ring-2 ring-amber-400 rounded-lg" : ""}>
            {showDateSep && <DateSeparator date={msg.timestamp} />}
            <MessageBubble
              message={msg}
              platform={platform}
              sourceId={sourceId}
              isBookmarked={bookmarkedIds.has(msg.id)}
              onToggleBookmark={() => onToggleBookmark(msg.id)}
              searchHighlight={searchHighlight}
              onLightbox={setLightboxItem}
            />
          </div>
        );
      })}
      {lightboxItem && <MediaLightbox item={lightboxItem} onClose={() => setLightboxItem(null)} />}
    </div>
  );
}
