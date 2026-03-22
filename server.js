const express = require("express");
const path = require("path");
const { scanAllSessions } = require("./scanner");

const app = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, "public")));

let cachedData = null;
let cacheTime = 0;
const CACHE_TTL = 30_000; // 30s

async function getData() {
  const now = Date.now();
  if (cachedData && now - cacheTime < CACHE_TTL) return cachedData;
  console.time("scan");
  cachedData = await scanAllSessions();
  cacheTime = now;
  console.timeEnd("scan");
  return cachedData;
}

// SSE endpoint — streams file/snippet discoveries during scan
app.get("/api/scan-stream", async (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  let closed = false;
  req.on("close", () => { closed = true; });

  const send = (event, data) => {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // If cached, stream discoveries from cache in reverse-chrono order
  const now = Date.now();
  if (cachedData && now - cacheTime < CACHE_TTL) {
    send("progress", { pct: 100, done: 0, total: 0 });
    // Stream a sample of cached discoveries (already sorted newest-first)
    const sample = cachedData.discoveries.slice(0, 800);
    send("discoveries", { items: sample });
    send("done", { nodes: cachedData.graph.nodes.length, edges: cachedData.graph.edges.length });
    res.end();
    return;
  }

  // Stream discoveries LIVE during scan — batch and flush frequently
  let pendingBatch = [];
  const budget = { prompt: 400, code: 400, response: 300, file: 200, snippet: 150, title: 100 };
  const counts = {};

  const flushBatch = () => {
    if (closed || pendingBatch.length === 0) return;
    send("discoveries", { items: pendingBatch });
    pendingBatch = [];
  };

  cachedData = await scanAllSessions(
    // onProgress
    (evt) => {
      if (closed) return;
      if (evt.type === "progress") {
        send("progress", evt);
        // Flush accumulated discoveries with each file completion
        flushBatch();
      }
    },
    // onDiscovery — called for EACH discovery as it's found during parsing
    (item) => {
      if (closed) return;
      const limit = budget[item.type] || 50;
      counts[item.type] = (counts[item.type] || 0) + 1;
      if (counts[item.type] <= limit) {
        pendingBatch.push(item);
        // Flush every 30 items for responsive streaming
        if (pendingBatch.length >= 30) flushBatch();
      }
    }
  );
  cacheTime = Date.now();

  if (closed) return;

  // Flush any remaining
  flushBatch();

  send("done", {
    nodes: cachedData.graph.nodes.length,
    edges: cachedData.graph.edges.length,
    shared: cachedData.graph.stats.sharedFiles,
  });
  res.end();
});

// Search across all sessions — messages, files, commands
app.get("/api/search", async (req, res) => {
  try {
    const data = await getData();
    const { q, type } = req.query;
    if (!q) return res.json({ results: [] });

    const query = q.toLowerCase();
    const results = [];

    for (const session of data.sessions) {
      // Search user messages
      if (!type || type === "messages" || type === "all") {
        for (const msg of (session.userMessages || [])) {
          if (msg.text.toLowerCase().includes(query)) {
            results.push({
              type: "message",
              sessionId: session.id,
              sessionTitle: session.title || session.id.slice(0, 8),
              project: session.project,
              text: msg.text,
              timestamp: msg.timestamp,
            });
          }
        }
      }

      // Search files touched
      if (!type || type === "files" || type === "all") {
        for (const fi of session.fileInteractions) {
          if (fi.file.toLowerCase().includes(query)) {
            results.push({
              type: "file",
              sessionId: session.id,
              sessionTitle: session.title || session.id.slice(0, 8),
              project: session.project,
              file: fi.file,
              action: fi.action,
              timestamp: fi.timestamp,
            });
          }
        }
      }
    }

    // Deduplicate file results — group by file + session
    if (!type || type === "files" || type === "all") {
      const fileMap = new Map();
      const nonFileResults = results.filter(r => r.type !== "file");
      const fileResults = results.filter(r => r.type === "file");
      for (const r of fileResults) {
        const key = `${r.sessionId}:${r.file}`;
        if (!fileMap.has(key)) fileMap.set(key, r);
      }
      results.length = 0;
      results.push(...nonFileResults, ...Array.from(fileMap.values()));
    }

    // Sort by timestamp desc
    results.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));

    res.json({ results: results.slice(0, 200), total: results.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Frequent user commands / repeated patterns
app.get("/api/patterns", async (req, res) => {
  try {
    const data = await getData();
    const freq = new Map(); // text -> {count, sessions}

    for (const session of data.sessions) {
      for (const msg of (session.userMessages || [])) {
        // Normalize: lowercase, trim, collapse whitespace
        const norm = msg.text.toLowerCase().trim().replace(/\s+/g, " ");
        if (norm.length < 5 || norm.length > 200) continue;
        if (!freq.has(norm)) freq.set(norm, { text: msg.text, count: 0, sessions: new Set() });
        const entry = freq.get(norm);
        entry.count++;
        entry.sessions.add(session.id);
      }
    }

    // Find near-duplicates using simple prefix matching
    const patterns = Array.from(freq.values())
      .filter(e => e.count >= 2 || e.sessions.size >= 2)
      .map(e => ({ text: e.text, count: e.count, sessionCount: e.sessions.size }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 50);

    res.json({ patterns });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/graph", async (req, res) => {
  try {
    const data = await getData();
    const { project, minSessions, timeRange } = req.query;

    let graph = data.graph;

    // Filter by time range
    if (timeRange && timeRange !== "all") {
      const now = Date.now();
      const cutoffs = {
        "1h": now - 60 * 60 * 1000,
        "today": new Date().setHours(0, 0, 0, 0),
        "week": now - 7 * 24 * 60 * 60 * 1000,
        "month": now - 30 * 24 * 60 * 60 * 1000,
      };
      const cutoff = cutoffs[timeRange];
      if (cutoff) {
        const sessionNodes = new Set(
          graph.nodes
            .filter(n => n.type === "session" && new Date(n.endTime || n.startTime || 0) >= cutoff)
            .map(n => n.id)
        );
        const relevantEdges = graph.edges.filter(e => sessionNodes.has(e.source));
        const relevantFiles = new Set(relevantEdges.map(e => e.target));
        const nodes = graph.nodes.filter(n => sessionNodes.has(n.id) || relevantFiles.has(n.id));
        graph = { nodes, edges: relevantEdges, stats: graph.stats };
      }
    }

    // Filter by project if specified
    if (project) {
      const sessionNodes = new Set(
        graph.nodes
          .filter((n) => n.type === "session" && n.project?.includes(project))
          .map((n) => n.id)
      );
      const relevantEdges = graph.edges.filter((e) =>
        sessionNodes.has(e.source)
      );
      const relevantFiles = new Set(relevantEdges.map((e) => e.target));
      const nodes = graph.nodes.filter(
        (n) => sessionNodes.has(n.id) || relevantFiles.has(n.id)
      );
      graph = { nodes, edges: relevantEdges, stats: graph.stats };
    }

    // Filter files by minimum session count
    if (minSessions) {
      const min = parseInt(minSessions);
      const keepFiles = new Set(
        graph.nodes
          .filter(
            (n) =>
              n.type === "file" && (n.sessionCount || 0) >= min
          )
          .map((n) => n.id)
      );
      const keepSessions = new Set(
        graph.nodes.filter((n) => n.type === "session").map((n) => n.id)
      );
      const edges = graph.edges.filter(
        (e) => keepFiles.has(e.target) && keepSessions.has(e.source)
      );
      // Only keep sessions that still have edges
      const activeSessions = new Set(edges.map((e) => e.source));
      const nodes = graph.nodes.filter(
        (n) =>
          keepFiles.has(n.id) || activeSessions.has(n.id)
      );
      graph = { nodes, edges, stats: graph.stats };
    }

    res.json(graph);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/sessions", async (req, res) => {
  const data = await getData();
  const sessions = data.sessions.map((s) => ({
    id: s.id,
    title: s.title,
    project: s.project,
    branch: s.branch,
    startTime: s.startTime,
    endTime: s.endTime,
    messages: s.messages,
    toolCalls: s.toolCalls.length,
    filesRead: s.fileInteractions.filter((f) => f.action === "read").length,
    filesWritten: s.fileInteractions.filter((f) => f.action === "write").length,
  }));
  res.json(sessions);
});

app.get("/api/projects", async (req, res) => {
  const data = await getData();
  res.json(data.projects);
});

app.get("/api/session/:id", async (req, res) => {
  const data = await getData();
  const session = data.sessions.find((s) => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: "not found" });
  res.json(session);
});

// Replay endpoint — returns timestamped events for today (or a given range)
app.get("/api/replay", async (req, res) => {
  try {
    const data = await getData();
    const range = req.query.range || "today";
    const now = Date.now();
    const cutoffs = {
      "1h": now - 60 * 60 * 1000,
      "today": new Date().setHours(0, 0, 0, 0),
      "week": now - 7 * 24 * 60 * 60 * 1000,
      "month": now - 30 * 24 * 60 * 60 * 1000,
      "all": 0,
    };
    const cutoff = cutoffs[range] || cutoffs.today;

    const events = [];
    for (const session of data.sessions) {
      const sessionStart = new Date(session.startTime || 0).getTime();
      if (sessionStart < cutoff) continue;

      // Session start event
      events.push({
        type: "session-start",
        timestamp: session.startTime,
        sessionId: session.id,
        label: session.title || session.id.slice(0, 8),
        project: session.project,
        branch: session.branch,
      });

      // File interaction events
      for (const fi of session.fileInteractions) {
        events.push({
          type: "file-touch",
          timestamp: fi.timestamp,
          sessionId: session.id,
          file: fi.file,
          action: fi.action,
          tool: fi.tool,
        });
      }
    }

    // Sort chronologically
    events.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));

    res.json({ events, range, cutoff: new Date(cutoff).toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Context Map running at http://localhost:${PORT}`);
});
