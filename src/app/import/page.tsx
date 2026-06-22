export default function ImportPage() {
  return (
    <div>
      <h1 className="text-3xl font-bold mb-2">Import Files</h1>
      <p className="text-[var(--muted-foreground)] mb-8">
        Import message files from Facebook, SMS backups, or other sources
      </p>

      <div className="rounded-lg border-2 border-dashed border-[var(--border)] bg-[var(--card)] p-12 text-center">
        <p className="text-lg font-medium mb-2">Drop files here or click to browse</p>
        <p className="text-sm text-[var(--muted-foreground)] mb-4">
          Supported: Facebook JSON, Facebook HTML/TXT, SMS XML (SMS Backup &amp; Restore)
        </p>
        <p className="text-xs text-[var(--muted-foreground)]">
          Files are parsed locally — nothing is uploaded to the cloud
        </p>
      </div>
    </div>
  );
}
