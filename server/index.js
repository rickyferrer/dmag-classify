'use strict';

const express  = require('express');
const { spawn } = require('child_process');
const multer   = require('multer');
const fs       = require('fs');
const path     = require('path');
const { parse }    = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const cors     = require('cors');

const app  = express();
const PORT = process.env.PORT || 3001;
const ROOT = path.join(__dirname, '..');
const DATA_FILE  = path.join(ROOT, 'dmag_march_classified.json');
const UPLOADS    = path.join(ROOT, 'uploads');

fs.mkdirSync(UPLOADS, { recursive: true });

app.use(cors({ origin: ['http://localhost:5173', 'http://localhost:3001'] }));
app.use(express.json());
app.use(express.static(path.join(ROOT, 'client', 'dist')));

// ─── Pipeline state ───────────────────────────────────────────────────────────
let pipelineState = { status: 'idle', log: [], startedAt: null, finishedAt: null };
const sseSubs = new Set();

function broadcast(payload) {
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseSubs) {
    try { res.write(msg); } catch { sseSubs.delete(res); }
  }
}

function logLine(line) {
  pipelineState.log.push(line);
  broadcast({ type: 'log', line });
}

// ─── SSE — live pipeline progress ─────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.set({
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  });
  res.flushHeaders();
  // Send current snapshot immediately so the UI syncs on connect/reconnect
  res.write(`data: ${JSON.stringify({ type: 'snapshot', ...pipelineState })}\n\n`);
  sseSubs.add(res);
  req.on('close', () => sseSubs.delete(res));
});

// ─── Run classification pipeline ──────────────────────────────────────────────
// The classify script already batches Anthropic calls in groups of 10; we just
// stream its stdout back to the SSE subscribers — no need to re-implement batching.
app.post('/api/run', (req, res) => {
  if (pipelineState.status === 'running') {
    return res.status(409).json({ error: 'Pipeline is already running' });
  }

  const { inputFile, after, before } = req.body || {};
  pipelineState = { status: 'running', log: [], startedAt: new Date().toISOString(), finishedAt: null };
  broadcast({ type: 'start', status: 'running' });

  const args = [path.join(ROOT, 'dmag_classify.js')];
  if (inputFile) args.push('--input', inputFile);
  if (after)     args.push('--after',  after);
  if (before)    args.push('--before', before);

  const proc = spawn('node', args, { env: process.env, cwd: ROOT });

  const onData = (prefix) => (chunk) =>
    chunk.toString().split('\n').forEach(l => { if (l.trim()) logLine(prefix + l); });

  proc.stdout.on('data', onData(''));
  proc.stderr.on('data', onData('[err] '));

  proc.on('close', (code) => {
    pipelineState.status    = code === 0 ? 'done' : 'error';
    pipelineState.finishedAt = new Date().toISOString();
    broadcast({ type: 'done', status: pipelineState.status, exitCode: code });
  });

  res.json({ ok: true });
});

// ─── Results ──────────────────────────────────────────────────────────────────
app.get('/api/results', (req, res) => {
  if (!fs.existsSync(DATA_FILE)) return res.json([]);
  try {
    res.json(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  } catch {
    res.status(500).json({ error: 'Failed to read results file' });
  }
});

// ─── Manual re-classify ───────────────────────────────────────────────────────
app.patch('/api/results/:id', (req, res) => {
  if (!fs.existsSync(DATA_FILE)) return res.status(404).json({ error: 'No results file' });
  try {
    const posts = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const id    = parseInt(req.params.id, 10);
    const post  = posts.find(p => p.id === id);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    Object.assign(post, req.body, { manually_corrected: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(posts, null, 2));
    res.json(post);
  } catch {
    res.status(500).json({ error: 'Update failed' });
  }
});

// ─── Upload analytics CSV + merge (no re-classification) ─────────────────────
// Merge is done directly in the server to preserve existing classifications
// and any manual corrections the user has applied.
const upload = multer({ dest: UPLOADS });

app.post('/api/upload-analytics', upload.single('analytics'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  if (!fs.existsSync(DATA_FILE)) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Run classification first before uploading analytics' });
  }

  try {
    const posts    = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    let csvText = fs.readFileSync(req.file.path, 'utf8');

    // Strip UTF-8 BOM if present (common in Excel/GA4 exports)
    if (csvText.charCodeAt(0) === 0xFEFF) csvText = csvText.slice(1);

    // GA4 exports often prepend metadata lines (e.g. "# Jan 1 – Mar 31, 2026")
    // before the real header row. Skip any leading lines that don't look like
    // a header (i.e. lines where every field starts with # or the line has
    // far fewer commas than the data rows).
    const lines = csvText.split(/\r?\n/);
    let startLine = 0;
    for (let i = 0; i < Math.min(lines.length, 10); i++) {
      const trimmed = lines[i].trim();
      if (!trimmed || trimmed.startsWith('#')) { startLine = i + 1; continue; }
      // If the first non-empty, non-comment line looks like a real header, stop
      break;
    }
    const cleanCsv = lines.slice(startLine).join('\n');

    const analytics = parse(cleanCsv, {
      columns:             true,
      skip_empty_lines:    true,
      relax_column_count:  true,   // tolerate rows with extra/missing columns
      bom:                 true,
      trim:                true,
    });

    // Build lookup by URL slug (primary) and normalised title (fallback).
    // Handles GA4 page_path format and title-only exports (Search Console, etc.)
    const bySlug  = {};
    const byTitle = {};
    const SITE_SUFFIXES = /\s*[-|–]\s*D\s*(CEO\s*)?Magazine\s*$/i;

    for (const row of analytics) {
      // slug-based key from any URL-like column
      const urlVal = row.slug || row.page_path || row.url
        || row['Page path'] || row['Page path and screen class']
        || row['Full page URL'] || row['Page'] || '';
      if (urlVal) {
        // Strip protocol + domain from full URLs before extracting slug
        const urlPath = urlVal.replace(/^https?:\/\/[^/]+/, '');
        const key = urlPath.replace(/^\/|\/$/g, '').split('/').pop().toLowerCase();
        if (key) bySlug[key] = row;
      }
      // title-based key — strip trailing " - D Magazine" / " - D CEO Magazine"
      const titleVal = row.title || row['Page title'] || row['Page Title'] ||
                       row['Page title and screen name'] ||
                       row['Landing page'] || Object.values(row)[0] || '';
      if (titleVal) {
        const key = titleVal.replace(SITE_SUFFIXES, '').trim().toLowerCase();
        if (key) byTitle[key] = row;
      }
    }

    let matched = 0;
    let matchedBySlug = 0, matchedByTitle = 0;
    for (const post of posts) {
      const slugKey  = post.slug.replace(/^\/|\/$/g, '').split('/').pop().toLowerCase();
      const titleKey = (post.title || '').trim().toLowerCase();
      const row = bySlug[slugKey] || bySlug[post.slug.toLowerCase()] || byTitle[titleKey];
      if (row) {
        matched++;
        if (bySlug[slugKey] || bySlug[post.slug.toLowerCase()]) matchedBySlug++;
        else matchedByTitle++;
        for (const [k, v] of Object.entries(row)) post[`ga_${k}`] = v;
      }
    }

    const matchDetail = `(${matchedBySlug} by URL, ${matchedByTitle} by title)`;

    fs.writeFileSync(DATA_FILE, JSON.stringify(posts, null, 2));
    fs.unlinkSync(req.file.path);

    const msg = `Analytics merged: ${matched}/${posts.length} articles matched ${matchDetail}`;
    logLine(msg);
    broadcast({ type: 'analytics_merged', matched, total: posts.length });

    res.json({ ok: true, matched, total: posts.length });
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: e.message });
  }
});

// ─── Export CSV ───────────────────────────────────────────────────────────────
app.get('/api/export', (req, res) => {
  if (!fs.existsSync(DATA_FILE)) return res.status(404).json({ error: 'No results file' });
  try {
    const posts = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    res.set({
      'Content-Type':        'text/csv',
      'Content-Disposition': 'attachment; filename="dmag_classified.csv"',
    });
    res.send(stringify(posts, { header: true }));
  } catch {
    res.status(500).json({ error: 'Export failed' });
  }
});

// ─── SPA fallback ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  const idx = path.join(ROOT, 'client', 'dist', 'index.html');
  fs.existsSync(idx)
    ? res.sendFile(idx)
    : res.status(404).send('Frontend not built. Run: npm run build');
});

app.listen(PORT, () => console.log(`Server → http://localhost:${PORT}`));
