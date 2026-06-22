"use client";

import { useState, useEffect } from "react";

interface PatternBuilderProps {
  onApply: (pattern: string) => void;
  initialQuery?: string;
}

export function PatternBuilder({ onApply, initialQuery = "" }: PatternBuilderProps) {
  const [mode, setMode] = useState<"builder" | "manual">("builder");
  const [terms, setTerms] = useState<string[]>([initialQuery || ""]);
  const [matchType, setMatchType] = useState<"any" | "all" | "exact" | "variations">("any");
  const [manualPattern, setManualPattern] = useState(initialQuery || "");

  useEffect(() => {
    if (initialQuery) {
      if (mode === "builder") {
        setTerms([initialQuery]);
      } else {
        setManualPattern(initialQuery);
      }
    }
  }, [initialQuery]);

  function addTerm() {
    setTerms([...terms, ""]);
  }

  function updateTerm(index: number, value: string) {
    const next = [...terms];
    next[index] = value;
    setTerms(next);
  }

  function removeTerm(index: number) {
    if (terms.length <= 1) return;
    setTerms(terms.filter((_, i) => i !== index));
  }

  function clearAll() {
    setTerms([""]);
    setManualPattern("");
    setMatchType("any");
  }

  function buildPattern(): string {
    const filled = terms.filter((t) => t.trim());
    if (filled.length === 0) return "";

    const escaped = filled.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

    switch (matchType) {
      case "any":
        return escaped.join("|");
      case "all":
        if (escaped.length === 1) return escaped[0];
        return escaped.map((t) => `(?=.*${t})`).join("") + ".*";
      case "exact":
        return escaped.map((t) => `\\b${t}\\b`).join("|");
      case "variations": {
        const patterns = filled.map((term) => {
          const base = term.toLowerCase().trim();
          const variations = generateVariations(base);
          const uniqueVariations = [...new Set(variations)];
          return uniqueVariations.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
        });
        return patterns.join("|");
      }
    }
  }

  function generateVariations(term: string): string[] {
    const variations = [term];

    if (term.endsWith("e")) {
      variations.push(term.slice(0, -1));
    } else {
      variations.push(term + "e");
    }

    if (term.endsWith("ing")) {
      variations.push(term.slice(0, -3));
      variations.push(term.slice(0, -3) + "e");
    }
    if (term.endsWith("ed")) {
      variations.push(term.slice(0, -2));
      variations.push(term.slice(0, -2) + "e");
      variations.push(term.slice(0, -1));
    }

    if (!term.endsWith("s")) {
      variations.push(term + "s");
      variations.push(term + "es");
    } else {
      variations.push(term.slice(0, -1));
      if (term.endsWith("es")) variations.push(term.slice(0, -2));
    }

    const synonyms: Record<string, string[]> = {
      weed: ["weed", "pot", "marijuana", "cannabis", "stoned", "high", "bud", "dope"],
      pot: ["weed", "pot", "marijuana", "cannabis", "stoned", "high"],
      drink: ["drink", "drinking", "drunk", "alcohol", "beer", "wine", "liquor", "booze", "hammered", "wasted", "blacked out"],
      drunk: ["drink", "drinking", "drunk", "alcohol", "wasted", "hammered", "blacked out", "intoxicated"],
      abuse: ["abuse", "abusive", "abused", "hit", "hitting", "hurt", "assault", "attacked", "violent", "violence"],
      scared: ["scared", "afraid", "frightened", "terrified", "fear", "panic", "anxiety", "anxious"],
      custody: ["custody", "parenting", "visitation", "access", "guardianship"],
      money: ["money", "pay", "paid", "payment", "etransfer", "e-transfer", "cash", "bank", "account"],
    };

    const lowerTerm = term.toLowerCase();
    if (synonyms[lowerTerm]) {
      variations.push(...synonyms[lowerTerm]);
    }

    return variations;
  }

  function getPreview(): string {
    if (mode === "manual") return manualPattern;
    return buildPattern();
  }

  function handleApply() {
    if (mode === "manual") {
      onApply(manualPattern);
    } else {
      const pattern = buildPattern();
      if (pattern) onApply(pattern);
    }
  }

  const preview = getPreview();

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">Pattern Builder</h3>
          <div className="flex rounded-lg border border-[var(--border)] overflow-hidden text-xs">
            <button onClick={() => setMode("builder")}
              className={`px-3 py-1 ${mode === "builder" ? "bg-[var(--primary)] text-white" : "hover:bg-[var(--secondary)]"}`}>
              Visual
            </button>
            <button onClick={() => setMode("manual")}
              className={`px-3 py-1 ${mode === "manual" ? "bg-[var(--primary)] text-white" : "hover:bg-[var(--secondary)]"}`}>
              Regex
            </button>
          </div>
        </div>
        <button onClick={clearAll} className="text-xs text-[var(--muted-foreground)] hover:text-[var(--destructive)]">
          Clear
        </button>
      </div>

      {mode === "builder" ? (
        <div className="space-y-3">
          <div>
            <label className="text-xs text-[var(--muted-foreground)] mb-1 block">Search terms</label>
            {terms.map((term, i) => (
              <div key={i} className="flex gap-2 mb-1">
                <input type="text" value={term} onChange={(e) => updateTerm(i, e.target.value)}
                  placeholder="Enter a word or phrase..."
                  className="flex-1 px-3 py-1.5 rounded border border-[var(--border)] bg-[var(--background)] text-sm" />
                {terms.length > 1 && (
                  <button onClick={() => removeTerm(i)}
                    className="px-2 text-[var(--destructive)] text-sm hover:bg-[var(--destructive)]/10 rounded">x</button>
                )}
              </div>
            ))}
            <button onClick={addTerm} className="text-xs text-[var(--primary)] hover:underline mt-1">
              + Add another term
            </button>
          </div>

          <div>
            <label className="text-xs text-[var(--muted-foreground)] mb-1 block">Match type</label>
            <div className="grid grid-cols-2 gap-2">
              {[
                { value: "any", label: "Any of these", desc: "Find messages with any term" },
                { value: "all", label: "All of these", desc: "Must contain every term" },
                { value: "exact", label: "Exact words", desc: "Whole words only, no partials" },
                { value: "variations", label: "With synonyms", desc: "Include related words automatically" },
              ].map((opt) => (
                <button key={opt.value} onClick={() => setMatchType(opt.value as typeof matchType)}
                  className={`text-left px-3 py-2 rounded border text-sm transition ${
                    matchType === opt.value ? "border-[var(--primary)] bg-[var(--primary)]/10" : "border-[var(--border)] hover:border-[var(--muted-foreground)]"
                  }`}>
                  <div className="font-medium text-xs">{opt.label}</div>
                  <div className="text-[10px] text-[var(--muted-foreground)]">{opt.desc}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div>
          <label className="text-xs text-[var(--muted-foreground)] mb-1 block">Regular expression</label>
          <input type="text" value={manualPattern} onChange={(e) => setManualPattern(e.target.value)}
            placeholder="e.g. brook(e|lyn)?"
            className="w-full px-3 py-1.5 rounded border border-[var(--border)] bg-[var(--background)] text-sm font-mono" />
          <p className="text-[10px] text-[var(--muted-foreground)] mt-1">
            Case-insensitive. Use | for OR, () for groups, ? for optional, .* for anything.
          </p>
        </div>
      )}

      {preview && (
        <div className="mt-3 p-2 rounded bg-[var(--secondary)] border border-[var(--border)]">
          <p className="text-[10px] text-[var(--muted-foreground)] mb-1">Generated pattern:</p>
          <code className="text-xs font-mono break-all">{preview}</code>
        </div>
      )}

      <button onClick={handleApply} disabled={!preview}
        className="mt-3 px-4 py-1.5 rounded-lg bg-[var(--primary)] text-white text-sm font-medium hover:opacity-90 transition disabled:opacity-50">
        Apply Pattern
      </button>
    </div>
  );
}
