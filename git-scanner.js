/**
 * git-scanner.js — Discovers git repos from Claude session data,
 * runs `git log`, parses output, and loads into DuckDB.
 *
 * Usage:
 *   const gitScanner = require("./git-scanner");
 *   await gitScanner.syncGitHistory(store);
 *
 * Or standalone:
 *   node git-scanner.js
 */

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

/**
 * Discover unique git repo roots from session cwds in DuckDB.
 * For each cwd, walk up to find .git directory.
 */
async function discoverRepos(store) {
  const rows = await store.query(
    "SELECT DISTINCT cwd FROM sessions WHERE cwd IS NOT NULL AND cwd != ''"
  );

  const repoRoots = new Set();
  for (const { cwd } of rows) {
    const root = findGitRoot(cwd);
    if (root) repoRoots.add(root);
  }

  return Array.from(repoRoots);
}

function findGitRoot(dir) {
  let current = dir;
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Run git log on a single repo and return parsed commits + file changes.
 */
async function scanRepo(repoPath) {
  const output = await new Promise((resolve, reject) => {
    execFile(
      "git",
      ["log", "--all", "--format=COMMIT:%H|%aI|%an|%s", "--numstat", "--no-merges"],
      { cwd: repoPath, maxBuffer: 50 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve(stdout);
      }
    );
  });

  const commits = [];
  const changes = [];
  let current = null;

  for (const line of output.split("\n")) {
    if (line.startsWith("COMMIT:")) {
      const parts = line.slice(7).split("|");
      current = {
        hash: parts[0],
        date: parts[1],
        author: parts[2],
        subject: parts.slice(3).join("|"), // subject may contain |
      };
      commits.push(current);
    } else if (current && /^\d+\t\d+\t/.test(line)) {
      const [additions, deletions, ...fileParts] = line.split("\t");
      const filePath = fileParts.join("\t"); // handle tabs in filenames
      changes.push({
        commitHash: current.hash,
        filePath,
        additions: parseInt(additions) || 0,
        deletions: parseInt(deletions) || 0,
      });
    }
    // Skip binary files (lines with "-\t-\t") and empty lines
  }

  return { commits, changes };
}

/**
 * Run git log incrementally (only new commits since last indexed date).
 */
async function scanRepoIncremental(repoPath, afterDate) {
  const args = ["log", "--all", "--format=COMMIT:%H|%aI|%an|%s", "--numstat", "--no-merges"];
  if (afterDate) {
    args.push(`--after=${afterDate}`);
  }

  const output = await new Promise((resolve, reject) => {
    execFile(
      "git", args,
      { cwd: repoPath, maxBuffer: 50 * 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      }
    );
  });

  const commits = [];
  const changes = [];
  let current = null;

  for (const line of output.split("\n")) {
    if (line.startsWith("COMMIT:")) {
      const parts = line.slice(7).split("|");
      current = {
        hash: parts[0],
        date: parts[1],
        author: parts[2],
        subject: parts.slice(3).join("|"),
      };
      commits.push(current);
    } else if (current && /^\d+\t\d+\t/.test(line)) {
      const [additions, deletions, ...fileParts] = line.split("\t");
      changes.push({
        commitHash: current.hash,
        filePath: fileParts.join("\t"),
        additions: parseInt(additions) || 0,
        deletions: parseInt(deletions) || 0,
      });
    }
  }

  return { commits, changes };
}

/**
 * Full sync: discover repos, scan each, insert into DuckDB.
 */
async function syncGitHistory(store, onProgress) {
  const repos = await discoverRepos(store);
  let totalCommits = 0;

  for (let i = 0; i < repos.length; i++) {
    const repoPath = repos[i];

    // Check what we already have
    const existing = await store.query(
      "SELECT MAX(commit_date) AS last_date FROM git_commits WHERE repo_path = ?",
      repoPath
    );
    const lastDate = existing[0]?.last_date || null;

    let data;
    try {
      data = lastDate
        ? await scanRepoIncremental(repoPath, lastDate)
        : await scanRepo(repoPath);
    } catch (err) {
      console.error(`git-scanner: error scanning ${repoPath}:`, err.message);
      continue;
    }

    if (data.commits.length === 0) {
      if (onProgress) onProgress({ repo: repoPath, pct: Math.round(((i + 1) / repos.length) * 100), commits: 0 });
      continue;
    }

    // Batch insert commits
    for (const c of data.commits) {
      try {
        await store.query(
          `INSERT OR IGNORE INTO git_commits (hash, repo_path, commit_date, author, subject)
           VALUES (?, ?, ?, ?, ?)`,
          c.hash, repoPath, c.date, c.author, c.subject
        );
      } catch { /* duplicate, skip */ }
    }

    // Batch insert file changes
    for (const fc of data.changes) {
      await store.query(
        `INSERT INTO git_file_changes (commit_hash, repo_path, file_path, additions, deletions)
         VALUES (?, ?, ?, ?, ?)`,
        fc.commitHash, repoPath, fc.filePath, fc.additions, fc.deletions
      );
    }

    totalCommits += data.commits.length;

    if (onProgress) {
      onProgress({
        repo: repoPath,
        pct: Math.round(((i + 1) / repos.length) * 100),
        commits: data.commits.length,
      });
    }
  }

  return { reposScanned: repos.length, commitsInserted: totalCommits };
}

module.exports = { discoverRepos, scanRepo, syncGitHistory };

// ── CLI ──
if (require.main === module) {
  (async () => {
    const store = require("./db");
    await store.init();
    await store.sync(); // ensure sessions are indexed first

    console.time("git-sync");
    const result = await syncGitHistory(store, (evt) => {
      console.log(`  ${evt.pct}% — ${evt.repo} (${evt.commits} new commits)`);
    });
    console.timeEnd("git-sync");
    console.log("Result:", result);

    const repos = await store.getGitRepos();
    console.log("Repos:", repos);

    await store.close();
  })();
}
