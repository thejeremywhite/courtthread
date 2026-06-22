export default function SettingsPage() {
  return (
    <div>
      <h1 className="text-3xl font-bold mb-2">Settings</h1>
      <p className="text-[var(--muted-foreground)] mb-8">
        Configure corrections, display preferences, and export settings
      </p>

      <div className="space-y-6">
        <section className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-6">
          <h2 className="text-lg font-semibold mb-4">Case Information</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-[var(--muted-foreground)] mb-1">
                Case Name
              </label>
              <input
                type="text"
                className="w-full px-3 py-2 rounded border border-[var(--border)] bg-[var(--background)]"
                placeholder="e.g. White v. Mann"
              />
            </div>
            <div>
              <label className="block text-sm text-[var(--muted-foreground)] mb-1">
                Court File Number
              </label>
              <input
                type="text"
                className="w-full px-3 py-2 rounded border border-[var(--border)] bg-[var(--background)]"
                placeholder="e.g. 12345"
              />
            </div>
            <div>
              <label className="block text-sm text-[var(--muted-foreground)] mb-1">
                Your Name (message owner)
              </label>
              <input
                type="text"
                className="w-full px-3 py-2 rounded border border-[var(--border)] bg-[var(--background)]"
                placeholder="e.g. Jeremy White"
              />
            </div>
            <div>
              <label className="block text-sm text-[var(--muted-foreground)] mb-1">
                Default Timezone
              </label>
              <select className="w-full px-3 py-2 rounded border border-[var(--border)] bg-[var(--background)]">
                <option>America/Vancouver (PST/PDT)</option>
                <option>America/Edmonton (MST/MDT)</option>
                <option>America/Toronto (EST/EDT)</option>
              </select>
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-6">
          <h2 className="text-lg font-semibold mb-4">Data Directories</h2>
          <p className="text-sm text-[var(--muted-foreground)] mb-2">
            Directories the app can serve media files from (set via DATA_DIRS in .env.local)
          </p>
          <code className="text-xs text-[var(--muted-foreground)] block bg-[var(--background)] p-2 rounded">
            Configure in .env.local: DATA_DIRS=path1,path2
          </code>
        </section>
      </div>
    </div>
  );
}
