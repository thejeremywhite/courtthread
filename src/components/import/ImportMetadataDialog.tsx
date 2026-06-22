"use client";

import { useState } from "react";
import { DateTimePicker } from "@/components/DateTimePicker";

export interface ImportMetadata {
  platforms: string[];
  sourceDescription: string;
  dateObtained: string;
  wasModified: "no" | "yes" | "unknown";
  modificationNotes: string;
  exportMethods: string[];
  notes: string;
}

interface ImportMetadataDialogProps {
  filename: string;
  fileModified?: number; // ms timestamp from the file/directory metadata, if known
  onConfirm: (metadata: ImportMetadata) => void;
  onCancel: () => void;
}

const KNOWN_PLATFORMS = [
  "Facebook Messenger", "SMS / Text Messages", "Instagram", "WhatsApp",
  "iMessage", "Telegram", "Signal", "Email",
];

const EXPORT_METHODS = [
  "Official platform export / download",
  "Third-party backup app",
  "Screenshot",
  "Copy/paste",
  "Forwarded/shared by someone",
  "Court order / legal production",
];

export function ImportMetadataDialog({ filename, fileModified, onConfirm, onCancel }: ImportMetadataDialogProps) {
  const [selectedPlatforms, setSelectedPlatforms] = useState<Set<string>>(new Set());
  const [customPlatform, setCustomPlatform] = useState("");
  const [sourceDescription, setSourceDescription] = useState("");
  const [dateObtained, setDateObtained] = useState("");
  const [wasModified, setWasModified] = useState<"no" | "yes" | "unknown">("unknown");
  const [modificationNotes, setModificationNotes] = useState("");
  const [selectedMethods, setSelectedMethods] = useState<Set<string>>(new Set());
  const [customMethod, setCustomMethod] = useState("");
  const [notes, setNotes] = useState("");

  function togglePlatform(p: string) {
    setSelectedPlatforms((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p); else next.add(p);
      return next;
    });
  }

  function toggleMethod(m: string) {
    setSelectedMethods((prev) => {
      const next = new Set(prev);
      if (next.has(m)) next.delete(m); else next.add(m);
      return next;
    });
  }

  function handleConfirm() {
    const platforms = [...selectedPlatforms];
    if (customPlatform.trim()) platforms.push(customPlatform.trim());
    const exportMethods = [...selectedMethods];
    if (customMethod.trim()) exportMethods.push(customMethod.trim());

    onConfirm({
      platforms,
      sourceDescription,
      dateObtained,
      wasModified,
      modificationNotes,
      exportMethods,
      notes,
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onCancel} />
      <div className="relative bg-[var(--background)] border border-[var(--border)] rounded-xl shadow-2xl w-full max-w-lg max-h-[85dvh] overflow-y-auto mx-4">
        <div className="sticky top-0 bg-[var(--background)] border-b border-[var(--border)] px-6 py-4 rounded-t-xl z-10">
          <h2 className="text-lg font-semibold">Import Details</h2>
          <p className="text-xs text-[var(--muted-foreground)] mt-1">
            Optional — helps establish provenance for court submissions
          </p>
          <p className="text-xs text-[var(--primary)] mt-1 truncate">{filename}</p>
        </div>

        <div className="px-6 py-4 space-y-4">
          {/* Platforms — multi-select */}
          <div>
            <label className="text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wider mb-1.5 block">
              Platform(s) — select all that apply
            </label>
            <div className="flex flex-wrap gap-1.5">
              {KNOWN_PLATFORMS.map((p) => (
                <button key={p} onClick={() => togglePlatform(p)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium transition ${
                    selectedPlatforms.has(p)
                      ? "bg-[var(--primary)] text-white"
                      : "bg-[var(--secondary)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  }`}>
                  {p}
                </button>
              ))}
            </div>
            <input type="text" value={customPlatform} onChange={(e) => setCustomPlatform(e.target.value)}
              placeholder="Other platform..."
              className="w-full mt-2 px-3 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--card)] text-sm" />
          </div>

          {/* How obtained — multi-select */}
          <div>
            <label className="text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wider mb-1.5 block">
              How was this data obtained? Select all that apply
            </label>
            <div className="flex flex-wrap gap-1.5">
              {EXPORT_METHODS.map((m) => (
                <button key={m} onClick={() => toggleMethod(m)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium transition ${
                    selectedMethods.has(m)
                      ? "bg-[var(--primary)] text-white"
                      : "bg-[var(--secondary)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  }`}>
                  {m}
                </button>
              ))}
            </div>
            <input type="text" value={customMethod} onChange={(e) => setCustomMethod(e.target.value)}
              placeholder="Other method..."
              className="w-full mt-2 px-3 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--card)] text-sm" />
          </div>

          {/* Source description */}
          <div>
            <label className="text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wider mb-1.5 block">
              Source description
            </label>
            <input type="text" value={sourceDescription} onChange={(e) => setSourceDescription(e.target.value)}
              placeholder="e.g. Downloaded from Facebook account settings on my laptop"
              className="w-full px-3 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--card)] text-sm" />
          </div>

          {/* Date obtained */}
          <div>
            <label className="text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wider mb-1.5 block">
              Date &amp; time obtained / exported
            </label>
            <div className="flex items-start gap-2 flex-wrap">
              <div className="w-56">
                <DateTimePicker value={dateObtained} onChange={setDateObtained} placeholder="Pick date & time..." />
              </div>
              {fileModified ? (
                <button
                  type="button"
                  onClick={() => setDateObtained(new Date(fileModified).toISOString())}
                  className="px-3 py-1.5 rounded-lg border border-[var(--border)] text-xs hover:bg-[var(--secondary)] transition"
                  title="Use the file's last-modified timestamp from its metadata"
                >
                  Use file date
                  <span className="block text-[10px] text-[var(--muted-foreground)]">
                    {new Date(fileModified).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}
                  </span>
                </button>
              ) : null}
            </div>
          </div>

          {/* Modified? */}
          <div>
            <label className="text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wider mb-1.5 block">
              Was this data modified before import?
            </label>
            <div className="flex gap-2">
              {([
                { key: "no" as const, label: "No, original" },
                { key: "yes" as const, label: "Yes, modified" },
                { key: "unknown" as const, label: "Not sure" },
              ]).map((opt) => (
                <button key={opt.key} onClick={() => setWasModified(opt.key)}
                  className={`flex-1 px-3 py-1.5 rounded-lg border text-xs font-medium transition ${
                    wasModified === opt.key
                      ? opt.key === "yes" ? "border-amber-500 bg-amber-500/10 text-amber-400"
                        : opt.key === "no" ? "border-green-500 bg-green-500/10 text-green-400"
                        : "border-[var(--primary)] bg-[var(--primary)]/10"
                      : "border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--muted-foreground)]"
                  }`}>
                  {opt.label}
                </button>
              ))}
            </div>
            {wasModified === "yes" && (
              <textarea value={modificationNotes} onChange={(e) => setModificationNotes(e.target.value)}
                placeholder="Describe what was changed and why..."
                rows={2}
                className="w-full mt-2 px-3 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--card)] text-sm resize-none" />
            )}
          </div>

          {/* Notes */}
          <div>
            <label className="text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wider mb-1.5 block">
              Additional notes
            </label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything else relevant..."
              rows={2}
              className="w-full px-3 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--card)] text-sm resize-none" />
          </div>
        </div>

        <div className="sticky bottom-0 bg-[var(--background)] border-t border-[var(--border)] px-6 py-3 flex justify-between rounded-b-xl z-10">
          <button onClick={onCancel}
            className="px-4 py-2 rounded-lg text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition">
            Cancel
          </button>
          <div className="flex gap-2">
            <button onClick={handleConfirm}
              className="px-4 py-2 rounded-lg border border-[var(--border)] text-sm hover:bg-[var(--secondary)] transition">
              Skip Details
            </button>
            <button onClick={handleConfirm}
              className="px-5 py-2 rounded-lg bg-[var(--primary)] text-white text-sm font-medium hover:opacity-90 transition">
              Import
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
