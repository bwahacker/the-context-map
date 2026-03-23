/**
 * fs-timeline.js — Filesystem Timeline View
 *
 * Renders a d3.partition() icicle layout of the filesystem on canvas.
 * A time scrubber controls which files glow (based on temporal proximity to edits).
 * Prompts and edits pop up as annotations linked to the files they touched.
 *
 * Exposes: window.FsTimeline = { show, hide, toggle }
 */

window.FsTimeline = (function () {
  "use strict";

  // ─── State ───
  let canvas, ctx;
  let visible = false;
  let currentRepo = null;
  let allRepos = [];
  let treeData = null;
  let hierarchy = null;
  let partitionRoot = null;
  let cellMap = new Map();       // filePath -> partition node
  let timeRange = { min: null, max: null };
  let scrubTime = null;
  let changes = [];              // git changes loaded for current window
  let activity = null;           // { prompts, edits }
  let animFrameId = null;
  let scrubFetchTimeout = null;
  let hoveredCell = null;
  let isDraggingScrubber = false;

  // ─── Constants ───
  const FADE_WINDOW_MS = 2 * 60 * 60 * 1000;  // 2 hours
  const SCRUBBER_H = 60;
  const SCRUBBER_MARGIN = 40;
  const HEADER_H = 36;
  const ANNOTATION_MAX = 8;
  const GLOW = [255, 155, 74];
  const BASE = [22, 22, 38];
  const DIR_BASE = [16, 16, 28];

  // ─── Helpers ───
  function W() { return canvas ? canvas.width / (devicePixelRatio || 1) : innerWidth; }
  function H() { return canvas ? canvas.height / (devicePixelRatio || 1) : innerHeight; }

  function cellColor(intensity) {
    const r = BASE[0] + (GLOW[0] - BASE[0]) * intensity;
    const g = BASE[1] + (GLOW[1] - BASE[1]) * intensity;
    const b = BASE[2] + (GLOW[2] - BASE[2]) * intensity;
    return `rgb(${r | 0},${g | 0},${b | 0})`;
  }

  function dirColor(depth) {
    const d = Math.min(depth, 8);
    const f = 1 - d * 0.06;
    return `rgb(${DIR_BASE[0] * f | 0},${DIR_BASE[1] * f | 0},${DIR_BASE[2] + d * 4 | 0})`;
  }

  function formatDate(d) {
    if (!d) return "";
    const dt = d instanceof Date ? d : new Date(d);
    return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  function formatDateTime(d) {
    if (!d) return "";
    const dt = d instanceof Date ? d : new Date(d);
    return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " +
      dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y);
    c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r);
    c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h);
    c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r);
    c.quadraticCurveTo(x, y, x + r, y);
    c.closePath();
    c.fill();
    if (c.strokeStyle && c.lineWidth) c.stroke();
  }

  // ─── Data Loading ───

  async function loadRepos() {
    try {
      allRepos = await fetch("/api/git/repos").then(r => r.json());
    } catch { allRepos = []; }
    return allRepos;
  }

  async function loadTree(repo, before) {
    const params = new URLSearchParams({ repo });
    if (before) params.set("before", before);
    treeData = await fetch("/api/git/tree?" + params).then(r => r.json());
    return treeData;
  }

  async function loadChangesForWindow(repo, centerDate) {
    const windowMs = FADE_WINDOW_MS;
    const start = new Date(centerDate.getTime() - windowMs).toISOString();
    const end = new Date(centerDate.getTime() + windowMs).toISOString();
    changes = await fetch("/api/git/changes?" + new URLSearchParams({ repo, start, end })).then(r => r.json());
  }

  async function loadActivityNear(repo, date) {
    activity = await fetch("/api/git/activity?" + new URLSearchParams({
      repo, at: date.toISOString(), window: "30"
    })).then(r => r.json());
  }

  // ─── Hierarchy / Layout ───

  function buildHierarchy(files) {
    const root = { name: "/", children: {} };

    for (const f of files) {
      const parts = f.file_path.split("/").filter(Boolean);
      let node = root;
      for (let i = 0; i < parts.length; i++) {
        if (!node.children) node.children = {};
        if (!node.children[parts[i]]) {
          node.children[parts[i]] = { name: parts[i], children: {} };
        }
        node = node.children[parts[i]];
        if (i === parts.length - 1) {
          node.data = f;
          node.value = Math.max(1, f.commit_count || 1);
          delete node.children;
        }
      }
    }

    function toArray(node) {
      if (!node.children) return node;
      const kids = Object.values(node.children);
      if (kids.length === 0) { delete node.children; return node; }
      node.children = kids.map(toArray);
      return node;
    }

    return d3.hierarchy(toArray(root))
      .sum(d => d.value || 0)
      .sort((a, b) => b.value - a.value);
  }

  function computePartition() {
    const layoutW = W();
    const layoutH = H() - SCRUBBER_H - HEADER_H;

    const treemap = d3.treemap()
      .size([layoutW, layoutH])
      .paddingTop(18)    // room for directory label
      .paddingRight(2)
      .paddingBottom(2)
      .paddingLeft(2)
      .paddingInner(2)
      .round(true);

    partitionRoot = treemap(hierarchy);

    cellMap.clear();
    for (const node of partitionRoot.descendants()) {
      if (node.data.data?.file_path) {
        cellMap.set(node.data.data.file_path, node);
      }
    }
  }

  // ─── Rendering ───

  function render() {
    if (!visible || !partitionRoot) return;

    const w = W(), h = H();
    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = "#0a0a14";
    ctx.fillRect(0, 0, w, h);

    // Header bar
    drawHeader(w);

    // Push layout down by header height
    ctx.save();
    ctx.translate(0, HEADER_H);

    const now = scrubTime ? scrubTime.getTime() : Date.now();

    // Build change index for fast lookup
    const changeIndex = new Map();
    for (const c of changes) {
      const fp = c.file_path;
      const dist = Math.abs(new Date(c.commit_date).getTime() - now);
      const existing = changeIndex.get(fp);
      if (!existing || dist < existing) {
        changeIndex.set(fp, dist);
      }
    }

    // Draw all cells
    for (const node of partitionRoot.descendants()) {
      const isLeaf = !node.children;
      let glowIntensity = 0;

      if (isLeaf && node.data.data?.file_path) {
        const dist = changeIndex.get(node.data.data.file_path);
        if (dist !== undefined) {
          glowIntensity = Math.max(0, 1 - dist / FADE_WINDOW_MS);
        }
      }

      drawCell(node, glowIntensity, isLeaf);
    }

    // Annotations
    if (activity) drawAnnotations();

    // Hover tooltip
    if (hoveredCell) drawTooltip(hoveredCell);

    ctx.restore();

    // Scrubber
    drawScrubber(w, h);

    animFrameId = requestAnimationFrame(render);
  }

  function drawHeader(w) {
    ctx.fillStyle = "rgba(10, 10, 20, 0.95)";
    ctx.fillRect(0, 0, w, HEADER_H);
    ctx.strokeStyle = "#2a2a4a";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, HEADER_H);
    ctx.lineTo(w, HEADER_H);
    ctx.stroke();

    ctx.fillStyle = "#8a8aff";
    ctx.font = "bold 14px 'SF Mono', monospace";
    ctx.textBaseline = "middle";
    ctx.fillText("FS TIMELINE", 14, HEADER_H / 2);

    if (currentRepo) {
      const repoName = currentRepo.split("/").slice(-2).join("/");
      ctx.fillStyle = "#666";
      ctx.font = "12px 'SF Mono', monospace";
      ctx.fillText(repoName, 140, HEADER_H / 2);
    }

    // Repo selector arrows (if multiple repos)
    if (allRepos.length > 1) {
      ctx.fillStyle = "#555";
      ctx.font = "14px sans-serif";
      ctx.fillText("◀", 120, HEADER_H / 2);
      ctx.fillText("▶", 120 + (currentRepo ? currentRepo.split("/").slice(-2).join("/").length * 7.5 : 0) + 20, HEADER_H / 2);
    }

    // Close button
    ctx.fillStyle = "#555";
    ctx.font = "16px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText("✕ ESC", w - 14, HEADER_H / 2);
    ctx.textAlign = "left";
  }

  function drawCell(node, glowIntensity, isLeaf) {
    const { x0, y0, x1, y1 } = node;
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < 1 || h < 1) return;

    if (isLeaf) {
      // ── File cell ──
      ctx.fillStyle = cellColor(glowIntensity);
      if (glowIntensity > 0.7) {
        ctx.shadowColor = `rgba(255,155,74,${glowIntensity * 0.5})`;
        ctx.shadowBlur = 10;
      }
      ctx.fillRect(x0, y0, w, h);
      ctx.shadowBlur = 0;

      // Border
      ctx.strokeStyle = `rgba(60,60,90,${0.3 + glowIntensity * 0.4})`;
      ctx.lineWidth = 0.5;
      ctx.strokeRect(x0, y0, w, h);

      // File name label
      if (w > 24 && h > 10) {
        const fontSize = Math.min(10, h - 2);
        ctx.font = `${fontSize}px 'SF Mono', monospace`;
        ctx.fillStyle = glowIntensity > 0.5 ? "#fff" : "#777";
        ctx.textBaseline = "middle";
        const maxChars = Math.floor((w - 4) / (fontSize * 0.6));
        const label = node.data.name;
        ctx.fillText(
          label.length > maxChars ? label.slice(0, maxChars - 1) + "…" : label,
          x0 + 2, y0 + h / 2
        );
      }
    } else {
      // ── Directory container ──
      // Background fill for the whole directory area
      ctx.fillStyle = dirColor(node.depth);
      ctx.fillRect(x0, y0, w, h);

      // Border
      ctx.strokeStyle = node.depth < 2
        ? "rgba(80,80,140,0.5)"
        : "rgba(50,50,90,0.4)";
      ctx.lineWidth = node.depth < 2 ? 1 : 0.5;
      ctx.strokeRect(x0, y0, w, h);

      // Directory name in the top padding area
      if (w > 20) {
        const fontSize = Math.min(11, 14);
        ctx.font = `bold ${fontSize}px 'SF Mono', monospace`;
        ctx.fillStyle = node.depth === 0 ? "#9999cc"
          : node.depth === 1 ? "#7777aa"
          : "#555588";
        ctx.textBaseline = "top";
        const maxChars = Math.floor((w - 4) / (fontSize * 0.6));
        const label = node.data.name === "/" ? currentRepo?.split("/").pop() || "/" : node.data.name + "/";
        ctx.fillText(
          label.length > maxChars ? label.slice(0, maxChars - 1) + "…" : label,
          x0 + 3, y0 + 2
        );
      }
    }
  }

  function drawAnnotations() {
    if (!activity || !activity.edits || activity.edits.length === 0) return;

    // Group edits by file
    const editsByFile = new Map();
    for (const edit of activity.edits) {
      const basename = edit.file_path.split("/").pop();
      // Try to match against cellMap using full path or basename
      let matchKey = null;
      for (const [fp] of cellMap) {
        if (edit.file_path.endsWith(fp) || fp.endsWith(edit.file_path.split("/").slice(-2).join("/"))) {
          matchKey = fp;
          break;
        }
      }
      if (!matchKey) continue;
      if (!editsByFile.has(matchKey)) editsByFile.set(matchKey, []);
      editsByFile.get(matchKey).push(edit);
    }

    let drawn = 0;
    for (const [filePath, edits] of editsByFile) {
      if (drawn >= ANNOTATION_MAX) break;
      const cell = cellMap.get(filePath);
      if (!cell) continue;

      const cx = cell.x0 + (cell.x1 - cell.x0) / 2;
      const cy = cell.y0;

      // Find triggering prompt (closest preceding)
      const editTime = new Date(edits[0].timestamp).getTime();
      const trigger = activity.prompts
        ?.filter(p => new Date(p.timestamp).getTime() <= editTime)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];

      // Connection line
      ctx.strokeStyle = "rgba(255,155,74,0.4)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(cx, cy - 6);
      ctx.lineTo(cx, cy - 36);
      ctx.stroke();
      ctx.setLineDash([]);

      // Card
      const cardW = 180;
      const cardH = trigger ? 42 : 24;
      const cardX = Math.max(4, Math.min(cx - cardW / 2, W() - cardW - 4));
      const cardY = cy - 36 - cardH;

      ctx.fillStyle = "rgba(12,12,22,0.92)";
      ctx.strokeStyle = "rgba(255,155,74,0.3)";
      ctx.lineWidth = 1;
      roundRect(ctx, cardX, cardY, cardW, cardH, 4);

      // Edit label
      const basename = edits[0].file_path.split("/").pop();
      ctx.fillStyle = "#e85b5b";
      ctx.font = "10px 'SF Mono', monospace";
      ctx.textBaseline = "top";
      ctx.fillText(`${edits[0].tool || "Edit"} ${basename}`, cardX + 6, cardY + cardH - 16);

      // Prompt label
      if (trigger) {
        const promptText = trigger.text.length > 28 ? trigger.text.slice(0, 25) + "…" : trigger.text;
        ctx.fillStyle = "#e8a838";
        ctx.fillText(`"${promptText}"`, cardX + 6, cardY + 5);
        ctx.fillStyle = "rgba(232,168,56,0.4)";
        ctx.fillText("→", cardX + 6, cardY + cardH - 28);
      }

      drawn++;
    }
  }

  function drawTooltip(node) {
    const { x0, y0, x1, y1 } = node;
    const cx = (x0 + x1) / 2;
    const isLeaf = !node.children;
    const label = isLeaf
      ? (node.data.data?.file_path || node.data.name)
      : node.data.name + "/";
    const extra = isLeaf && node.data.data
      ? `  ${node.data.data.commit_count || 0} commits`
      : "";

    const text = label + extra;
    ctx.font = "11px 'SF Mono', monospace";
    const tw = ctx.measureText(text).width + 12;
    const tx = Math.max(2, Math.min(cx - tw / 2, W() - tw - 2));
    const ty = y0 - 22;

    ctx.fillStyle = "rgba(10,10,20,0.95)";
    ctx.strokeStyle = "#4a4a8a";
    ctx.lineWidth = 1;
    roundRect(ctx, tx, ty, tw, 18, 4);

    ctx.fillStyle = isLeaf ? "#ccc" : "#8888bb";
    ctx.textBaseline = "middle";
    ctx.fillText(text, tx + 6, ty + 9);
  }

  function drawScrubber(w, h) {
    const y = h - SCRUBBER_H + 10;
    const barW = w - 2 * SCRUBBER_MARGIN;

    // Background
    ctx.fillStyle = "rgba(10,10,20,0.95)";
    ctx.fillRect(0, h - SCRUBBER_H, w, SCRUBBER_H);
    ctx.strokeStyle = "#2a2a4a";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h - SCRUBBER_H);
    ctx.lineTo(w, h - SCRUBBER_H);
    ctx.stroke();

    // Track
    ctx.fillStyle = "#15151f";
    roundRect(ctx, SCRUBBER_MARGIN, y, barW, 6, 3);

    // Time labels
    ctx.fillStyle = "#555";
    ctx.font = "10px 'SF Mono', monospace";
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillText(formatDate(timeRange.min), SCRUBBER_MARGIN, y + 12);
    ctx.textAlign = "right";
    ctx.fillText(formatDate(timeRange.max), SCRUBBER_MARGIN + barW, y + 12);
    ctx.textAlign = "left";

    // Fill
    const pct = scrubPct();
    const grad = ctx.createLinearGradient(SCRUBBER_MARGIN, 0, SCRUBBER_MARGIN + barW * pct, 0);
    grad.addColorStop(0, "#3a3a88");
    grad.addColorStop(1, "#ff9b4a");
    ctx.fillStyle = grad;
    roundRect(ctx, SCRUBBER_MARGIN, y, barW * pct, 6, 3);

    // Thumb
    const thumbX = SCRUBBER_MARGIN + barW * pct;
    ctx.beginPath();
    ctx.arc(thumbX, y + 3, 7, 0, Math.PI * 2);
    ctx.fillStyle = "#bbbbff";
    ctx.shadowColor = "rgba(123,123,255,0.5)";
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.shadowBlur = 0;

    // Current time
    if (scrubTime) {
      ctx.fillStyle = "#aaaadd";
      ctx.font = "11px 'SF Mono', monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(formatDateTime(scrubTime), thumbX, y - 6);
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
    }
  }

  function scrubPct() {
    if (!timeRange.min || !timeRange.max || !scrubTime) return 1;
    const min = timeRange.min.getTime();
    const max = timeRange.max.getTime();
    if (max === min) return 1;
    return Math.max(0, Math.min(1, (scrubTime.getTime() - min) / (max - min)));
  }

  // ─── Scrubber Interaction ───

  function onScrub(pct) {
    if (!timeRange.min || !timeRange.max) return;
    const min = timeRange.min.getTime();
    const max = timeRange.max.getTime();
    scrubTime = new Date(min + (max - min) * Math.max(0, Math.min(1, pct)));

    clearTimeout(scrubFetchTimeout);
    scrubFetchTimeout = setTimeout(async () => {
      try {
        await Promise.all([
          loadChangesForWindow(currentRepo, scrubTime),
          loadActivityNear(currentRepo, scrubTime),
        ]);
      } catch (e) { console.error("scrub fetch:", e); }
    }, 80);
  }

  function scrubFromMouse(e) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const barW = W() - 2 * SCRUBBER_MARGIN;
    const pct = (x - SCRUBBER_MARGIN) / barW;
    onScrub(pct);
  }

  function isInScrubberArea(e) {
    const rect = canvas.getBoundingClientRect();
    const y = e.clientY - rect.top;
    return y > H() - SCRUBBER_H;
  }

  // ─── Mouse Events ───

  function onMouseMove(e) {
    if (isDraggingScrubber) {
      scrubFromMouse(e);
      return;
    }

    if (!partitionRoot) return;

    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top - HEADER_H;

    // Don't highlight when in scrubber area
    if (my + HEADER_H > H() - SCRUBBER_H || my < 0) {
      hoveredCell = null;
      canvas.style.cursor = isInScrubberArea(e) ? "pointer" : "default";
      return;
    }

    // Find cell under cursor
    hoveredCell = null;
    for (const node of partitionRoot.descendants()) {
      if (mx >= node.x0 && mx <= node.x1 && my >= node.y0 && my <= node.y1) {
        // Pick deepest (smallest) cell
        if (!hoveredCell || node.depth > hoveredCell.depth) {
          hoveredCell = node;
        }
      }
    }
    canvas.style.cursor = hoveredCell ? "pointer" : "default";
  }

  function onMouseDown(e) {
    if (isInScrubberArea(e)) {
      isDraggingScrubber = true;
      scrubFromMouse(e);
    }
  }

  function onMouseUp() {
    isDraggingScrubber = false;
  }

  function onClick(e) {
    if (isInScrubberArea(e)) return;
    if (!hoveredCell || !hoveredCell.data.data) return;

    // Show file detail in the existing detail panel
    const fp = hoveredCell.data.data.file_path;
    const panel = document.getElementById("detail");
    const content = document.getElementById("detailContent");
    if (panel && content) {
      panel.classList.add("open");
      content.innerHTML =
        '<h2>' + hoveredCell.data.name + '</h2>' +
        '<div class="field"><span class="key">path:</span> <span class="val">' + fp + '</span></div>' +
        '<div class="field"><span class="key">commits:</span> <span class="val">' + (hoveredCell.data.data.commit_count || 0) + '</span></div>' +
        '<div class="field"><span class="key">last modified:</span> <span class="val">' + formatDateTime(hoveredCell.data.data.last_modified) + '</span></div>' +
        '<div class="field"><span class="key">additions:</span> <span class="val">' + (hoveredCell.data.data.total_additions || 0) + '</span></div>' +
        '<div class="field"><span class="key">deletions:</span> <span class="val">' + (hoveredCell.data.data.total_deletions || 0) + '</span></div>';
    }
  }

  function onKeyDown(e) {
    if (!visible) return;
    if (e.key === "Escape") { hide(); e.preventDefault(); }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const step = e.shiftKey ? 0.1 : 0.02;
      const dir = e.key === "ArrowLeft" ? -1 : 1;
      onScrub(scrubPct() + step * dir);
    }
  }

  function onResize() {
    if (!visible) return;
    const dpr = devicePixelRatio || 1;
    var _cw = innerWidth, _ch = innerHeight - 52;
    canvas.width = _cw * dpr;
    canvas.height = _ch * dpr;
    canvas.style.width = _cw + "px";
    canvas.style.height = _ch + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (hierarchy) computePartition();
  }

  // ─── Show / Hide ───

  async function show() {
    canvas = document.getElementById("fsTimelineCanvas");
    if (!canvas) return;

    // Setup canvas
    const dpr = devicePixelRatio || 1;
    var _cw = innerWidth, _ch = innerHeight - 52;
    canvas.width = _cw * dpr;
    canvas.height = _ch * dpr;
    canvas.style.width = _cw + "px";
    canvas.style.height = _ch + "px";
    canvas.style.display = "block";
    ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    visible = true;

    // Hide other views
    const graph = document.getElementById("graph");
    if (graph) graph.style.display = "none";
    const loader = document.getElementById("loader");
    if (loader) loader.style.display = "none";

    // Show loading state
    function showLoadingMsg(msg) {
      ctx.fillStyle = "#0a0a14";
      ctx.fillRect(0, 0, W(), H());
      ctx.fillStyle = "#7b7bff";
      ctx.font = "16px 'SF Mono', monospace";
      ctx.textAlign = "center";
      ctx.fillText(msg, W() / 2, H() / 2);
      ctx.textAlign = "left";
    }

    // Skip re-fetch if we already have data for this repo
    if (hierarchy && treeData && treeData.length > 0) {
      render();
    } else {
      showLoadingMsg("Fetching repos...");

      // Load data
      await loadRepos();
      if (allRepos.length === 0) {
        showLoadingMsg("No git repos found. Server may still be syncing.");
        return;
      }

      // Pick repo matching current project filter, or this project, or smallest
      const projFilter = document.getElementById("projectFilter")?.value || "";
      const matchedRepo = projFilter ? allRepos.find(r => r.repo_path.includes(projFilter.split("/").pop())) : null;
      const thisProject = allRepos.find(r => location.pathname === "/" && r.repo_path.includes("context-map"));
      const preferred = allRepos.filter(r => r.commit_count < 1000);
      currentRepo = (matchedRepo || thisProject || (preferred.length ? preferred[0] : allRepos[allRepos.length - 1])).repo_path;

      showLoadingMsg("Loading " + currentRepo.split("/").slice(-2).join("/") + "...");
      await loadTree(currentRepo);

      if (!treeData || treeData.length === 0) {
        showLoadingMsg("No file data for this repo.");
        return;
      }

      // Build layout
      hierarchy = buildHierarchy(treeData);
      computePartition();

      // Time range
      const dates = treeData.map(f => new Date(f.last_modified)).filter(d => !isNaN(d.getTime()));
      if (dates.length) {
        timeRange.min = new Date(Math.min(...dates));
        timeRange.max = new Date(Math.max(...dates));
        scrubTime = new Date(timeRange.max);
      }

      // Start rendering immediately — don't wait for changes
      render();

      // Load changes in background
      try {
        await Promise.all([
          loadChangesForWindow(currentRepo, scrubTime),
          loadActivityNear(currentRepo, scrubTime),
        ]);
      } catch (e) { console.error("initial load:", e); }
    }

    // Events
    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("click", onClick);
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);

  }

  function hide() {
    visible = false;
    if (canvas) canvas.style.display = "none";
    cancelAnimationFrame(animFrameId);

    // Show graph again
    const graph = document.getElementById("graph");
    if (graph) graph.style.display = "";

    // Remove events
    if (canvas) {
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mousedown", onMouseDown);
      canvas.removeEventListener("click", onClick);
    }
    document.removeEventListener("mouseup", onMouseUp);
    document.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("resize", onResize);
  }

  function toggle() {
    if (visible) hide();
    else show();
  }

  // Auto-show if URL is /timeline
  if (location.pathname === "/timeline") {
    window.addEventListener("load", () => setTimeout(show, 500));
  }

  async function refresh() {
    // Clear cached data and re-fetch with current project
    hierarchy = null;
    treeData = null;
    partitionRoot = null;
    cellMap.clear();
    changes = [];
    activity = null;
    if (visible) {
      await show();
    }
  }

  return { show, hide, toggle, refresh };
})();
