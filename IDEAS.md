# Ideas & Feature Requests

## Tour Guide
- [x] Keyboard shortcuts: Space, Right Arrow, Enter/Return to advance; Left Arrow to go back; Escape to cancel/close

## Map Navigation
- [x] Modifier-key pan mode: hold Shift or Alt/Option to pan without hitting nodes; show grab/hand cursor
- Clicking in negative space is hard — pan mode helps but consider other approaches too
- Note: 2D pan mode is superseded by 3D flight controls; retained as part of 2D fallback view

## Replay / Movie Controller
- [x] "Replay today" button — standard movie controller look (play/pause, step fwd/back, first/last, scrubber, frame counter, speed selector)
- [x] Glassmorphism-styled floating controller bar (inspired by [Featrix/sphereviewer](https://github.com/Featrix/sphereviewer) PlaybackController)
- [x] Progressive reveal: dims entire graph, then lights up sessions and files chronologically as they were touched
- [x] Time-proportional playback: busy bursts play fast, quiet periods don't stall
- [x] Keyboard shortcuts while controller is open: Space (play/pause), Left/Right (step), Home/End (first/last), Escape (close)
- Note: Replay controls merge into the Cockpit Bar "Time Circuits" section — no separate floating bar needed

## 3D Code Flythrough Loader
- [x] Keep the flythrough — it's beautiful, don't remove it
- [x] HUD vertically centered on screen with sci-fi/heads-up-display feel (corner brackets, dark radial backdrop)
- [x] Accelerate as loading progresses (particles, stars, grid lines all speed up toward 3x by 100%)
- [x] Particle colors must match the legend (prompts=orange, code=green, files=blue, snippets=purple)
- [x] Center exclusion zone so particles don't obscure the HUD text
- [ ] Make loader HUD fonts bigger so it's impossible to miss (title, subtitle, status, counter, legend)

## Search & Message Drill-Down
- [x] Search box with Cmd+K shortcut
- [x] Search across all user messages and file paths
- [x] Filter by type: all / messages / files
- [x] Search results panel (left side) with highlighted matches
- [x] Click result to zoom to node in graph
- [ ] Show the actual messages — "show me all the stuff I wrote about a topic or that affected a specific file"
- [ ] Full message transcript view when drilling into a session
- [ ] Generate a list of useful query types automatically (topic clusters, file-centric, time-based)

## Time Filtering
- [x] Time filter buttons: all / month / week / today / 1h
- [ ] Show files edited today, last hour — surface recent activity prominently
- Note: Time filter buttons move into the Cockpit Bar "Time Circuits" section

## Control Panel Visibility
- [x] Make the control panel easier to see — labeled sections, dividers, glowing border
- [x] Users missed it until the tour — needs to be obvious
- Note: Superseded by Cockpit Bar — controls move to bottom cockpit instead of top toolbar

## Detachable / Multi-Panel Comparison
- [x] Pop-out button on detail panel to create floating windows
- [x] Draggable, resizable floating panels
- [x] Open multiple panels to compare sessions or files side by side
- [ ] Snap/dock floating panels to edges or tile them automatically

## Repeated Command / Pattern Detection
- [x] Identify commands typed often or strings that are near-similar and worth making a shortcut
- [x] Patterns panel showing frequency and session count
- [ ] Identify near-similar strings (fuzzy matching) not just exact duplicates
- [ ] Command sequencing analysis — what commands tend to follow each other
- [ ] Use sequencing data to guide arrangement of keys on a Stream Deck

## Stream Deck Integration
- [x] Link to Stream Deck on Amazon with referral code (https://amzn.to/4spWTlX) — "supports this project"
- [ ] Generate Stream Deck profile/layout based on most-used command sequences
- [ ] Export button configs directly

## Cross-Project Slicing
- [ ] Slice and dice across projects — "I work across a lot of sessions"
- [ ] Cross-project file hotspots (same file touched from different project contexts)
- [ ] Cross-project topic search (find a topic across all projects at once)
- [ ] Project comparison view — side-by-side activity

## Keyboard Shortcuts
- [x] Stripe-style keyboard modifier hints in the UI
- [x] Bottom shortcut bar showing available keys
- [x] Cheat sheet modal (press ?)
- [x] 1-5 for time filters, P for patterns, T for tour, 0 for reset zoom, Esc to close
- Note: Bottom shortcut bar superseded by Cockpit Bar; keyboard hints integrate into cockpit UI

## 3D WebGL Graph (Primary View)
- [ ] Replace D3.js 2D force graph with Three.js WebGL 3D graph
- [ ] InstancedMesh rendering for performance (single draw call for thousands of nodes)
- [ ] WASD flight-sim navigation with FlyControls
- [ ] d3-force-3d for 3D force-directed layout
- [ ] Raycasting for node hover/click interaction
- [ ] CSS2DRenderer for crisp text labels in 3D space
- [ ] Bloom post-processing for sci-fi glow effect
- [ ] Color-coded nodes matching existing legend (sessions=orange, files=blue, etc.)
- [ ] Preserve all existing features (search, time filters, detail panels, replay, patterns)
- [ ] [View in 2D] button — falls back to D3.js flat graph for users who prefer it
- D3.js 2D view is the fallback, not the default — 3D is primary

## Radar HUD Minimap
- [ ] Flight-sim style radar in corner showing full graph overview
- [ ] Current viewport / camera frustum indicated on radar
- [ ] Click radar to jump to location
- [ ] Node dots on radar match node colors

## Cockpit Control Bar
- [ ] Bottom-of-screen cockpit-style control bar (replaces current top toolbar and bottom shortcut bar)
- [ ] Flight instrument aesthetic — dark, glowing, sci-fi
- [ ] Big predefined buttons: [Today] [1h] [Week] [Month] [All] — must actually trigger time filtering (current shortcut buttons are non-functional)
- [ ] Search, project filter, min-sessions slider all move into cockpit
- [ ] [View in 2D] toggle button for D3 fallback

### Time Circuits (Back to the Future inspired)
- [ ] "Where You Were" — previous time range / last position in the graph
- [ ] "Where You Are" — current time filter and position, live clock
- [ ] "Where You're Going" — destination / next replay keyframe / upcoming activity
- [ ] Replay controls (play/pause, step, scrubber) integrated here — replaces floating movie controller
- [ ] Timeline display showing temporal context of current view

## DuckDB Storage Layer
- [ ] Load all scanned data into DuckDB for incremental indexing
- [ ] Don't re-scan unchanged session files — incremental updates only
- [ ] SQL queries on messages, files, timestamps, content of changes
- [ ] Sort by date, source tree, file name / full path, content of changes
- [ ] Full-text search on message content
- [ ] Should be a robust, standalone module — not bolted onto the current in-memory scanner
