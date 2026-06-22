"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { ImportMetadataDialog, ImportMetadata } from "@/components/import/ImportMetadataDialog";

interface PendingImport {
  type: "files" | "path";
  files?: FileList | File[];
  path?: string;
  label: string;
}

interface SourceRow {
  id: string;
  filename: string;
  file_path: string;
  file_type: string;
  file_size: number;
  imported_at: string;
  conversation_count: number;
  message_count: number;
}

interface CaseRow {
  id: string;
  name: string;
  court_file_number: string | null;
  section_count: number;
  conversation_count: number;
}

interface SectionRow {
  id: string;
  name: string;
  section_type: string;
  conversation_count: number;
}

interface ImportResult {
  success: boolean;
  stats: {
    filesProcessed: number;
    conversationsImported: number;
    messagesImported: number;
    skippedEmpty?: number;
  };
  emptyFiles?: string[];
  errors: Array<{ file: string; error: string }>;
}

export default function ImportPage() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [importPath, setImportPath] = useState("");
  const [ownerName, setOwnerName] = useState("Jeremy White");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [sourcePlatformFilter, setSourcePlatformFilter] = useState("");
  const [sourceSort, setSourceSort] = useState<"recent" | "messages" | "name">("recent");
  const [hideEmptySources, setHideEmptySources] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [tab, setTab] = useState<"browse" | "path" | "quick">("browse");
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);

  const [cases, setCases] = useState<CaseRow[]>([]);
  const [sections, setSections] = useState<SectionRow[]>([]);
  const [selectedCase, setSelectedCase] = useState<string>("");
  const [selectedSection, setSelectedSection] = useState<string>("");
  const [showNewCase, setShowNewCase] = useState(false);
  const [newCaseName, setNewCaseName] = useState("");
  const [newCaseFileNumber, setNewCaseFileNumber] = useState("");
  const [showNewSection, setShowNewSection] = useState(false);
  const [newSectionName, setNewSectionName] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);

  const loadSources = useCallback(async () => {
    try {
      const res = await fetch("/api/sources");
      const data = await res.json();
      if (res.ok) setSources(data.sources || []);
    } catch { /* ignore */ }
  }, []);

  const loadCases = useCallback(async () => {
    try {
      const res = await fetch("/api/cases");
      const data = await res.json();
      if (res.ok) setCases(data.cases || []);
    } catch { /* ignore */ }
  }, []);

  const loadSections = useCallback(async (caseId: string) => {
    if (!caseId) { setSections([]); return; }
    try {
      const res = await fetch(`/api/cases/${caseId}/sections`);
      const data = await res.json();
      if (res.ok) setSections(data.sections || []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadSources(); loadCases(); }, [loadSources, loadCases]);
  useEffect(() => { loadSections(selectedCase); setSelectedSection(""); }, [selectedCase, loadSections]);

  async function handleCreateCase() {
    if (!newCaseName.trim()) return;
    try {
      const res = await fetch("/api/cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newCaseName, court_file_number: newCaseFileNumber || undefined }),
      });
      const data = await res.json();
      if (res.ok) {
        setSelectedCase(data.id);
        setShowNewCase(false);
        setNewCaseName("");
        setNewCaseFileNumber("");
        loadCases();
      }
    } catch { /* ignore */ }
  }

  async function handleCreateSection() {
    if (!newSectionName.trim() || !selectedCase) return;
    try {
      const res = await fetch(`/api/cases/${selectedCase}/sections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newSectionName }),
      });
      const data = await res.json();
      if (res.ok) {
        setSelectedSection(data.id);
        setShowNewSection(false);
        setNewSectionName("");
        loadSections(selectedCase);
      }
    } catch { /* ignore */ }
  }

  function handleFileUpload(files: FileList | File[]) {
    if (!files || files.length === 0) return;
    const validExts = [".json", ".xml", ".txt", ".html", ".htm", ".zip"];
    const fileArr = Array.from(files).filter((f) => {
      const ext = f.name.toLowerCase().match(/\.[^.]+$/)?.[0] || "";
      return validExts.includes(ext);
    });
    if (fileArr.length === 0) {
      setError("No supported files found. Accepted formats: JSON, XML, TXT, HTML, ZIP");
      return;
    }
    setError(null);
    const label = fileArr.length === 1 ? fileArr[0].name : `${fileArr.length} files`;
    setPendingImport({ type: "files", files: fileArr, label });
  }

  function handlePathImport() {
    if (!importPath.trim()) return;
    setPendingImport({ type: "path", path: importPath, label: importPath.split(/[/\\]/).pop() || importPath });
  }

  async function executeImport(metadata: ImportMetadata) {
    const current = pendingImport;
    setPendingImport(null);
    if (!current) return;

    setImporting(true);
    setError(null);
    setImportResult(null);

    const metaJson = JSON.stringify(metadata);

    try {
      if (current.type === "files" && current.files) {
        const formData = new FormData();
        formData.append("ownerName", ownerName);
        formData.append("importMetadata", metaJson);
        if (selectedCase) formData.append("caseId", selectedCase);
        if (selectedSection) formData.append("sectionId", selectedSection);
        for (const file of Array.from(current.files)) {
          formData.append("files", file);
        }
        const res = await fetch("/api/import/upload", { method: "POST", body: formData });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        setImportResult(data);
      } else if (current.type === "path" && current.path) {
        const res = await fetch("/api/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: current.path,
            ownerName,
            importMetadata: metadata,
            caseId: selectedCase || undefined,
            sectionId: selectedSection || undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        setImportResult(data);
      }
      loadSources();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setImporting(false);
    }
  }

  async function handleDeleteSource(sourceId: string, filename: string) {
    if (!confirm(`Delete "${filename}" and all its messages?`)) return;
    try {
      const res = await fetch(`/api/sources/${sourceId}`, { method: "DELETE" });
      if (res.ok) loadSources();
    } catch { /* ignore */ }
  }

  async function handleClearAll() {
    if (!confirm("Delete ALL imported data? This cannot be undone.")) return;
    try {
      const res = await fetch("/api/clear", { method: "POST" });
      if (res.ok) { setSources([]); setImportResult(null); loadCases(); }
    } catch { /* ignore */ }
  }

  async function handleDeleteEmpty() {
    const emptyCount = sources.filter((s) => (s.message_count || 0) === 0).length;
    if (emptyCount === 0) return;
    if (!confirm(`Remove ${emptyCount} empty source${emptyCount !== 1 ? "s" : ""} (0 messages)? This cannot be undone.`)) return;
    try {
      const res = await fetch("/api/sources/cleanup", { method: "POST" });
      if (res.ok) loadSources();
    } catch { /* ignore */ }
  }

  function platformLabel(fileType: string): { label: string; cls: string } {
    if (fileType.startsWith("facebook")) return { label: "Facebook", cls: "bg-blue-500/20 text-blue-400" };
    if (fileType === "sms-thread-txt" || fileType === "sms-xml") return { label: "SMS", cls: "bg-green-500/20 text-green-400" };
    if (fileType === "calls-xml") return { label: "Calls", cls: "bg-amber-500/20 text-amber-400" };
    if (fileType === "directory") return { label: "Folder", cls: "bg-purple-500/20 text-purple-400" };
    return { label: fileType || "File", cls: "bg-[var(--secondary)] text-[var(--muted-foreground)]" };
  }

  function cleanSourceName(filename: string): string {
    const base = filename.split(/[/\\]/).pop() || filename;
    return base.replace(/\.(txt|html?|json|xml)$/i, "");
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) handleFileUpload(e.dataTransfer.files);
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  const knownPaths = [
    { label: "Jessica FB Messenger (HTML)", path: "H:\\OneDrive\\_Waylon Court\\_Supreme Court - Case Conference\\Messaging_Emails_Texts\\jessicaarsenault_10154239868166081" },
    { label: "Jessica FB Messenger (JSON)", path: "D:\\tmp\\fb_zips\\facebook-TheJeremyWhite-2024-10-04-l4hWHVZF\\your_facebook_activity\\messages\\inbox\\jessicaarsenault_10154239868166081" },
    { label: "SMS Backup & Restore", path: "H:\\OneDrive\\_Waylon Court\\_Supreme Court - Case Conference\\Messaging_Emails_Texts\\SMS Backup and Restore" },
    { label: "All Messaging Data", path: "H:\\OneDrive\\_Waylon Court\\_Supreme Court - Case Conference\\Messaging_Emails_Texts" },
  ];

  const importControls = (
    <div className="space-y-4">
      {/* Case & Section Selection */}
      <div className="flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[180px]">
          <label className="text-xs text-[var(--muted-foreground)] mb-1 block">Case</label>
          {showNewCase ? (
            <div className="flex gap-1">
              <input type="text" value={newCaseName} onChange={(e) => setNewCaseName(e.target.value)}
                placeholder="Case name" onKeyDown={(e) => e.key === "Enter" && handleCreateCase()}
                className="flex-1 px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--background)] text-sm" />
              <input type="text" value={newCaseFileNumber} onChange={(e) => setNewCaseFileNumber(e.target.value)}
                placeholder="File #" className="w-24 px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--background)] text-sm" />
              <button onClick={handleCreateCase} className="px-2 py-1.5 rounded bg-[var(--primary)] text-white text-xs">Save</button>
              <button onClick={() => setShowNewCase(false)} className="px-2 py-1.5 text-xs text-[var(--muted-foreground)]">x</button>
            </div>
          ) : (
            <div className="flex gap-1">
              <select value={selectedCase} onChange={(e) => setSelectedCase(e.target.value)}
                className="flex-1 px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--background)] text-sm">
                <option value="">No case (general)</option>
                {cases.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}{c.court_file_number ? ` (${c.court_file_number})` : ""}</option>
                ))}
              </select>
              <button onClick={() => setShowNewCase(true)} className="px-2 py-1.5 rounded border border-[var(--border)] text-xs hover:bg-[var(--secondary)]" title="New case">+</button>
            </div>
          )}
        </div>

        {selectedCase && (
          <div className="flex-1 min-w-[180px]">
            <label className="text-xs text-[var(--muted-foreground)] mb-1 block">Section</label>
            {showNewSection ? (
              <div className="flex gap-1">
                <input type="text" value={newSectionName} onChange={(e) => setNewSectionName(e.target.value)}
                  placeholder="Section name" onKeyDown={(e) => e.key === "Enter" && handleCreateSection()}
                  className="flex-1 px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--background)] text-sm" />
                <button onClick={handleCreateSection} className="px-2 py-1.5 rounded bg-[var(--primary)] text-white text-xs">Save</button>
                <button onClick={() => setShowNewSection(false)} className="px-2 py-1.5 text-xs text-[var(--muted-foreground)]">x</button>
              </div>
            ) : (
              <div className="flex gap-1">
                <select value={selectedSection} onChange={(e) => setSelectedSection(e.target.value)}
                  className="flex-1 px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--background)] text-sm">
                  <option value="">No section</option>
                  {sections.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
                <button onClick={() => setShowNewSection(true)} className="px-2 py-1.5 rounded border border-[var(--border)] text-xs hover:bg-[var(--secondary)]" title="New section">+</button>
              </div>
            )}
          </div>
        )}

        <div>
          <label className="text-xs text-[var(--muted-foreground)] mb-1 block">Owner</label>
          <input type="text" value={ownerName} onChange={(e) => setOwnerName(e.target.value)}
            className="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--background)] text-sm w-40" />
        </div>
      </div>

      {/* Tab switcher */}
      <div className="flex rounded-lg border border-[var(--border)] overflow-hidden text-sm">
        {([
          { key: "browse" as const, label: "Browse Files" },
          { key: "path" as const, label: "Enter Path" },
          { key: "quick" as const, label: "Quick Import" },
        ]).map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`flex-1 px-4 py-2 transition ${tab === t.key ? "bg-[var(--primary)] text-white" : "hover:bg-[var(--secondary)]"}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Browse tab */}
      {tab === "browse" && (
        <div onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={handleDrop}
          className={`rounded-lg border-2 border-dashed p-8 text-center transition ${dragOver ? "border-[var(--primary)] bg-[var(--primary)]/5" : "border-[var(--border)] bg-[var(--card)]"}`}>
          <p className="text-lg font-medium mb-3">{importing ? "Importing..." : "Drop files here"}</p>
          <div className="flex justify-center gap-3">
            <input ref={fileInputRef} type="file" multiple accept=".json,.xml,.txt,.html,.htm,.zip" onChange={(e) => e.target.files && handleFileUpload(e.target.files)} className="hidden" />
            {/* @ts-expect-error webkitdirectory */}
            <input ref={dirInputRef} type="file" webkitdirectory="" onChange={(e) => e.target.files && handleFileUpload(e.target.files)} className="hidden" />
            <button onClick={() => fileInputRef.current?.click()} disabled={importing}
              className="px-5 py-2.5 rounded-lg bg-[var(--primary)] text-white font-medium hover:opacity-90 transition disabled:opacity-50">
              Select Files
            </button>
            <button onClick={() => dirInputRef.current?.click()} disabled={importing}
              className="px-5 py-2.5 rounded-lg border border-[var(--border)] font-medium hover:bg-[var(--secondary)] transition disabled:opacity-50">
              Select Folder
            </button>
          </div>
          <p className="text-xs text-[var(--muted-foreground)] mt-4">Facebook JSON/HTML, SMS XML, TXT, ZIP</p>
        </div>
      )}

      {/* Path tab */}
      {tab === "path" && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
          <div className="flex gap-3">
            <input type="text" value={importPath} onChange={(e) => setImportPath(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handlePathImport()}
              placeholder="File or directory path..."
              className="flex-1 px-4 py-2 rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] font-mono text-sm" />
            <button onClick={handlePathImport} disabled={!importPath.trim() || importing}
              className="px-6 py-2 rounded-lg bg-[var(--primary)] text-white font-medium hover:opacity-90 transition disabled:opacity-50">
              {importing ? "Importing..." : "Import"}
            </button>
          </div>
        </div>
      )}

      {/* Quick tab */}
      {tab === "quick" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {knownPaths.map((kp) => (
            <button key={kp.path} onClick={() => { setImportPath(kp.path); setTab("path"); }}
              className="text-left px-4 py-3 rounded-lg border border-[var(--border)] bg-[var(--card)] hover:border-[var(--primary)] transition">
              <div className="font-medium text-sm">{kp.label}</div>
              <div className="text-[10px] text-[var(--muted-foreground)] mt-1 break-all font-mono">{kp.path}</div>
            </button>
          ))}
        </div>
      )}

      {/* Result / Error */}
      {error && (
        <div className="rounded-lg border border-[var(--destructive)] bg-[var(--destructive)]/10 p-3">
          <p className="text-sm text-[var(--destructive)]">{error}</p>
        </div>
      )}
      {importResult && (
        <div className="rounded-lg border border-[var(--accent)] bg-[var(--accent)]/10 p-3">
          <div className="flex items-center justify-between">
            <p className="text-sm">
              <span className="font-semibold text-[var(--accent)]">Done: </span>
              {importResult.stats.filesProcessed} files, {importResult.stats.conversationsImported} conversations, {importResult.stats.messagesImported.toLocaleString()} messages
            </p>
            <a href="/conversations" className="text-sm text-[var(--primary)] hover:underline">View &rarr;</a>
          </div>
          {!!importResult.stats.skippedEmpty && importResult.stats.skippedEmpty > 0 && (
            <details className="mt-1">
              <summary className="text-xs text-amber-500 cursor-pointer">
                {importResult.stats.skippedEmpty} file{importResult.stats.skippedEmpty !== 1 ? "s" : ""} had no messages and {importResult.stats.skippedEmpty !== 1 ? "were" : "was"} skipped (not imported)
              </summary>
              {importResult.emptyFiles && importResult.emptyFiles.length > 0 && (
                <ul className="text-xs mt-1 space-y-0.5 max-h-32 overflow-y-auto">
                  {importResult.emptyFiles.map((f, i) => <li key={i} className="text-[var(--muted-foreground)]">{f}</li>)}
                </ul>
              )}
            </details>
          )}
          {importResult.errors.length > 0 && (
            <details className="mt-1">
              <summary className="text-xs text-[var(--destructive)] cursor-pointer">{importResult.errors.length} errors</summary>
              <ul className="text-xs mt-1 space-y-0.5">{importResult.errors.map((e, i) => <li key={i} className="text-[var(--muted-foreground)]">{e.file}: {e.error}</li>)}</ul>
            </details>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div>
      {/* DESKTOP: sticky import bar at top */}
      <div className="hidden lg:block sticky top-0 z-10 -mx-6 -mt-6 px-6 pt-6 pb-4 bg-[var(--background)] border-b border-[var(--border)] mb-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold">Import</h1>
            <p className="text-sm text-[var(--muted-foreground)]">
              Import message files into{" "}
              {selectedCase ? cases.find((c) => c.id === selectedCase)?.name || "case" : "CourtThread"}
            </p>
          </div>
        </div>
        {importControls}
      </div>

      {/* MOBILE: header + FAB */}
      <div className="lg:hidden">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold">Import</h1>
            <p className="text-sm text-[var(--muted-foreground)]">
              {sources.length} source{sources.length !== 1 ? "s" : ""} imported
            </p>
          </div>
        </div>
      </div>

      {/* Sources list (both desktop and mobile) */}
      <div className="rounded-lg border border-[var(--border)] bg-[var(--card)]">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
          <h2 className="text-sm font-semibold">
            Imported Sources
            {sources.length > 0 && <span className="text-[var(--muted-foreground)] font-normal ml-1">({sources.length})</span>}
          </h2>
          {sources.length > 0 && (
            <button onClick={handleClearAll} className="text-[10px] text-[var(--destructive)] hover:underline">Clear All</button>
          )}
        </div>

        {sources.length > 0 && (() => {
          const emptyCount = sources.filter((s) => (s.message_count || 0) === 0).length;
          const platforms = Array.from(new Set(sources.map((s) => platformLabel(s.file_type).label)));
          return (
            <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-[var(--border)] text-xs">
              <select value={sourcePlatformFilter} onChange={(e) => setSourcePlatformFilter(e.target.value)}
                className="px-2 py-1 rounded border border-[var(--border)] bg-[var(--background)]">
                <option value="">All platforms</option>
                {platforms.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              <select value={sourceSort} onChange={(e) => setSourceSort(e.target.value as "recent" | "messages" | "name")}
                className="px-2 py-1 rounded border border-[var(--border)] bg-[var(--background)]">
                <option value="recent">Most recent</option>
                <option value="messages">Most messages</option>
                <option value="name">Name (A–Z)</option>
              </select>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={hideEmptySources} onChange={(e) => setHideEmptySources(e.target.checked)} className="rounded" />
                Hide empty
              </label>
              {emptyCount > 0 && (
                <button onClick={handleDeleteEmpty}
                  className="ml-auto px-2 py-1 rounded border border-[var(--destructive)] text-[var(--destructive)] hover:bg-[var(--destructive)]/10 transition">
                  Remove {emptyCount} empty
                </button>
              )}
            </div>
          );
        })()}

        {sources.length === 0 ? (
          <p className="text-sm text-[var(--muted-foreground)] text-center py-8">No data imported yet</p>
        ) : (() => {
          const displayed = sources
            .filter((s) => !sourcePlatformFilter || platformLabel(s.file_type).label === sourcePlatformFilter)
            .filter((s) => !hideEmptySources || (s.message_count || 0) > 0)
            .sort((a, b) => {
              if (sourceSort === "messages") return (b.message_count || 0) - (a.message_count || 0);
              if (sourceSort === "name") return cleanSourceName(a.filename).localeCompare(cleanSourceName(b.filename));
              return (b.imported_at || "").localeCompare(a.imported_at || "");
            });
          return (
            <div className="divide-y divide-[var(--border)]/50 max-h-[60vh] overflow-y-auto">
              {displayed.map((src) => {
                const plat = platformLabel(src.file_type);
                const isEmpty = (src.message_count || 0) === 0;
                return (
                  <div key={src.id} className="group flex items-center justify-between px-4 py-2.5 hover:bg-[var(--secondary)]/30 transition">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] ${plat.cls}`}>{plat.label}</span>
                        <p className="text-sm font-medium truncate">{cleanSourceName(src.filename)}</p>
                        {isEmpty && <span className="shrink-0 text-[10px] text-[var(--destructive)]">empty</span>}
                      </div>
                      <p className="text-xs text-[var(--muted-foreground)] mt-0.5">
                        {src.conversation_count} conv &middot; {(src.message_count || 0).toLocaleString()} msgs &middot; {formatSize(src.file_size)} &middot; {new Date(src.imported_at).toLocaleDateString()}
                      </p>
                    </div>
                    <button onClick={() => handleDeleteSource(src.id, src.filename)}
                      className="ml-3 text-xs text-[var(--destructive)] opacity-0 group-hover:opacity-100 transition hover:underline shrink-0">
                      Delete
                    </button>
                  </div>
                );
              })}
              {displayed.length === 0 && (
                <p className="text-sm text-[var(--muted-foreground)] text-center py-8">No sources match the current filter.</p>
              )}
            </div>
          );
        })()}
      </div>

      {/* MOBILE: FAB + bottom drawer */}
      <div className="lg:hidden">
        <button
          onClick={() => setDrawerOpen(true)}
          className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full bg-[var(--primary)] text-white shadow-lg flex items-center justify-center text-2xl hover:opacity-90 transition"
          aria-label="Import files"
        >
          +
        </button>

        {drawerOpen && (
          <>
            <div className="fixed inset-0 bg-black/50 z-40" onClick={() => setDrawerOpen(false)} />
            <div className="fixed bottom-0 left-0 right-0 z-50 bg-[var(--background)] border-t border-[var(--border)] rounded-t-2xl max-h-[85dvh] overflow-y-auto p-6 animate-slide-up">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold">Import Files</h2>
                <button onClick={() => setDrawerOpen(false)} className="text-[var(--muted-foreground)] text-xl px-2">&times;</button>
              </div>
              {importControls}
            </div>
          </>
        )}
      </div>

      {/* Import metadata dialog */}
      {pendingImport && (
        <ImportMetadataDialog
          filename={pendingImport.label}
          fileModified={(() => {
            const f = pendingImport.files ? Array.from(pendingImport.files)[0] : undefined;
            return f && typeof f.lastModified === "number" ? f.lastModified : undefined;
          })()}
          onConfirm={executeImport}
          onCancel={() => setPendingImport(null)}
        />
      )}
    </div>
  );
}
