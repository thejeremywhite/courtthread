# CourtThread

Local-first web app for importing, searching, formatting, and exporting message threads (Facebook Messenger, SMS, call logs) for court use.

## Features

- **Multi-format import**: Facebook JSON/HTML/TXT, SMS XML (SMS Backup & Restore), call logs
- **Platform-styled display**: Messages styled like Facebook Messenger or iMessage
- **Powerful search**: Full-text (SQLite FTS5), regex, misspelling support, context window
- **Court-friendly export**: Print view, PDF export, CSV, with case headers and page numbers
- **Manual corrections**: Fix sender, timestamps, direction with full audit trail
- **Local media**: Images and videos served directly from your filesystem — no upload needed
- **Privacy first**: Everything runs locally on your machine. No cloud required.

## Quick Start

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Configuration

Copy `.env.local.example` to `.env.local` and set:

```
AUTH_PASSWORD=your-password-here
DATA_DIRS=/path/to/messages,/path/to/fb-export
DB_PATH=./data/courtthread.db
```

## Tech Stack

- **Next.js 15** (App Router)
- **SQLite** via better-sqlite3 (FTS5 for full-text search)
- **Tailwind CSS** + shadcn/ui
- **TypeScript**

## License

MIT
