# The Context Map

**See everything Claude Code has ever done for you — as a living, explorable graph.**

The Context Map scans your local Claude Code session history and renders an interactive force-directed graph of every session and every file it touched. Sessions are blue nodes. Files are green. Lines connect them. Shared files — the ones Claude keeps coming back to across sessions — glow amber and grow larger. The result is a real-time map of your AI-assisted development work.

## Why this matters

When you use Claude Code daily across multiple projects, you accumulate hundreds of sessions and thousands of file interactions. That history is valuable, but it's buried in `~/.claude/projects/` as raw JSONL logs. You can't search it, you can't see patterns, and you can't answer basic questions like:

- **What files come up again and again?** The shared-file heatmap shows you which files are the real center of gravity in your work — the ones Claude touches across many sessions. These are your most important files.
- **What did I work on today?** Time filters (all / month / week / today / 1h) let you slice the graph to any window. The replay controller lets you watch today's activity unfold chronologically.
- **What do I keep asking for?** The pattern detector finds commands and prompts you type repeatedly — candidates for aliases, scripts, or Stream Deck buttons.
- **How do my sessions relate?** When two sessions touch the same files, the graph connects them visually. You can see which sessions were part of the same logical effort, even if you didn't think of them that way.

This is your development work made visible. Not the code — the *process*.

## Getting started

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000). The scanner reads your `~/.claude/projects/` directory and builds the graph. No data leaves your machine.

## What you'll see

**The loader** — a 3D code flythrough where your actual file paths, prompts, code snippets, and Claude's responses fly toward you through a starfield. It accelerates as scanning progresses. The particles are color-coded: orange for prompts, green for code, blue for files, purple for snippets.

**The graph** — a D3 force-directed layout. Blue circles are sessions (sized by tool call count). Green/amber circles are files (sized by how many sessions touched them). Edges show read/write relationships. Click any node to inspect it. Pop out detail panels into floating windows to compare sessions side by side.

**The controls** — filter by project, time range, or minimum shared-session count. Search across all your messages and files with `Cmd+K`. View repeated command patterns. Replay today's activity with the movie controller.

## Features

- **Force-directed session graph** with zoom, pan, drag, and detail panels
- **3D code flythrough loader** with real-time SSE streaming of discoveries
- **Full-text search** across user messages and file paths (`Cmd+K`)
- **Time filtering** — all / month / week / today / 1h
- **Replay controller** — VCR-style playback of today's activity with scrub, speed control, and keyboard shortcuts
- **Pattern detection** — surfaces repeated commands across sessions
- **Detachable panels** — pop out, drag, resize, compare side by side
- **Keyboard shortcuts** — Stripe-style hints, bottom bar, cheat sheet (`?`)
- **Pan mode** — hold Shift or Alt/Option to pan without clicking nodes
- **Guided tour** — walks new users through every feature

## Architecture

Three files. No build step. No framework.

- **`scanner.js`** — reads `~/.claude/projects/`, parses JSONL session logs, extracts file interactions, user messages, code snippets, and tool calls. Emits discoveries via callback for real-time streaming.
- **`server.js`** — Express server with SSE streaming (`/api/scan-stream`), graph API (`/api/graph`), search (`/api/search`), patterns (`/api/patterns`), replay (`/api/replay`), and session detail endpoints. 30-second cache.
- **`public/index.html`** — single-file frontend. D3 graph, 3D canvas flythrough, movie controller, search, patterns, tour, keyboard shortcuts. No build step, no framework, no dependencies beyond D3.

## Requirements

- Node.js 18+
- Claude Code installed (needs `~/.claude/projects/` with session logs)
