/**
 * heatmap.js — Activity heatmap: files × time
 *
 * Y-axis (left): expandable project → directory → file tree
 * X-axis (bottom): expandable time windows (months → weeks → days)
 * Cells: colored by activity intensity (reads + writes + messages)
 *
 * Usage: window.Heatmap.show() / .hide() / .toggle()
 */
window.Heatmap = (function () {
  "use strict";

  let canvas, ctx, visible = false, animId;
  let data = null; // { tree, timeBuckets, cells, dateRange }

  // ── Layout constants ──
  const ROW_H = 36;
  const COL_W = 44;
  const LABEL_W = 340;
  const TIME_H = 80;
  const HEADER_H = 32;
  const PAD = 16;

  // ── Colors ──
  const BG = "#0a0a14";
  const GRID_COLOR = "#1a1a2a";
  const LABEL_COLOR = "#999";
  const LABEL_HOVER = "#ddd";
  const DIR_BG = "#0e0e1a";

  // Heatmap color ramp (0=dark → 1=bright amber)
  function heatColor(intensity) {
    if (intensity <= 0) return "rgba(20,20,40,0.6)";
    const t = Math.min(1, intensity);
    const r = Math.round(30 + 200 * t);
    const g = Math.round(25 + 130 * t * t);
    const b = Math.round(60 - 30 * t);
    return `rgb(${r},${g},${b})`;
  }

  // ── Tree node ──
  // Junk files/dirs to filter out
  const JUNK = new Set([".DS_Store", "..", ".", ".git", "node_modules", "__pycache__", ".pyc", "Thumbs.db"]);
  const JUNK_DIRS = ["/private/tmp/", "/tmp/claude", "/.claude/"];
  function isJunk(name) {
    if (JUNK.has(name)) return true;
    if (name.endsWith(".pyc") || name.endsWith(".DS_Store") || name.endsWith(".output")) return true;
    return false;
  }
  function isJunkPath(filePath) {
    return JUNK_DIRS.some(d => filePath.includes(d));
  }

  // { name, path, depth, children[], expanded, rowCount (visible descendants), activity }
  function buildTree(fileActivity) {
    const root = { name: "root", path: "", depth: -1, children: [], expanded: true, isDir: true, activity: 0 };
    const nodeMap = new Map();
    nodeMap.set("", root);

    // Group files by project, find common prefix per project, make relative
    const byProject = new Map(); // project → [{file_path, reads, writes}]
    for (const row of fileActivity) {
      if (isJunkPath(row.file_path)) continue;
      const proj = row.project || "(no project)";
      if (!byProject.has(proj)) byProject.set(proj, []);
      byProject.get(proj).push(row);
    }

    // Build relative paths: strip longest common directory prefix per project
    const pathActivity = new Map();
    for (const [proj, rows] of byProject) {
      // Filter out junk paths first so they don't pollute the prefix
      const cleanRows = rows.filter(r => {
        const fn = r.file_path.split("/").pop();
        return !isJunk(fn) && !isJunkPath(r.file_path);
      });
      if (cleanRows.length === 0) continue;

      // Find common prefix of all file paths in this project
      const paths = cleanRows.map(r => r.file_path);
      let prefix = paths[0] || "";
      for (let i = 1; i < paths.length; i++) {
        while (prefix && !paths[i].startsWith(prefix)) {
          prefix = prefix.slice(0, prefix.lastIndexOf("/"));
        }
      }
      if (prefix && !prefix.endsWith("/")) prefix += "/";

      for (const row of cleanRows) {
        let relPath = row.file_path.startsWith(prefix) ? row.file_path.slice(prefix.length) : row.file_path;
        if (!relPath) continue;

        const key = proj + "/" + relPath;
        pathActivity.set(key, (pathActivity.get(key) || 0) + row.reads + row.writes);
      }
    }

    // Build tree from all unique paths
    for (const [fullPath, activity] of pathActivity) {
      const parts = fullPath.split("/").filter(p => p.length > 0);
      let current = root;
      for (let i = 0; i < parts.length; i++) {
        const partial = parts.slice(0, i + 1).join("/");
        if (!nodeMap.has(partial)) {
          const node = {
            name: parts[i],
            path: partial,
            depth: i,
            children: [],
            expanded: false,
            isDir: i < parts.length - 1,
            activity: 0,
          };
          nodeMap.set(partial, node);
          current.children.push(node);
        }
        const node = nodeMap.get(partial);
        node.activity += activity;
        if (i === parts.length - 1) node.isDir = false;
        current = node;
      }
    }

    // Sort children: dirs first, then by activity desc
    function sortTree(node) {
      node.children.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return b.activity - a.activity;
      });
      for (const c of node.children) sortTree(c);
    }
    sortTree(root);

    // Collapse single-child directory chains: A → B → C → file becomes "A/B/C" → file
    function collapse(node) {
      for (let i = 0; i < node.children.length; i++) {
        collapse(node.children[i]);
      }
      while (node.isDir && node.children.length === 1 && node.children[0].isDir) {
        const child = node.children[0];
        node.name = node.name + "/" + child.name;
        node.path = child.path;
        node.children = child.children;
        // Update nodeMap so lookups still work
        nodeMap.set(child.path, node);
      }
    }
    for (const c of root.children) collapse(c);

    return { root, nodeMap };
  }

  // ── Auto-expand to fill viewport ──
  // Expand levels until visible rows fill ~75% of available height
  function autoExpand(root, availH) {
    const targetRows = Math.floor((availH * 0.75) / ROW_H);

    // Start with top-level (projects) expanded
    for (const c of root.children) c.expanded = true;

    let iterations = 0;
    while (iterations++ < 10) {
      const rows = flattenTree(root);
      if (rows.length >= targetRows) break;

      // Find the directory with most activity that isn't expanded yet
      let best = null, bestAct = -1;
      for (const r of rows) {
        if (r.node.isDir && !r.node.expanded && r.node.children.length > 0 && r.node.activity > bestAct) {
          // Check if expanding would overshoot
          const wouldAdd = r.node.children.length;
          const afterExpand = rows.length + wouldAdd;
          // Pick the expansion that gets closest to target without going way over
          if (afterExpand <= targetRows * 1.3 || bestAct < 0) {
            best = r.node;
            bestAct = r.node.activity;
          }
        }
      }
      if (!best) break;

      // Check: expanding this + current count. If going over by too much, prefer 72% fill over 98%
      const currentCount = rows.length;
      const afterCount = currentCount + best.children.length;
      if (currentCount >= targetRows * 0.7 && afterCount > targetRows * 1.0) break;

      best.expanded = true;
    }
  }

  // Flatten tree into visible rows (respecting expanded state)
  function flattenTree(node) {
    const rows = [];
    function walk(n, depth) {
      if (n === node) {
        // root — skip but walk children
        for (const c of n.children) walk(c, 0);
        return;
      }
      rows.push({ node: n, depth });
      if (n.expanded && n.children.length > 0) {
        for (const c of n.children) walk(c, depth + 1);
      }
    }
    walk(node, 0);
    return rows;
  }

  // ── Time buckets ──
  // Returns array of { label, startDate, endDate, key }
  // Granularity adapts: if range > 90d → months, > 21d → weeks, else → days
  function buildTimeBuckets(dateRange, expandedBuckets) {
    const min = new Date(dateRange.min);
    const max = new Date(dateRange.max);
    const spanDays = (max - min) / 86400000;

    let granularity = "month";
    if (spanDays <= 21) granularity = "day";
    else if (spanDays <= 90) granularity = "week";

    const buckets = [];
    const d = new Date(min);
    d.setHours(0, 0, 0, 0);

    if (granularity === "month") {
      d.setDate(1);
      while (d <= max) {
        const end = new Date(d);
        end.setMonth(end.getMonth() + 1);
        const key = d.toISOString().slice(0, 7);
        const expanded = expandedBuckets.has(key);
        buckets.push({
          label: d.toLocaleDateString("en-US", { month: "short", year: "2-digit" }),
          startDate: new Date(d), endDate: end, key, granularity: "month", expanded,
        });
        if (expanded) {
          // Add sub-buckets (weeks or days within this month)
          const subEnd = new Date(Math.min(end.getTime(), max.getTime() + 86400000));
          const sd = new Date(d);
          while (sd < subEnd) {
            const dayEnd = new Date(sd);
            dayEnd.setDate(dayEnd.getDate() + 1);
            const dayKey = sd.toISOString().slice(0, 10);
            buckets.push({
              label: sd.getDate().toString(),
              startDate: new Date(sd), endDate: dayEnd, key: dayKey,
              granularity: "day", parent: key,
            });
            sd.setDate(sd.getDate() + 1);
          }
        }
        d.setMonth(d.getMonth() + 1);
      }
    } else if (granularity === "week") {
      // Start on Monday
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      while (d <= max) {
        const end = new Date(d);
        end.setDate(end.getDate() + 7);
        const key = "W" + d.toISOString().slice(0, 10);
        const expanded = expandedBuckets.has(key);
        buckets.push({
          label: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
          startDate: new Date(d), endDate: end, key, granularity: "week", expanded,
        });
        if (expanded) {
          const sd = new Date(d);
          const subEnd = new Date(Math.min(end.getTime(), max.getTime() + 86400000));
          while (sd < subEnd) {
            const dayEnd = new Date(sd);
            dayEnd.setDate(dayEnd.getDate() + 1);
            const dayKey = sd.toISOString().slice(0, 10);
            const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
            buckets.push({
              label: dayNames[sd.getDay()],
              startDate: new Date(sd), endDate: dayEnd, key: dayKey,
              granularity: "day", parent: key,
            });
            sd.setDate(sd.getDate() + 1);
          }
        }
        d.setDate(d.getDate() + 7);
      }
    } else {
      while (d <= max) {
        const end = new Date(d);
        end.setDate(end.getDate() + 1);
        const key = d.toISOString().slice(0, 10);
        const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        buckets.push({
          label: dayNames[d.getDay()] + " " + d.getDate(),
          startDate: new Date(d), endDate: end, key, granularity: "day",
        });
        d.setDate(d.getDate() + 1);
      }
    }

    return buckets;
  }

  // ── Build cell lookup ──
  // Map: "filePath|dateKey" → { reads, writes, messages, total }
  function buildCellData(fileActivity, msgActivity) {
    const cells = new Map();

    for (const row of fileActivity) {
      const proj = row.project || "(no project)";
      const fullPath = proj + "/" + row.file_path;
      const dateKey = String(row.date).slice(0, 10);
      const k = fullPath + "|" + dateKey;
      if (!cells.has(k)) cells.set(k, { reads: 0, writes: 0, messages: 0, total: 0 });
      const c = cells.get(k);
      c.reads += row.reads;
      c.writes += row.writes;
      c.total += row.reads + row.writes;
    }

    // Messages are per-project per-day, not per-file
    // Store under project path with special marker
    for (const row of msgActivity) {
      const proj = row.project || "(no project)";
      const dateKey = String(row.date).slice(0, 10);
      const k = proj + "|" + dateKey;
      if (!cells.has(k)) cells.set(k, { reads: 0, writes: 0, messages: 0, total: 0 });
      const c = cells.get(k);
      c.messages += row.messages;
      c.total += row.messages;
    }

    // Find max for normalization
    let maxTotal = 1;
    for (const c of cells.values()) {
      if (c.total > maxTotal) maxTotal = c.total;
    }

    return { cells, maxTotal };
  }

  // Get aggregated activity for a directory across all descendants
  function getDirActivity(node, dateKey, cells) {
    let total = 0;
    const k = node.path + "|" + dateKey;
    const c = cells.get(k);
    if (c) total += c.total;
    if (node.isDir) {
      for (const child of node.children) {
        total += getDirActivity(child, dateKey, cells);
      }
    }
    return total;
  }

  // ── Precomputed grid values ──
  // gridCache[rowIdx][colIdx] = value (precomputed on layout change)
  let gridCache = [];

  function rebuildGridCache() {
    gridCache = [];
    maxCellValue = 1;
    for (let i = 0; i < visibleRows.length; i++) {
      const rowVals = [];
      const row = visibleRows[i];
      for (let j = 0; j < timeBuckets.length; j++) {
        const bucket = timeBuckets[j];
        let value = 0;
        // Aggregate across all days in this bucket
        const sd = new Date(bucket.startDate);
        const ed = new Date(bucket.endDate);
        while (sd < ed) {
          const dk = sd.toISOString().slice(0, 10);
          if (row.node.isDir) {
            value += getDirActivity(row.node, dk, cellData.cells);
          } else {
            const c = cellData.cells.get(row.node.path + "|" + dk);
            if (c) value += c.total;
          }
          sd.setDate(sd.getDate() + 1);
        }
        rowVals.push(value);
        if (value > maxCellValue) maxCellValue = value;
      }
      gridCache.push(rowVals);
    }
  }

  // ── State ──
  let tree = null; // { root, nodeMap }
  let visibleRows = [];
  let timeBuckets = [];
  let cellData = null;
  let expandedBuckets = new Set();
  let scrollY = 0, scrollX = 0;
  let hoverRow = -1, hoverCol = -1;
  let tooltip = null;
  let maxCellValue = 1;

  function W() { return canvas.width / (devicePixelRatio || 1); }
  function H() { return canvas.height / (devicePixelRatio || 1); }

  // ── Rendering ──
  function render() {
    if (!visible || !ctx) return;
    animId = requestAnimationFrame(render);

    const w = W(), h = H();
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);

    if (!tree || !cellData) {
      ctx.fillStyle = "#7b7bff";
      ctx.font = "20px 'SF Mono', monospace";
      ctx.textAlign = "center";
      ctx.fillText("Loading heatmap\u2026", w / 2, h / 2);
      ctx.textAlign = "left";
      return;
    }

    const gridLeft = LABEL_W + PAD;
    const gridTop = HEADER_H;
    const gridBottom = h - TIME_H;
    const gridRight = w - PAD;

    // ── Draw stats bar ──
    ctx.fillStyle = "rgba(20,20,35,0.9)";
    ctx.fillRect(0, 0, w, HEADER_H);
    ctx.font = "13px 'SF Mono', monospace";
    ctx.fillStyle = "#888";
    const totalFiles = visibleRows.filter(r => !r.node.isDir).length;
    const totalDirs = visibleRows.filter(r => r.node.isDir).length;
    ctx.fillText(totalDirs + " dirs \u00b7 " + totalFiles + " files \u00b7 " + timeBuckets.filter(b => !b.parent).length + " time periods", PAD, 21);
    // Legend
    ctx.fillStyle = "#555";
    ctx.textAlign = "right";
    ctx.fillText("cells = file reads + writes by Claude", w - PAD, 21);
    ctx.textAlign = "left";

    // ── Draw row labels (left) ──
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, gridTop, LABEL_W + PAD, gridBottom - gridTop);
    ctx.clip();

    for (let i = 0; i < visibleRows.length; i++) {
      const y = gridTop + i * ROW_H - scrollY;
      if (y + ROW_H < gridTop || y > gridBottom) continue;

      const row = visibleRows[i];
      const indent = row.depth * 14 + 8;
      const isHover = i === hoverRow;

      // Row background
      if (isHover) {
        ctx.fillStyle = "rgba(123,123,255,0.08)";
        ctx.fillRect(0, y, LABEL_W + PAD, ROW_H);
      }

      // Expand arrow for directories
      if (row.node.isDir && row.node.children.length > 0) {
        ctx.fillStyle = "#555";
        ctx.font = "13px sans-serif";
        ctx.fillText(row.node.expanded ? "\u25BC" : "\u25B6", indent, y + 23);
      }

      // Label
      ctx.fillStyle = isHover ? LABEL_HOVER : (row.node.isDir ? "#8888cc" : LABEL_COLOR);
      ctx.font = row.node.isDir ? "bold 15px 'SF Mono', monospace" : "14px 'SF Mono', monospace";
      const maxLabelW = LABEL_W - indent - 20;
      let label = row.node.name;
      if (ctx.measureText(label).width > maxLabelW) {
        while (label.length > 3 && ctx.measureText(label + "\u2026").width > maxLabelW) {
          label = label.slice(0, -1);
        }
        label += "\u2026";
      }
      ctx.fillText(label, indent + 18, y + 23);

      // Activity count (right-aligned)
      ctx.fillStyle = "#444";
      ctx.font = "12px 'SF Mono', monospace";
      ctx.textAlign = "right";
      ctx.fillText(row.node.activity.toString(), LABEL_W - 8, y + 23);
      ctx.textAlign = "left";
    }
    ctx.restore();

    // ── Draw divider ──
    ctx.strokeStyle = "#2a2a4a";
    ctx.beginPath();
    ctx.moveTo(LABEL_W + PAD - 1, gridTop);
    ctx.lineTo(LABEL_W + PAD - 1, gridBottom);
    ctx.stroke();

    // ── Draw heatmap cells ──
    ctx.save();
    ctx.beginPath();
    ctx.rect(gridLeft, gridTop, gridRight - gridLeft, gridBottom - gridTop);
    ctx.clip();

    const colsVisible = timeBuckets;
    for (let i = 0; i < visibleRows.length; i++) {
      const y = gridTop + i * ROW_H - scrollY;
      if (y + ROW_H < gridTop || y > gridBottom) continue;

      for (let j = 0; j < colsVisible.length; j++) {
        const x = gridLeft + j * COL_W - scrollX;
        if (x + COL_W < gridLeft || x > gridRight) continue;

        const value = (gridCache[i] && gridCache[i][j]) || 0;
        const intensity = maxCellValue > 0 ? value / maxCellValue : 0;
        const isSubBucket = !!colsVisible[j].parent;
        const cw = isSubBucket ? COL_W - 2 : COL_W;

        ctx.fillStyle = heatColor(intensity);
        ctx.fillRect(x + 1, y + 1, cw - 2, ROW_H - 2);

        // Hover highlight
        if (i === hoverRow && j === hoverCol) {
          ctx.strokeStyle = "#7b7bff";
          ctx.lineWidth = 1.5;
          ctx.strokeRect(x + 1, y + 1, cw - 2, ROW_H - 2);
          ctx.lineWidth = 1;
        }

        // Show count for high-activity cells
        if (value > 0 && (cw > 22 || intensity > 0.3)) {
          ctx.fillStyle = intensity > 0.5 ? "#fff" : "#888";
          ctx.font = "12px 'SF Mono', monospace";
          ctx.textAlign = "center";
          ctx.fillText(value.toString(), x + cw / 2, y + 22);
          ctx.textAlign = "left";
        }
      }
    }
    ctx.restore();

    // ── Draw time labels (bottom) ──
    ctx.save();
    ctx.beginPath();
    ctx.rect(gridLeft, gridBottom, gridRight - gridLeft, TIME_H);
    ctx.clip();

    ctx.strokeStyle = "#2a2a4a";
    ctx.beginPath();
    ctx.moveTo(gridLeft, gridBottom);
    ctx.lineTo(gridRight, gridBottom);
    ctx.stroke();

    for (let j = 0; j < colsVisible.length; j++) {
      const x = gridLeft + j * COL_W - scrollX;
      if (x + COL_W < gridLeft || x > gridRight) continue;

      const bucket = colsVisible[j];
      const isSubBucket = !!bucket.parent;
      const isHover = j === hoverCol;

      // Clickable expand indicator for non-day buckets
      if (bucket.granularity !== "day" && !isSubBucket) {
        ctx.fillStyle = isHover ? "#7b7bff" : "#555";
        ctx.font = "13px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(bucket.expanded ? "\u25B2" : "\u25BC", x + COL_W / 2, gridBottom + 16);
      }

      // Label (rotated 45°)
      ctx.save();
      ctx.translate(x + COL_W / 2, gridBottom + (isSubBucket ? 22 : 28));
      ctx.rotate(-Math.PI / 4);
      ctx.fillStyle = isSubBucket ? "#777" : (isHover ? "#ccc" : "#999");
      ctx.font = (isSubBucket ? "12px" : "14px") + " 'SF Mono', monospace";
      ctx.textAlign = "right";
      ctx.fillText(bucket.label, 0, 0);
      ctx.restore();
    }
    ctx.restore();

    // ── Draw tooltip ──
    if (tooltip) {
      const tw = ctx.measureText(tooltip.text).width + 16;
      const tx = Math.min(tooltip.x, w - tw - 8);
      const ty = Math.max(tooltip.y - 30, HEADER_H);
      ctx.fillStyle = "rgba(10,10,30,0.95)";
      ctx.strokeStyle = "#3a3a6a";
      ctx.lineWidth = 1;
      roundRect(ctx, tx, ty, tw, 22, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#ccc";
      ctx.font = "13px 'SF Mono', monospace";
      ctx.fillText(tooltip.text, tx + 8, ty + 15);
    }

    // ── Grid lines ──
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 0.5;
    // Horizontal
    for (let i = 0; i <= visibleRows.length; i++) {
      const y = gridTop + i * ROW_H - scrollY;
      if (y < gridTop || y > gridBottom) continue;
      ctx.beginPath(); ctx.moveTo(gridLeft, y); ctx.lineTo(gridRight, y); ctx.stroke();
    }
    // Vertical
    for (let j = 0; j <= colsVisible.length; j++) {
      const x = gridLeft + j * COL_W - scrollX;
      if (x < gridLeft || x > gridRight) continue;
      ctx.beginPath(); ctx.moveTo(x, gridTop); ctx.lineTo(x, gridBottom); ctx.stroke();
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // ── Interaction ──
  function onMouseMove(e) {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const gridLeft = LABEL_W + PAD;
    const gridTop = HEADER_H;
    const gridBottom = H() - TIME_H;

    // Row hover
    if (my >= gridTop && my < gridBottom) {
      hoverRow = Math.floor((my - gridTop + scrollY) / ROW_H);
      if (hoverRow >= visibleRows.length) hoverRow = -1;
    } else {
      hoverRow = -1;
    }

    // Col hover
    if (mx >= gridLeft) {
      hoverCol = Math.floor((mx - gridLeft + scrollX) / COL_W);
      if (hoverCol >= timeBuckets.length) hoverCol = -1;
    } else {
      hoverCol = -1;
    }

    // Tooltip
    if (hoverRow >= 0 && hoverCol >= 0) {
      const row = visibleRows[hoverRow];
      const bucket = timeBuckets[hoverCol];
      const name = row.node.name;
      const time = bucket.label;
      const value = (gridCache[hoverRow] && gridCache[hoverRow][hoverCol]) || 0;
      let detail = name + " \u00b7 " + time + (value > 0 ? " \u00b7 " + value + " file " + (value === 1 ? "touch" : "touches") : " \u00b7 no activity");
      tooltip = { text: detail, x: mx, y: my };
    } else {
      tooltip = null;
    }

    canvas.style.cursor = (hoverRow >= 0 && mx < LABEL_W + PAD) ? "pointer" :
                           (hoverCol >= 0 && my > H() - TIME_H) ? "pointer" :
                           (my < HEADER_H && mx > W() - 40) ? "pointer" : "default";
  }

  function onClick(e) {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const gridTop = HEADER_H;
    const gridBottom = H() - TIME_H;

    // Row label click → toggle expand
    if (mx < LABEL_W + PAD && my >= gridTop && my < gridBottom && hoverRow >= 0 && hoverRow < visibleRows.length) {
      const node = visibleRows[hoverRow].node;
      if (node.isDir && node.children.length > 0) {
        node.expanded = !node.expanded;
        visibleRows = flattenTree(tree.root);
        recalcMaxCell();
      }
      return;
    }

    // Time label click → toggle expand
    if (my > gridBottom && hoverCol >= 0 && hoverCol < timeBuckets.length) {
      const bucket = timeBuckets[hoverCol];
      if (bucket.granularity !== "day" && !bucket.parent) {
        if (expandedBuckets.has(bucket.key)) {
          expandedBuckets.delete(bucket.key);
        } else {
          expandedBuckets.add(bucket.key);
        }
        timeBuckets = buildTimeBuckets(data.dateRange, expandedBuckets);
        recalcMaxCell();
      }
      return;
    }
  }

  function onWheel(e) {
    e.preventDefault();
    const gridLeft = LABEL_W + PAD;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;

    if (mx < gridLeft) {
      // Scroll rows
      scrollY = Math.max(0, Math.min(scrollY + e.deltaY, Math.max(0, visibleRows.length * ROW_H - (H() - HEADER_H - TIME_H))));
    } else {
      // Scroll columns
      scrollX = Math.max(0, Math.min(scrollX + e.deltaX + e.deltaY, Math.max(0, timeBuckets.length * COL_W - (W() - LABEL_W - PAD * 2))));
    }
  }

  function onKeyDown(e) {
    if (e.key === "Escape") { hide(); e.preventDefault(); }
  }

  function onResize() {
    const dpr = devicePixelRatio || 1;
    var cw = innerWidth, ch = innerHeight - 52;
    canvas.width = cw * dpr;
    canvas.height = ch * dpr;
    canvas.style.width = cw + "px";
    canvas.style.height = ch + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Clamp scroll positions to new bounds
    scrollY = Math.max(0, Math.min(scrollY, Math.max(0, visibleRows.length * ROW_H - (H() - HEADER_H - TIME_H))));
    scrollX = Math.max(0, Math.min(scrollX, Math.max(0, timeBuckets.length * COL_W - (W() - LABEL_W - PAD * 2))));
  }

  // Recalculate grid cache and maxCellValue
  function recalcMaxCell() {
    rebuildGridCache();
  }

  // ── Public API ──
  async function show() {
    canvas = document.getElementById("heatmapCanvas");
    if (!canvas) return;

    const dpr = devicePixelRatio || 1;
    var cw = innerWidth, ch = innerHeight - 52;
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
    const fsTl = document.getElementById("fsTimelineCanvas");
    if (fsTl) fsTl.style.display = "none";

    // Events
    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("click", onClick);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);

    // Start render loop
    animId = requestAnimationFrame(render);

    await fetchData();
  }

  async function fetchData() {
    try {
      const project = document.getElementById("projectFilter")?.value || "";
      const url = "/api/heatmap" + (project ? "?project=" + encodeURIComponent(project) : "");
      const resp = await fetch(url);
      const raw = await resp.json();
      data = raw;

      tree = buildTree(raw.fileActivity);
      cellData = buildCellData(raw.fileActivity, raw.msgActivity);

      const availH = H() - HEADER_H - TIME_H;
      autoExpand(tree.root, availH);
      visibleRows = flattenTree(tree.root);

      expandedBuckets = new Set();
      timeBuckets = buildTimeBuckets(raw.dateRange, expandedBuckets);

      recalcMaxCell();
      scrollY = 0;
      scrollX = 0;
    } catch (err) {
      console.error("Heatmap: failed to load data", err);
    }
  }

  async function refresh() {
    if (visible) await fetchData();
  }

  function hide() {
    visible = false;
    if (canvas) canvas.style.display = "none";
    cancelAnimationFrame(animId);

    const graph = document.getElementById("graph");
    if (graph) graph.style.display = "";

    if (canvas) {
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("wheel", onWheel);
    }
    document.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("resize", onResize);
  }

  function toggle() {
    if (visible) hide(); else show();
  }

  return { show, hide, toggle, refresh };
})();
