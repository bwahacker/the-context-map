const fs = require("fs");
const path = require("path");
const readline = require("readline");

const CLAUDE_DIR = path.join(require("os").homedir(), ".claude");
const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");

// Tools that touch files and how to extract the path
const FILE_TOOLS = {
  Read: (input) => [input.file_path].filter(Boolean),
  Edit: (input) => [input.file_path].filter(Boolean),
  Write: (input) => [input.file_path].filter(Boolean),
  Glob: (input) => [input.path].filter(Boolean),
  Grep: (input) => [input.path].filter(Boolean),
  Bash: (input) => [], // we'll skip bash for now — too noisy
};

const ACTION_TYPE = {
  Read: "read",
  Edit: "write",
  Write: "write",
  Glob: "read",
  Grep: "read",
};

// Extract interesting code snippets from assistant text blocks
function extractSnippets(content) {
  const snippets = [];
  if (!Array.isArray(content)) return snippets;
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      // Grab lines that look like code — function defs, imports, class defs, assignments
      const lines = block.text.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (
          trimmed.length > 15 &&
          trimmed.length < 120 &&
          !trimmed.startsWith("*") &&
          !trimmed.startsWith("//") &&
          !trimmed.startsWith("#") &&
          !trimmed.startsWith("-") &&
          (
            /^(def |class |function |const |let |var |import |from |export |async |await |return |if |for |while |switch |interface |type |struct |fn |pub |impl |module |package )/.test(trimmed) ||
            /^[a-zA-Z_]\w*\s*[=(]/.test(trimmed) ||
            /\.(map|filter|reduce|forEach|find|then|catch|push|set|get)\(/.test(trimmed) ||
            /=>\s*[{(]/.test(trimmed) ||
            /\{\s*$/.test(trimmed)
          )
        ) {
          snippets.push(trimmed);
        }
      }
    }
    // Also grab tool input snippets — grep patterns, bash commands
    if (block.type === "tool_use") {
      const input = block.input || {};
      if (input.command && input.command.length > 10 && input.command.length < 100) {
        snippets.push("$ " + input.command);
      }
      if (input.pattern && input.pattern.length > 3) {
        snippets.push("/" + input.pattern + "/");
      }
    }
  }
  return snippets;
}

async function parseSessionFile(filePath, onDiscover) {
  const session = {
    id: path.basename(filePath, ".jsonl"),
    project: null,
    title: null,
    branch: null,
    cwd: null,
    startTime: null,
    endTime: null,
    version: null,
    messages: 0,
    toolCalls: [],
    fileInteractions: [], // {file, action, tool, timestamp}
    userMessages: [], // {text, timestamp} — for search
  };

  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const ts = entry.timestamp;

    // Track time range
    if (ts) {
      if (!session.startTime || ts < session.startTime) session.startTime = ts;
      if (!session.endTime || ts > session.endTime) session.endTime = ts;
    }

    // Metadata from first user message
    if (entry.type === "user" && !session.cwd) {
      session.cwd = entry.cwd || null;
      session.branch = entry.gitBranch || null;
      session.version = entry.version || null;
    }

    // Session title
    if (entry.type === "ai-title") {
      const content = entry.message?.content;
      if (typeof content === "string") session.title = content;
      else if (Array.isArray(content)) {
        const textBlock = content.find((b) => b.type === "text");
        if (textBlock) session.title = textBlock.text;
      }
    }

    // Count messages and capture user text for search
    if (entry.type === "user" || entry.type === "assistant") {
      session.messages++;
    }
    if (entry.type === "user") {
      const content = entry.message?.content;
      let text = "";
      if (typeof content === "string") text = content;
      else if (Array.isArray(content)) {
        text = content.filter(b => b.type === "text").map(b => b.text).join(" ");
      }
      if (text.trim()) {
        session.userMessages.push({ text: text.trim(), timestamp: ts });
      }
    }

    // Extract tool uses
    if (entry.type === "assistant" && entry.message?.content) {
      const content = entry.message.content;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (block.type !== "tool_use") continue;

        const toolName = block.name;
        const input = block.input || {};

        session.toolCalls.push({
          tool: toolName,
          timestamp: ts,
        });

        // Extract file paths from known file tools
        const extractor = FILE_TOOLS[toolName];
        if (!extractor) continue;

        const paths = extractor(input);
        for (const fp of paths) {
          if (!fp) continue;
          session.fileInteractions.push({
            file: fp,
            action: ACTION_TYPE[toolName] || "read",
            tool: toolName,
            timestamp: ts,
          });
          if (onDiscover) onDiscover({ type: "file", value: fp, tool: toolName });
        }
      }

      // Extract code written via Edit/Write tools
      if (onDiscover) {
        for (const block of content) {
          if (block.type !== "tool_use") continue;
          const inp = block.input || {};

          // Code being written — Edit new_string or Write content
          const codeText = inp.new_string || inp.content;
          if ((block.name === "Edit" || block.name === "Write") && codeText) {
            const codeLines = codeText.split("\n");
            for (const cl of codeLines) {
              const t = cl.trim();
              if (t.length > 12 && t.length < 120 && !/^\s*$/.test(t) && !/^[/*#\-=]+$/.test(t)) {
                onDiscover({ type: "code", value: t });
              }
            }
          }
        }

        // Also extract from assistant text (existing snippet logic)
        const snippets = extractSnippets(content);
        for (const s of snippets.slice(0, 3)) {
          onDiscover({ type: "snippet", value: s });
        }
      }
    }

    // Extract user prompts
    if (entry.type === "user" && onDiscover) {
      const ucontent = entry.message?.content;
      let utext = "";
      if (typeof ucontent === "string") utext = ucontent;
      else if (Array.isArray(ucontent)) {
        utext = ucontent.filter(b => b.type === "text").map(b => b.text).join(" ");
      }
      // Strip system/IDE tags and their content
      utext = utext.replace(/<[^>]*>[^<]*<\/[^>]*>/g, "").replace(/<[^>]+>/g, "").trim();
      // Skip if it looks like a system message
      if (utext.length > 10 && utext.length < 300 &&
          !utext.startsWith("The user opened") &&
          !utext.startsWith("Note:") &&
          !/^(system|reminder|context)/i.test(utext)) {
        // Send the whole prompt if short, or first meaningful sentence
        const display = utext.length > 80 ? utext.slice(0, 77) + "..." : utext;
        onDiscover({ type: "prompt", value: display });
      }
    }
  }

  return session;
}

function decodeProjectPath(encoded) {
  // The encoding replaces / with - but directory names can also contain -
  // So we use the cwd from the first user message in any session instead
  // For now, just return the encoded name as-is for display
  return encoded;
}

async function scanAllSessions(onProgress) {
  const projects = [];

  if (!fs.existsSync(PROJECTS_DIR)) {
    console.error("No projects directory found at", PROJECTS_DIR);
    return { projects, sessions: [], graph: { nodes: [], edges: [] } };
  }

  const projectDirs = fs
    .readdirSync(PROJECTS_DIR)
    .filter((d) =>
      fs.statSync(path.join(PROJECTS_DIR, d)).isDirectory()
    );

  // Count total jsonl files for progress
  let totalFiles = 0;
  let doneFiles = 0;
  for (const pd of projectDirs) {
    totalFiles += fs
      .readdirSync(path.join(PROJECTS_DIR, pd))
      .filter((f) => f.endsWith(".jsonl")).length;
  }

  const allSessions = [];

  for (const projDir of projectDirs) {
    const projPath = path.join(PROJECTS_DIR, projDir);
    const decodedPath = decodeProjectPath(projDir);
    const jsonlFiles = fs
      .readdirSync(projPath)
      .filter((f) => f.endsWith(".jsonl"));

    const projSessions = [];

    for (const jsonlFile of jsonlFiles) {
      const fullPath = path.join(projPath, jsonlFile);
      try {
        const session = await parseSessionFile(fullPath, onProgress);
        session.project = projDir;
        projSessions.push(session);
      } catch (err) {
        console.error(`Error parsing ${fullPath}:`, err.message);
      }
      doneFiles++;
      if (onProgress) {
        onProgress({
          type: "progress",
          done: doneFiles,
          total: totalFiles,
          pct: Math.round((doneFiles / totalFiles) * 100),
        });
      }
    }

    // Use cwd from first session that has one for display
    const displayPath =
      projSessions.find((s) => s.cwd)?.cwd || projDir;

    projects.push({
      path: displayPath,
      encodedDir: projDir,
      sessionCount: projSessions.length,
    });

    allSessions.push(...projSessions);
  }

  // Sort sessions by start time
  allSessions.sort(
    (a, b) => new Date(a.startTime || 0) - new Date(b.startTime || 0)
  );

  // Build graph
  const graph = buildGraph(allSessions);

  return { projects, sessions: allSessions, graph };
}

function buildGraph(sessions) {
  const nodes = new Map(); // id -> node
  const edges = []; // {source, target, action, tool, sessionId, timestamp}

  for (const session of sessions) {
    // Session node
    const sessionNodeId = `session:${session.id}`;
    nodes.set(sessionNodeId, {
      id: sessionNodeId,
      type: "session",
      label: session.title || session.id.slice(0, 8),
      project: session.project,
      branch: session.branch,
      startTime: session.startTime,
      endTime: session.endTime,
      messages: session.messages,
      toolCalls: session.toolCalls.length,
    });

    // File nodes and edges
    const seenFiles = new Map(); // file -> {reads, writes}
    for (const interaction of session.fileInteractions) {
      const fileNodeId = `file:${interaction.file}`;

      if (!nodes.has(fileNodeId)) {
        nodes.set(fileNodeId, {
          id: fileNodeId,
          type: "file",
          label: path.basename(interaction.file),
          fullPath: interaction.file,
          dir: path.dirname(interaction.file),
        });
      }

      const key = interaction.file;
      if (!seenFiles.has(key)) {
        seenFiles.set(key, { reads: 0, writes: 0 });
      }
      const counts = seenFiles.get(key);
      if (interaction.action === "read") counts.reads++;
      else counts.writes++;
    }

    // Create one edge per file per session with counts
    for (const [filePath, counts] of seenFiles) {
      edges.push({
        source: sessionNodeId,
        target: `file:${filePath}`,
        reads: counts.reads,
        writes: counts.writes,
        sessionId: session.id,
      });
    }
  }

  // Find files touched by multiple sessions (shared context)
  const fileToSessions = new Map();
  for (const edge of edges) {
    if (!fileToSessions.has(edge.target)) {
      fileToSessions.set(edge.target, new Set());
    }
    fileToSessions.get(edge.target).add(edge.source);
  }

  // Mark shared files
  for (const [fileId, sessionIds] of fileToSessions) {
    const node = nodes.get(fileId);
    if (node) {
      node.sessionCount = sessionIds.size;
      node.shared = sessionIds.size > 1;
    }
  }

  return {
    nodes: Array.from(nodes.values()),
    edges,
    stats: {
      totalSessions: sessions.length,
      totalFiles: Array.from(nodes.values()).filter((n) => n.type === "file")
        .length,
      sharedFiles: Array.from(nodes.values()).filter(
        (n) => n.type === "file" && n.shared
      ).length,
      totalEdges: edges.length,
    },
  };
}

module.exports = { scanAllSessions, parseSessionFile };
