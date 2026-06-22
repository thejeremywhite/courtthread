export default function ConversationsPage() {
  return (
    <div>
      <h1 className="text-3xl font-bold mb-2">Conversations</h1>
      <p className="text-[var(--muted-foreground)] mb-8">
        Browse imported message threads
      </p>

      <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-8 text-center text-[var(--muted-foreground)]">
        No conversations imported yet. Go to{" "}
        <a href="/import" className="text-[var(--primary)] underline">
          Import
        </a>{" "}
        to get started.
      </div>
    </div>
  );
}
