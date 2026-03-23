/**
 * sequencer.js — MIDI-sequencer / piano-roll view of Claude Code sessions
 *
 * Y axis = tracks (one per session, grouped by project)
 * X axis = time (zoomable)
 * Colored blocks = events: user prompts (gold), file reads (green), file writes (red)
 *
 * Exposes: window.Sequencer = { show, hide, toggle, refresh }
 */

window.Sequencer = (function () {
  "use strict";

  // ─── State ───
  let canvas, ctx;
  let visible = false;
  let tracks = [];         // { session, events, projectGroup }
  let projectGroups = [];  // { name, collapsed, trackStart, trackCount }
  let timeMin = 0, timeMax = 0;
  let timeScale = 1;       // px per ms
  let scrollX = 0, scrollY = 0;
  let playheadTime = 0;
  let playing = false;
  let playInterval = null;
  let hoveredBlock = null;
  let selectedBlock = null;
  let animFrameId = null;
  let searchQuery = "";
  let searchMatches = new Set();
  let searchEventMatches = [];

  // View mode: "session" (default), "file", "timeline"
  let viewMode = "session";
  let lastSessions = [];
  let lastRange = {};
  const modeButtons = [
    { mode: "session",  label: "SESSION",  x: 0, w: 0 },
    { mode: "file",     label: "FILE",     x: 0, w: 0 },
    { mode: "timeline", label: "TIMELINE", x: 0, w: 0 },
  ];

  // Expanded clips state — Map of "trackIdx:clipIdx" → { data, scrollX, scrollY }
  const expandedPanels = new Map();
  let activePanel = null;        // key of panel currently being scrolled/dragged
  const EXPAND_H = 900;          // height of expanded row
  const FILE_BAR_H = 100;        // file tree area at bottom of expanded panel

  function panelKey(trackIdx, clipIdx) { return trackIdx + ":" + clipIdx; }
  function isExpanded(trackIdx, clipIdx) { return expandedPanels.has(panelKey(trackIdx, clipIdx)); }
  function getPanel(trackIdx, clipIdx) { return expandedPanels.get(panelKey(trackIdx, clipIdx)); }
  function hasAnyExpanded() { return expandedPanels.size > 0; }

  // Diff row state — "trackIdx:clipIdx:filePath" → { diffs, scrollX, loading }
  const diffRows = new Map();
  const DIFF_ROW_H = 200;
  function diffRowKey(trackIdx, clipIdx, filePath) { return trackIdx + ":" + clipIdx + ":" + filePath; }
  function diffRowHeightForPanel(trackIdx, clipIdx) {
    let h = 0;
    for (const [key] of diffRows) {
      if (key.startsWith(trackIdx + ":" + clipIdx + ":")) h += DIFF_ROW_H;
    }
    return h;
  }

  // Drag state
  let dragging = false, dragStartX = 0, dragStartY = 0, dragScrollX = 0, dragScrollY = 0;
  let draggingExpanded = false; // true when dragging inside expanded panel
  let draggingDiffRow = null; // key of diff row being dragged
  let draggingColIdx = -1; // which column index is being dragged inside expanded panel
  let scrubbing = false;

  // ─── Constants ───
  const TRACK_H = 36;
  const HEADER_W = 240;
  const RULER_H = 36;
  const TOP_BAR_H = 40;        // search bar area
  const GROUP_H = 24;           // project group header
  const MIN_BLOCK_W = 4;
  const COLORS = {
    user:    { r: 232, g: 168, b: 56  },  // gold
    read:    { r: 74,  g: 186, b: 106 },  // green
    write:   { r: 232, g: 91,  b: 91  },  // red
    tool:    { r: 123, g: 123, b: 255 },  // blue
    bg:      "#0a0a14",
    track:   "#0e0e1a",
    trackAlt:"#101020",
    grid:    "#1a1a2a",
    gridMaj: "#222244",
    header:  "#0c0c18",
    text:    "#c0c0c0",
    textBrt: "#f0f0f0",
    playhead:"#7b7bff",
    highlight:"rgba(123,123,255,0.15)",
    search:  "rgba(232,168,56,0.3)",
  };

  // ─── Helpers ───
  function W() { return canvas ? canvas.width / (devicePixelRatio || 1) : innerWidth; }
  function H() { return canvas ? canvas.height / (devicePixelRatio || 1) : innerHeight - 52; }
  function contentH() { return TOP_BAR_H + RULER_H; }

  function timeToX(t) {
    return HEADER_W + (new Date(t).getTime() - timeMin) * timeScale - scrollX;
  }

  function xToTime(x) {
    return timeMin + (x - HEADER_W + scrollX) / timeScale;
  }

  function trackY(index) {
    // Account for group headers + track positions
    let y = contentH() - scrollY;
    for (const g of projectGroups) {
      y += GROUP_H;
      if (index >= g.trackStart && index < g.trackStart + g.trackCount) {
        if (g.collapsed) return -9999; // hidden
        return y + (index - g.trackStart) * TRACK_H;
      }
      if (!g.collapsed) y += g.trackCount * TRACK_H;
    }
    return y;
  }

  // Markdown-aware word wrap: never break inside **bold** or `code` spans
  function mdWrap(text, width) {
    // Tokenize into spans: plain text, **bold**, `code`
    const tokens = [];
    let remain = text;
    while (remain.length > 0) {
      const bm = remain.match(/^([\s\S]*?)\*\*(.+?)\*\*/);
      const cm = remain.match(/^([\s\S]*?)(`[^`]+`)/);
      if (bm && (!cm || bm[1].length <= cm[1].length)) {
        if (bm[1]) tokens.push(bm[1]);
        tokens.push("**" + bm[2] + "**");
        remain = remain.slice(bm[0].length);
      } else if (cm) {
        if (cm[1]) tokens.push(cm[1]);
        tokens.push(cm[2]);
        remain = remain.slice(cm[0].length);
      } else {
        tokens.push(remain);
        break;
      }
    }
    // Now wrap by words, keeping markdown spans intact
    const lines = [];
    let cur = "";
    for (const tok of tokens) {
      // If it's a markdown span, don't split it
      if (tok.startsWith("**") || tok.startsWith("`")) {
        if (cur.length + tok.length > width && cur.length > 12) {
          lines.push(cur);
          cur = tok;
        } else {
          cur += tok;
        }
      } else {
        // Plain text — split on spaces
        const words = tok.split(/( +)/);
        for (const w of words) {
          if (cur.length + w.length > width && cur.length > 12) {
            lines.push(cur);
            cur = w.replace(/^ +/, ""); // trim leading space on new line
          } else {
            cur += w;
          }
        }
      }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [""];
  }

  // Render a line with basic markdown: **bold**, `code`
  function drawMdLine(ctx, text, x, y, baseFont, boldFont, codeFont, baseColor, codeColor) {
    // Split on **bold** and `code` spans
    const parts = [];
    let remain = text;
    while (remain.length > 0) {
      // Check for **bold**
      const bm = remain.match(/^(.*?)\*\*(.+?)\*\*(.*)/s);
      // Check for `code`
      const cm = remain.match(/^(.*?)`(.+?)`(.*)/s);

      if (bm && (!cm || bm.index <= cm.index || bm[1].length <= cm[1].length)) {
        if (bm[1]) parts.push({ text: bm[1], font: baseFont, color: baseColor });
        parts.push({ text: bm[2], font: boldFont, color: baseColor });
        remain = bm[3];
      } else if (cm) {
        if (cm[1]) parts.push({ text: cm[1], font: baseFont, color: baseColor });
        parts.push({ text: cm[2], font: codeFont, color: codeColor, codeBg: true });
        remain = cm[3];
      } else {
        parts.push({ text: remain, font: baseFont, color: baseColor });
        break;
      }
    }

    let px = x;
    for (const p of parts) {
      ctx.font = p.font;
      if (p.codeBg) {
        const tw = ctx.measureText(p.text).width;
        ctx.fillStyle = "rgba(80,80,160,0.25)";
        ctx.fillRect(px - 2, y - 10, tw + 4, 14);
        ctx.fillStyle = p.color;
        ctx.fillText(p.text, px, y);
        px += tw;
      } else {
        ctx.fillStyle = p.color;
        ctx.fillText(p.text, px, y);
        px += ctx.measureText(p.text).width;
      }
    }
    // Reset
    ctx.font = baseFont;
    ctx.fillStyle = baseColor;
  }

  function expandHeightForTrack(trackIdx) {
    let h = 0;
    for (const [key] of expandedPanels) {
      if (key.startsWith(trackIdx + ":")) {
        const ci = parseInt(key.split(":")[1]);
        h += EXPAND_H + diffRowHeightForPanel(trackIdx, ci);
      }
    }
    return h;
  }

  function totalContentHeight() {
    let h = 0;
    for (const g of projectGroups) {
      h += GROUP_H;
      if (!g.collapsed) {
        for (let ti = 0; ti < g.trackCount; ti++) {
          h += TRACK_H + expandHeightForTrack(g.trackStart + ti);
        }
      }
    }
    return h;
  }

  function fmtTime(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " +
      d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function fmtDuration(ms) {
    if (ms < 60000) return Math.round(ms / 1000) + "s";
    if (ms < 3600000) return Math.round(ms / 60000) + "m";
    return (ms / 3600000).toFixed(1) + "h";
  }

  function blockColor(type, intensity) {
    const c = COLORS[type] || COLORS.tool;
    // Muted/dulled colors — lower saturation, lower brightness
    const a = 0.25 + 0.35 * Math.min(1, intensity);
    return `rgba(${Math.round(c.r * 0.7)},${Math.round(c.g * 0.7)},${Math.round(c.b * 0.7)},${a})`;
  }

  function blockBorder(type) {
    const c = COLORS[type] || COLORS.tool;
    return `rgba(${Math.min(255, c.r + 20)},${Math.min(255, c.g + 20)},${Math.min(255, c.b + 20)},0.6)`;
  }

  // ─── Data ───
  async function fetchData() {
    const project = document.getElementById("projectFilter")?.value || "";
    // Read current time range from the active time button
    const activeTimeBtn = document.querySelector(".time-btn.active");
    const timeRange = activeTimeBtn ? activeTimeBtn.dataset.range : "all";
    const params = new URLSearchParams();
    if (project) params.set("project", project);
    if (timeRange && timeRange !== "all") params.set("timeRange", timeRange);
    if (searchQuery) params.set("search", searchQuery);

    try {
      const data = await fetch("/api/sequencer?" + params).then(r => r.json());
      if (data.error) { console.error("sequencer:", data.error); return; }
      lastSessions = data.sessions;
      lastRange = data.timeRange;
      buildTracks(data.sessions, data.timeRange);
      needsRedraw = true;
      // Ensure render loop is running
      if (visible && !animFrameId) render();
    } catch (e) { console.error("sequencer fetch:", e); }
  }

  function buildTracks(sessions, range) {
    tracks = [];
    projectGroups = [];
    expandedPanels.clear();
    diffRows.clear();

    if (!sessions.length) {
      timeMin = Date.now() - 86400000;
      timeMax = Date.now();
      timeScale = (W() - HEADER_W) / (timeMax - timeMin);
      return;
    }

    switch (viewMode) {
      case "file":     buildByFile(sessions); break;
      case "timeline": buildTimeline(sessions); break;
      default:         buildBySession(sessions); break;
    }

    // Time range
    timeMin = range.min ? new Date(range.min).getTime() : Date.now() - 86400000;
    timeMax = range.max ? new Date(range.max).getTime() : Date.now();
    const span = timeMax - timeMin || 86400000;
    timeMin -= span * 0.02;
    timeMax += span * 0.02;
    timeScale = (W() - HEADER_W - 20) / (timeMax - timeMin);
    scrollX = 0;
    scrollY = 0;
    playheadTime = timeMax;
  }

  // ── Session mode (default): cluster by file affinity, bin-pack into lanes ──
  function buildBySession(sessions) {
    const sessionFiles = sessions.map(s => {
      const files = new Set();
      for (const e of s.events) { if (e.file) files.add(e.file); }
      return { session: s, files };
    });

    const assigned = new Set();
    const clusters = [];
    const sorted = sessionFiles.map((sf, i) => ({ ...sf, idx: i }))
      .sort((a, b) => new Date(a.session.startTime || 0) - new Date(b.session.startTime || 0));

    for (const sf of sorted) {
      if (assigned.has(sf.idx)) continue;
      const cluster = [sf];
      assigned.add(sf.idx);
      const clusterFiles = new Set(sf.files);
      for (const other of sorted) {
        if (assigned.has(other.idx)) continue;
        let overlap = 0;
        for (const f of other.files) { if (clusterFiles.has(f)) overlap++; }
        const affinity = clusterFiles.size > 0
          ? overlap / Math.max(1, Math.min(other.files.size, clusterFiles.size)) : 0;
        if (affinity >= 0.3 || (other.files.size === 0 && cluster.length < 3)) {
          cluster.push(other);
          assigned.add(other.idx);
          for (const f of other.files) clusterFiles.add(f);
        }
      }
      clusters.push({ sessions: cluster, files: clusterFiles });
    }

    let idx = 0;
    for (const cluster of clusters) {
      cluster.sessions.sort((a, b) =>
        new Date(a.session.startTime || 0) - new Date(b.session.startTime || 0));
      const lanes = [];
      for (const sf of cluster.sessions) {
        const sStart = new Date(sf.session.startTime || 0).getTime();
        const sEnd = new Date(sf.session.endTime || sf.session.startTime || 0).getTime();
        let placed = false;
        for (const lane of lanes) {
          if (sStart >= lane.endTime + 60000) {
            lane.clips.push(sf); lane.endTime = Math.max(lane.endTime, sEnd); placed = true; break;
          }
        }
        if (!placed) lanes.push({ clips: [sf], endTime: sEnd });
      }

      const topFiles = Array.from(cluster.files)
        .map(f => f.split("/").pop())
        .filter(f => !f.startsWith(".") && !f.endsWith(".output"));
      const clusterLabel = topFiles.slice(0, 4).join(", ") || "misc";

      projectGroups.push({
        name: clusterLabel, fullName: clusterLabel, collapsed: false,
        trackStart: idx, trackCount: lanes.length, clipCount: cluster.sessions.length,
      });

      for (const lane of lanes) {
        const clips = lane.clips.map(sf => {
          const maxLen = Math.max(1, ...sf.session.events.map(e => e.length || 1));
          return {
            session: sf.session,
            events: sf.session.events.map(e => ({
              ...e,
              intensity: e.type === "user" ? Math.min(1, (e.length || 50) / Math.max(maxLen, 200)) : 0.7,
            })),
          };
        });
        tracks.push({ clips, projectGroup: clusterLabel });
        idx++;
      }
    }
  }

  // ── File mode: one track per file, grouped by full directory hierarchy ──
  function buildByFile(sessions) {
    // Collect all file events across sessions
    const fileEvents = new Map(); // filePath → [{ event, session }]
    for (const s of sessions) {
      for (const e of s.events) {
        if (!e.file) continue;
        if (!fileEvents.has(e.file)) fileEvents.set(e.file, []);
        fileEvents.get(e.file).push({ event: e, session: s });
      }
    }

    // Find common prefix to trim
    const allPaths = [...fileEvents.keys()];
    let prefix = "";
    if (allPaths.length > 1) {
      const first = allPaths[0].split("/");
      let pi = 0;
      outer: for (; pi < first.length - 1; pi++) {
        for (const p of allPaths) {
          if (p.split("/")[pi] !== first[pi]) break outer;
        }
      }
      prefix = first.slice(0, pi).join("/");
    } else if (allPaths.length === 1) {
      prefix = allPaths[0].split("/").slice(0, -1).join("/");
    }

    // Group files by their immediate parent directory (relative to prefix)
    const dirGroups = new Map(); // relativeDir → [filePath]
    for (const fp of allPaths) {
      const rel = prefix ? fp.slice(prefix.length + 1) : fp;
      const parts = rel.split("/");
      parts.pop(); // remove filename
      const dir = parts.join("/") || ".";
      if (!dirGroups.has(dir)) dirGroups.set(dir, []);
      dirGroups.get(dir).push(fp);
    }

    // Sort directories alphabetically, sort files within each by edit count desc
    const sortedDirs = [...dirGroups.keys()].sort();

    let idx = 0;
    for (const dir of sortedDirs) {
      const files = dirGroups.get(dir);
      files.sort((a, b) => fileEvents.get(b).length - fileEvents.get(a).length);

      const totalEdits = files.reduce((a, fp) => a + fileEvents.get(fp).length, 0);
      const displayDir = dir === "." ? (prefix.split("/").pop() || "/") : dir;

      projectGroups.push({
        name: displayDir + "/", fullName: dir, collapsed: false,
        trackStart: idx, trackCount: files.length, clipCount: totalEdits,
        isFileGroup: true,
      });

      for (const fp of files) {
        const entries = fileEvents.get(fp);
        const sessionMap = new Map();
        for (const { event, session } of entries) {
          if (!sessionMap.has(session.id)) sessionMap.set(session.id, { session, events: [] });
          sessionMap.get(session.id).events.push({ ...event, intensity: 0.7 });
        }

        const clips = [...sessionMap.values()].map(({ session, events }) => ({ session, events }));
        const fname = fp.split("/").pop();
        const editCount = entries.length;
        const sessionCount = sessionMap.size;
        tracks.push({
          clips, projectGroup: dir,
          label: fname,
          sublabel: editCount + " edits, " + sessionCount + " session" + (sessionCount !== 1 ? "s" : ""),
        });
        idx++;
      }
    }
  }

  // ── Timeline mode: single flat track, all events in chronological order ──
  function buildTimeline(sessions) {
    // Collect ALL events with session context
    const allEvents = [];
    for (const s of sessions) {
      for (const e of s.events) {
        if (!e.ts) continue;
        allEvents.push({ event: e, session: s, time: new Date(e.ts).getTime() });
      }
    }
    allEvents.sort((a, b) => a.time - b.time);

    // Group consecutive same-session events into clips on a single track
    const clips = [];
    let curClip = null;
    for (const item of allEvents) {
      if (!curClip || curClip.session.id !== item.session.id) {
        curClip = { session: item.session, events: [] };
        clips.push(curClip);
      }
      curClip.events.push({ ...item.event, intensity: 0.7 });
    }

    projectGroups.push({
      name: allEvents.length + " events, " + sessions.length + " sessions",
      fullName: "Timeline", collapsed: false,
      trackStart: 0, trackCount: 1, clipCount: clips.length,
    });

    tracks.push({
      clips, projectGroup: "Timeline",
      label: "all events",
      sublabel: allEvents.length + " events",
    });
  }

  // ─── Rendering ───
  let needsRedraw = true;
  function requestRedraw() { needsRedraw = true; }

  function render() {
    if (!visible) return;
    animFrameId = requestAnimationFrame(render);

    // Only redraw when something changed
    if (!needsRedraw) return;
    needsRedraw = false;

    const w = W(), h = H();
    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, w, h);

    // Draw tracks area
    drawTracks(w, h);

    // Draw time ruler
    drawRuler(w);

    // Draw top search bar
    drawTopBar(w);

    // Draw track headers (left sidebar) — drawn last to overlay
    drawHeaders(w, h);

    // Draw playhead
    drawPlayhead(h);

    // Tooltip
    if (hoveredBlock) drawTooltip(hoveredBlock);
  }

  function drawTopBar(w) {
    ctx.fillStyle = "rgba(10,10,20,0.97)";
    ctx.fillRect(0, 0, w, TOP_BAR_H);
    ctx.strokeStyle = "#2a2a4a";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, TOP_BAR_H); ctx.lineTo(w, TOP_BAR_H); ctx.stroke();

    // Title
    ctx.fillStyle = "#8a8aff";
    ctx.font = "bold 14px 'SF Mono', monospace";
    ctx.textBaseline = "middle";
    ctx.fillText("SEQUENCER", 14, TOP_BAR_H / 2);

    // Mode selector buttons
    let bx = 130;
    const by = TOP_BAR_H / 2;
    ctx.font = "bold 11px 'SF Mono', monospace";
    for (const btn of modeButtons) {
      const tw = ctx.measureText(btn.label).width + 16;
      const active = viewMode === btn.mode;
      btn.x = bx; btn.w = tw;
      // Background
      ctx.fillStyle = active ? "rgba(120,120,255,0.25)" : "rgba(40,40,60,0.5)";
      ctx.beginPath(); ctx.roundRect(bx, by - 12, tw, 24, 4); ctx.fill();
      // Border
      ctx.strokeStyle = active ? "#8a8aff" : "#3a3a5a";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(bx, by - 12, tw, 24, 4); ctx.stroke();
      // Label
      ctx.fillStyle = active ? "#ffffff" : "#888888";
      ctx.fillText(btn.label, bx + 8, by + 1);
      bx += tw + 6;
    }

    // Clip/lane counts
    const totalClips = tracks.reduce((a, t) => a + t.clips.length, 0);
    const totalEvents = tracks.reduce((a, t) => a + t.clips.reduce((b, c) => b + c.events.length, 0), 0);
    const statsX = bx + 14;

    // Search indicator
    if (searchQuery) {
      ctx.fillStyle = "#ffcc44";
      ctx.font = "14px 'SF Mono', monospace";
      ctx.fillText('search: "' + searchQuery + '"  (' + totalClips + ' chats, ' + tracks.length + ' lanes)', statsX, TOP_BAR_H / 2);
    } else {
      ctx.fillStyle = "#b0b0b0";
      ctx.font = "14px 'SF Mono', monospace";
      const modeLabel = viewMode === "file" ? (tracks.length + " files across " + projectGroups.length + " dirs")
        : viewMode === "timeline" ? (totalEvents + " events across " + tracks.length + " lanes")
        : (totalClips + " chats across " + tracks.length + " lanes");
      ctx.fillText(modeLabel + " — Cmd+K to search", statsX, TOP_BAR_H / 2);
    }

    ctx.fillStyle = "#a0a0a0";
    ctx.font = "13px 'SF Mono', monospace";
    ctx.textAlign = "right";
    ctx.fillText(totalEvents + " events", w - 14, TOP_BAR_H / 2);
    ctx.textAlign = "left";
  }

  function drawRuler(w) {
    const y = TOP_BAR_H;
    ctx.fillStyle = "rgba(12,12,22,0.95)";
    ctx.fillRect(HEADER_W, y, w - HEADER_W, RULER_H);
    ctx.strokeStyle = "#2a2a4a";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(HEADER_W, y + RULER_H); ctx.lineTo(w, y + RULER_H); ctx.stroke();

    // Adaptive time grid
    const visibleMs = (w - HEADER_W) / timeScale;
    let step, labelFn;

    if (visibleMs < 600000) {
      // < 10 min visible: show minute ticks
      step = 60000;
      labelFn = t => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    } else if (visibleMs < 7200000) {
      // < 2h: 5 min ticks
      step = 300000;
      labelFn = t => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } else if (visibleMs < 86400000) {
      // < 1 day: hour ticks
      step = 3600000;
      labelFn = t => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } else if (visibleMs < 604800000) {
      // < 1 week: 6h ticks
      step = 21600000;
      labelFn = t => { const d = new Date(t); return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "2-digit" }); };
    } else if (visibleMs < 2592000000) {
      // < 30 days: day ticks
      step = 86400000;
      labelFn = t => new Date(t).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    } else {
      // months: week ticks
      step = 604800000;
      labelFn = t => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    }

    // Draw ticks
    const start = Math.floor((timeMin + scrollX / timeScale) / step) * step;
    const end = timeMin + (w - HEADER_W + scrollX) / timeScale;
    ctx.font = "12px 'SF Mono', monospace";
    ctx.textBaseline = "bottom";

    for (let t = start; t <= end; t += step) {
      const x = timeToX(t);
      if (x < HEADER_W || x > w) continue;

      // Tick line through ruler
      ctx.strokeStyle = "#555";
      ctx.beginPath(); ctx.moveTo(x, y + RULER_H - 8); ctx.lineTo(x, y + RULER_H); ctx.stroke();

      // Label
      ctx.fillStyle = "#c0c0c0";
      ctx.textAlign = "center";
      ctx.fillText(labelFn(t), x, y + RULER_H - 10);
    }
    ctx.textAlign = "left";
  }

  function drawTracks(w, h) {
    const clipTop = contentH();

    // Grid lines from ruler
    const visibleMs = (w - HEADER_W) / timeScale;
    let gridStep;
    if (visibleMs < 600000) gridStep = 60000;
    else if (visibleMs < 7200000) gridStep = 300000;
    else if (visibleMs < 86400000) gridStep = 3600000;
    else if (visibleMs < 604800000) gridStep = 21600000;
    else if (visibleMs < 2592000000) gridStep = 86400000;
    else gridStep = 604800000;

    const gridStart = Math.floor((timeMin + scrollX / timeScale) / gridStep) * gridStep;
    const gridEnd = timeMin + (w - HEADER_W + scrollX) / timeScale;

    // Draw vertical grid lines
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 0.5;
    for (let t = gridStart; t <= gridEnd; t += gridStep) {
      const x = timeToX(t);
      if (x < HEADER_W || x > w) continue;
      ctx.beginPath(); ctx.moveTo(x, clipTop); ctx.lineTo(x, h); ctx.stroke();
    }

    // Draw tracks + clips (group headers drawn after to layer on top)
    const groupHeaderPositions = [];
    let yPos = clipTop - scrollY;
    for (let gi = 0; gi < projectGroups.length; gi++) {
      const group = projectGroups[gi];

      // Record group header position for later drawing
      groupHeaderPositions.push({ y: yPos, gi });
      yPos += GROUP_H;

      if (group.collapsed) continue;

      // Track lanes — each lane has multiple clips
      for (let ti = 0; ti < group.trackCount; ti++) {
        const trackIdx = group.trackStart + ti;
        const track = tracks[trackIdx];
        if (!track) continue;

        const ty = yPos;
        yPos += TRACK_H;

        // Skip if off-screen
        if (ty + TRACK_H < clipTop || ty > h) continue;

        // Track background (alternating)
        ctx.fillStyle = ti % 2 === 0 ? COLORS.track : COLORS.trackAlt;
        ctx.fillRect(HEADER_W, Math.max(clipTop, ty), w - HEADER_W, TRACK_H);

        // Track bottom border
        ctx.strokeStyle = "#1a1a2a";
        ctx.lineWidth = 0.5;
        ctx.beginPath(); ctx.moveTo(HEADER_W, ty + TRACK_H); ctx.lineTo(w, ty + TRACK_H); ctx.stroke();

        // Is there an expanded clip? Which one?
        const hasExpanded = hasAnyExpanded();

        // Draw each clip (session) in this lane
        for (let ci = 0; ci < track.clips.length; ci++) {
          const clip = track.clips[ci];
          const isActiveClip = isExpanded(trackIdx, ci);
          const isDimmed = hasExpanded && !isActiveClip;

          // Session span bar (the "clip" container)
          if (clip.session.startTime && clip.session.endTime) {
            const sx = timeToX(clip.session.startTime);
            const ex = timeToX(clip.session.endTime);
            if (ex > HEADER_W && sx < w) {
              const clx = Math.max(HEADER_W, sx);
              const clw = Math.min(w, ex) - clx;

              if (isActiveClip) {
                // Bright highlight for active clip
                ctx.fillStyle = "rgba(80,80,180,0.25)";
                ctx.beginPath();
                ctx.roundRect(clx, ty + 1, clw, TRACK_H - 2, 4);
                ctx.fill();
                // Bright border
                ctx.strokeStyle = "rgba(180,180,255,0.9)";
                ctx.lineWidth = 2.5;
                ctx.beginPath();
                ctx.roundRect(clx, ty + 1, clw, TRACK_H - 2, 4);
                ctx.stroke();
              } else {
                // Normal or dimmed clip
                ctx.fillStyle = isDimmed ? "rgba(20,20,40,0.1)" : "rgba(40,40,80,0.15)";
                ctx.beginPath();
                ctx.roundRect(clx, ty + 1, clw, TRACK_H - 2, 4);
                ctx.fill();
                ctx.strokeStyle = isDimmed ? "rgba(80,80,140,0.2)" : "rgba(130,130,220,0.5)";
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.roundRect(clx, ty + 1, clw, TRACK_H - 2, 4);
                ctx.stroke();
              }

              // Clip title label — show title, not UUID
              if (clw > 40) {
                ctx.font = "11px 'SF Mono', monospace";
                ctx.fillStyle = isDimmed ? "#555577" : "#c0c0ee";
                ctx.textBaseline = "top";
                const title = clip.session.title || "";
                const maxC = Math.floor((clw - 6) / 6.6);
                if (title) ctx.fillText(title.slice(0, maxC), clx + 3, ty + 2);
              }
            }
          }

          // Event blocks within this clip
          for (let ei = 0; ei < clip.events.length; ei++) {
            const evt = clip.events[ei];
            if (!evt.ts) continue;
            const ex = timeToX(evt.ts);
            let bw;
            if (evt.type === "user") {
              bw = Math.max(MIN_BLOCK_W, Math.min(80, (evt.length || 50) * timeScale * 10000));
            } else {
              bw = Math.max(MIN_BLOCK_W, 8);
            }

            if (ex + bw < HEADER_W || ex > w) continue;

            const bx = Math.max(HEADER_W, ex);
            const by = ty + 10;
            const bh = TRACK_H - 13;

            const blockType = evt.type === "user" ? "user" : evt.type === "read" ? "read" : evt.type === "write" ? "write" : "tool";

            if (isDimmed) {
              // Dimmed event blocks — very faded
              ctx.globalAlpha = 0.2;
            }

            ctx.fillStyle = blockColor(blockType, evt.intensity);
            ctx.fillRect(bx, by, Math.min(bw, w - bx), bh);

            ctx.fillStyle = blockBorder(blockType);
            ctx.fillRect(bx, by, 1.5, bh);

            if (isDimmed) {
              ctx.globalAlpha = 1;
            }

            // Highlight if hovered or selected
            if (!isDimmed && hoveredBlock && hoveredBlock.trackIdx === trackIdx && hoveredBlock.clipIdx === ci && hoveredBlock.eventIdx === ei) {
              ctx.strokeStyle = "#fff";
              ctx.lineWidth = 1.5;
              ctx.strokeRect(bx, by, Math.min(bw, w - bx), bh);
            }
            if (!isDimmed && selectedBlock && selectedBlock.trackIdx === trackIdx && selectedBlock.clipIdx === ci && selectedBlock.eventIdx === ei) {
              ctx.strokeStyle = COLORS.playhead;
              ctx.lineWidth = 2;
              ctx.strokeRect(bx - 1, by - 1, Math.min(bw + 2, w - bx + 2), bh + 2);
            }

            // Label for files
            if (!isDimmed && bw > 20 && (evt.type === "read" || evt.type === "write") && evt.file) {
              const fname = evt.file.split("/").pop();
              ctx.font = "10px 'SF Mono', monospace";
              ctx.fillStyle = evt.type === "write" ? "#ffcccc" : "#ccffcc";
              ctx.textBaseline = "middle";
              const maxChars = Math.floor((bw - 4) / 6);
              ctx.fillText(fname.slice(0, maxChars), bx + 3, by + bh / 2);
            }

            // Label for user messages
            if (!isDimmed && bw > 30 && evt.type === "user" && evt.text) {
              ctx.font = "10px 'SF Mono', monospace";
              ctx.fillStyle = "#ffeecc";
              ctx.textBaseline = "middle";
              const maxChars = Math.floor((bw - 4) / 6);
              ctx.fillText(evt.text.slice(0, maxChars), bx + 3, by + bh / 2);
            }
          }
        }

        // ── Expanded panels + diff rows below this track ──
        for (let ci = 0; ci < track.clips.length; ci++) {
          const pk = panelKey(trackIdx, ci);
          const panel = expandedPanels.get(pk);
          if (panel) {
            drawExpandedPanel(HEADER_W, yPos, w - HEADER_W, EXPAND_H, clipTop, h, panel, trackIdx, ci);
            yPos += EXPAND_H;
            // Draw any open diff rows for this panel
            for (const [drKey, drState] of diffRows) {
              if (drKey.startsWith(trackIdx + ":" + ci + ":")) {
                const filePath = drKey.slice((trackIdx + ":" + ci + ":").length);
                drawDiffRow(HEADER_W, yPos, w - HEADER_W, DIFF_ROW_H, clipTop, h, drState, filePath, panel);
                yPos += DIFF_ROW_H;
              }
            }
          }
        }
      }
    }

    // ── Draw group headers ON TOP of clips ──
    for (const { y: gy } of groupHeaderPositions) {
      if (gy + GROUP_H > clipTop && gy < h) {
        ctx.fillStyle = "#111122";
        ctx.fillRect(HEADER_W, Math.max(clipTop, gy), w - HEADER_W, GROUP_H);
        ctx.strokeStyle = "#2a2a4a";
        ctx.beginPath();
        ctx.moveTo(HEADER_W, gy + GROUP_H);
        ctx.lineTo(w, gy + GROUP_H);
        ctx.stroke();
      }
    }
  }

  function drawExpandedPanel(px, py, pw, ph, clipTop, viewH, panel, pTrackIdx, pClipIdx) {
    if (py + ph < clipTop || py > viewH) return;

    const drawY = Math.max(clipTop, py);
    const drawH = Math.min(ph, py + ph - drawY);

    // Panel background
    ctx.fillStyle = "#050510";
    ctx.fillRect(px, drawY, pw, drawH);
    ctx.strokeStyle = "#5555aa";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(px, drawY, pw, drawH);

    if (!panel.data) {
      const elapsed = ((Date.now() - (panel.loadStart || Date.now())) / 1000).toFixed(1);
      const dots = ".".repeat(1 + Math.floor(Date.now() / 400) % 3);
      ctx.fillStyle = "#ccccff";
      ctx.font = "bold 16px 'SF Mono', monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("Loading transcript" + dots, px + pw / 2, py + ph / 2 - 12);
      ctx.font = "13px 'SF Mono', monospace";
      ctx.fillStyle = "#888";
      ctx.fillText(elapsed + "s elapsed", px + pw / 2, py + ph / 2 + 14);
      ctx.textAlign = "left";
      // Keep redrawing to animate
      needsRedraw = true;
      return;
    }

    const msgs = panel.data.messages || [];
    if (msgs.length === 0) {
      ctx.fillStyle = "#c0c0c0";
      ctx.font = "14px 'SF Mono', monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("No messages found", px + pw / 2, py + ph / 2);
      ctx.textAlign = "left";
      return;
    }

    // ── Pair user→assistant exchanges ──
    // Each exchange = { user: [msgs], assistant: [msgs], edits: [] }
    const exchanges = [];
    let curExchange = null;
    for (const msg of msgs) {
      const text = (msg.text || "").trim();
      if (!text && (!msg.tools || !msg.tools.length) && (!msg.edits || !msg.edits.length)) continue;
      if (msg.role === "user") {
        curExchange = { user: [msg], assistant: [], edits: [] };
        exchanges.push(curExchange);
      } else if (msg.role === "assistant") {
        if (!curExchange) {
          curExchange = { user: [], assistant: [], edits: [] };
          exchanges.push(curExchange);
        }
        curExchange.assistant.push(msg);
        if (msg.edits) {
          for (const e of msg.edits) curExchange.edits.push(e);
        }
      }
    }

    // ── Collect only modified files from session events ──
    const files = [];
    const fileSet = new Set();
    const track = tracks[pTrackIdx];
    if (track) {
      const clip = track.clips[pClipIdx];
      if (clip && clip.events) {
        for (const evt of clip.events) {
          if (evt.file && evt.type === "write" && !fileSet.has(evt.file)) {
            fileSet.add(evt.file);
            files.push({ path: evt.file, type: evt.type });
          }
        }
      }
    }

    // ── Layout: measure columns ──
    const COL_GAP = 8;
    const COL_PAD = 12;
    const FONT_SIZE = 13;
    const LINE_H = 18;
    const HEADER_HT = 22;
    const msgAreaH = ph - FILE_BAR_H - 8;
    const charW = FONT_SIZE * 0.6;

    // Helper: build wrapped lines from a set of messages
    function buildLines(messages) {
      const lines = [];
      let toolOnlyCount = 0;
      for (const msg of messages) {
        const rawText = (msg.text || "").replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, "")
          .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
          .replace(/<[^>]+>/g, "").trim();
        if (rawText) {
          for (const para of rawText.split("\n")) {
            if (!para.trim()) { lines.push({ text: "", tool: false }); continue; }
            for (const wl of mdWrap(para, 50)) {
              lines.push({ text: wl, tool: false });
            }
          }
        }
        if (msg.tools && msg.tools.length) {
          if (rawText) {
            lines.push({ text: "⚙ " + msg.tools.join(", "), tool: true });
          } else {
            toolOnlyCount += msg.tools.length;
          }
        }
        if (messages.length > 1 && rawText) lines.push({ text: "", tool: false });
      }
      if (toolOnlyCount > 0) {
        lines.push({ text: "⚙ called " + toolOnlyCount + " tools", tool: true });
      }
      while (lines.length > 0 && !lines[lines.length - 1].text) lines.pop();
      return lines;
    }

    // Build exchange columns — each has: userLines, assistantLines, edits, timestamp
    const columns = [];
    for (const ex of exchanges) {
      const userLines = buildLines(ex.user);
      const assistantLines = buildLines(ex.assistant);

      // Build edit display lines
      const editLines = [];
      for (const edit of ex.edits) {
        editLines.push({ text: (edit.tool === "Write" ? "✎ Write " : "✎ Edit ") + edit.file, edit_header: true });
        if (edit.tool === "Edit") {
          if (edit.oldString) {
            for (const ol of edit.oldString.split("\n").slice(0, 10)) {
              editLines.push({ text: "- " + ol, edit_del: true });
            }
            if (edit.oldString.split("\n").length > 10) editLines.push({ text: "  ..." + (edit.oldString.split("\n").length - 10) + " more", edit_del: true });
          }
          if (edit.newString) {
            for (const nl of edit.newString.split("\n").slice(0, 10)) {
              editLines.push({ text: "+ " + nl, edit_add: true });
            }
            if (edit.newString.split("\n").length > 10) editLines.push({ text: "  ..." + (edit.newString.split("\n").length - 10) + " more", edit_add: true });
          }
        } else if (edit.tool === "Write") {
          for (const wl of (edit.content || "").split("\n").slice(0, 10)) {
            editLines.push({ text: wl, edit_add: true });
          }
        }
        editLines.push({ text: "", tool: false }); // gap between edits
      }

      // Width from widest section
      let maxLen = 20;
      const allSample = [...userLines.slice(0, 30), ...assistantLines.slice(0, 30), ...editLines.slice(0, 20)];
      for (const l of allSample) maxLen = Math.max(maxLen, (l.text || "").length);
      const colW = Math.min(420, Math.max(200, maxLen * charW + COL_PAD * 2));

      const ts = (ex.user[0] || ex.assistant[0] || {}).timestamp;
      columns.push({ userLines, assistantLines, editLines, edits: ex.edits, width: colW, timestamp: ts });
    }

    // Total width of all columns
    const totalW = columns.reduce((a, c) => a + c.width + COL_GAP, 0);

    // Clamp scroll
    const maxScrollX = Math.max(0, totalW - pw + 20);
    panel.scrollX = Math.max(0, Math.min(panel.scrollX, maxScrollX));

    // ── Draw exchange columns (vertical: prompt → response → files) ──
    ctx.save();
    ctx.beginPath();
    ctx.rect(px, drawY, pw, drawH - FILE_BAR_H);
    ctx.clip();

    const baseFont = FONT_SIZE + "px 'SF Mono', monospace";
    const boldFont = "bold " + FONT_SIZE + "px 'SF Mono', monospace";
    const codeFont = FONT_SIZE + "px 'SF Mono', monospace";
    const codeColor = "#88ddff";
    const listColor = "#ffcc44";

    // Helper: render lines into a section, returns y after last line
    function renderLines(lines, cx, startY, colW, clipYTop, clipYBot, color) {
      ctx.font = baseFont;
      ctx.fillStyle = color;
      let ly = startY;
      for (const line of lines) {
        if (ly > clipYBot + 10) break;
        if (!line.text) { ly += LINE_H * 0.4; continue; }
        if (ly + LINE_H >= clipYTop) {
          if (line.edit_header) {
            ctx.font = "bold 11px 'SF Mono', monospace";
            ctx.fillStyle = "#ddbb55";
            ctx.fillText(line.text, cx + COL_PAD, ly);
            ctx.font = baseFont; ctx.fillStyle = color;
          } else if (line.edit_del) {
            ctx.fillStyle = "rgba(255,80,80,0.12)";
            ctx.fillRect(cx + COL_PAD - 2, ly - 2, colW - COL_PAD * 2 + 4, LINE_H);
            ctx.font = "10px 'SF Mono', monospace"; ctx.fillStyle = "#ff8888";
            ctx.fillText(line.text.slice(0, 50), cx + COL_PAD, ly);
            ctx.font = baseFont; ctx.fillStyle = color;
          } else if (line.edit_add) {
            ctx.fillStyle = "rgba(80,255,80,0.08)";
            ctx.fillRect(cx + COL_PAD - 2, ly - 2, colW - COL_PAD * 2 + 4, LINE_H);
            ctx.font = "10px 'SF Mono', monospace"; ctx.fillStyle = "#88ff88";
            ctx.fillText(line.text.slice(0, 50), cx + COL_PAD, ly);
            ctx.font = baseFont; ctx.fillStyle = color;
          } else if (line.tool) {
            ctx.fillStyle = "#66dd66"; ctx.font = "12px 'SF Mono', monospace";
            ctx.fillText(line.text, cx + COL_PAD, ly);
            ctx.fillStyle = color; ctx.font = baseFont;
          } else {
            const t = line.text;
            let lx = cx + COL_PAD;
            if (/^#{1,4}\s/.test(t)) {
              ctx.font = boldFont; ctx.fillStyle = "#ffffff";
              ctx.fillText(t.replace(/^#{1,4}\s+/, ""), lx, ly);
              ctx.font = baseFont; ctx.fillStyle = color;
            } else if (/^\|.*\|/.test(t.trim())) {
              if (/^\|[\s\-:|]+\|$/.test(t.trim())) {
                ctx.fillStyle = "#444466";
                ctx.fillRect(lx, ly + LINE_H * 0.4, colW - COL_PAD * 2, 1);
                ctx.fillStyle = color;
              } else {
                const cells = t.split("|").filter((c, i, a) => i > 0 && i < a.length - 1);
                let tx = lx;
                const cellW = Math.max(60, (colW - COL_PAD * 2) / Math.max(1, cells.length));
                for (const cell of cells) {
                  if (cell.trim()) drawMdLine(ctx, cell.trim(), tx + 4, ly, baseFont, boldFont, codeFont, color, codeColor);
                  ctx.fillStyle = "#333355"; ctx.fillRect(tx, ly - 2, 1, LINE_H); ctx.fillStyle = color;
                  tx += cellW;
                }
                ctx.fillStyle = "#333355"; ctx.fillRect(tx, ly - 2, 1, LINE_H); ctx.fillStyle = color;
              }
            } else if (/^\s*[-•*]\s/.test(t)) {
              ctx.fillStyle = listColor; ctx.fillText("•", lx, ly); lx += 12; ctx.fillStyle = color;
              drawMdLine(ctx, t.replace(/^\s*[-•*]\s*/, ""), lx, ly, baseFont, boldFont, codeFont, color, codeColor);
            } else if (/^\s*\d+\.\s/.test(t)) {
              const num = t.match(/^\s*(\d+\.)\s*/);
              ctx.fillStyle = listColor; ctx.fillText(num[1], lx, ly);
              lx += ctx.measureText(num[1]).width + 4; ctx.fillStyle = color;
              drawMdLine(ctx, t.replace(/^\s*\d+\.\s*/, ""), lx, ly, baseFont, boldFont, codeFont, color, codeColor);
            } else {
              drawMdLine(ctx, t, lx, ly, baseFont, boldFont, codeFont, color, codeColor);
            }
          }
        }
        ly += LINE_H;
      }
      return ly;
    }

    // Ensure per-column scroll state
    if (!panel.colScrollY) panel.colScrollY = [];

    // Store column layout for hit-testing in wheel handler
    panel.colLayouts = [];

    let cx = px + 10 - panel.scrollX;
    for (let ci = 0; ci < columns.length; ci++) {
      const col = columns[ci];
      if (!panel.colScrollY[ci]) panel.colScrollY[ci] = 0;
      const colRight = cx + col.width;
      if (colRight < px) { cx = colRight + COL_GAP; continue; }
      if (cx > px + pw) break;

      // Store layout for wheel handler hit-testing
      panel.colLayouts.push({ idx: ci, x: cx, width: col.width });

      const colTop = py + 4;
      const colH = msgAreaH - 4;
      const clipYTop = colTop;
      const clipYBot = colTop + colH;

      // Clip column
      ctx.save();
      ctx.beginPath();
      ctx.rect(cx, drawY, col.width, drawH - FILE_BAR_H);
      ctx.clip();

      let sy = colTop - panel.colScrollY[ci];

      // ── Section 1: User prompt ──
      if (col.userLines.length > 0) {
        const secH = col.userLines.length * LINE_H + HEADER_HT + 6;
        // Background
        ctx.fillStyle = "rgba(70,55,15,0.4)";
        ctx.beginPath(); ctx.roundRect(cx, sy, col.width, secH, 6); ctx.fill();
        // Accent
        ctx.fillStyle = "#ffcc44";
        ctx.fillRect(cx + 6, sy, col.width - 12, 3);
        // Label + time
        ctx.font = "bold 12px 'SF Mono', monospace";
        ctx.fillStyle = "#ffcc44"; ctx.textBaseline = "top";
        ctx.fillText("YOU", cx + COL_PAD, sy + 7);
        if (col.timestamp) {
          ctx.font = "11px 'SF Mono', monospace"; ctx.fillStyle = "#b0b0b0"; ctx.textAlign = "right";
          const ts = new Date(col.timestamp);
          ctx.fillText(ts.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " +
            ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), cx + col.width - COL_PAD, sy + 8);
          ctx.textAlign = "left";
        }
        renderLines(col.userLines, cx, sy + HEADER_HT + 4, col.width, clipYTop, clipYBot, "#ffffff");
        // Border
        ctx.strokeStyle = "rgba(255,200,60,0.25)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.roundRect(cx, sy, col.width, secH, 6); ctx.stroke();
        sy += secH + 4;
      }

      // ── Section 2: Claude response ──
      if (col.assistantLines.length > 0) {
        const secH = col.assistantLines.length * LINE_H + HEADER_HT + 6;
        ctx.fillStyle = "rgba(20,20,50,0.4)";
        ctx.beginPath(); ctx.roundRect(cx, sy, col.width, secH, 6); ctx.fill();
        ctx.fillStyle = "#7777ee";
        ctx.fillRect(cx + 6, sy, col.width - 12, 3);
        ctx.font = "bold 12px 'SF Mono', monospace";
        ctx.fillStyle = "#aaaaff"; ctx.textBaseline = "top";
        const aCount = col.assistantLines.filter(l => l.tool).length;
        ctx.fillText("CLAUDE" + (aCount > 0 ? "" : ""), cx + COL_PAD, sy + 7);
        renderLines(col.assistantLines, cx, sy + HEADER_HT + 4, col.width, clipYTop, clipYBot, "#e8e8e8");
        ctx.strokeStyle = "rgba(120,120,240,0.25)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.roundRect(cx, sy, col.width, secH, 6); ctx.stroke();
        sy += secH + 4;
      }

      // ── Section 3: Files changed (edits) ──
      if (col.editLines.length > 0) {
        const secH = col.editLines.length * LINE_H + HEADER_HT + 4;
        ctx.fillStyle = "rgba(15,25,15,0.5)";
        ctx.beginPath(); ctx.roundRect(cx, sy, col.width, secH, 6); ctx.fill();
        ctx.fillStyle = "#44aa44";
        ctx.fillRect(cx + 6, sy, col.width - 12, 3);
        ctx.font = "bold 12px 'SF Mono', monospace";
        ctx.fillStyle = "#66cc66"; ctx.textBaseline = "top";
        ctx.fillText("FILES (" + col.edits.length + ")", cx + COL_PAD, sy + 7);
        renderLines(col.editLines, cx, sy + HEADER_HT + 2, col.width, clipYTop, clipYBot, "#cccccc");
        ctx.strokeStyle = "rgba(60,160,60,0.25)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.roundRect(cx, sy, col.width, secH, 6); ctx.stroke();
        sy += secH + 4;
      }

      // Scrollbar for full column
      const colSY = panel.colScrollY[ci] || 0;
      const totalH = sy + colSY - colTop;
      if (totalH > colH) {
        const barH = Math.max(15, colH * colH / totalH);
        const maxSY = totalH - colH;
        // Clamp scroll to max
        if (colSY > maxSY) panel.colScrollY[ci] = maxSY;
        const barY = colTop + ((panel.colScrollY[ci] || 0) / maxSY) * (colH - barH);
        ctx.fillStyle = "rgba(150,150,255,0.3)";
        ctx.beginPath(); ctx.roundRect(cx + col.width - 5, Math.max(colTop, barY), 3, barH, 2); ctx.fill();
      } else {
        // Content fits — reset scroll
        panel.colScrollY[ci] = 0;
      }

      ctx.restore(); // unclip column
      cx += col.width + COL_GAP;
    }

    ctx.restore();

    // ── File tree at bottom ──
    const fileBarY = py + ph - FILE_BAR_H;
    if (fileBarY + FILE_BAR_H > drawY && fileBarY < drawY + drawH) {
      // Separator line
      ctx.strokeStyle = "#3a3a6a";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, fileBarY);
      ctx.lineTo(px + pw, fileBarY);
      ctx.stroke();

      // Background
      ctx.fillStyle = "#070714";
      ctx.fillRect(px, fileBarY, pw, FILE_BAR_H);

      if (files.length === 0) {
        ctx.fillStyle = "#666";
        ctx.font = "12px 'SF Mono', monospace";
        ctx.textBaseline = "middle";
        ctx.fillText("No file events", px + 14, fileBarY + FILE_BAR_H / 2);
      } else {
        // Group files by directory
        const dirMap = new Map();
        for (const f of files) {
          const parts = f.path.split("/");
          const fname = parts.pop();
          // Use last 2 dir segments as key
          const dir = parts.slice(-2).join("/") || "/";
          if (!dirMap.has(dir)) dirMap.set(dir, []);
          dirMap.get(dir).push({ name: fname, type: f.type, path: f.path });
        }

        // Render as columns — one per directory
        ctx.save();
        ctx.beginPath();
        ctx.rect(px, fileBarY, pw, FILE_BAR_H);
        ctx.clip();

        const COL_W = 200;
        const F_LINE_H = 16;
        let dx = px + 10;
        for (const [dir, dirFiles] of dirMap) {
          if (dx > px + pw) break;
          // Directory header
          ctx.font = "bold 10px 'SF Mono', monospace";
          ctx.fillStyle = "#8888bb";
          ctx.textBaseline = "top";
          const dirLabel = dir.length > 28 ? "…" + dir.slice(-27) : dir;
          ctx.fillText(dirLabel + "/", dx, fileBarY + 6);

          // Files under this dir
          ctx.font = "11px 'SF Mono', monospace";
          let fy = fileBarY + 22;
          for (const f of dirFiles) {
            if (fy + F_LINE_H > fileBarY + FILE_BAR_H) break;
            const drk = diffRowKey(pTrackIdx, pClipIdx, f.path || "");
            const isActive = diffRows.has(drk);
            if (isActive) {
              ctx.fillStyle = "rgba(100,100,255,0.2)";
              ctx.fillRect(dx, fy - 1, COL_W - 4, F_LINE_H);
            }
            ctx.fillStyle = isActive ? "#aaaaff" : (f.type === "write" ? "#ff9999" : "#99ff99");
            const marker = isActive ? "▼ " : (f.type === "write" ? "▪ " : "▫ ");
            ctx.fillText(marker + f.name, dx + 4, fy);
            fy += F_LINE_H;
          }

          dx += COL_W;
        }
        ctx.restore();
      }
    }

    // ── Horizontal scrollbar ──
    if (totalW > pw) {
      const barW = Math.max(30, pw * pw / totalW);
      const barX = px + (panel.scrollX / maxScrollX) * (pw - barW);
      ctx.fillStyle = "rgba(150,150,255,0.35)";
      ctx.beginPath();
      ctx.roundRect(barX, fileBarY - 8, barW, 5, 3);
      ctx.fill();
    }
  }

  // ─── Diff Row Rendering ───
  function drawDiffRow(px, py, pw, ph, clipTop, viewH, drState, filePath, parentPanel) {
    const drawY = Math.max(clipTop, py);
    const drawH = Math.min(py + ph, viewH) - drawY;
    if (drawH <= 0 || drawY >= viewH) return;

    // Background
    ctx.fillStyle = "#08051a";
    ctx.fillRect(px, drawY, pw, drawH);

    // Top border
    ctx.strokeStyle = "#5555aa";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, drawY);
    ctx.lineTo(px + pw, drawY);
    ctx.stroke();

    // File label on left
    const fname = filePath.split("/").pop();
    ctx.font = "bold 12px 'SF Mono', monospace";
    ctx.fillStyle = "#aaaaff";
    ctx.textBaseline = "top";
    ctx.fillText("▼ " + fname, px + 10, drawY + 6);

    if (drState.loading || !drState.diffs) {
      ctx.font = "13px 'SF Mono', monospace";
      ctx.fillStyle = "#888";
      const dots = ".".repeat(1 + (Math.floor(Date.now() / 400) % 3));
      ctx.fillText("Loading diffs" + dots, px + 10, drawY + 30);
      needsRedraw = true;
      return;
    }

    const edits = drState.diffs;
    if (edits.length === 0) {
      ctx.font = "13px 'SF Mono', monospace";
      ctx.fillStyle = "#666";
      ctx.fillText("No tool interactions found for this file", px + 10, drawY + 30);
      return;
    }

    // Count edits vs reads for summary
    const editCount = edits.filter(d => d.tool === "Edit" || d.tool === "Write").length;
    const readCount = edits.filter(d => d.tool === "Read").length;
    ctx.font = "11px 'SF Mono', monospace";
    ctx.fillStyle = "#888";
    const summary = editCount + " edit" + (editCount !== 1 ? "s" : "") + ", " + readCount + " read" + (readCount !== 1 ? "s" : "");
    ctx.fillText(summary, px + ctx.measureText("▼ " + fname).width + 30, drawY + 8);

    // Clip to row area
    ctx.save();
    ctx.beginPath();
    ctx.rect(px, drawY + 20, pw, drawH - 20);
    ctx.clip();

    const DCOL_W = 300;
    const DCOL_GAP = 8;
    const DCOL_PAD = 8;
    const DLINE_H = 15;
    const colTop = drawY + 22;
    const colH = drawH - 28;
    const dScrollX = drState.scrollX || 0;
    const dScrollY = drState.scrollY || 0;

    let dcx = px + 10 - dScrollX;
    for (let di = 0; di < edits.length; di++) {
      if (dcx + DCOL_W < px) { dcx += DCOL_W + DCOL_GAP; continue; }
      if (dcx > px + pw) break;
      drawDiffColumn(dcx, colTop, DCOL_W, colH, [edits[di]], DCOL_PAD, DLINE_H, dScrollY);
      dcx += DCOL_W + DCOL_GAP;
    }

    // Horizontal scrollbar
    const totalW = edits.length * (DCOL_W + DCOL_GAP);
    if (totalW > pw) {
      const barW = Math.max(30, pw * pw / totalW);
      const maxSX = totalW - pw;
      const barX = px + (dScrollX / maxSX) * (pw - barW);
      ctx.fillStyle = "rgba(150,150,255,0.35)";
      ctx.beginPath();
      ctx.roundRect(barX, py + ph - 8, barW, 5, 3);
      ctx.fill();
    }

    ctx.restore();
  }

  function drawDiffColumn(cx, colTop, colW, colH, diffs, PAD, LINE_H, scrollY) {
    // Column background
    ctx.fillStyle = "#0c0825";
    ctx.beginPath();
    ctx.roundRect(cx, colTop, colW, colH, 4);
    ctx.fill();

    // Column border
    ctx.strokeStyle = "#333366";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(cx, colTop, colW, colH, 4);
    ctx.stroke();

    // Clip inside column
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx + 2, colTop + 2, colW - 4, colH - 4);
    ctx.clip();

    const maxChars = Math.max(10, Math.floor((colW - PAD * 2 - 20) / 7));
    let ly = colTop + 4 - scrollY;

    for (const diff of diffs) {
      // Header — tool + date + time
      ctx.font = "bold 11px 'SF Mono', monospace";
      ctx.fillStyle = diff.tool === "Write" ? "#ff9999" : diff.tool === "Read" ? "#88bbff" : "#ddbb55";
      ctx.textBaseline = "top";
      let label = diff.tool;
      if (diff.timestamp) {
        const d = new Date(diff.timestamp);
        label += "  " + d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
          " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      }
      if (ly + LINE_H > colTop && ly < colTop + colH) ctx.fillText(label, cx + PAD, ly);
      ly += LINE_H + 2;

      ctx.font = "11px 'SF Mono', monospace";

      if (diff.tool === "Edit") {
        if (diff.oldString) {
          for (const ol of diff.oldString.split("\n")) {
            if (ly > colTop + colH) break;
            if (ly + LINE_H > colTop) {
              ctx.fillStyle = "rgba(255,80,80,0.15)";
              ctx.fillRect(cx + 4, ly - 2, colW - 8, LINE_H);
              ctx.fillStyle = "#ff8888";
              ctx.fillText("- " + ol.slice(0, maxChars), cx + PAD, ly);
            }
            ly += LINE_H;
          }
        }
        ly += 3;
        if (diff.newString) {
          for (const nl of diff.newString.split("\n")) {
            if (ly > colTop + colH) break;
            if (ly + LINE_H > colTop) {
              ctx.fillStyle = "rgba(80,255,80,0.1)";
              ctx.fillRect(cx + 4, ly - 2, colW - 8, LINE_H);
              ctx.fillStyle = "#88ff88";
              ctx.fillText("+ " + nl.slice(0, maxChars), cx + PAD, ly);
            }
            ly += LINE_H;
          }
        }
      } else if (diff.tool === "Write") {
        for (const wl of (diff.content || "").split("\n")) {
          if (ly > colTop + colH) break;
          if (ly + LINE_H > colTop) {
            ctx.fillStyle = "#88ff88";
            ctx.fillText(wl.slice(0, maxChars), cx + PAD, ly);
          }
          ly += LINE_H;
        }
      } else if (diff.tool === "Read") {
        if (ly + LINE_H > colTop && ly < colTop + colH) {
          ctx.fillStyle = "#6688aa";
          ctx.fillText("📖 file read", cx + PAD, ly);
        }
        ly += LINE_H;
      }
      ly += 6; // gap between diffs in same column
    }

    // Total content height for scroll indicator
    const totalH = ly + scrollY - colTop;
    const visibleH = colH;
    if (totalH > visibleH) {
      // Scroll indicator — "N more lines below"
      const remaining = Math.ceil((totalH - visibleH - scrollY) / LINE_H);
      if (remaining > 0) {
        ctx.fillStyle = "rgba(8,5,26,0.9)";
        ctx.fillRect(cx + 2, colTop + colH - 18, colW - 4, 18);
        ctx.fillStyle = "#8888cc";
        ctx.font = "10px 'SF Mono', monospace";
        ctx.fillText("↓ " + remaining + " more lines", cx + PAD, colTop + colH - 6);
      }
      // Scrollbar
      const barH = Math.max(12, visibleH * visibleH / totalH);
      const maxSY = totalH - visibleH;
      const barY = colTop + (scrollY / maxSY) * (visibleH - barH);
      ctx.fillStyle = "rgba(150,150,255,0.3)";
      ctx.beginPath();
      ctx.roundRect(cx + colW - 6, barY, 3, barH, 2);
      ctx.fill();
    }

    ctx.restore();
  }

  function drawHeaders(w, h) {
    const clipTop = contentH();
    // Header background
    ctx.fillStyle = "rgba(10,10,20,0.97)";
    ctx.fillRect(0, clipTop, HEADER_W, h - clipTop);
    ctx.strokeStyle = "#2a2a4a";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(HEADER_W, clipTop); ctx.lineTo(HEADER_W, h); ctx.stroke();

    let yPos = clipTop - scrollY;
    for (let gi = 0; gi < projectGroups.length; gi++) {
      const group = projectGroups[gi];

      // Group header
      if (yPos + GROUP_H > clipTop && yPos < h) {
        const gy = Math.max(clipTop, yPos);
        ctx.fillStyle = "#131328";
        ctx.fillRect(0, gy, HEADER_W, GROUP_H);
        ctx.strokeStyle = "#2a2a5a";
        ctx.beginPath(); ctx.moveTo(0, yPos + GROUP_H); ctx.lineTo(HEADER_W, yPos + GROUP_H); ctx.stroke();

        ctx.fillStyle = "#bbbbff";
        ctx.font = "bold 13px 'SF Mono', monospace";
        ctx.textBaseline = "middle";
        const arrow = group.collapsed ? "▶" : "▼";
        ctx.fillText(arrow + " " + group.name, 8, yPos + GROUP_H / 2);

        // Group stats
        ctx.fillStyle = "#a0a0a0";
        ctx.font = "12px 'SF Mono', monospace";
        ctx.textAlign = "right";
        if (group.isFileGroup) {
          ctx.fillText(group.trackCount + " files, " + (group.clipCount || 0) + " edits", HEADER_W - 8, yPos + GROUP_H / 2);
        } else {
          ctx.fillText((group.clipCount || group.trackCount) + " chats, " + group.trackCount + " lanes", HEADER_W - 8, yPos + GROUP_H / 2);
        }
        ctx.textAlign = "left";
      }
      yPos += GROUP_H;

      if (group.collapsed) continue;

      for (let ti = 0; ti < group.trackCount; ti++) {
        const track = tracks[group.trackStart + ti];
        if (!track) continue;
        const ty = yPos;
        yPos += TRACK_H;

        if (ty + TRACK_H < clipTop || ty > h) continue;

        // Track header background
        ctx.fillStyle = ti % 2 === 0 ? "#0c0c18" : "#0e0e1c";
        ctx.fillRect(0, Math.max(clipTop, ty), HEADER_W, TRACK_H);

        // Track bottom line
        ctx.strokeStyle = "#1a1a2a";
        ctx.lineWidth = 0.5;
        ctx.beginPath(); ctx.moveTo(0, ty + TRACK_H); ctx.lineTo(HEADER_W, ty + TRACK_H); ctx.stroke();

        // Lane label
        const nClips = track.clips.length;
        const nEvents = track.clips.reduce((a, c) => a + c.events.length, 0);
        ctx.font = "13px 'SF Mono', monospace";
        ctx.fillStyle = "#e0e0e0";
        ctx.textBaseline = "top";
        const maxChars = Math.floor((HEADER_W - 16) / 7.8);
        if (track.label) {
          ctx.fillText(track.label.slice(0, maxChars), 12, ty + 4);
        } else if (nClips === 1) {
          const title = track.clips[0].session.title || "Untitled";
          ctx.fillText(title.slice(0, maxChars), 12, ty + 4);
        } else {
          ctx.fillText(nClips + " clips", 12, ty + 4);
        }
        ctx.font = "11px 'SF Mono', monospace";
        ctx.fillStyle = "#a0a0a0";
        ctx.fillText(track.sublabel || (nEvents + " events"), 12, ty + 21);

        // Account for expanded panels + diff rows in this track
        const trackIdx = group.trackStart + ti;
        for (const [key] of expandedPanels) {
          if (key.startsWith(trackIdx + ":")) {
            const ci = parseInt(key.split(":")[1]);
            const ehy = yPos;
            yPos += EXPAND_H;
            if (ehy < h && ehy + EXPAND_H > clipTop) {
              ctx.fillStyle = "#08081a";
              ctx.fillRect(0, Math.max(clipTop, ehy), HEADER_W, EXPAND_H);
              ctx.fillStyle = "#4a4a8a";
              ctx.fillRect(0, Math.max(clipTop, ehy), 3, EXPAND_H);
              ctx.fillStyle = "#c0c0c0";
              ctx.font = "13px 'SF Mono', monospace";
              ctx.textBaseline = "top";
              ctx.fillText("ESC to close all", 12, ehy + 8);
              ctx.fillStyle = "#a0a0a0";
              ctx.font = "11px 'SF Mono', monospace";
              ctx.fillText("drag to scroll", 12, ehy + 26);
            }
            // Advance past diff rows for this panel
            for (const [drKey] of diffRows) {
              if (drKey.startsWith(trackIdx + ":" + ci + ":")) {
                yPos += DIFF_ROW_H;
              }
            }
          }
        }
      }
    }

    // Cover the top-left corner
    ctx.fillStyle = "rgba(10,10,20,0.97)";
    ctx.fillRect(0, TOP_BAR_H, HEADER_W, RULER_H);
    ctx.strokeStyle = "#2a2a4a";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(HEADER_W, TOP_BAR_H); ctx.lineTo(HEADER_W, TOP_BAR_H + RULER_H); ctx.stroke();

    // Legend in corner
    ctx.font = "11px 'SF Mono', monospace";
    ctx.textBaseline = "middle";
    const legend = [
      { label: "prompt", color: COLORS.user },
      { label: "read", color: COLORS.read },
      { label: "write", color: COLORS.write },
    ];
    let lx = 10;
    for (const l of legend) {
      ctx.fillStyle = `rgb(${l.color.r},${l.color.g},${l.color.b})`;
      ctx.fillRect(lx, TOP_BAR_H + RULER_H / 2 - 4, 10, 8);
      lx += 13;
      ctx.fillStyle = "#c0c0c0";
      ctx.fillText(l.label, lx, TOP_BAR_H + RULER_H / 2);
      lx += ctx.measureText(l.label).width + 10;
    }
  }

  function drawPlayhead(h) {
    if (!playheadTime) return;
    const x = timeToX(playheadTime);
    if (x < HEADER_W || x > W()) return;

    ctx.strokeStyle = COLORS.playhead;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, TOP_BAR_H);
    ctx.lineTo(x, h);
    ctx.stroke();

    // Playhead triangle on ruler
    ctx.fillStyle = COLORS.playhead;
    ctx.beginPath();
    ctx.moveTo(x - 5, TOP_BAR_H);
    ctx.lineTo(x + 5, TOP_BAR_H);
    ctx.lineTo(x, TOP_BAR_H + 8);
    ctx.closePath();
    ctx.fill();

    // Time label
    ctx.font = "12px 'SF Mono', monospace";
    ctx.fillStyle = "#ccccff";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(fmtTime(playheadTime), x, TOP_BAR_H + 10);
    ctx.textAlign = "left";
  }

  function drawTooltip(block) {
    const track = tracks[block.trackIdx];
    if (!track) return;
    const clip = track.clips[block.clipIdx];
    if (!clip) return;
    const evt = clip.events[block.eventIdx];
    if (!evt) return;

    const PAD = 14;
    const LINE_H = 18;
    const MAX_TIP_W = 1200;

    // Strip IDE/system tags from text
    function cleanText(t) {
      return (t || "").replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, "")
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
        .replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    }

    // Build tooltip content as styled lines: { text, color, font, wrap? }
    const parts = [];

    // Session title + time
    parts.push({ text: clip.session.title || "Untitled session", color: "#ccccff", font: "bold 14px 'SF Mono', monospace" });
    parts.push({ text: fmtTime(evt.ts), color: "#c0c0c0", font: "13px 'SF Mono', monospace" });

    if (evt.type === "user") {
      parts.push({ text: "", color: "#333", font: "1px sans-serif", sep: true }); // separator
      parts.push({ text: "USER PROMPT", color: "#ffcc44", font: "bold 12px 'SF Mono', monospace" });
      // Show up to 600 chars of cleaned message, wrapped
      const fullText = cleanText(evt.text);
      const maxChars = 600;
      const displayText = fullText.length > maxChars ? fullText.slice(0, maxChars) + "..." : fullText;
      // Word-wrap into lines of ~120 chars (wider box)
      const wrapWidth = 120;
      for (let i = 0; i < displayText.length; i += wrapWidth) {
        let chunk = displayText.slice(i, i + wrapWidth);
        if (i + wrapWidth < displayText.length) {
          const lastSpace = chunk.lastIndexOf(" ");
          if (lastSpace > 40) { chunk = chunk.slice(0, lastSpace); i -= (wrapWidth - lastSpace - 1); }
        }
        parts.push({ text: chunk, color: "#f0f0f0", font: "14px 'SF Mono', monospace" });
      }
    } else if (evt.file) {
      parts.push({ text: "", color: "#333", font: "1px sans-serif", sep: true });
      const action = evt.type === "write" ? "WRITE" : "READ";
      const actionColor = evt.type === "write" ? "#e85b5b" : "#4aba6a";
      parts.push({ text: action + (evt.tool ? " (" + evt.tool + ")" : ""), color: actionColor, font: "bold 12px 'SF Mono', monospace" });
      // Show full file path, word-wrapped
      const fp = evt.file;
      const fname = fp.split("/").pop();
      parts.push({ text: fname, color: "#ffffff", font: "bold 14px 'SF Mono', monospace" });
      // Show directory
      const dir = fp.split("/").slice(0, -1).join("/");
      if (dir) {
        const wrapWidth = 120;
        for (let i = 0; i < dir.length; i += wrapWidth) {
          parts.push({ text: dir.slice(i, i + wrapWidth), color: "#b0b0b0", font: "13px 'SF Mono', monospace" });
        }
      }
    }

    // Project line
    if (clip.session.project) {
      parts.push({ text: "", color: "#333", font: "1px sans-serif", sep: true });
      parts.push({ text: "project: " + clip.session.project.split("/").slice(-2).join("/"), color: "#a0a0a0", font: "12px 'SF Mono', monospace" });
    }

    // Measure and draw
    let tipW = 0;
    for (const p of parts) {
      if (p.sep) continue;
      ctx.font = p.font;
      tipW = Math.max(tipW, ctx.measureText(p.text).width);
    }
    tipW = Math.min(MAX_TIP_W, tipW + PAD * 2);
    let tipH = PAD;
    for (const p of parts) {
      tipH += p.sep ? 8 : LINE_H;
    }
    tipH += PAD / 2;

    // Position: prefer above the cursor, shift left if near right edge
    const tx = Math.max(HEADER_W + 4, Math.min(block.x - tipW / 2, W() - tipW - 8));
    const ty = Math.max(contentH() + 4, Math.min(block.y - tipH - 12, H() - tipH - 8));

    // Background
    ctx.fillStyle = "rgba(8,8,16,0.96)";
    ctx.strokeStyle = "#4a4a8a";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(tx, ty, tipW, tipH, 6);
    ctx.fill();
    ctx.stroke();

    // Accent bar on left
    const accentColor = evt.type === "user" ? "#e8a838" : evt.type === "write" ? "#e85b5b" : "#4aba6a";
    ctx.fillStyle = accentColor;
    ctx.beginPath();
    ctx.roundRect(tx, ty, 4, tipH, [6, 0, 0, 6]);
    ctx.fill();

    // Draw lines
    let ly = ty + PAD;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    for (const p of parts) {
      if (p.sep) {
        ctx.strokeStyle = "#2a2a4a";
        ctx.beginPath(); ctx.moveTo(tx + 10, ly + 4); ctx.lineTo(tx + tipW - 10, ly + 4); ctx.stroke();
        ly += 8;
        continue;
      }
      ctx.font = p.font;
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, tx + PAD, ly);
      ly += LINE_H;
    }
  }

  // ─── Hit Testing ───
  function hitTest(mx, my) {
    const clipTop = contentH();
    if (mx < HEADER_W || my < clipTop) return null;

    let yPos = clipTop - scrollY;
    for (let gi = 0; gi < projectGroups.length; gi++) {
      const group = projectGroups[gi];
      yPos += GROUP_H;
      if (group.collapsed) continue;

      for (let ti = 0; ti < group.trackCount; ti++) {
        const trackIdx = group.trackStart + ti;
        const track = tracks[trackIdx];
        if (!track) continue;
        const ty = yPos;
        yPos += TRACK_H;

        // Check if mouse is in the expanded panel area
        const expH = expandHeightForTrack(trackIdx);
        if (my >= ty && my < ty + TRACK_H) {
          // In the track row — check events
          for (let ci = 0; ci < track.clips.length; ci++) {
            const clip = track.clips[ci];
            for (let ei = 0; ei < clip.events.length; ei++) {
              const evt = clip.events[ei];
              if (!evt.ts) continue;
              const ex = timeToX(evt.ts);
              let bw;
              if (evt.type === "user") {
                bw = Math.max(MIN_BLOCK_W, Math.min(80, (evt.length || 50) * timeScale * 10000));
              } else {
                bw = Math.max(MIN_BLOCK_W, 8);
              }
              if (mx >= Math.max(HEADER_W, ex) && mx <= ex + bw) {
                return { trackIdx, clipIdx: ci, eventIdx: ei, x: mx, y: my };
              }
            }
          }
        }
        yPos += expH; // skip expanded panel area
      }
    }
    return null;
  }

  function hitTestGroupHeader(mx, my) {
    const clipTop = contentH();
    if (mx > HEADER_W || my < clipTop) return -1;

    let yPos = clipTop - scrollY;
    for (let gi = 0; gi < projectGroups.length; gi++) {
      if (my >= yPos && my < yPos + GROUP_H) return gi;
      yPos += GROUP_H;
      if (!projectGroups[gi].collapsed) {
        const g = projectGroups[gi];
        for (let ti = 0; ti < g.trackCount; ti++) {
          yPos += TRACK_H + expandHeightForTrack(g.trackStart + ti);
        }
      }
    }
    return -1;
  }

  // Walk expanded panels + diff rows, calling visitor(trackIdx, clipIdx, panelY, panelKey) for each region
  // Returns first truthy visitor result, or null
  function walkExpandedRegions(mx, my, visitor) {
    if (!hasAnyExpanded()) return null;
    const clipTop = contentH();
    let yPos = clipTop - scrollY;
    for (let gi = 0; gi < projectGroups.length; gi++) {
      const group = projectGroups[gi];
      yPos += GROUP_H;
      if (group.collapsed) continue;
      for (let ti = 0; ti < group.trackCount; ti++) {
        const trackIdx = group.trackStart + ti;
        yPos += TRACK_H;
        const track = tracks[trackIdx];
        if (track) {
          for (let ci = 0; ci < track.clips.length; ci++) {
            const pk = panelKey(trackIdx, ci);
            if (expandedPanels.has(pk)) {
              const res = visitor(trackIdx, ci, yPos, pk, "panel");
              if (res) return res;
              yPos += EXPAND_H;
              // Diff rows for this panel
              for (const [drKey] of diffRows) {
                if (drKey.startsWith(trackIdx + ":" + ci + ":")) {
                  const res2 = visitor(trackIdx, ci, yPos, drKey, "diffrow");
                  if (res2) return res2;
                  yPos += DIFF_ROW_H;
                }
              }
            }
          }
        }
      }
    }
    return null;
  }

  // Check if point is inside any expanded panel; returns panel key or false
  function isInExpandedPanel(mx, my) {
    return walkExpandedRegions(mx, my, (ti, ci, y, key, type) => {
      if (type === "panel" && my >= y && my < y + EXPAND_H && mx >= HEADER_W) return key;
    }) || false;
  }

  // Check if point is inside any diff row; returns diff row key or false
  function isInDiffRow(mx, my) {
    return walkExpandedRegions(mx, my, (ti, ci, y, key, type) => {
      if (type === "diffrow" && my >= y && my < y + DIFF_ROW_H && mx >= HEADER_W) return key;
    }) || false;
  }

  // Check if click is on a file name in any expanded panel's file bar
  // Returns { trackIdx, clipIdx, filePath, sessionId } or null
  function hitTestFileBar(mx, my) {
    return walkExpandedRegions(mx, my, (trackIdx, clipIdx, panelY, pk, type) => {
      if (type !== "panel") return null;
      const fileBarY = panelY + EXPAND_H - FILE_BAR_H;
      if (my < fileBarY || my >= panelY + EXPAND_H || mx < HEADER_W) return null;

      // Reconstruct file layout (same as drawExpandedPanel)
      const panel = expandedPanels.get(pk);
      if (!panel || !panel.data) return null;
      const track = tracks[trackIdx];
      if (!track) return null;
      const clip = track.clips[clipIdx];
      if (!clip) return null;

      const files = [];
      const fileSet = new Set();
      if (clip.events) {
        for (const evt of clip.events) {
          if (evt.file && !fileSet.has(evt.file)) {
            fileSet.add(evt.file);
            files.push({ path: evt.file, type: evt.type });
          }
        }
      }
      if (files.length === 0) return null;

      // Group by directory (same logic as rendering)
      const dirMap = new Map();
      for (const f of files) {
        const parts = f.path.split("/");
        const fname = parts.pop();
        const dir = parts.slice(-2).join("/") || "/";
        if (!dirMap.has(dir)) dirMap.set(dir, []);
        dirMap.get(dir).push({ name: fname, fullPath: f.path, type: f.type });
      }

      const COL_W = 200, F_LINE_H = 16;
      let dx = HEADER_W + 10;
      for (const [dir, dirFiles] of dirMap) {
        let fy = fileBarY + 22;
        for (const f of dirFiles) {
          if (fy + F_LINE_H > fileBarY + FILE_BAR_H) break;
          if (mx >= dx && mx < dx + COL_W && my >= fy && my < fy + F_LINE_H) {
            return { trackIdx, clipIdx, filePath: f.fullPath, sessionId: clip.session.id };
          }
          fy += F_LINE_H;
        }
        dx += COL_W;
      }
      return null;
    });
  }

  // ─── Events ───
  function onMouseMove(e) {
    if (dragging) {
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      if (draggingDiffRow) {
        const dr = diffRows.get(draggingDiffRow);
        if (dr) {
          dr.scrollX = Math.max(0, dragScrollX - dx);
          dr.scrollY = Math.max(0, dragScrollY - dy);
        }
      } else if (draggingExpanded && activePanel) {
        const panel = expandedPanels.get(activePanel);
        if (panel) {
          panel.scrollX = Math.max(0, dragScrollX - dx);
          if (draggingColIdx >= 0 && panel.colScrollY) {
            panel.colScrollY[draggingColIdx] = Math.max(0, dragScrollY - dy);
          }
        }
      } else {
        scrollX = dragScrollX - dx;
        scrollY = Math.max(0, dragScrollY - dy);
      }
      needsRedraw = true;
      return;
    }
    if (scrubbing) {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      playheadTime = xToTime(mx);
      needsRedraw = true;
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const prev = hoveredBlock;
    hoveredBlock = hitTest(mx, my);
    const fileHover = hitTestFileBar(mx, my);
    const inDiff = !fileHover && isInDiffRow(mx, my);
    const inExpanded = !fileHover && !inDiff && isInExpandedPanel(mx, my);
    canvas.style.cursor = hoveredBlock ? "pointer" : fileHover ? "pointer" : inDiff ? "grab" : inExpanded ? "grab" : (my < contentH() ? "default" : "grab");
    if (hoveredBlock !== prev) needsRedraw = true;
  }

  function onMouseDown(e) {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    needsRedraw = true;

    // Mode button click
    if (my >= 0 && my < TOP_BAR_H) {
      for (const btn of modeButtons) {
        if (mx >= btn.x && mx < btn.x + btn.w && my >= TOP_BAR_H / 2 - 12 && my < TOP_BAR_H / 2 + 12) {
          if (viewMode !== btn.mode) {
            viewMode = btn.mode;
            buildTracks(lastSessions, lastRange);
          }
          return;
        }
      }
    }

    // Ruler scrub
    if (my >= TOP_BAR_H && my < contentH()) {
      scrubbing = true;
      playheadTime = xToTime(mx);
      return;
    }

    // Group header collapse toggle
    const gi = hitTestGroupHeader(mx, my);
    if (gi >= 0) {
      projectGroups[gi].collapsed = !projectGroups[gi].collapsed;
      return;
    }

    // Click on file name in file bar — toggle diff row
    const fileHit = hitTestFileBar(mx, my);
    if (fileHit) {
      const drk = diffRowKey(fileHit.trackIdx, fileHit.clipIdx, fileHit.filePath);
      if (diffRows.has(drk)) {
        diffRows.delete(drk);
      } else {
        diffRows.set(drk, { diffs: null, scrollX: 0, loading: true });
        fetch("/api/session/" + fileHit.sessionId + "/file-diffs?file=" + encodeURIComponent(fileHit.filePath))
          .then(r => r.json())
          .then(data => {
            const dr = diffRows.get(drk);
            if (dr) { dr.diffs = data.diffs || []; dr.loading = false; needsRedraw = true; }
          })
          .catch(() => {
            const dr = diffRows.get(drk);
            if (dr) { dr.diffs = []; dr.loading = false; needsRedraw = true; }
          });
      }
      needsRedraw = true;
      return;
    }

    // Drag inside diff row — scroll
    const inDiff = isInDiffRow(mx, my);
    if (inDiff) {
      dragging = true;
      draggingDiffRow = inDiff;
      const dr = diffRows.get(inDiff);
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      dragScrollX = dr ? dr.scrollX : 0;
      dragScrollY = dr ? (dr.scrollY || 0) : 0;
      canvas.style.cursor = "grabbing";
      return;
    }

    // Drag inside expanded panel for scrolling
    const inPanel = isInExpandedPanel(mx, my);
    if (inPanel) {
      dragging = true;
      draggingExpanded = true;
      activePanel = inPanel;
      const panel = expandedPanels.get(inPanel);
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      dragScrollX = panel ? panel.scrollX : 0;
      // Find which column mouse is in for per-column drag
      draggingColIdx = -1;
      if (panel && panel.colLayouts) {
        for (const cl of panel.colLayouts) {
          if (mx >= cl.x && mx < cl.x + cl.width) {
            draggingColIdx = cl.idx;
            break;
          }
        }
      }
      dragScrollY = (panel && draggingColIdx >= 0 && panel.colScrollY)
        ? (panel.colScrollY[draggingColIdx] || 0) : 0;
      canvas.style.cursor = "grabbing";
      return;
    }

    // Click on event block — toggle expand for this clip
    if (hoveredBlock) {
      selectedBlock = hoveredBlock;
      const clickedTrack = hoveredBlock.trackIdx;
      const clickedClip = hoveredBlock.clipIdx;
      const pk = panelKey(clickedTrack, clickedClip);

      if (expandedPanels.has(pk)) {
        expandedPanels.delete(pk);
      } else {
        expandedPanels.set(pk, { data: null, scrollX: 0, scrollY: 0, loadStart: Date.now() });
        const track = tracks[clickedTrack];
        const clip = track.clips[clickedClip];
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 10000);
        fetch("/api/session/" + clip.session.id + "/transcript", { signal: ctrl.signal })
          .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
          .then(data => {
            const p = expandedPanels.get(pk);
            if (p) { p.data = data; needsRedraw = true; }
          })
          .catch(err => {
            console.warn("Transcript fetch failed:", err.message);
            const p = expandedPanels.get(pk);
            if (p) { p.data = { messages: [{ role: "assistant", text: "Could not load transcript: " + err.message }] }; needsRedraw = true; }
          });
      }
      return;
    }

    // Pan drag
    dragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragScrollX = scrollX;
    dragScrollY = scrollY;
    canvas.style.cursor = "grabbing";
  }

  function onMouseUp() {
    dragging = false;
    draggingExpanded = false;
    draggingDiffRow = null;
    scrubbing = false;
    canvas.style.cursor = "default";
    needsRedraw = true;
  }

  function onWheel(e) {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const maxScrollY = Math.max(0, totalContentHeight() - (H() - contentH()) + 20);

    // If scrolling inside diff row
    const wheelDiff = isInDiffRow(mx, my);
    if (wheelDiff) {
      const dr = diffRows.get(wheelDiff);
      if (dr) {
        if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          dr.scrollX = Math.max(0, dr.scrollX + (e.deltaX || e.deltaY));
        } else {
          dr.scrollY = Math.max(0, (dr.scrollY || 0) + e.deltaY);
        }
      }
      needsRedraw = true;
      return;
    }

    // If scrolling inside expanded panel
    const wheelPanel = isInExpandedPanel(mx, my);
    if (wheelPanel) {
      const panel = expandedPanels.get(wheelPanel);
      if (panel) {
        if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          panel.scrollX = Math.max(0, panel.scrollX + (e.deltaX || e.deltaY));
        } else {
          // Find which column the mouse is over and scroll just that one
          let scrolled = false;
          if (panel.colLayouts && panel.colScrollY) {
            for (const cl of panel.colLayouts) {
              if (mx >= cl.x && mx < cl.x + cl.width) {
                panel.colScrollY[cl.idx] = Math.max(0, (panel.colScrollY[cl.idx] || 0) + e.deltaY);
                scrolled = true;
                break;
              }
            }
          }
          // Fallback: scroll all columns
          if (!scrolled) {
            panel.scrollY = Math.max(0, panel.scrollY + e.deltaY);
          }
        }
      }
      needsRedraw = true;
      return;
    }

    if (e.ctrlKey || e.metaKey) {
      // Ctrl/Cmd+wheel = zoom time axis centered on cursor
      if (mx > HEADER_W) {
        const factor = e.deltaY > 0 ? 0.9 : 1.1;
        const mouseTime = xToTime(mx);
        timeScale *= factor;
        timeScale = Math.max(1e-10, Math.min(1, timeScale));
        scrollX = (mouseTime - timeMin) * timeScale - (mx - HEADER_W);
      }
      needsRedraw = true;
      return;
    }

    if (e.shiftKey) {
      // Shift+wheel = horizontal scroll
      scrollX += e.deltaY;
      needsRedraw = true;
      return;
    }

    // Regular wheel = vertical scroll
    scrollY = Math.max(0, Math.min(maxScrollY, scrollY + e.deltaY));
    needsRedraw = true;
  }

  function onKeyDown(e) {
    if (!visible) return;
    if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation();
      // Close all expanded panels first, then hide view
      if (hasAnyExpanded()) {
        expandedPanels.clear();
        activePanel = null;
        return;
      }
      hide();
      return;
    }
    if (e.key === " ") {
      e.preventDefault(); e.stopPropagation();
      togglePlayback();
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault(); e.stopPropagation();
      const step = (W() - HEADER_W) / timeScale * 0.1;
      playheadTime += e.key === "ArrowLeft" ? -step : step;
    }
    needsRedraw = true;
  }

  function togglePlayback() {
    playing = !playing;
    if (playing) {
      const msPerFrame = (timeMax - timeMin) / 300; // traverse full range in ~5s at 60fps
      playInterval = setInterval(() => {
        playheadTime += msPerFrame;
        if (playheadTime > timeMax) { playheadTime = timeMin; }
        needsRedraw = true;
      }, 16);
    } else {
      clearInterval(playInterval);
      playInterval = null;
    }
  }

  function showBlockDetail(block) {
    const track = tracks[block.trackIdx];
    if (!track) return;
    const clip = track.clips[block.clipIdx];
    if (!clip) return;
    const evt = clip.events[block.eventIdx];
    if (!evt) return;

    const panel = document.getElementById("detail");
    const content = document.getElementById("detailContent");
    if (!panel || !content) return;
    panel.classList.add("open");

    let html = "";
    html += '<h2>' + (clip.session.title || clip.session.id.slice(0, 12)) + '</h2>';
    html += '<div class="field"><span class="key">time:</span> <span class="val">' + fmtTime(evt.ts) + '</span></div>';
    html += '<div class="field"><span class="key">project:</span> <span class="val">' + (clip.session.project || "?") + '</span></div>';

    if (evt.type === "user") {
      html += '<div class="field"><span class="key">type:</span> <span class="val" style="color:#e8a838">user prompt</span></div>';
      html += '<div style="margin-top:10px;padding:10px;background:#1a1a2e;border-left:3px solid #e8a838;border-radius:0 4px 4px 0;font-size:11px;color:#ccc;white-space:pre-wrap;word-break:break-word;max-height:400px;overflow-y:auto">' +
        (evt.text || "").replace(/</g, "&lt;") + '</div>';
    } else if (evt.file) {
      const fname = evt.file.split("/").slice(-2).join("/");
      html += '<div class="field"><span class="key">type:</span> <span class="val" style="color:' +
        (evt.type === "write" ? "#e85b5b" : "#4aba6a") + '">' + evt.type + '</span></div>';
      html += '<div class="field"><span class="key">file:</span> <span class="val">' + fname + '</span></div>';
      html += '<div class="field"><span class="key">tool:</span> <span class="val">' + (evt.tool || "?") + '</span></div>';
      html += '<div class="field"><span class="key">full path:</span> <span class="val" style="font-size:10px;word-break:break-all">' + evt.file + '</span></div>';
      // Link to file story
      html += '<button class="transcript-btn" onclick="showFileStory(\'' + evt.file.replace(/'/g, "\\'") + '\')">View File Story</button>';
    }

    // Link to full session transcript
    html += '<button class="transcript-btn" style="margin-top:8px" onclick="loadTranscript(\'' +
      clip.session.id + "','" + (clip.session.title || "").replace(/'/g, "\\'") + '\')">View Session Transcript</button>';

    content.innerHTML = html;
  }

  // ─── Show / Hide ───
  async function show() {
    canvas = document.getElementById("sequencerCanvas");
    if (!canvas) return;

    const dpr = devicePixelRatio || 1;
    const cw = innerWidth, ch = innerHeight - 52;
    canvas.width = cw * dpr;
    canvas.height = ch * dpr;
    canvas.style.width = cw + "px";
    canvas.style.height = ch + "px";
    canvas.style.display = "block";
    ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    visible = true;

    // Hide other views
    const graph = document.getElementById("graph");
    if (graph) graph.style.display = "none";
    const loader = document.getElementById("loader");
    if (loader) loader.style.display = "none";

    // Loading state
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W(), H());
    ctx.fillStyle = "#aaaaff";
    ctx.font = "16px 'SF Mono', monospace";
    ctx.textAlign = "center";
    ctx.fillText("Loading sequencer...", W() / 2, H() / 2);
    ctx.textAlign = "left";

    await fetchData();
    render();

    // Events
    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
  }

  function hide() {
    visible = false;
    playing = false;
    clearInterval(playInterval);
    playInterval = null;
    if (canvas) canvas.style.display = "none";
    cancelAnimationFrame(animFrameId);

    const graph = document.getElementById("graph");
    if (graph) graph.style.display = "";

    if (canvas) {
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mousedown", onMouseDown);
      canvas.removeEventListener("wheel", onWheel);
    }
    document.removeEventListener("mouseup", onMouseUp);
    document.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("resize", onResize);
  }

  function toggle() {
    if (visible) hide();
    else show();
  }

  async function refresh() {
    if (!visible) return;
    // Show loading feedback
    ctx.fillStyle = "rgba(10,10,20,0.85)";
    ctx.fillRect(HEADER_W, contentH(), W() - HEADER_W, H() - contentH());
    ctx.fillStyle = "#aaaaff";
    ctx.font = "14px 'SF Mono', monospace";
    ctx.textAlign = "center";
    ctx.fillText("Reloading...", (W() + HEADER_W) / 2, H() / 2);
    ctx.textAlign = "left";
    await fetchData();
  }

  // Search integration — called from the main search system
  async function search(query) {
    searchQuery = query;
    if (!visible) return;
    ctx.fillStyle = "rgba(10,10,20,0.85)";
    ctx.fillRect(HEADER_W, contentH(), W() - HEADER_W, H() - contentH());
    ctx.fillStyle = "#e8a838";
    ctx.font = "14px 'SF Mono', monospace";
    ctx.textAlign = "center";
    ctx.fillText('Searching "' + query + '"...', (W() + HEADER_W) / 2, H() / 2);
    ctx.textAlign = "left";
    await fetchData();
  }

  function onResize() {
    if (!visible) return;
    const dpr = devicePixelRatio || 1;
    const cw = innerWidth, ch = innerHeight - 52;
    canvas.width = cw * dpr;
    canvas.height = ch * dpr;
    canvas.style.width = cw + "px";
    canvas.style.height = ch + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    needsRedraw = true;
  }

  return { show, hide, toggle, refresh, search };
})();
