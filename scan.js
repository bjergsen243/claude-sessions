#!/usr/bin/env node
// Scans ~/.claude/projects/ for session data and outputs sessions.json
// Usage: node scan.js > sessions.json

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

async function parseSession(filePath, project) {
  return new Promise((resolve) => {
    const session = {
      id: path.basename(filePath, '.jsonl'),
      project,
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

        // Count user + assistant messages
        if (data.type === 'user' || data.type === 'assistant') {
          session.messageCount++;
        }

        // Extract first user message as session summary
        if (data.type === 'user' && !session.firstMessage) {
          const content = data.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && block.text) {
                // Strip system-reminder tags and trim
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
      // Skip empty sessions
      if (session.messageCount > 0 && session.started) {
        resolve(session);
      } else {
        resolve(null);
      }
    });

    rl.on('error', () => resolve(null));
  });
}

async function main() {
  if (!fs.existsSync(PROJECTS_DIR)) {
    console.error('No projects directory found at', PROJECTS_DIR);
    process.exit(1);
  }

  const projects = fs.readdirSync(PROJECTS_DIR).filter(d =>
    fs.statSync(path.join(PROJECTS_DIR, d)).isDirectory()
  );

  const allSessions = [];

  for (const project of projects) {
    const projectDir = path.join(PROJECTS_DIR, project);
    const jsonlFiles = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));

    const promises = jsonlFiles.map(f =>
      parseSession(path.join(projectDir, f), project)
    );

    const results = await Promise.all(promises);
    for (const s of results) {
      if (s) allSessions.push(s);
    }
  }

  // Sort by most recent first
  allSessions.sort((a, b) => new Date(b.started) - new Date(a.started));

  console.log(JSON.stringify(allSessions, null, 2));
}

main().catch(console.error);
