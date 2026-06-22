export default function SearchPage() {
  return (
    <div>
      <h1 className="text-3xl font-bold mb-2">Search</h1>
      <p className="text-[var(--muted-foreground)] mb-8">
        Search across all imported messages with full-text, regex, and misspelling support
      </p>

      <div className="flex gap-4 mb-6">
        <input
          type="text"
          placeholder="Search messages..."
          className="flex-1 px-4 py-2 rounded-lg border border-[var(--border)] bg-[var(--card)] text-[var(--foreground)]"
          disabled
        />
        <button
          className="px-6 py-2 rounded-lg bg-[var(--primary)] text-white font-medium opacity-50"
          disabled
        >
          Search
        </button>
      </div>

      <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-8 text-center text-[var(--muted-foreground)]">
        Import messages first, then search across all conversations.
      </div>
    </div>
  );
}
