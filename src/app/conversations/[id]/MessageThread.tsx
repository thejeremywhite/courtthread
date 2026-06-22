"use client";

import { useState, type RefObject } from "react";

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

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
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

function MediaAttachment({ media, sourceId }: { media: any; sourceId: string }) {
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
        className="mt-1 rounded-lg max-w-full max-h-64 object-contain cursor-pointer"
        loading="lazy"
        onClick={() => window.open(mediaUrl, "_blank")}
      />
    );
  }

  if (media.type === "video") {
    return (
      <video controls preload="metadata" className="mt-1 rounded-lg max-w-full max-h-64">
        <source src={mediaUrl} />
        [Video: {media.filename}]
      </video>
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
}: {
  message: Message;
  platform: string;
  sourceId: string;
  isBookmarked: boolean;
  onToggleBookmark: () => void;
  searchHighlight?: string;
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
    ? platform === "facebook" ? "bg-[var(--outgoing-fb-bg)] text-white" : "bg-[var(--outgoing-sms-bg)] text-white"
    : "bg-[var(--incoming-bg)]";

  const hasMedia = metadata.media?.length > 0;
  const hasOnlyMedia = hasMedia && !message.content;
  const contentText = message.content?.replace(/\[image: [^\]]+\]/g, "").replace(/\[video: [^\]]+\]/g, "").replace(/\[audio: [^\]]+\]/g, "").trim();

  return (
    <div className={`flex ${isOutgoing ? "justify-end" : "justify-start"} mb-1 group`}>
      <div className={`max-w-[70%] ${isOutgoing ? "items-end" : "items-start"}`}>
        {!isOutgoing && (
          <p className="text-xs text-[var(--muted-foreground)] mb-0.5 ml-3">{message.sender_name}</p>
        )}
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
          <div className={`px-3 py-2 rounded-2xl ${hasOnlyMedia ? "bg-transparent p-0" : bgClass} ${isBookmarked ? "ring-2 ring-amber-400" : ""}`}>
            {contentText && (
              <p className="text-sm whitespace-pre-wrap break-words">
                {searchHighlight ? highlightText(contentText, searchHighlight) : contentText}
              </p>
            )}
            {hasMedia && metadata.media.map((m: any, i: number) => (
              <MediaAttachment key={i} media={m} sourceId={msgSourceId} />
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

export function MessageThread({
  messages,
  platform,
  sourceId,
  bookmarkedIds,
  onToggleBookmark,
  highlightText: searchHighlight,
  highlightMessageId,
  highlightRef,
}: {
  messages: Message[];
  platform: string;
  sourceId: string;
  bookmarkedIds: Set<string>;
  onToggleBookmark: (messageId: string) => void;
  highlightText?: string;
  highlightMessageId?: string;
  highlightRef?: RefObject<HTMLDivElement | null>;
}) {
  let lastDate = "";

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
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
            />
          </div>
        );
      })}
    </div>
  );
}
