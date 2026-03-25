#!/usr/bin/env node
// Claude Sessions Dashboard — Local server
// Auto-scans Claude Code session data and serves the dashboard UI.
//
// Config via environment variables or .env file:
//   PORT              — server port (default: 3456)
//   CLAUDE_CONFIG_DIR — path to .claude directory (default: ~/.claude)
//   READONLY          — disable delete (default: false)

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

// ── Load .env file if present ───────────────────────────────────────────────

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (val && !process.env[key]) process.env[key] = val;
  }
}

// ── Config ──────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3456', 10);
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const READONLY = process.env.READONLY === 'true';
const METADATA_PATH = path.join(__dirname, 'metadata.json');

// ── Metadata (custom names) ─────────────────────────────────────────────────

let metadata = {};

function loadMetadata() {
  try {
    if (fs.existsSync(METADATA_PATH)) {
      metadata = JSON.parse(fs.readFileSync(METADATA_PATH, 'utf8'));
    }
  } catch {
    metadata = {};
  }
}

function saveMetadata() {
  fs.writeFileSync(METADATA_PATH, JSON.stringify(metadata, null, 2));
}

loadMetadata();

// ── Tag stripping ───────────────────────────────────────────────────────────

function stripTags(text) {
  let t = text;
  let prev;
  do {
    prev = t;
    t = t.replace(/<[a-z_:-]+(?:\s[^>]*)?>[\s\S]*?<\/[a-z_:-]+>/g, '');
  } while (t !== prev);
  return t.replace(/<\/?[a-z_:-]+(?:\s[^>]*)?>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Path resolution ─────────────────────────────────────────────────────────

// Claude Code encodes project paths by replacing / with -
// e.g. /Users/soren/code/finan/fo-ledger -> -Users-soren-code-finan-fo-ledger
// We can't just replace all dashes because folder names contain dashes too.
// Strategy: greedily match against existing directories on disk.
function resolveProjectPath(encoded) {
  const parts = encoded.replace(/^-/, '').split('-');
  let resolved = '/';

  let i = 0;
  while (i < parts.length) {
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
      resolved = path.join(resolved, parts[i]);
      i++;
    }
  }
  return resolved;
}

// ── Session scanner ─────────────────────────────────────────────────────────

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
          let text = '';
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && block.text) {
                text = stripTags(block.text);
                if (text) break;
              }
            }
          } else if (typeof content === 'string') {
            text = stripTags(content);
          }
          if (text) session.firstMessage = text.slice(0, 120);
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
      if (s) {
        const key = `${s.project}/${s.id}`;
        if (metadata[key]?.name) s.customName = metadata[key].name;
        allSessions.push(s);
      }
    }
  }

  allSessions.sort((a, b) => new Date(b.started) - new Date(a.started));
  return allSessions;
}

// ── Read conversation ───────────────────────────────────────────────────────

function readConversation(project, sessionId) {
  return new Promise((resolve, reject) => {
    if (project.includes('..') || sessionId.includes('..') ||
        project.includes('/') || sessionId.includes('/')) {
      return reject(new Error('Invalid path'));
    }

    const filePath = path.join(PROJECTS_DIR, project, `${sessionId}.jsonl`);
    if (!fs.existsSync(filePath)) return reject(new Error('Not found'));

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
              const t = stripTags(block.text);
              if (t) text += (text ? '\n' : '') + t;
            } else if (block.type === 'tool_use') {
              toolCalls.push({ name: block.name, id: block.id });
            }
          }
        } else if (typeof content === 'string') {
          text = stripTags(content);
        }

        if (!text) return;

        messages.push({
          role: data.type,
          text,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          timestamp: data.timestamp || null,
        });
      } catch {}
    });

    rl.on('close', () => resolve(messages));
    rl.on('error', reject);
  });
}

// ── Session deletion ────────────────────────────────────────────────────────

function deleteSession(project, sessionId) {
  if (READONLY) return false;
  if (project.includes('..') || sessionId.includes('..')) return false;
  if (project.includes('/') || sessionId.includes('/')) return false;

  const projectDir = path.join(PROJECTS_DIR, project);
  if (!fs.existsSync(projectDir)) return false;

  let deleted = false;

  const jsonlFile = path.join(projectDir, `${sessionId}.jsonl`);
  if (fs.existsSync(jsonlFile)) {
    fs.unlinkSync(jsonlFile);
    deleted = true;
  }

  const sessionDir = path.join(projectDir, sessionId);
  if (fs.existsSync(sessionDir) && fs.statSync(sessionDir).isDirectory()) {
    fs.rmSync(sessionDir, { recursive: true });
    deleted = true;
  }

  if (deleted) {
    const key = `${project}/${sessionId}`;
    if (metadata[key]) {
      delete metadata[key];
      saveMetadata();
    }
  }

  return deleted;
}

// ── Read request body ────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// ── HTTP server ─────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const json = (code, data) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  // GET /api/sessions
  if (req.method === 'GET' && req.url === '/api/sessions') {
    try {
      json(200, await scanSessions());
    } catch (err) {
      json(500, { error: err.message });
    }
    return;
  }

  // GET /api/session/:project/:id
  const getMatch = req.url.match(/^\/api\/session\/([^/]+)\/([^/]+)$/);
  if (req.method === 'GET' && getMatch) {
    try {
      const messages = await readConversation(
        decodeURIComponent(getMatch[1]),
        decodeURIComponent(getMatch[2])
      );
      json(200, messages);
    } catch (err) {
      json(err.message === 'Not found' ? 404 : 400, { error: err.message });
    }
    return;
  }

  // DELETE /api/session/:project/:id
  const deleteMatch = req.url.match(/^\/api\/session\/([^/]+)\/([^/]+)$/);
  if (req.method === 'DELETE' && deleteMatch) {
    if (READONLY) {
      json(403, { error: 'Server is in read-only mode' });
      return;
    }
    const ok = deleteSession(
      decodeURIComponent(deleteMatch[1]),
      decodeURIComponent(deleteMatch[2])
    );
    json(ok ? 200 : 404, { deleted: ok });
    return;
  }

  // PUT /api/session/:project/:id/name — rename a session
  const nameMatch = req.url.match(/^\/api\/session\/([^/]+)\/([^/]+)\/name$/);
  if (req.method === 'PUT' && nameMatch) {
    if (READONLY) {
      json(403, { error: 'Server is in read-only mode' });
      return;
    }
    try {
      const body = await readBody(req);
      const project = decodeURIComponent(nameMatch[1]);
      const id = decodeURIComponent(nameMatch[2]);
      const name = (body.name || '').trim();
      if (!name) {
        json(400, { error: 'Name is required' });
        return;
      }
      const key = `${project}/${id}`;
      metadata[key] = { ...metadata[key], name };
      saveMetadata();
      json(200, { name });
    } catch (err) {
      json(400, { error: err.message });
    }
    return;
  }

  // DELETE /api/session/:project/:id/name — clear custom name
  if (req.method === 'DELETE' && nameMatch) {
    if (READONLY) {
      json(403, { error: 'Server is in read-only mode' });
      return;
    }
    const project = decodeURIComponent(nameMatch[1]);
    const id = decodeURIComponent(nameMatch[2]);
    const key = `${project}/${id}`;
    if (metadata[key]) {
      delete metadata[key].name;
      if (Object.keys(metadata[key]).length === 0) delete metadata[key];
      saveMetadata();
    }
    json(200, { cleared: true });
    return;
  }

  // Serve static files
  let filePath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  filePath = path.join(__dirname, filePath);

  const ext = path.extname(filePath);
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
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
  console.log(`\n  Claude Sessions running at http://localhost:${PORT}`);
  console.log(`  Scanning: ${PROJECTS_DIR}`);
  if (READONLY) console.log('  Mode: read-only (delete disabled)');
  console.log(`  Press Ctrl+C to stop\n`);
});
