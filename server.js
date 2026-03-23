const express = require("express");
const path = require("path");
const { scanAllSessions } = require("./scanner");
const store = require("./db");
const gitScanner = require("./git-scanner");

const app = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, "public")));

// DuckDB init + background sync
let dbReady = false;
(async () => {
  try {
    await store.init();
    console.time("db-sync");
    const result = await store.sync((evt) => {
      if (evt.pct % 25 === 0 && evt.done === Math.floor(evt.total * evt.pct / 100)) {
        console.log(`  db sync: ${evt.pct}% (${evt.scanned} scanned, ${evt.skipped} skipped)`);
      }
    });
    console.timeEnd("db-sync");
    console.log(`DB ready: ${result.scanned} scanned, ${result.skipped} skipped, ${result.total} total`);
    dbReady = true;
    // Git history sync (non-blocking — runs after DB is ready)
    gitScanner.syncGitHistory(store, (evt) => {
      console.log(`  git sync: ${evt.pct}% — ${evt.repo} (${evt.commits} commits)`);
    }).then(r => console.log(`Git sync done: ${r.reposScanned} repos, ${r.commitsInserted} commits`))
      .catch(e => console.error("Git sync error:", e.message));
  } catch (err) {
    console.error("DuckDB init failed, falling back to scanner:", err.message);
  }
})();

// Re-sync DB periodically (every 60s) to pick up new sessions
setInterval(async () => {
  if (!dbReady) return;
  try {
    await store.sync();
    await gitScanner.syncGitHistory(store);
  } catch (e) { console.error("bg sync:", e.message); }
}, 60_000);

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

// SSE endpoint — streams discoveries for the flythrough loader
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

  // If DuckDB is ready, pull discoveries from the DB — no re-scan needed
  if (dbReady) {
    send("progress", { pct: 50, done: 1, total: 1 });
    try {
      const [discoveries, counts] = await Promise.all([
        store.getDiscoveries(),
        store.getQuickCounts(),
      ]);
      send("discoveries", { items: discoveries });
      send("progress", { pct: 100, done: 1, total: 1 });
      send("done", counts);
    } catch (err) {
      console.error("scan-stream DuckDB error:", err.message);
      send("done", { nodes: 0, edges: 0, shared: 0 });
    }
    res.end();
    return;
  }

  // Fallback: full scan via scanner.js (first run before DB is ready)
  let pendingBatch = [];

  const flushBatch = () => {
    if (closed || pendingBatch.length === 0) return;
    send("discoveries", { items: pendingBatch });
    pendingBatch = [];
  };

  cachedData = await scanAllSessions(
    (evt) => {
      if (closed) return;
      if (evt.type === "progress") {
        send("progress", evt);
        flushBatch();
      }
    },
    (item) => {
      if (closed) return;
      pendingBatch.push(item);
      if (pendingBatch.length >= 30) flushBatch();
    }
  );
  cacheTime = Date.now();

  if (closed) return;
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
    const { q, type } = req.query;
    if (!q) return res.json({ results: [] });

    if (dbReady) {
      const data = await store.search(q, type || "all");
      return res.json(data);
    }

    // Fallback: in-memory scan
    const data = await getData();
    const query = q.toLowerCase();
    const results = [];

    for (const session of data.sessions) {
      if (!type || type === "messages" || type === "all") {
        for (const msg of (session.userMessages || [])) {
          if (msg.text.toLowerCase().includes(query)) {
            results.push({
              type: "message", sessionId: session.id,
              sessionTitle: session.title || session.id.slice(0, 8),
              project: session.project, text: msg.text, timestamp: msg.timestamp,
            });
          }
        }
      }
      if (!type || type === "files" || type === "all") {
        for (const fi of session.fileInteractions) {
          if (fi.file.toLowerCase().includes(query)) {
            results.push({
              type: "file", sessionId: session.id,
              sessionTitle: session.title || session.id.slice(0, 8),
              project: session.project, file: fi.file, action: fi.action, timestamp: fi.timestamp,
            });
          }
        }
      }
    }

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

    results.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
    res.json({ results, total: results.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Frequent user commands / repeated patterns
app.get("/api/patterns", async (req, res) => {
  try {
    if (dbReady) {
      const patterns = await store.getPatterns();
      return res.json({ patterns });
    }

    const data = await getData();
    const freq = new Map();
    for (const session of data.sessions) {
      for (const msg of (session.userMessages || [])) {
        const norm = msg.text.toLowerCase().trim().replace(/\s+/g, " ");
        if (norm.length < 5 || norm.length > 200) continue;
        if (!freq.has(norm)) freq.set(norm, { text: msg.text, count: 0, sessions: new Set() });
        const entry = freq.get(norm);
        entry.count++;
        entry.sessions.add(session.id);
      }
    }
    const patterns = Array.from(freq.values())
      .filter(e => e.count >= 2 || e.sessions.size >= 2)
      .map(e => ({ text: e.text, count: e.count, sessionCount: e.sessions.size }))
      .sort((a, b) => b.count - a.count)
;
    res.json({ patterns });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// File co-occurrence graph — files connected by how often they're edited together
app.get("/api/file-graph", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ error: "DB not ready" });
    const { project, minCooccurrence, timeRange } = req.query;
    const graph = await store.getFileGraph({ project, minCooccurrence, timeRange });
    res.json(graph);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/graph", async (req, res) => {
  try {
    const { project, minSessions, timeRange } = req.query;

    if (dbReady) {
      const graph = await store.getGraph({ project, minSessions, timeRange });
      return res.json(graph);
    }

    const data = await getData();
    let graph = data.graph;

    // Filter by time range
    if (timeRange && timeRange !== "all") {
      const now = Date.now();
      const cutoffs = {
        "1h": now - 60 * 60 * 1000,
        "24h": now - 24 * 60 * 60 * 1000,
        "48h": now - 48 * 60 * 60 * 1000,
        "today": now - 24 * 60 * 60 * 1000,
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

app.get("/api/heatmap", async (req, res) => {
  try {
    if (!dbReady) return res.json({ fileActivity: [], msgActivity: [], dateRange: {} });
    const { project } = req.query;
    const data = await store.getHeatmapData(project);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/sessions", async (req, res) => {
  try {
    if (dbReady) {
      const rows = await store.query(`
        SELECT s.id, s.title, s.project, s.branch, s.start_time AS "startTime",
               s.end_time AS "endTime", s.messages, s.tool_calls AS "toolCalls",
               COUNT(*) FILTER (WHERE fi.action = 'read') AS "filesRead",
               COUNT(*) FILTER (WHERE fi.action = 'write') AS "filesWritten"
        FROM sessions s
        LEFT JOIN file_interactions fi ON fi.session_id = s.id
        GROUP BY s.id, s.title, s.project, s.branch, s.start_time, s.end_time, s.messages, s.tool_calls
        ORDER BY s.start_time
      `);
      return res.json(rows);
    }
    const data = await getData();
    const sessions = data.sessions.map((s) => ({
      id: s.id, title: s.title, project: s.project, branch: s.branch,
      startTime: s.startTime, endTime: s.endTime, messages: s.messages,
      toolCalls: s.toolCalls.length,
      filesRead: s.fileInteractions.filter((f) => f.action === "read").length,
      filesWritten: s.fileInteractions.filter((f) => f.action === "write").length,
    }));
    res.json(sessions);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.get("/api/projects", async (req, res) => {
  try {
    if (dbReady) return res.json(await store.getProjects());
    const data = await getData();
    res.json(data.projects);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.get("/api/session/:id", async (req, res) => {
  try {
    if (dbReady) {
      const session = await store.getSession(req.params.id);
      if (!session) return res.status(404).json({ error: "not found" });
      return res.json(session);
    }
    const data = await getData();
    const session = data.sessions.find((s) => s.id === req.params.id);
    if (!session) return res.status(404).json({ error: "not found" });
    res.json(session);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Full message transcript for a session
app.get("/api/session/:id/transcript", async (req, res) => {
  try {
    const data = await getData();
    const session = data.sessions.find((s) => s.id === req.params.id);
    if (!session) return res.status(404).json({ error: "not found" });

    // Read the raw JSONL and extract all user + assistant messages in order
    const fs = require("fs");
    const path = require("path");
    const readline = require("readline");
    const CLAUDE_DIR = path.join(require("os").homedir(), ".claude", "projects");
    const filePath = path.join(CLAUDE_DIR, session.project, session.id + ".jsonl");

    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "session file not found" });

    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const messages = [];

    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }

      if (entry.type === "user") {
        const content = entry.message?.content;
        let text = "";
        if (typeof content === "string") text = content;
        else if (Array.isArray(content)) {
          text = content.filter(b => b.type === "text").map(b => b.text).join("\n");
        }
        // Strip system tags
        text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").replace(/<[^>]+>/g, "").trim();
        if (text && text.length > 3 && !text.startsWith("Note:") && !text.startsWith("The user opened")) {
          messages.push({ role: "user", text, timestamp: entry.timestamp });
        }
      }

      if (entry.type === "assistant" && entry.message?.content) {
        const content = entry.message.content;
        if (!Array.isArray(content)) continue;
        const textParts = [];
        const tools = [];
        for (const block of content) {
          if (block.type === "text" && block.text) textParts.push(block.text);
          if (block.type === "tool_use") tools.push(block.name);
        }
        const text = textParts.join("\n").trim();
        if (text || tools.length) {
          messages.push({
            role: "assistant",
            text: text || null,
            tools: tools.length ? tools : undefined,
            timestamp: entry.timestamp,
          });
        }
      }
    }

    res.json({
      sessionId: session.id,
      title: session.title,
      project: session.project,
      messages,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Auto-generated search suggestions based on actual data
app.get("/api/suggestions", async (req, res) => {
  try {
    const data = await getData();
    const suggestions = [];

    // Topic clusters: find most common words across user messages (skip stopwords)
    const stopwords = new Set(["the","a","an","and","or","but","in","on","at","to","for","of","with","by","is","it","this","that","i","we","you","me","my","can","do","did","will","be","have","has","had","not","no","so","if","from","up","out","as","all","just","get","got","make","let","its","are","was","were","been","dont","im","ive","also","would","should","could","what","how","when","where","why","there","here","then","than","them","they","these","those","about","into","over","after","before","need","want","like","use","file","code","user","line","true","false","null","undefined","data","type","name","text","value","string","number","function","return","const","class","import","export","async","await","each","some","more","most","other","only","very","same","such","take","give","look","come","find","made","goes","work","used","using","please","thanks","sure","okay","yeah","right","well","note","added","following","based","should","must","does","done","already","actually","still","even","though","because","since","while","until","next","last","first","every","many","much","back","down","through","between","both","being","during","another","which","their","them","your","our","called","within","along","around","upon","under","above","below","help","keep","thing","things","show","read","write","path","tool","input","content","message","entry","block","error","check","update","result","change","changes","changed"]);
    const wordFreq = new Map();
    for (const session of data.sessions) {
      for (const msg of (session.userMessages || [])) {
        const words = msg.text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/);
        for (const w of words) {
          if (w.length < 4 || stopwords.has(w) || /^\d+$/.test(w)) continue;
          wordFreq.set(w, (wordFreq.get(w) || 0) + 1);
        }
      }
    }
    const topWords = Array.from(wordFreq.entries())
      .filter(([, c]) => c >= 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    for (const [word, count] of topWords) {
      suggestions.push({ type: "topic", text: word, count, description: count + " mentions across sessions" });
    }

    // File hotspots: most-touched files
    const fileCounts = new Map();
    for (const session of data.sessions) {
      const seen = new Set();
      for (const fi of session.fileInteractions) {
        if (seen.has(fi.file)) continue;
        seen.add(fi.file);
        fileCounts.set(fi.file, (fileCounts.get(fi.file) || 0) + 1);
      }
    }
    const topFiles = Array.from(fileCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
    for (const [file, count] of topFiles) {
      const name = file.split("/").pop();
      suggestions.push({ type: "file", text: name, count, description: count + " sessions touched this file" });
    }

    // Time-based suggestions
    const now = Date.now();
    const todayStart = new Date().setHours(0, 0, 0, 0);
    const todaySessions = data.sessions.filter(s => new Date(s.startTime || 0).getTime() >= todayStart);
    if (todaySessions.length) {
      // Extract keywords from today's messages
      const todayWords = new Map();
      for (const s of todaySessions) {
        for (const msg of (s.userMessages || [])) {
          const words = msg.text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/);
          for (const w of words) {
            if (w.length < 4 || stopwords.has(w)) continue;
            todayWords.set(w, (todayWords.get(w) || 0) + 1);
          }
        }
      }
      const todayTop = Array.from(todayWords.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);
      for (const [word, count] of todayTop) {
        suggestions.push({ type: "today", text: word, count, description: "mentioned " + count + "x today" });
      }
    }

    res.json({ suggestions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Replay endpoint — returns timestamped events for today (or a given range)
app.get("/api/replay", async (req, res) => {
  try {
    const range = req.query.range || "today";

    if (dbReady) {
      const events = await store.getReplayEvents(range);
      return res.json({ events, range });
    }

    const data = await getData();
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

// DB stats
app.get("/api/stats", async (req, res) => {
  try {
    if (dbReady) return res.json(await store.getStats());
    res.json({ error: "DB not ready" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// File story — all sessions that touched a file, with context
app.get("/api/file-story", async (req, res) => {
  try {
    const { path } = req.query;
    if (!path) return res.status(400).json({ error: "path required" });
    if (!dbReady) return res.status(503).json({ error: "DB not ready" });
    const story = await store.getFileStory(path);
    res.json(story);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Force DB re-sync
app.post("/api/sync", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ error: "DB not ready" });
    const result = await store.sync();
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Arbitrary SQL query (dev/debug only)
app.get("/api/sql", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ error: "DB not ready" });
    const { q } = req.query;
    if (!q) return res.json({ error: "provide ?q=SQL" });
    // Safety: read-only
    if (/^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)/i.test(q)) {
      return res.status(403).json({ error: "read-only" });
    }
    const rows = await store.query(q);
    res.json({ rows, count: rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Git History Endpoints ──

app.get("/api/git/repos", async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: "DB not ready" });
  try {
    const repos = await store.getGitRepos();
    res.json(repos);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/git/tree", async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: "DB not ready" });
  try {
    const { repo, before, limit } = req.query;
    if (!repo) return res.status(400).json({ error: "repo required" });
    const tree = await store.getGitTree(repo, before || new Date().toISOString(), parseInt(limit) || 500);
    res.json(tree);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/git/changes", async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: "DB not ready" });
  try {
    const { repo, start, end } = req.query;
    if (!repo || !start || !end) return res.status(400).json({ error: "repo, start, end required" });
    const changes = await store.getGitChanges(repo, start, end);
    res.json(changes);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/git/activity", async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: "DB not ready" });
  try {
    const { repo, at, window: win } = req.query;
    if (!repo || !at) return res.status(400).json({ error: "repo, at required" });
    const activity = await store.getActivityNear(repo, at, parseInt(win) || 30);
    res.json(activity);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Serve /timeline as the same index.html (SPA route)
app.get("/timeline", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Context Map running at http://localhost:${PORT}`);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await store.close();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await store.close();
  process.exit(0);
});
