"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
  });
}

// Standalone full-size viewer for a single media item — reached via the Media Gallery
// lightbox's "Open full size". Unlike linking straight to the raw /api/media file (a bare
// image byte stream with no caption and no way back into the conversation), this carries
// the same context the lightbox shows: timestamp, sender, conversation title, and a
// working "Show in conversation" link.
function MediaViewInner() {
  const params = useSearchParams();
  const sourceId = params.get("sourceId") || "";
  const filename = params.get("filename") || "";
  const type = params.get("type") || "image";
  const conversationId = params.get("conversationId") || "";
  const messageId = params.get("messageId") || "";
  const timestamp = params.get("timestamp") || "";
  const senderName = params.get("senderName") || "";
  const conversationTitle = params.get("conversationTitle") || "";
  const content = params.get("content") || "";

  const mediaUrl = `/api/media?sourceId=${encodeURIComponent(sourceId)}&filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(type)}`;
  const isVideo = type === "video";

  return (
    <div className="min-h-screen bg-black text-white flex flex-col">
      <div className="flex-1 flex items-center justify-center p-4">
        {isVideo ? (
          <video src={mediaUrl} className="max-w-full max-h-[85vh] object-contain" controls autoPlay />
        ) : (
          <img src={mediaUrl} alt={filename} className="max-w-full max-h-[85vh] object-contain" />
        )}
      </div>
      <div className="bg-black/80 border-t border-white/10 px-4 py-3 text-sm">
        <p>
          {timestamp && formatTime(timestamp)}
          {senderName && <> — <strong>{senderName}</strong></>}
          {conversationTitle && <span className="text-white/70"> in {conversationTitle}</span>}
        </p>
        {content && <p className="text-white/70 truncate mt-0.5">{content}</p>}
        <div className="flex gap-3 mt-1.5">
          {conversationId && (
            <a
              href={`/conversations/${conversationId}${messageId ? `?messageId=${messageId}` : ""}`}
              target="_blank" rel="noopener noreferrer"
              className="text-xs text-blue-400 hover:underline"
            >
              Show in conversation
            </a>
          )}
          <a href={mediaUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 hover:underline">
            Open raw file
          </a>
        </div>
      </div>
    </div>
  );
}

export default function MediaViewPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-black" />}>
      <MediaViewInner />
    </Suspense>
  );
}
