/**
 * db.js — DuckDB storage layer for The Context Map
 *
 * Standalone module. Scans ~/.claude/projects/ JSONL session logs into a
 * local DuckDB database with incremental indexing (skips unchanged files).
 *
 * Usage:
 *   const db = require("./db");
 *   await db.init();           // open/create DB, run migrations
 *   await db.sync();           // incremental scan
 *   const rows = await db.query("SELECT ...");
 *   const graph = await db.getGraph({ project, minSessions, timeRange });
 *   const results = await db.search("refactor", "all");
 *   await db.close();
 */

const { Database } = require("duckdb-async");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const CLAUDE_DIR = path.join(require("os").homedir(), ".claude");
const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");
const DB_PATH = path.join(__dirname, "contextmap.duckdb");

let db = null;

// Convert BigInt values to Numbers in query results
function debi(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map(row => {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = typeof v === "bigint" ? Number(v) : v;
    }
    return out;
  });
}

// ═══════════════════════════════════════════════════════════════════
// INIT & SCHEMA
// ═══════════════════════════════════════════════════════════════════

async function init() {
  db = await Database.create(DB_PATH);
  // Wrap db.all to auto-convert BigInts to Numbers
  const origAll = db.all.bind(db);
  db.all = async (...args) => debi(await origAll(...args));
  await migrate();
  return db;
}

async function migrate() {
  // Indexed files tracker — skip unchanged files on re-scan
  await db.run(`
    CREATE TABLE IF NOT EXISTS indexed_files (
      file_path   TEXT PRIMARY KEY,
      project_dir TEXT NOT NULL,
      size_bytes  BIGINT NOT NULL,
      mtime_ms    BIGINT NOT NULL,
      indexed_at  TIMESTAMP DEFAULT current_timestamp
    )
  `);

  // Sessions
  await db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      project_dir TEXT,
      project     TEXT,
      title       TEXT,
      branch      TEXT,
      cwd         TEXT,
      start_time  TIMESTAMP,
      end_time    TIMESTAMP,
      messages    INTEGER DEFAULT 0,
      tool_calls  INTEGER DEFAULT 0
    )
  `);

  // User messages — full text for search
  await db.run(`
    CREATE TABLE IF NOT EXISTS user_messages (
      session_id  TEXT NOT NULL,
      text        TEXT NOT NULL,
      timestamp   TIMESTAMP
    )
  `);

  // File interactions
  await db.run(`
    CREATE TABLE IF NOT EXISTS file_interactions (
      session_id  TEXT NOT NULL,
      file_path   TEXT NOT NULL,
      action      TEXT NOT NULL,
      tool        TEXT,
      timestamp   TIMESTAMP
    )
  `);

  // Tool calls
  await db.run(`
    CREATE TABLE IF NOT EXISTS tool_calls (
      session_id  TEXT NOT NULL,
      tool        TEXT NOT NULL,
      timestamp   TIMESTAMP
    )
  `);

  // Git commits (populated by git-scanner.js)
  await db.run(`
    CREATE TABLE IF NOT EXISTS git_commits (
      hash        TEXT NOT NULL,
      repo_path   TEXT NOT NULL,
      commit_date TIMESTAMP NOT NULL,
      author      TEXT,
      subject     TEXT,
      PRIMARY KEY (hash, repo_path)
    )
  `);

  // Git file changes per commit
  await db.run(`
    CREATE TABLE IF NOT EXISTS git_file_changes (
      commit_hash TEXT NOT NULL,
      repo_path   TEXT NOT NULL,
      file_path   TEXT NOT NULL,
      additions   INTEGER DEFAULT 0,
      deletions   INTEGER DEFAULT 0
    )
  `);

  // Pre-computed daily summaries (materialized during sync)
  await db.run(`
    CREATE TABLE IF NOT EXISTS daily_summary (
      day           DATE NOT NULL,
      project_dir   TEXT,
      sessions      INTEGER DEFAULT 0,
      messages      INTEGER DEFAULT 0,
      file_reads    INTEGER DEFAULT 0,
      file_writes   INTEGER DEFAULT 0,
      tool_calls    INTEGER DEFAULT 0,
      unique_files  INTEGER DEFAULT 0,
      PRIMARY KEY (day, project_dir)
    )
  `);

  // Pre-computed hourly summaries for "last hour" fast lookup
  await db.run(`
    CREATE TABLE IF NOT EXISTS hourly_summary (
      hour          TIMESTAMP NOT NULL,
      project_dir   TEXT,
      sessions      INTEGER DEFAULT 0,
      messages      INTEGER DEFAULT 0,
      file_reads    INTEGER DEFAULT 0,
      file_writes   INTEGER DEFAULT 0,
      PRIMARY KEY (hour, project_dir)
    )
  `);

  // Cached flythrough discoveries — pre-built during sync
  await db.run(`
    CREATE TABLE IF NOT EXISTS cached_discoveries (
      id            INTEGER,
      type          TEXT NOT NULL,
      value         TEXT NOT NULL,
      ts            TIMESTAMP,
      session_id    TEXT
    )
  `);

  // Cached graph counts — avoids full graph build on page load
  await db.run(`
    CREATE TABLE IF NOT EXISTS cached_counts (
      key           TEXT PRIMARY KEY,
      value         INTEGER DEFAULT 0,
      updated_at    TIMESTAMP DEFAULT current_timestamp
    )
  `);

  // Indexes for common queries
  await db.run(`CREATE INDEX IF NOT EXISTS idx_fi_session ON file_interactions(session_id)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_fi_file ON file_interactions(file_path)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_fi_ts ON file_interactions(timestamp)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_msg_session ON user_messages(session_id)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_msg_ts ON user_messages(timestamp)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_dir)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_start ON sessions(start_time)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_gc_repo ON git_commits(repo_path)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_gc_date ON git_commits(commit_date)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_gfc_commit ON git_file_changes(commit_hash, repo_path)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_gfc_file ON git_file_changes(file_path)`);
}

// ═══════════════════════════════════════════════════════════════════
// INCREMENTAL SYNC
// ═══════════════════════════════════════════════════════════════════

const FILE_TOOLS = {
  Read: (input) => [input.file_path].filter(Boolean),
  Edit: (input) => [input.file_path].filter(Boolean),
  Write: (input) => [input.file_path].filter(Boolean),
  Glob: (input) => [input.path].filter(Boolean),
  Grep: (input) => [input.path].filter(Boolean),
};

const ACTION_TYPE = {
  Read: "read", Edit: "write", Write: "write", Glob: "read", Grep: "read",
};

/**
 * Sync the DB with the filesystem. Only re-parses files whose
 * size or mtime have changed since last index.
 *
 * @param {function} onProgress - optional (evt) => void
 * @returns {{ scanned, skipped, total }}
 */
async function sync(onProgress) {
  if (!fs.existsSync(PROJECTS_DIR)) {
    return { scanned: 0, skipped: 0, total: 0 };
  }

  // Gather all JSONL files (recursive — includes subagent sessions)
  const projectDirs = fs.readdirSync(PROJECTS_DIR)
    .filter(d => fs.statSync(path.join(PROJECTS_DIR, d)).isDirectory());

  const allFiles = [];
  function walkDir(dir, projectDir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath, projectDir);
      } else if (entry.name.endsWith(".jsonl")) {
        allFiles.push({ projectDir, filePath: fullPath, fileName: entry.name });
      }
    }
  }
  for (const pd of projectDirs) {
    walkDir(path.join(PROJECTS_DIR, pd), pd);
  }

  // Load existing index
  const indexed = new Map();
  const rows = await db.all("SELECT file_path, size_bytes, mtime_ms FROM indexed_files");
  for (const r of rows) indexed.set(r.file_path, r);

  let scanned = 0, skipped = 0;

  for (let i = 0; i < allFiles.length; i++) {
    const { projectDir, filePath, fileName } = allFiles[i];
    const stat = fs.statSync(filePath);
    const existing = indexed.get(filePath);

    if (existing && Number(existing.size_bytes) === stat.size && Number(existing.mtime_ms) === Math.floor(stat.mtimeMs)) {
      skipped++;
    } else {
      // Parse and index this file
      const sessionId = path.basename(fileName, ".jsonl");

      // Subagent files: attribute file interactions to parent session, don't create separate session
      const isSubagent = filePath.includes("/subagents/");
      let parentSessionId = null;
      if (isSubagent) {
        // Path: .../projects/<proj>/<parent-uuid>/subagents/<agent-xxx>.jsonl
        const parts = filePath.split("/");
        const subIdx = parts.indexOf("subagents");
        if (subIdx > 0) parentSessionId = parts[subIdx - 1];
      }

      // Delete old data for this session (re-index)
      const deleteId = isSubagent ? sessionId : sessionId;
      await db.run("DELETE FROM file_interactions WHERE session_id = ?", deleteId);
      await db.run("DELETE FROM user_messages WHERE session_id = ?", deleteId);
      await db.run("DELETE FROM tool_calls WHERE session_id = ?", deleteId);
      if (!isSubagent) {
        await db.run("DELETE FROM sessions WHERE id = ?", sessionId);
      }

      await indexSessionFile(filePath, isSubagent ? (parentSessionId || sessionId) : sessionId, projectDir, isSubagent);

      // Mark as indexed
      await db.run("DELETE FROM indexed_files WHERE file_path = ?", filePath);
      await db.run(`
        INSERT INTO indexed_files (file_path, project_dir, size_bytes, mtime_ms)
        VALUES (?, ?, ?, ?)
      `, filePath, projectDir, stat.size, Math.floor(stat.mtimeMs));

      scanned++;
    }

    if (onProgress) {
      onProgress({
        type: "progress",
        done: i + 1,
        total: allFiles.length,
        pct: Math.round(((i + 1) / allFiles.length) * 100),
        scanned,
        skipped,
      });
    }
  }

  // Materialize summaries if anything changed
  if (scanned > 0) {
    await materialize();
  }

  return { scanned, skipped, total: allFiles.length };
}

/**
 * Rebuild all pre-computed summary tables.
 * Runs after sync when files were actually re-indexed.
 */
async function materialize() {
  console.time("materialize");

  // Daily summary
  await db.run("DELETE FROM daily_summary");
  await db.run(`
    INSERT INTO daily_summary (day, project_dir, sessions, messages, file_reads, file_writes, tool_calls, unique_files)
    SELECT
      CAST(s.start_time AS DATE) AS day,
      s.project_dir,
      COUNT(DISTINCT s.id) AS sessions,
      COALESCE(SUM(s.messages), 0) AS messages,
      COALESCE((SELECT COUNT(*) FROM file_interactions fi WHERE fi.session_id IN
        (SELECT id FROM sessions WHERE CAST(start_time AS DATE) = CAST(s.start_time AS DATE) AND project_dir = s.project_dir)
        AND fi.action = 'read'), 0) AS file_reads,
      COALESCE((SELECT COUNT(*) FROM file_interactions fi WHERE fi.session_id IN
        (SELECT id FROM sessions WHERE CAST(start_time AS DATE) = CAST(s.start_time AS DATE) AND project_dir = s.project_dir)
        AND fi.action = 'write'), 0) AS file_writes,
      COALESCE(SUM(s.tool_calls), 0) AS tool_calls,
      COALESCE((SELECT COUNT(DISTINCT fi.file_path) FROM file_interactions fi WHERE fi.session_id IN
        (SELECT id FROM sessions WHERE CAST(start_time AS DATE) = CAST(s.start_time AS DATE) AND project_dir = s.project_dir)), 0) AS unique_files
    FROM sessions s
    WHERE s.start_time IS NOT NULL
    GROUP BY CAST(s.start_time AS DATE), s.project_dir
  `);

  // Hourly summary
  await db.run("DELETE FROM hourly_summary");
  await db.run(`
    INSERT INTO hourly_summary (hour, project_dir, sessions, messages, file_reads, file_writes)
    SELECT
      DATE_TRUNC('hour', s.start_time) AS hour,
      s.project_dir,
      COUNT(DISTINCT s.id),
      COALESCE(SUM(s.messages), 0),
      0, 0
    FROM sessions s
    WHERE s.start_time IS NOT NULL
    GROUP BY DATE_TRUNC('hour', s.start_time), s.project_dir
  `);

  // Cached discoveries — random sample for flythrough
  await db.run("DELETE FROM cached_discoveries");
  await db.run(`
    INSERT INTO cached_discoveries (id, type, value, ts, session_id)
    SELECT ROW_NUMBER() OVER () AS id, type, value, ts, session_id FROM (
      SELECT 'title' AS type, title AS value, start_time AS ts, id AS session_id
      FROM sessions WHERE title IS NOT NULL
      UNION ALL
      SELECT 'prompt', LEFT(text, 120), timestamp, session_id
      FROM user_messages WHERE text IS NOT NULL
      UNION ALL
      SELECT 'file', file_path, timestamp, session_id
      FROM file_interactions
    ) USING SAMPLE 2000 ROWS
  `);

  // Cached counts
  await db.run("DELETE FROM cached_counts");
  await db.run(`
    INSERT INTO cached_counts (key, value) VALUES
      ('sessions', (SELECT COUNT(*) FROM sessions)),
      ('files', (SELECT COUNT(DISTINCT file_path) FROM file_interactions)),
      ('shared', (SELECT COUNT(*) FROM (
        SELECT file_path FROM file_interactions
        GROUP BY file_path HAVING COUNT(DISTINCT session_id) > 1
      ))),
      ('messages', (SELECT COUNT(*) FROM user_messages))
  `);

  console.timeEnd("materialize");
}

async function indexSessionFile(filePath, sessionId, projectDir, isSubagent = false) {
  const session = {
    id: sessionId,
    projectDir,
    project: null,
    title: null,
    branch: null,
    cwd: null,
    startTime: null,
    endTime: null,
    messages: 0,
    toolCallCount: 0,
  };

  const messages = [];
  const fileInteractions = [];
  const toolCalls = [];

  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    const ts = entry.timestamp || null;

    // Time range
    if (ts) {
      if (!session.startTime || ts < session.startTime) session.startTime = ts;
      if (!session.endTime || ts > session.endTime) session.endTime = ts;
    }

    // Metadata
    if (entry.type === "user" && !session.cwd) {
      session.cwd = entry.cwd || null;
      session.branch = entry.gitBranch || null;
    }

    // Title
    if (entry.type === "ai-title") {
      const content = entry.message?.content;
      if (typeof content === "string") session.title = content;
      else if (Array.isArray(content)) {
        const tb = content.find(b => b.type === "text");
        if (tb) session.title = tb.text;
      }
    }

    // Messages
    if (entry.type === "user" || entry.type === "assistant") session.messages++;

    // User messages for search
    if (entry.type === "user") {
      const content = entry.message?.content;
      let text = "";
      if (typeof content === "string") text = content;
      else if (Array.isArray(content)) {
        text = content.filter(b => b.type === "text").map(b => b.text).join(" ");
      }
      // Strip system reminder tags
      text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
      if (text.length > 0 && text.length < 10000) {
        messages.push({ text, timestamp: ts });
      }
    }

    // Tool uses + file interactions
    if (entry.type === "assistant" && Array.isArray(entry.message?.content)) {
      for (const block of entry.message.content) {
        if (block.type !== "tool_use") continue;
        const toolName = block.name;
        const input = block.input || {};

        toolCalls.push({ tool: toolName, timestamp: ts });
        session.toolCallCount++;

        const extractor = FILE_TOOLS[toolName];
        if (!extractor) continue;
        for (const fp of extractor(input)) {
          if (!fp) continue;
          fileInteractions.push({
            filePath: fp,
            action: ACTION_TYPE[toolName] || "read",
            tool: toolName,
            timestamp: ts,
          });
        }
      }
    }
  }

  // Derive project display path from cwd
  session.project = session.cwd
    ? session.cwd.split("/").slice(-2).join("/")
    : projectDir;

  // Subagents: only index file interactions (attributed to parent session), skip session/messages/tool_calls
  if (isSubagent) {
    for (const fi of fileInteractions) {
      await db.run(
        "INSERT INTO file_interactions (session_id, file_path, action, tool, timestamp) VALUES (?, ?, ?, ?, ?)",
        session.id, fi.filePath, fi.action, fi.tool, fi.timestamp
      );
    }
    return;
  }

  // Insert session
  await db.run(`
    INSERT INTO sessions (id, project_dir, project, title, branch, cwd, start_time, end_time, messages, tool_calls)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, session.id, session.projectDir, session.project, session.title, session.branch,
     session.cwd, session.startTime, session.endTime, session.messages, session.toolCallCount);

  // Batch insert messages
  for (const m of messages) {
    await db.run(
      "INSERT INTO user_messages (session_id, text, timestamp) VALUES (?, ?, ?)",
      session.id, m.text, m.timestamp
    );
  }

  // Batch insert file interactions
  for (const fi of fileInteractions) {
    await db.run(
      "INSERT INTO file_interactions (session_id, file_path, action, tool, timestamp) VALUES (?, ?, ?, ?, ?)",
      session.id, fi.filePath, fi.action, fi.tool, fi.timestamp
    );
  }

  // Batch insert tool calls
  for (const tc of toolCalls) {
    await db.run(
      "INSERT INTO tool_calls (session_id, tool, timestamp) VALUES (?, ?, ?)",
      session.id, tc.tool, tc.timestamp
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
// QUERY API
// ═══════════════════════════════════════════════════════════════════

/**
 * Run an arbitrary SQL query.
 */
async function query(sql, ...params) {
  return debi(await db.all(sql, ...params));
}

/**
 * Build the graph structure matching the existing /api/graph format.
 */
async function getGraph({ project, minSessions, timeRange } = {}) {
  let sessionFilter = "1=1";
  const params = [];

  if (timeRange && timeRange !== "all") {
    const cutoffs = {
      "1h": "now() - INTERVAL 1 HOUR",
      "24h": "now() - INTERVAL 24 HOUR",
      "48h": "now() - INTERVAL 48 HOUR",
      "today": "now() - INTERVAL 24 HOUR",
      "week": "now() - INTERVAL 7 DAY",
      "month": "now() - INTERVAL 30 DAY",
    };
    if (cutoffs[timeRange]) {
      sessionFilter += ` AND COALESCE(s.end_time, s.start_time) >= ${cutoffs[timeRange]}`;
    }
  }

  if (project) {
    sessionFilter += " AND s.project_dir LIKE ?";
    params.push(`%${project}%`);
  }

  // Session nodes
  const sessions = await db.all(`
    SELECT s.id, s.project, s.branch, s.title, s.start_time, s.end_time,
           s.messages, s.tool_calls
    FROM sessions s
    WHERE ${sessionFilter}
    ORDER BY s.start_time
  `, ...params);

  if (sessions.length === 0) {
    return { nodes: [], edges: [], stats: { totalSessions: 0, totalFiles: 0, sharedFiles: 0, totalEdges: 0 } };
  }

  const sessionIds = sessions.map(s => s.id);
  const placeholders = sessionIds.map(() => "?").join(",");

  // Edges: one per (session, file) with read/write counts
  const edges = await db.all(`
    SELECT session_id, file_path,
           COUNT(*) FILTER (WHERE action = 'read') AS reads,
           COUNT(*) FILTER (WHERE action = 'write') AS writes
    FROM file_interactions
    WHERE session_id IN (${placeholders})
    GROUP BY session_id, file_path
  `, ...sessionIds);

  // File nodes: unique files + session counts
  const fileCounts = await db.all(`
    SELECT file_path, COUNT(DISTINCT session_id) AS session_count
    FROM file_interactions
    WHERE session_id IN (${placeholders})
    GROUP BY file_path
  `, ...sessionIds);

  // Apply minSessions filter
  const min = parseInt(minSessions) || 1;
  const fileMap = new Map();
  for (const fc of fileCounts) {
    if (fc.session_count >= min) {
      fileMap.set(fc.file_path, fc.session_count);
    }
  }

  // Build nodes
  const nodes = [];
  for (const s of sessions) {
    nodes.push({
      id: `session:${s.id}`,
      type: "session",
      label: s.title || s.id.slice(0, 8),
      project: s.project,
      branch: s.branch,
      startTime: s.start_time,
      endTime: s.end_time,
      messages: s.messages,
      toolCalls: s.tool_calls,
    });
  }

  for (const [fp, count] of fileMap) {
    nodes.push({
      id: `file:${fp}`,
      type: "file",
      label: path.basename(fp),
      fullPath: fp,
      dir: path.dirname(fp),
      sessionCount: count,
      shared: count > 1,
    });
  }

  // Build edges (filtered by minSessions)
  const filteredEdges = [];
  const activeSessionIds = new Set();
  for (const e of edges) {
    if (!fileMap.has(e.file_path)) continue;
    filteredEdges.push({
      source: `session:${e.session_id}`,
      target: `file:${e.file_path}`,
      reads: e.reads,
      writes: e.writes,
      sessionId: e.session_id,
    });
    activeSessionIds.add(e.session_id);
  }

  // Remove sessions with no edges after filtering
  const finalNodes = nodes.filter(n =>
    n.type === "file" || activeSessionIds.has(n.id.replace("session:", ""))
  );

  return {
    nodes: finalNodes,
    edges: filteredEdges,
    stats: {
      totalSessions: sessions.length,
      totalFiles: fileMap.size,
      sharedFiles: [...fileMap.values()].filter(c => c > 1).length,
      totalEdges: filteredEdges.length,
    },
  };
}

/**
 * Full-text search across messages and file paths.
 */
async function search(q, type = "all", limit = 10000) {
  const results = [];
  const query = `%${q}%`;

  if (type === "all" || type === "messages") {
    const msgs = await db.all(`
      SELECT m.text, m.timestamp, m.session_id,
             s.title AS session_title, s.project
      FROM user_messages m
      JOIN sessions s ON s.id = m.session_id
      WHERE m.text ILIKE ?
      ORDER BY m.timestamp DESC
      LIMIT ?
    `, query, limit);

    for (const m of msgs) {
      results.push({
        type: "message",
        sessionId: m.session_id,
        sessionTitle: m.session_title || m.session_id.slice(0, 8),
        project: m.project,
        text: m.text,
        timestamp: m.timestamp,
      });
    }
  }

  if (type === "all" || type === "files") {
    const files = await db.all(`
      SELECT DISTINCT ON (fi.session_id, fi.file_path)
             fi.file_path, fi.action, fi.timestamp, fi.session_id,
             s.title AS session_title, s.project
      FROM file_interactions fi
      JOIN sessions s ON s.id = fi.session_id
      WHERE fi.file_path ILIKE ?
      ORDER BY fi.session_id, fi.file_path, fi.timestamp DESC
      LIMIT ?
    `, query, limit);

    for (const f of files) {
      results.push({
        type: "file",
        sessionId: f.session_id,
        sessionTitle: f.session_title || f.session_id.slice(0, 8),
        project: f.project,
        file: f.file_path,
        action: f.action,
        timestamp: f.timestamp,
      });
    }
  }

  results.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
  return { results: results.slice(0, limit), total: results.length };
}

/**
 * Repeated command patterns.
 */
async function getPatterns(minCount = 2, limit = 10000) {
  const rows = await db.all(`
    SELECT text, COUNT(*) AS count, COUNT(DISTINCT session_id) AS session_count
    FROM (
      SELECT session_id, LOWER(TRIM(REGEXP_REPLACE(text, '\\s+', ' ', 'g'))) AS text
      FROM user_messages
      WHERE LENGTH(text) BETWEEN 5 AND 200
    )
    GROUP BY text
    HAVING COUNT(*) >= ? OR COUNT(DISTINCT session_id) >= ?
    ORDER BY count DESC
    LIMIT ?
  `, minCount, minCount, limit);

  return rows.map(r => ({ text: r.text, count: r.count, sessionCount: r.session_count }));
}

/**
 * Replay events for a time range.
 */
async function getReplayEvents(range = "today") {
  const cutoffs = {
    "1h": "now() - INTERVAL 1 HOUR",
    "today": "today()",
    "week": "now() - INTERVAL 7 DAY",
    "month": "now() - INTERVAL 30 DAY",
    "all": "'1970-01-01'::TIMESTAMP",
  };
  const cutoff = cutoffs[range] || cutoffs.today;

  const events = await db.all(`
    SELECT 'session-start' AS type, s.start_time AS timestamp, s.id AS session_id,
           s.title AS label, s.project, s.branch, NULL AS file, NULL AS action, NULL AS tool
    FROM sessions s
    WHERE s.start_time >= ${cutoff}

    UNION ALL

    SELECT 'file-touch' AS type, fi.timestamp, fi.session_id,
           NULL AS label, NULL AS project, NULL AS branch,
           fi.file_path AS file, fi.action, fi.tool
    FROM file_interactions fi
    JOIN sessions s ON s.id = fi.session_id
    WHERE s.start_time >= ${cutoff}

    ORDER BY timestamp
  `);

  return events;
}

/**
 * Get all projects.
 */
async function getProjects() {
  return db.all(`
    SELECT project_dir AS "encodedDir",
           COALESCE(MAX(cwd), project_dir) AS path,
           COUNT(*) AS "sessionCount"
    FROM sessions
    GROUP BY project_dir
    ORDER BY COUNT(*) DESC
  `);
}

/**
 * Get session detail.
 */
async function getSession(sessionId) {
  const session = await db.all("SELECT * FROM sessions WHERE id = ?", sessionId);
  if (session.length === 0) return null;

  const messages = await db.all(
    "SELECT text, timestamp FROM user_messages WHERE session_id = ? ORDER BY timestamp",
    sessionId
  );
  const files = await db.all(
    "SELECT file_path AS file, action, tool, timestamp FROM file_interactions WHERE session_id = ? ORDER BY timestamp",
    sessionId
  );
  const tools = await db.all(
    "SELECT tool, timestamp FROM tool_calls WHERE session_id = ? ORDER BY timestamp",
    sessionId
  );

  return {
    ...session[0],
    userMessages: messages,
    fileInteractions: files,
    toolCalls: tools,
  };
}

/**
 * Stats summary.
 */
async function getStats() {
  const [stats] = await db.all(`
    SELECT
      (SELECT COUNT(*) FROM sessions) AS total_sessions,
      (SELECT COUNT(DISTINCT file_path) FROM file_interactions) AS total_files,
      (SELECT COUNT(*) FROM user_messages) AS total_messages,
      (SELECT COUNT(*) FROM tool_calls) AS total_tool_calls,
      (SELECT COUNT(*) FROM file_interactions) AS total_file_interactions,
      (SELECT MIN(start_time) FROM sessions) AS earliest_session,
      (SELECT MAX(end_time) FROM sessions) AS latest_session
  `);
  return stats;
}

// ═══════════════════════════════════════════════════════════════════
// GIT QUERIES
// ═══════════════════════════════════════════════════════════════════

/**
 * List all repos with git history in the DB.
 */
async function getGitRepos() {
  return db.all(`
    SELECT repo_path, COUNT(*) AS commit_count,
           MIN(commit_date) AS first_commit, MAX(commit_date) AS last_commit
    FROM git_commits
    GROUP BY repo_path
    ORDER BY commit_count DESC
  `);
}

/**
 * Get all files with commit activity for a repo, optionally before a date.
 */
async function getGitTree(repoPath, beforeDate, limit = 500) {
  const before = beforeDate || new Date().toISOString();
  return db.all(`
    SELECT gfc.file_path,
           MAX(gc.commit_date) AS last_modified,
           SUM(gfc.additions) AS total_additions,
           SUM(gfc.deletions) AS total_deletions,
           COUNT(*) AS commit_count
    FROM git_file_changes gfc
    JOIN git_commits gc ON gc.hash = gfc.commit_hash AND gc.repo_path = gfc.repo_path
    WHERE gc.repo_path = ?
      AND gc.commit_date <= ?
    GROUP BY gfc.file_path
    ORDER BY commit_count DESC
    LIMIT ?
  `, repoPath, before, limit);
}

/**
 * Get file changes in a time window (for the heat/glow effect).
 */
async function getGitChanges(repoPath, startDate, endDate) {
  return db.all(`
    SELECT gfc.file_path, gc.commit_date, gfc.additions, gfc.deletions,
           gc.subject, gc.author, gc.hash
    FROM git_file_changes gfc
    JOIN git_commits gc ON gc.hash = gfc.commit_hash AND gc.repo_path = gfc.repo_path
    WHERE gc.repo_path = ?
      AND gc.commit_date BETWEEN ? AND ?
    ORDER BY gc.commit_date
  `, repoPath, startDate, endDate);
}

/**
 * Get Claude prompts + file edits near a timestamp.
 * Joins user_messages + file_interactions via sessions.cwd.
 */
async function getActivityNear(repoPath, centerDate, windowMinutes = 30) {
  const center = new Date(centerDate).getTime();
  const windowMs = windowMinutes * 60 * 1000;
  const start = new Date(center - windowMs).toISOString();
  const end = new Date(center + windowMs).toISOString();

  const prompts = await db.all(`
    SELECT um.text, um.timestamp, um.session_id
    FROM user_messages um
    JOIN sessions s ON s.id = um.session_id
    WHERE s.cwd LIKE ? || '%'
      AND um.timestamp BETWEEN ? AND ?
    ORDER BY um.timestamp
  `, repoPath, start, end);

  const edits = await db.all(`
    SELECT fi.file_path, fi.action, fi.tool, fi.timestamp, fi.session_id
    FROM file_interactions fi
    JOIN sessions s ON s.id = fi.session_id
    WHERE s.cwd LIKE ? || '%'
      AND fi.timestamp BETWEEN ? AND ?
      AND fi.action = 'write'
    ORDER BY fi.timestamp
  `, repoPath, start, end);

  return { prompts, edits };
}

/**
 * File co-occurrence graph — files as nodes, edges = co-edited in same session.
 * Edge weight = number of sessions where both files appeared.
 */
async function getFileGraph({ project, minCooccurrence, timeRange } = {}) {
  let sessionFilter = "1=1";
  const params = [];

  if (timeRange && timeRange !== "all") {
    const cutoffs = {
      "1h": "now() - INTERVAL 1 HOUR",
      "24h": "now() - INTERVAL 24 HOUR",
      "48h": "now() - INTERVAL 48 HOUR",
      "today": "now() - INTERVAL 24 HOUR",
      "week": "now() - INTERVAL 7 DAY",
      "month": "now() - INTERVAL 30 DAY",
    };
    if (cutoffs[timeRange]) {
      sessionFilter += ` AND COALESCE(s.end_time, s.start_time) >= ${cutoffs[timeRange]}`;
    }
  }

  if (project) {
    sessionFilter += " AND s.project_dir LIKE ?";
    params.push(`%${project}%`);
  }

  const minCo = parseInt(minCooccurrence) || 2;

  // Get all (session, file) pairs for matching sessions
  const pairs = await db.all(`
    SELECT DISTINCT fi.session_id, fi.file_path
    FROM file_interactions fi
    JOIN sessions s ON fi.session_id = s.id
    WHERE ${sessionFilter}
      AND fi.file_path NOT LIKE '/private/tmp/%'
      AND fi.file_path NOT LIKE '%/.claude/%'
      AND fi.file_path NOT LIKE '%.output'
  `, ...params);

  // Build session → files map
  const sessionFiles = new Map();
  const fileSessions = new Map(); // file → Set<session>
  for (const p of pairs) {
    if (!sessionFiles.has(p.session_id)) sessionFiles.set(p.session_id, []);
    sessionFiles.get(p.session_id).push(p.file_path);
    if (!fileSessions.has(p.file_path)) fileSessions.set(p.file_path, new Set());
    fileSessions.get(p.file_path).add(p.session_id);
  }

  // Build co-occurrence edges: for each session, every pair of files gets +1
  const edgeMap = new Map(); // "fileA|||fileB" → count
  for (const [, files] of sessionFiles) {
    if (files.length < 2 || files.length > 100) continue; // skip sessions with too many files (noise)
    // Sort for consistent key ordering
    const sorted = [...new Set(files)].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = sorted[i] + "|||" + sorted[j];
        edgeMap.set(key, (edgeMap.get(key) || 0) + 1);
      }
    }
  }

  // Filter edges by minimum co-occurrence
  const edges = [];
  const activeFiles = new Set();
  for (const [key, weight] of edgeMap) {
    if (weight < minCo) continue;
    const [a, b] = key.split("|||");
    edges.push({ source: a, target: b, weight });
    activeFiles.add(a);
    activeFiles.add(b);
  }

  // Build file nodes (only files that have edges)
  const nodes = [];
  for (const fp of activeFiles) {
    const sessionCount = fileSessions.get(fp)?.size || 0;
    nodes.push({
      id: fp,
      type: "file",
      label: path.basename(fp),
      fullPath: fp,
      dir: path.dirname(fp),
      sessionCount,
      shared: sessionCount > 1,
    });
  }

  // Sort edges by weight desc
  edges.sort((a, b) => b.weight - a.weight);

  return {
    nodes,
    edges,
    stats: {
      totalFiles: nodes.length,
      totalEdges: edges.length,
      maxWeight: edges.length > 0 ? edges[0].weight : 0,
      totalSessions: sessionFiles.size,
    },
  };
}

/**
 * Get the full story of a file — all sessions that touched it, with context.
 */
async function getFileStory(filePath) {
  // All interactions with this file, joined with session info
  const rows = await db.all(`
    SELECT fi.session_id, fi.action, fi.tool, fi.timestamp,
           s.title, s.project, s.start_time, s.end_time
    FROM file_interactions fi
    JOIN sessions s ON fi.session_id = s.id
    WHERE fi.file_path = ?
    ORDER BY fi.timestamp DESC
  `, filePath);

  // Group by session
  const sessionMap = new Map();
  for (const r of rows) {
    if (!sessionMap.has(r.session_id)) {
      sessionMap.set(r.session_id, {
        sessionId: r.session_id,
        title: r.title || r.session_id.slice(0, 8),
        project: r.project,
        startTime: r.start_time,
        endTime: r.end_time,
        touches: [],
      });
    }
    sessionMap.get(r.session_id).touches.push({
      action: r.action, tool: r.tool, timestamp: r.timestamp,
    });
  }

  // Get nearest user prompt per session for context
  const sessions = Array.from(sessionMap.values());
  for (const s of sessions) {
    const firstTouch = s.touches[s.touches.length - 1]; // oldest touch
    if (firstTouch && firstTouch.timestamp) {
      const prompts = await db.all(`
        SELECT text, timestamp FROM user_messages
        WHERE session_id = ?
        ORDER BY ABS(EPOCH(CAST(timestamp AS TIMESTAMP) - CAST(? AS TIMESTAMP)))
        LIMIT 1
      `, s.sessionId, firstTouch.timestamp);
      if (prompts.length > 0) {
        s.nearestPrompt = prompts[0].text.length > 150
          ? prompts[0].text.slice(0, 147) + "..."
          : prompts[0].text;
      }
    }
  }

  return {
    filePath,
    fileName: path.basename(filePath),
    sessionCount: sessions.length,
    totalTouches: rows.length,
    sessions,
  };
}

async function close() {
  if (db) await db.close();
  db = null;
}

// ═══════════════════════════════════════════════════════════════════
// CLI — run directly to sync & print stats
// ═══════════════════════════════════════════════════════════════════

if (require.main === module) {
  (async () => {
    console.time("init");
    await init();
    console.timeEnd("init");

    console.time("sync");
    const result = await sync((evt) => {
      if (evt.pct % 10 === 0) {
        process.stdout.write(`\r  ${evt.pct}% (${evt.done}/${evt.total}) — ${evt.scanned} scanned, ${evt.skipped} skipped`);
      }
    });
    console.log();
    console.timeEnd("sync");
    console.log("Result:", result);

    const stats = await getStats();
    console.log("Stats:", stats);

    await close();
  })();
}

/**
 * Get discoveries for the flythrough loader.
 * Pulls titles, prompts, files, and code snippets from DuckDB
 * so we don't need to re-scan JSONL files on every page load.
 */
async function getDiscoveries() {
  // Read from pre-computed cache — instant
  const rows = await db.all(`
    SELECT type, value, ts, session_id FROM cached_discoveries ORDER BY id
  `);
  return rows.map(r => ({
    type: r.type, value: r.value, ts: r.ts, sessionId: r.session_id
  }));
}

/**
 * Quick counts from pre-computed cache — instant.
 */
async function getQuickCounts() {
  const rows = await db.all(`SELECT key, value FROM cached_counts`);
  const m = {};
  for (const r of rows) m[r.key] = r.value || 0;
  return {
    nodes: (m.sessions || 0) + (m.files || 0),
    edges: m.files || 0,
    shared: m.shared || 0,
  };
}

/**
 * Heatmap data: activity counts grouped by date and file path.
 * Returns { rows: [{date, project, file_path, reads, writes, messages}], dateRange: {min,max} }
 */
async function getHeatmapData(project) {
  const projectFilter = project ? "AND s.project_dir LIKE ?" : "";
  const params = project ? [`%${project}%`] : [];

  // File interactions per day per file, with project from session
  const fileActivity = await db.all(`
    SELECT
      CAST(fi.timestamp AS DATE) AS date,
      s.project,
      fi.file_path,
      SUM(CASE WHEN fi.action = 'read' THEN 1 ELSE 0 END) AS reads,
      SUM(CASE WHEN fi.action = 'write' THEN 1 ELSE 0 END) AS writes
    FROM file_interactions fi
    JOIN sessions s ON fi.session_id = s.id
    WHERE fi.timestamp IS NOT NULL ${projectFilter}
    GROUP BY CAST(fi.timestamp AS DATE), s.project, fi.file_path
    ORDER BY date
  `, ...params);

  // Message counts per day per project
  const msgActivity = await db.all(`
    SELECT
      CAST(um.timestamp AS DATE) AS date,
      s.project,
      COUNT(*) AS messages
    FROM user_messages um
    JOIN sessions s ON um.session_id = s.id
    WHERE um.timestamp IS NOT NULL ${projectFilter}
    GROUP BY CAST(um.timestamp AS DATE), s.project
    ORDER BY date
  `, ...params);

  // Date range
  const range = await db.all(`
    SELECT MIN(s.start_time) AS min_date, MAX(s.end_time) AS max_date
    FROM sessions s WHERE 1=1 ${projectFilter}
  `, ...params);

  return {
    fileActivity,
    msgActivity,
    dateRange: { min: range[0]?.min_date, max: range[0]?.max_date },
  };
}

/**
 * Sequencer data — sessions with all events (messages + file interactions) for piano-roll view.
 */
async function getSequencerData({ project, timeRange, search } = {}) {
  const cutoffs = {
    "1h": "now() - INTERVAL 1 HOUR",
    "24h": "now() - INTERVAL 1 DAY",
    "48h": "now() - INTERVAL 2 DAY",
    "week": "now() - INTERVAL 7 DAY",
    "month": "now() - INTERVAL 30 DAY",
    "all": "'1970-01-01'::TIMESTAMP",
  };
  const cutoff = cutoffs[timeRange] || cutoffs["all"];

  let projectFilter = "";
  const params = [];
  if (project) {
    projectFilter = " AND s.project_dir LIKE ?";
    params.push(`%${project}%`);
  }

  // If searching, find matching session IDs first
  let searchFilter = "";
  if (search) {
    const searchSessions = await db.all(`
      SELECT DISTINCT session_id FROM (
        SELECT session_id FROM user_messages WHERE LOWER(text) LIKE LOWER(?)
        UNION
        SELECT session_id FROM file_interactions WHERE LOWER(file_path) LIKE LOWER(?)
      )
    `, `%${search}%`, `%${search}%`);
    const ids = searchSessions.map(r => `'${r.session_id}'`).join(",");
    if (ids.length === 0) return { sessions: [], timeRange: { min: null, max: null } };
    searchFilter = ` AND s.id IN (${ids})`;
  }

  // Get sessions
  const sessions = await db.all(`
    SELECT s.id, s.title, s.project, s.project_dir, s.start_time, s.end_time,
           s.messages, s.tool_calls
    FROM sessions s
    WHERE s.start_time >= ${cutoff} ${projectFilter} ${searchFilter}
    ORDER BY s.project, s.start_time
  `, ...params);

  if (sessions.length === 0) return { sessions: [], timeRange: { min: null, max: null } };

  const sessionIds = sessions.map(s => `'${s.id}'`).join(",");

  // Get all events for these sessions in one go
  const events = await db.all(`
    SELECT session_id, 'user' AS type, text, NULL AS file_path, NULL AS tool,
           timestamp, LENGTH(text) AS length
    FROM user_messages
    WHERE session_id IN (${sessionIds}) AND timestamp IS NOT NULL

    UNION ALL

    SELECT session_id, action AS type, NULL AS text, file_path, tool,
           timestamp, NULL AS length
    FROM file_interactions
    WHERE session_id IN (${sessionIds}) AND timestamp IS NOT NULL

    ORDER BY session_id, timestamp
  `);

  // Group events into sessions
  const eventMap = new Map();
  for (const e of events) {
    if (!eventMap.has(e.session_id)) eventMap.set(e.session_id, []);
    eventMap.get(e.session_id).push({
      type: e.type,
      text: e.text || null,
      file: e.file_path || null,
      tool: e.tool || null,
      ts: e.timestamp,
      length: e.length || 0,
    });
  }

  const result = sessions.map(s => {
    // Use first user message as title fallback
    let fallbackTitle = null;
    const evts = eventMap.get(s.id) || [];
    const firstMsg = evts.find(e => e.type === "user" && e.text);
    if (firstMsg) {
      fallbackTitle = firstMsg.text.replace(/<[^>]+>/g, "").trim().slice(0, 60);
      if (firstMsg.text.length > 60) fallbackTitle += "…";
    }
    return {
    id: s.id,
    title: s.title || fallbackTitle || "Session " + s.id.slice(0, 6),
    project: s.project,
    startTime: s.start_time,
    endTime: s.end_time,
    messages: s.messages,
    toolCalls: s.tool_calls,
    events: evts,
  };
  });

  // Time range
  const times = sessions.flatMap(s => [s.start_time, s.end_time].filter(Boolean)).map(t => new Date(t).getTime());
  const min = times.length ? new Date(Math.min(...times)).toISOString() : null;
  const max = times.length ? new Date(Math.max(...times)).toISOString() : null;

  return { sessions: result, timeRange: { min, max } };
}

module.exports = {
  init, sync, close, query,
  getGraph, search, getPatterns, getReplayEvents,
  getProjects, getSession, getStats,
  getGitRepos, getGitTree, getGitChanges, getActivityNear,
  getDiscoveries, getQuickCounts, getHeatmapData, getFileStory, getFileGraph,
  getSequencerData,
};
