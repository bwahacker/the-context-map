# The Context Map

> **100% local. Your data never leaves your machine. No accounts, no telemetry, no external API calls.**

**See everything Claude Code has ever done for you — as a living, explorable map.**

The server runs on localhost, reads your local `~/.claude/projects/` directory, and that's it.

The Context Map parses your Claude Code session history and gives you multiple ways to explore it: a force-directed graph of sessions and files, a MIDI-sequencer-style timeline, file-centric and chronological views, full message transcripts with inline diffs, and full-text search across everything.

## Why this exists

When you use Claude Code daily across multiple projects, you accumulate hundreds of sessions and thousands of file interactions. That history is valuable, but it's buried in `~/.claude/projects/` as raw JSONL logs. You can't search it, you can't see patterns, and you can't answer basic questions like:

- **What files come up again and again?** The shared-file heatmap shows your center of gravity — the files Claude touches across many sessions.
- **What did I work on today?** Time filters let you slice to any window. The sequencer view shows every event in chronological order.
- **What do I keep asking for?** The pattern detector finds prompts you type repeatedly — candidates for aliases, scripts, or automation.
- **How do my sessions relate?** When sessions touch the same files, the graph connects them. The file view groups all edits to each file across every session.
- **What actually changed?** Expand any session in the sequencer to see the full exchange: your prompt, Claude's response, and the exact diffs — inline, in order.

This is your development process made visible.

## Getting started

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000). Everything runs locally — the server reads `~/.claude/projects/` and indexes into a local DuckDB database. Nothing is sent anywhere.

## Views

**3D Flythrough** — the loading screen. Your file paths, prompts, code snippets, and Claude's responses fly toward you through a starfield while the database syncs. Color-coded: orange for prompts, green for code, blue for files, purple for snippets.

**Session Graph** — a D3 force-directed layout. Blue circles are sessions (sized by tool call count). Green/amber circles are files (sized by cross-session frequency). Click any node to inspect. Pop out detail panels into floating windows.

**Sequencer** — a canvas-based piano-roll timeline with three view modes:
- **Session** — one track per session, clustered by file affinity, bin-packed into lanes
- **File** — one track per file, grouped by directory hierarchy. See every edit to a file across all sessions on one row.
- **Timeline** — all events from all sessions on a single chronological track. See the true order of operations across your agents.

Click any clip in the sequencer to expand it into a full transcript with exchange-based layout: your prompt, Claude's response, and file diffs — each column scrolls independently.

## Features

- **Force-directed session graph** with zoom, pan, drag, and detail panels
- **Sequencer timeline** with session, file, and chronological view modes
- **Inline diffs** — see exactly what changed in each exchange
- **Full-text search** across all messages and file paths (`Cmd+K`)
- **Time filtering** — all / month / week / today / 1h
- **Replay controller** — VCR-style playback with scrub and speed control
- **Pattern detection** — surfaces repeated commands across sessions
- **Detachable panels** — pop out, drag, resize, compare side by side
- **DuckDB storage** — incremental indexing, fast queries, git history integration
- **Keyboard shortcuts** — Stripe-style hints, cheat sheet (`?`)

## Privacy

**Your data stays on your machine.** The Context Map:
- Runs entirely on `localhost`
- Reads only from `~/.claude/projects/` (your existing Claude Code logs)
- Stores its index in a local DuckDB file (`contextmap.duckdb`)
- Makes zero network requests to external services
- Has no analytics, tracking, or telemetry
- Requires no account or API key

## Architecture

No build step. No framework.

- **`scanner.js`** — reads `~/.claude/projects/`, parses JSONL session logs, extracts file interactions, messages, code snippets, and tool calls
- **`server.js`** — Express server with graph, search, sequencer, transcript, and pattern APIs. SSE streaming for live scan progress.
- **`db.js`** — DuckDB storage layer for incremental indexing and fast queries
- **`git-scanner.js`** — syncs git commit history from workspace repos
- **`public/index.html`** — main frontend: D3 graph, flythrough, controls, search
- **`public/sequencer.js`** — canvas-based sequencer/timeline view

## Requirements

- Node.js 18+
- Claude Code installed (needs `~/.claude/projects/` with session logs)

## Contact

Found a bug? Want to chat? mitch.haile@gmail.com
