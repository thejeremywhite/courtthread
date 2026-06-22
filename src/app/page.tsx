import { getStats } from "@/lib/db/queries";

export default async function Dashboard() {
  let stats = { conversations: 0, messages: 0, participants: 0, sources: 0 };
  try {
    stats = await getStats();
  } catch {
    // DB not initialized yet
  }

  return (
    <div>
      <h1 className="text-3xl font-bold mb-2">CourtThread</h1>
      <p className="text-[var(--muted-foreground)] mb-8">
        Message thread viewer for court evidence
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="Conversations" value={stats.conversations} />
        <StatCard label="Messages" value={stats.messages} />
        <StatCard label="Participants" value={stats.participants} />
        <StatCard label="Source Files" value={stats.sources} />
      </div>

      {stats.messages === 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-8 text-center">
          <h2 className="text-xl font-semibold mb-2">Get Started</h2>
          <p className="text-[var(--muted-foreground)] mb-4">
            Import your message files to begin searching and formatting threads
            for court use.
          </p>
          <a
            href="/import"
            className="inline-block px-6 py-2 rounded-lg bg-[var(--primary)] text-white font-medium hover:opacity-90 transition"
          >
            Import Files
          </a>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
      <p className="text-sm text-[var(--muted-foreground)]">{label}</p>
      <p className="text-2xl font-bold mt-1">{value.toLocaleString()}</p>
    </div>
  );
}
