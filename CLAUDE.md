# The Context Map

Interactive visualization of Claude Code sessions and file interactions.

## Architecture

- `server.js` — Express backend, API endpoints, caching
- `scanner.js` — Parses JSONL session files from `~/.claude/projects/`
- `public/index.html` — Single-page frontend (D3.js graph + UI)

## Stack

- Node.js + Express backend
- D3.js force-directed graph frontend
- Single HTML file with inline CSS/JS

## Critical Rules

### NEVER overwrite files the user is actively editing
- If a file write fails because the file was modified, STOP and ask the user what changed.
- Do NOT retry with `cat >` or any other method to force-write.
- The "linter modified it" message means the USER made changes. Treat those as intentional.
- Read the file again, diff against what you intended, and merge — don't replace.

### Always read before writing
- Read the current file state before every write attempt.
- If the file has changed since your last read, read it again and incorporate the changes.

### Commit discipline
- Do not commit files that haven't been reviewed.
- When the user has been editing files in parallel, ask what's ready before staging.

## Features (current)

- Graph visualization of sessions (blue) and files (green/amber)
- Search box (Cmd+K) — searches messages and files across sessions
- Time filters (1h, today, week, month, all)
- Project filter dropdown
- Min shared sessions slider (hotspot detection)
- Detail panel (right side) with pop-out to floating windows
- Search results panel (left side)
- Repeated command/pattern detection
- Interactive tour (v2)
- Prominent centered loader with progress percentage

## Features (planned)

- DuckDB storage module for incremental indexing and fast queries
- Flythrough/fly-in animation on load (USER HAD THIS — it was lost when index.html was overwritten, needs to be rebuilt)
- Command sequencing analysis for Stream Deck layout optimization
- Stream Deck integration guidance

## API Endpoints

- `GET /api/graph?project=&minSessions=&timeRange=` — filtered graph data
- `GET /api/search?q=&type=` — search messages and files
- `GET /api/patterns` — repeated user commands
- `GET /api/projects` — list all projects
- `GET /api/sessions` — list all sessions
- `GET /api/session/:id` — single session detail
- `GET /api/scan-stream` — SSE endpoint for live scan progress
