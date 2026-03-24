#!/usr/bin/env node
// Local server for Claude Sessions dashboard
// - Auto-scans ~/.claude/projects/ on each request (fast, no manual step)
// - DELETE /api/session/:project/:id removes session files
// Usage: node server.js [port]

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const PORT = parseInt(process.argv[2] || '3456', 10);
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

// ── Session scanner ─────────────────────────────────────────────────────────

// Resolve encoded project name (e.g. -Users-soren-code-finan-fo-ledger)
// back to real filesystem path (/Users/soren/code/finan/fo-ledger).
// Can't just replace all dashes — folder names contain dashes too.
// Strategy: greedily build the path by checking which directories exist.
function resolveProjectPath(encoded) {
  // Remove leading dash, split into segments
  const parts = encoded.replace(/^-/, '').split('-');
  let resolved = '/';

  let i = 0;
  while (i < parts.length) {
    // Try progressively longer dash-joined segments to find an existing dir
    let matched = false;
    for (let end = parts.length; end > i; end--) {
      const candidate = parts.slice(i, end).join('-');
      const full = path.join(resolved, candidate);
      try {
        if (fs.statSync(full).isDirectory()) {
          resolved = full;
          i = end;
          matched = true;
          break;
        }
      } catch {}
    }
    if (!matched) {
      // Fallback: just use this segment
      resolved = path.join(resolved, parts[i]);
      i++;
    }
  }
  return resolved;
}

function parseSession(filePath, project) {
  return new Promise((resolve) => {
    const session = {
      id: path.basename(filePath, '.jsonl'),
      project,
      dir: resolveProjectPath(project),
      started: null,
      ended: null,
      messageCount: 0,
      firstMessage: null,
      durationMinutes: 0,
    };

    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      try {
        const data = JSON.parse(line);
        const ts = data.timestamp;
        if (ts) {
          if (!session.started || ts < session.started) session.started = ts;
          if (!session.ended || ts > session.ended) session.ended = ts;
        }
        if (data.type === 'user' || data.type === 'assistant') {
          session.messageCount++;
        }
        if (data.type === 'user' && !session.firstMessage) {
          const content = data.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && block.text) {
                let text = block.text
                  .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
                  .replace(/<local-command-[\s\S]*?$/g, '')
                  .trim();
                if (text.length > 0) {
                  session.firstMessage = text.slice(0, 120);
                  break;
                }
              }
            }
          } else if (typeof content === 'string') {
            session.firstMessage = content.slice(0, 120);
          }
        }
      } catch {}
    });

    rl.on('close', () => {
      if (session.started && session.ended) {
        session.durationMinutes = Math.round(
          (new Date(session.ended) - new Date(session.started)) / 60000
        );
      }
      resolve(session.messageCount > 0 && session.started ? session : null);
    });

    rl.on('error', () => resolve(null));
  });
}

async function scanSessions() {
  if (!fs.existsSync(PROJECTS_DIR)) return [];

  const projects = fs.readdirSync(PROJECTS_DIR).filter(d =>
    fs.statSync(path.join(PROJECTS_DIR, d)).isDirectory()
  );

  const allSessions = [];

  for (const project of projects) {
    const projectDir = path.join(PROJECTS_DIR, project);
    const jsonlFiles = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
    const results = await Promise.all(
      jsonlFiles.map(f => parseSession(path.join(projectDir, f), project))
    );
    for (const s of results) {
      if (s) allSessions.push(s);
    }
  }

  allSessions.sort((a, b) => new Date(b.started) - new Date(a.started));
  return allSessions;
}

// ── Session deletion ────────────────────────────────────────────────────────

function deleteSession(project, sessionId) {
  // Validate: project and sessionId must not contain path traversal
  if (project.includes('..') || sessionId.includes('..')) return false;
  if (project.includes('/') || sessionId.includes('/')) return false;

  const projectDir = path.join(PROJECTS_DIR, project);
  if (!fs.existsSync(projectDir)) return false;

  let deleted = false;

  // Remove .jsonl file
  const jsonlFile = path.join(projectDir, `${sessionId}.jsonl`);
  if (fs.existsSync(jsonlFile)) {
    fs.unlinkSync(jsonlFile);
    deleted = true;
  }

  // Remove companion directory (if exists)
  const sessionDir = path.join(projectDir, sessionId);
  if (fs.existsSync(sessionDir) && fs.statSync(sessionDir).isDirectory()) {
    fs.rmSync(sessionDir, { recursive: true });
    deleted = true;
  }

  return deleted;
}

// ── HTTP server ─────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // GET /api/sessions — scan and return all sessions
  if (req.method === 'GET' && req.url === '/api/sessions') {
    try {
      const sessions = await scanSessions();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sessions));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /api/session/:project/:id — read full conversation
  const getMatch = req.url.match(/^\/api\/session\/([^/]+)\/([^/]+)$/);
  if (req.method === 'GET' && getMatch) {
    const [, project, sessionId] = getMatch.map(decodeURIComponent);
    if (project.includes('..') || sessionId.includes('..') ||
        project.includes('/') || sessionId.includes('/')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid path' }));
      return;
    }
    const filePath = path.join(PROJECTS_DIR, project, `${sessionId}.jsonl`);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const messages = [];
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      try {
        const data = JSON.parse(line);
        if (data.type !== 'user' && data.type !== 'assistant') return;

        const content = data.message?.content;
        let text = '';
        let toolCalls = [];

        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              // Strip all XML-like tags (system, internal, claude metadata)
              // Loop to handle nested tags — inner tags get stripped first,
              // then outer tags become matchable on next pass
              let t = block.text;
              let prev;
              do {
                prev = t;
                t = t.replace(/<[a-z_:-]+(?:\s[^>]*)?>[\s\S]*?<\/[a-z_:-]+>/g, '');
              } while (t !== prev);
              // Clean up any remaining orphan tags
              t = t.replace(/<\/?[a-z_:-]+(?:\s[^>]*)?>/g, '')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
              if (t) text += (text ? '\n' : '') + t;
            } else if (block.type === 'tool_use') {
              toolCalls.push({ name: block.name, id: block.id });
            } else if (block.type === 'tool_result') {
              // skip tool results in the view
            }
          }
        } else if (typeof content === 'string') {
          let t = content;
          let prev;
          do {
            prev = t;
            t = t.replace(/<[a-z_:-]+(?:\s[^>]*)?>[\s\S]*?<\/[a-z_:-]+>/g, '');
          } while (t !== prev);
          text = t.replace(/<\/?[a-z_:-]+(?:\s[^>]*)?>/g, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        }

        // Skip messages with no visible content
        if (!text) return;

        messages.push({
          role: data.type,
          text,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          timestamp: data.timestamp || null,
        });
      } catch {}
    });

    rl.on('close', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(messages));
    });

    rl.on('error', () => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Read error' }));
    });
    return;
  }

  // DELETE /api/session/:project/:id — delete a session
  const deleteMatch = req.url.match(/^\/api\/session\/([^/]+)\/([^/]+)$/);
  if (req.method === 'DELETE' && deleteMatch) {
    const [, project, sessionId] = deleteMatch;
    const ok = deleteSession(decodeURIComponent(project), decodeURIComponent(sessionId));
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: ok }));
    return;
  }

  // Serve static files
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, filePath);

  const ext = path.extname(filePath);
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
  };

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`\x1b[1;36m󰊠 Claude Sessions\x1b[0m running at \x1b[1mhttp://localhost:${PORT}\x1b[0m`);
  console.log(`  Scanning: ${PROJECTS_DIR}`);
  console.log(`  Press Ctrl+C to stop\n`);
});
