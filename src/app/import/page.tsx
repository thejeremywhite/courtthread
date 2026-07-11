"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { ImportMetadataDialog, ImportMetadata, KNOWN_PLATFORMS, EXPORT_METHODS } from "@/components/import/ImportMetadataDialog";
import { DateTimePicker } from "@/components/DateTimePicker";
import { cleanSourceName } from "@/lib/sourceName";

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
  duplicate_conversation_count: number;
  is_duplicate_source: boolean;
  metadata: string;
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
  const [tab, setTab] = useState<"browse" | "quick">("browse");
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

  const [linkingSourceId, setLinkingSourceId] = useState<string | null>(null);
  const [linkMediaPath, setLinkMediaPath] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [detailSourceId, setDetailSourceId] = useState<string | null>(null);
  const [editingMeta, setEditingMeta] = useState<Record<string, string> | null>(null);
  const [savingMeta, setSavingMeta] = useState(false);

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
      // "Failed to fetch" (a TypeError) with a healthy server = the request died inside
      // the browser before any bytes were sent (seen as ERR_ALPN_NEGOTIATION_FAILED —
      // a stale cached protocol/socket for this origin). Give the recovery options
      // instead of a dead-end message.
      if (e instanceof TypeError) {
        setError(
          "The upload never reached the server — the browser refused the connection " +
          "(stale cached connection state for this address). Try: restart the browser " +
          "(brave://restart), or open the app via http://127.0.0.1:" + window.location.port +
          ", or import by folder path from the Quick tab."
        );
      } else {
        setError(e.message);
      }
    } finally {
      setImporting(false);
    }
  }

  async function handleLinkMedia(sourceId: string) {
    if (!linkMediaPath.trim()) return;
    setLinkError(null);
    try {
      const res = await fetch(`/api/sources/${sourceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ localMediaPath: linkMediaPath.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setLinkingSourceId(null);
      setLinkMediaPath("");
      loadSources();
    } catch (e: any) {
      setLinkError(e.message);
    }
  }

  function openDetails(src: SourceRow) {
    let meta: Record<string, any> = {};
    try { meta = JSON.parse(src.metadata || "{}"); } catch {}
    const prov = meta.provenance || {};
    setDetailSourceId(src.id);
    setEditingMeta({
      platforms: prov.platforms ? (Array.isArray(prov.platforms) ? prov.platforms.join(", ") : String(prov.platforms)) : "",
      sourceDescription: prov.sourceDescription || "",
      dateObtained: prov.dateObtained || "",
      wasModified: prov.wasModified || "unknown",
      modificationNotes: prov.modificationNotes || "",
      exportMethods: prov.exportMethods ? (Array.isArray(prov.exportMethods) ? prov.exportMethods.join(", ") : String(prov.exportMethods)) : "",
      notes: prov.notes || "",
      localMediaPath: meta.localMediaPath || "",
    });
  }

  // Toggle a value within a comma-separated metadata field (for the chip selectors).
  function toggleMetaCsv(field: string, val: string) {
    setEditingMeta((prev) => {
      if (!prev) return prev;
      const cur = (prev[field] || "").split(",").map((s) => s.trim()).filter(Boolean);
      const i = cur.indexOf(val);
      if (i >= 0) cur.splice(i, 1); else cur.push(val);
      return { ...prev, [field]: cur.join(", ") };
    });
  }
  function metaHasCsv(field: string, val: string) {
    return (editingMeta?.[field] || "").split(",").map((s) => s.trim()).includes(val);
  }

  async function handleSaveMeta() {
    if (!detailSourceId || !editingMeta) return;
    setSavingMeta(true);
    try {
      const src = sources.find(s => s.id === detailSourceId);
      let existing: Record<string, any> = {};
      try { existing = JSON.parse(src?.metadata || "{}"); } catch {}
      const existingProv = existing.provenance || {};
      const updated = {
        ...existing,
        provenance: {
          ...existingProv,
          platforms: editingMeta.platforms ? editingMeta.platforms.split(",").map(s => s.trim()).filter(Boolean) : existingProv.platforms,
          sourceDescription: editingMeta.sourceDescription,
          dateObtained: editingMeta.dateObtained,
          wasModified: editingMeta.wasModified,
          modificationNotes: editingMeta.modificationNotes,
          exportMethods: editingMeta.exportMethods ? editingMeta.exportMethods.split(",").map(s => s.trim()).filter(Boolean) : existingProv.exportMethods,
          notes: editingMeta.notes,
        },
        localMediaPath: editingMeta.localMediaPath || existing.localMediaPath,
      };
      const res = await fetch(`/api/sources/${detailSourceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metadata: updated }),
      });
      if (res.ok) {
        loadSources();
        setDetailSourceId(null);
        setEditingMeta(null);
      }
    } catch { /* ignore */ }
    setSavingMeta(false);
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

  async function handleDeleteDuplicates() {
    const dupCount = sources.filter((s) => s.is_duplicate_source).length;
    if (dupCount === 0) return;
    if (!confirm(`Permanently delete ${dupCount} duplicate source${dupCount !== 1 ? "s" : ""} (the same export imported more than once)? The more complete copy of each is kept. This cannot be undone.`)) return;
    try {
      const res = await fetch("/api/sources/cleanup-duplicates", { method: "POST" });
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
          { key: "browse" as const, label: "Import" },
          { key: "quick" as const, label: "Import History" },
        ]).map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`flex-1 px-4 py-2 transition ${tab === t.key ? "bg-[var(--primary)] text-white" : "hover:bg-[var(--secondary)]"}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Import tab — all controls on one line */}
      {tab === "browse" && (
        <div onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={handleDrop}
          className={`rounded-lg border p-3 transition ${dragOver ? "border-[var(--primary)] bg-[var(--primary)]/5" : "border-[var(--border)] bg-[var(--card)]"}`}>
          <div className="flex items-center gap-2 flex-wrap">
            <input ref={fileInputRef} type="file" multiple accept=".json,.xml,.txt,.html,.htm,.zip" onChange={(e) => { if (e.target.files) handleFileUpload(e.target.files); e.target.value = ""; }} className="hidden" />
            {/* @ts-expect-error webkitdirectory */}
            <input ref={dirInputRef} type="file" webkitdirectory="" onChange={(e) => { if (e.target.files) handleFileUpload(e.target.files); e.target.value = ""; }} className="hidden" />
            <button onClick={() => fileInputRef.current?.click()} disabled={importing}
              className="px-4 py-2 rounded-lg bg-[var(--primary)] text-white text-sm font-medium hover:opacity-90 transition disabled:opacity-50">
              Select Files
            </button>
            <button onClick={() => dirInputRef.current?.click()} disabled={importing}
              className="px-4 py-2 rounded-lg border border-[var(--border)] text-sm font-medium hover:bg-[var(--secondary)] transition disabled:opacity-50">
              Select Folder
            </button>
            <div className="flex-1 min-w-[200px]">
              <div className="flex gap-2">
                <input type="text" value={importPath} onChange={(e) => setImportPath(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handlePathImport()}
                  placeholder="Or enter a file/folder path..."
                  className="flex-1 px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--background)] text-sm font-mono" />
                <button onClick={handlePathImport} disabled={!importPath.trim() || importing}
                  className="px-4 py-2 rounded-lg bg-[var(--primary)] text-white text-sm font-medium hover:opacity-90 transition disabled:opacity-50 whitespace-nowrap">
                  {importing ? "Importing..." : "Import Path"}
                </button>
              </div>
            </div>
            <span className="text-[10px] text-[var(--muted-foreground)]">Facebook JSON/HTML, SMS XML, TXT, ZIP</span>
          </div>
        </div>
      )}

      {/* Import History tab */}
      {tab === "quick" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {knownPaths.map((kp) => (
            <button key={kp.path} onClick={() => { setImportPath(kp.path); setTab("browse"); }}
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
          const dupCount = sources.filter((s) => s.is_duplicate_source).length;
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
              <div className="ml-auto flex items-center gap-2">
                {dupCount > 0 && (
                  <button onClick={handleDeleteDuplicates}
                    title="Deletes the redundant copy of each duplicate-imported conversation; the more complete copy is kept"
                    className="px-2 py-1 rounded border border-[var(--destructive)] text-[var(--destructive)] hover:bg-[var(--destructive)]/10 transition">
                    Remove {dupCount} duplicate{dupCount !== 1 ? "s" : ""}
                  </button>
                )}
                {emptyCount > 0 && (
                  <button onClick={handleDeleteEmpty}
                    className="px-2 py-1 rounded border border-[var(--destructive)] text-[var(--destructive)] hover:bg-[var(--destructive)]/10 transition">
                    Remove {emptyCount} empty
                  </button>
                )}
              </div>
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
                const isUpload = src.file_path.startsWith("upload://");
                let linkedPath: string | null = null;
                try { linkedPath = JSON.parse(src.metadata || "{}").localMediaPath || null; } catch { /* ignore */ }
                const isLinking = linkingSourceId === src.id;
                return (
                  <div key={src.id} className="px-4 py-2.5 hover:bg-[var(--secondary)]/30 transition">
                    <div className="group flex items-center justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] ${plat.cls}`}>{plat.label}</span>
                          <p className="text-sm font-medium truncate">{cleanSourceName(src.filename)}</p>
                          {isEmpty && <span className="shrink-0 text-[10px] text-[var(--destructive)]">empty</span>}
                          {src.duplicate_conversation_count > 0 && (
                            <span
                              title="These conversations are already present in an earlier import — the same export was uploaded more than once. Nothing is deleted; the app just shows the more complete copy and hides this one from lists."
                              className="shrink-0 px-1.5 py-0.5 rounded text-[10px] bg-amber-500/15 text-amber-600 dark:text-amber-400">
                              {src.duplicate_conversation_count} duplicate{src.duplicate_conversation_count !== 1 ? "s" : ""} of an earlier import
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-[var(--muted-foreground)] mt-0.5">
                          {src.conversation_count} conv &middot; {(src.message_count || 0).toLocaleString()} msgs &middot; {formatSize(src.file_size)} &middot; {new Date(src.imported_at).toLocaleDateString()}
                        </p>
                        {linkedPath && (
                          <p className="text-[10px] text-[var(--accent)] mt-0.5 truncate font-mono">Media: {linkedPath}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 ml-3 shrink-0">
                        <button onClick={() => detailSourceId === src.id ? setDetailSourceId(null) : openDetails(src)}
                          className={`text-xs transition hover:underline ${detailSourceId === src.id ? "text-[var(--primary)]" : "text-[var(--muted-foreground)] opacity-0 group-hover:opacity-100"}`}>
                          {detailSourceId === src.id ? "Hide Details" : "Details"}
                        </button>
                        {isUpload && !isEmpty && (
                          <button onClick={() => { setLinkingSourceId(isLinking ? null : src.id); setLinkMediaPath(linkedPath || ""); setLinkError(null); }}
                            className="text-xs text-[var(--primary)] opacity-0 group-hover:opacity-100 transition hover:underline">
                            {linkedPath ? "Change" : "Link Media"}
                          </button>
                        )}
                        <button onClick={() => handleDeleteSource(src.id, src.filename)}
                          className="text-xs text-[var(--destructive)] opacity-0 group-hover:opacity-100 transition hover:underline">
                            Delete
                        </button>
                      </div>
                    </div>
                    {isLinking && (
                      <div className="mt-2 flex gap-2 items-center">
                        <input type="text" value={linkMediaPath} onChange={(e) => setLinkMediaPath(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && handleLinkMedia(src.id)}
                          placeholder="Paste local folder path (e.g. D:\tmp\fb_zips\jessicaarsenault_...)"
                          className="flex-1 px-2 py-1 rounded border border-[var(--border)] bg-[var(--background)] text-xs font-mono" />
                        <button onClick={() => handleLinkMedia(src.id)}
                          disabled={!linkMediaPath.trim()}
                          className="px-3 py-1 rounded bg-[var(--primary)] text-white text-xs disabled:opacity-50">
                          Save
                        </button>
                        <button onClick={() => { setLinkingSourceId(null); setLinkError(null); }}
                          className="px-2 py-1 text-xs text-[var(--muted-foreground)]">Cancel</button>
                        {linkError && <span className="text-[10px] text-[var(--destructive)]">{linkError}</span>}
                      </div>
                    )}
                    {detailSourceId === src.id && editingMeta && (
                      <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--background)] p-4 space-y-4">
                        <div className="flex items-center justify-between">
                          <h4 className="text-sm font-semibold">Import Details</h4>
                          <div className="flex items-center gap-2">
                            <button onClick={() => { setDetailSourceId(null); setEditingMeta(null); }}
                              className="px-3 py-1.5 rounded text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
                              Cancel
                            </button>
                            <button onClick={handleSaveMeta} disabled={savingMeta}
                              className="px-4 py-1.5 rounded bg-[var(--primary)] text-white text-sm disabled:opacity-50">
                              {savingMeta ? "Saving..." : "Save"}
                            </button>
                          </div>
                        </div>
                        <div className="space-y-4">
                          {/* Platforms — same multi-select chips as the import-time form */}
                          <div>
                            <label className="text-xs text-[var(--muted-foreground)] uppercase block mb-1.5">Platform(s) — select all that apply</label>
                            <div className="flex flex-wrap gap-1.5">
                              {KNOWN_PLATFORMS.map((p) => (
                                <button key={p} type="button" onClick={() => toggleMetaCsv("platforms", p)}
                                  className={`px-3 py-1.5 rounded-full text-xs font-medium transition ${
                                    metaHasCsv("platforms", p) ? "bg-[var(--primary)] text-white" : "bg-[var(--secondary)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                                  }`}>{p}</button>
                              ))}
                            </div>
                            <input type="text" value={editingMeta.platforms} onChange={(e) => setEditingMeta({...editingMeta, platforms: e.target.value})}
                              placeholder="Platforms (comma-separated; chips above also edit this)"
                              className="w-full mt-2 px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--card)] text-sm" />
                          </div>

                          {/* How obtained — multi-select chips */}
                          <div>
                            <label className="text-xs text-[var(--muted-foreground)] uppercase block mb-1.5">How was this data obtained? Select all that apply</label>
                            <div className="flex flex-wrap gap-1.5">
                              {EXPORT_METHODS.map((m) => (
                                <button key={m} type="button" onClick={() => toggleMetaCsv("exportMethods", m)}
                                  className={`px-3 py-1.5 rounded-full text-xs font-medium transition ${
                                    metaHasCsv("exportMethods", m) ? "bg-[var(--primary)] text-white" : "bg-[var(--secondary)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                                  }`}>{m}</button>
                              ))}
                            </div>
                            <input type="text" value={editingMeta.exportMethods} onChange={(e) => setEditingMeta({...editingMeta, exportMethods: e.target.value})}
                              placeholder="Other method..."
                              className="w-full mt-2 px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--card)] text-sm" />
                          </div>

                          <div>
                            <label className="text-xs text-[var(--muted-foreground)] uppercase block mb-1.5">Source Description</label>
                            <input type="text" value={editingMeta.sourceDescription} onChange={(e) => setEditingMeta({...editingMeta, sourceDescription: e.target.value})}
                              placeholder="e.g. Downloaded from Facebook account settings on my laptop"
                              className="w-full px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--card)] text-sm" />
                          </div>

                          {/* Date obtained — same DateTimePicker as the import-time form */}
                          <div>
                            <label className="text-xs text-[var(--muted-foreground)] uppercase block mb-1.5">Date &amp; time obtained / exported</label>
                            <div className="w-56">
                              <DateTimePicker value={editingMeta.dateObtained} onChange={(v) => setEditingMeta({...editingMeta, dateObtained: v})} placeholder="Pick date & time..." />
                            </div>
                          </div>

                          {/* Modified? — same 3-button selector */}
                          <div>
                            <label className="text-xs text-[var(--muted-foreground)] uppercase block mb-1.5">Was this data modified before import?</label>
                            <div className="flex gap-2 max-w-md">
                              {([
                                { key: "no", label: "No, original" },
                                { key: "yes", label: "Yes, modified" },
                                { key: "unknown", label: "Not sure" },
                              ]).map((opt) => (
                                <button key={opt.key} type="button" onClick={() => setEditingMeta({...editingMeta, wasModified: opt.key})}
                                  className={`flex-1 px-3 py-1.5 rounded-lg border text-xs font-medium transition ${
                                    editingMeta.wasModified === opt.key
                                      ? opt.key === "yes" ? "border-amber-500 bg-amber-500/10 text-amber-400"
                                        : opt.key === "no" ? "border-green-500 bg-green-500/10 text-green-400"
                                        : "border-[var(--primary)] bg-[var(--primary)]/10"
                                      : "border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--muted-foreground)]"
                                  }`}>{opt.label}</button>
                              ))}
                            </div>
                            {editingMeta.wasModified === "yes" && (
                              <textarea value={editingMeta.modificationNotes} onChange={(e) => setEditingMeta({...editingMeta, modificationNotes: e.target.value})}
                                placeholder="Describe what was changed and why..." rows={2}
                                className="w-full mt-2 px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--card)] text-sm resize-none" />
                            )}
                          </div>

                          <div>
                            <label className="text-xs text-[var(--muted-foreground)] uppercase block mb-1.5">Additional notes</label>
                            <input type="text" value={editingMeta.notes} onChange={(e) => setEditingMeta({...editingMeta, notes: e.target.value})}
                              className="w-full px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--card)] text-sm" />
                          </div>

                          <div>
                            <label className="text-xs text-[var(--muted-foreground)] uppercase block mb-1.5">Local Media Path</label>
                            <input type="text" value={editingMeta.localMediaPath} onChange={(e) => setEditingMeta({...editingMeta, localMediaPath: e.target.value})}
                              placeholder="Path to media folder on disk"
                              className="w-full px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--card)] text-sm font-mono" />
                          </div>
                        </div>
                        <p className="text-xs text-[var(--muted-foreground)]">
                          File: <span className="font-mono">{src.file_path}</span>
                          {src.imported_at && <> &middot; Imported: {new Date(src.imported_at).toLocaleString()}</>}
                        </p>
                      </div>
                    )}
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
