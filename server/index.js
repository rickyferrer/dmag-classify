'use strict';

const express   = require('express');
const { spawn } = require('child_process');
const multer    = require('multer');
const fs        = require('fs');
const path      = require('path');
const { parse }     = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const cors      = require('cors');
const schedule  = require('node-schedule');
const db        = require('./db');
const { refreshAnalytics, isConfigured } = require('./analytics');

const app  = express();
const PORT = process.env.PORT || 3001;
const ROOT = path.join(__dirname, '..');
const UPLOADS = path.join(ROOT, 'uploads');

fs.mkdirSync(UPLOADS, { recursive: true });

// ─── Auto-import legacy JSON on first run ─────────────────────────────────────
const JSON_LEGACY = path.join(ROOT, 'dmag_march_classified.json');
if (db.count() === 0 && fs.existsSync(JSON_LEGACY)) {
  try {
    const legacy = JSON.parse(fs.readFileSync(JSON_LEGACY, 'utf8'));
    db.upsertMany(legacy);
    console.log(`Imported ${legacy.length} posts from legacy JSON into SQLite`);
  } catch (e) {
    console.warn('Legacy JSON import failed:', e.message);
  }
}

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

// ─── Classification pipeline helper ───────────────────────────────────────────
// Shared by the HTTP handler and the scheduler to avoid duplication.
// trigger: 'manual' | 'auto'
function runPipeline(after, before, trigger = 'manual') {
  if (pipelineState.status === 'running') {
    console.log(`[pipeline] Already running — skipping ${trigger} trigger`);
    return;
  }

  pipelineState = { status: 'running', log: [], startedAt: new Date().toISOString(), finishedAt: null };
  broadcast({ type: 'start', status: 'running', trigger });

  const args = [path.join(ROOT, 'dmag_classify.js')];
  if (after)  args.push('--after',  after);
  if (before) args.push('--before', before);

  const existingIds = db.getClassifiedIds();
  const skipFile    = path.join(UPLOADS, `skip_${Date.now()}.json`);
  fs.writeFileSync(skipFile, JSON.stringify(existingIds));
  args.push('--existing', skipFile);
  logLine(`[${trigger}] Skipping ${existingIds.length} already-classified posts`);

  const proc   = spawn('node', args, { env: process.env, cwd: ROOT });
  const onData = (prefix) => (chunk) =>
    chunk.toString().split('\n').forEach(l => { if (l.trim()) logLine(prefix + l); });

  proc.stdout.on('data', onData(''));
  proc.stderr.on('data', onData('[err] '));

  proc.on('close', (code) => {
    try { fs.unlinkSync(skipFile); } catch {}

    const jsonOut = path.join(ROOT, 'dmag_march_classified.json');
    if (code === 0 && fs.existsSync(jsonOut)) {
      try {
        const posts = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
        db.upsertMany(posts);
        logLine(`Saved ${posts.length} articles to database`);
      } catch (e) {
        logLine(`[warn] DB import failed: ${e.message}`);
      }
    }

    pipelineState.status     = code === 0 ? 'done' : 'error';
    pipelineState.finishedAt = new Date().toISOString();
    broadcast({ type: 'done', status: pipelineState.status, exitCode: code, trigger });
  });
}

// ─── SSE — live pipeline progress ─────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.set({
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'snapshot', ...pipelineState })}\n\n`);
  sseSubs.add(res);
  req.on('close', () => sseSubs.delete(res));
});

// ─── Run classification pipeline (manual) ─────────────────────────────────────
app.post('/api/run', (req, res) => {
  if (pipelineState.status === 'running') {
    return res.status(409).json({ error: 'Pipeline is already running' });
  }
  const { after, before } = req.body || {};
  runPipeline(after, before, 'manual');
  res.json({ ok: true });
});

// ─── Results ──────────────────────────────────────────────────────────────────
app.get('/api/results', (req, res) => {
  try {
    res.json(db.getAll());
  } catch (e) {
    res.status(500).json({ error: 'Failed to read results' });
  }
});

// ─── Manual re-classify ───────────────────────────────────────────────────────
app.patch('/api/results/:id', (req, res) => {
  try {
    const id   = parseInt(req.params.id, 10);
    const post = db.updateOne(id, { ...req.body, manually_corrected: true });
    if (!post) return res.status(404).json({ error: 'Post not found' });
    res.json(post);
  } catch (e) {
    res.status(500).json({ error: 'Update failed' });
  }
});

// ─── Upload analytics CSV + merge ─────────────────────────────────────────────
const upload = multer({ dest: UPLOADS });

app.post('/api/upload-analytics', upload.single('analytics'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (db.count() === 0) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Run classification first before uploading analytics' });
  }

  try {
    const posts   = db.getAll();
    let csvText   = fs.readFileSync(req.file.path, 'utf8');

    if (csvText.charCodeAt(0) === 0xFEFF) csvText = csvText.slice(1);

    const lines = csvText.split(/\r?\n/);
    let startLine = 0;
    for (let i = 0; i < Math.min(lines.length, 10); i++) {
      const trimmed = lines[i].trim();
      if (!trimmed || trimmed.startsWith('#')) { startLine = i + 1; continue; }
      break;
    }
    const cleanCsv = lines.slice(startLine).join('\n');

    const firstDataLine = cleanCsv.split(/\r?\n/).find(l => l.trim()) || '';
    const tabCount   = (firstDataLine.match(/\t/g)  || []).length;
    const commaCount = (firstDataLine.match(/,/g)   || []).length;
    const delimiter  = tabCount > commaCount ? '\t' : ',';

    const analytics = parse(cleanCsv, {
      columns:            true,
      skip_empty_lines:   true,
      relax_column_count: true,
      bom:                true,
      trim:               true,
      delimiter,
    });

    const byPath  = {};
    const byTitle = {};
    const SITE_SUFFIXES = /\s*[-|–]\s*D\s*(CEO\s*)?Magazine\s*$/i;

    for (const row of analytics) {
      const urlVal = row.slug || row.page_path || row.url
        || row['Page path'] || row['Page path and screen class']
        || row['Full page URL'] || row['Page'] || '';
      if (urlVal) {
        const urlPath = urlVal.replace(/^https?:\/\/[^/]+/, '');
        const pathKey = urlPath.replace(/^\/|\/$/g, '').toLowerCase();
        if (pathKey) byPath[pathKey] = row;
      }
      const titleVal = row.title || row['Page title'] || row['Page Title'] ||
                       row['Page title and screen name'] ||
                       row['Landing page'] || Object.values(row)[0] || '';
      if (titleVal) {
        const key = titleVal.replace(SITE_SUFFIXES, '').trim().toLowerCase();
        if (key) byTitle[key] = row;
      }
    }

    let matched = 0, matchedByPath = 0, matchedByTitle = 0;
    const dbMatches = [];

    for (const post of posts) {
      const postPath = (post.link || '').replace(/^https?:\/\/[^/]+/, '').replace(/^\/|\/$/g, '').toLowerCase();
      const titleKey = (post.title || '').trim().toLowerCase();
      const row = (postPath && byPath[postPath]) || byTitle[titleKey];
      if (row) {
        matched++;
        if (postPath && byPath[postPath]) matchedByPath++;
        else matchedByTitle++;
        const analyticsObj = {};
        for (const [k, v] of Object.entries(row)) analyticsObj[k] = v;
        dbMatches.push({ id: post.id, analytics: analyticsObj });
      }
    }

    db.updateAnalytics(dbMatches);
    fs.unlinkSync(req.file.path);

    const matchDetail = `(${matchedByPath} by path, ${matchedByTitle} by title)`;
    const msg = `Analytics merged: ${matched}/${posts.length} articles matched ${matchDetail}`;
    logLine(msg);
    broadcast({ type: 'analytics_merged', matched, total: posts.length });

    res.json({ ok: true, matched, total: posts.length });
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: e.message });
  }
});

// ─── GA4 API analytics refresh ────────────────────────────────────────────────
app.get('/api/analytics-status', (req, res) => {
  res.json({
    configured:  isConfigured(),
    refreshedAt: db.getAnalyticsRefreshedAt(),
  });
});

app.post('/api/refresh-analytics', async (req, res) => {
  if (!isConfigured()) {
    return res.status(503).json({
      error: 'GA4 API not configured. Set GA4_PROPERTY_ID and GOOGLE_APPLICATION_CREDENTIALS_JSON.',
    });
  }
  try {
    const result = await refreshAnalytics();
    if (result.skipped) return res.json({ ok: true, skipped: true });
    logLine(`GA4 analytics refreshed: ${result.matched}/${result.total} articles matched`);
    broadcast({ type: 'analytics_merged', matched: result.matched, total: result.total, source: 'ga4_api', refreshedAt: result.refreshedAt });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[analytics] Refresh error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Export CSV ───────────────────────────────────────────────────────────────
app.get('/api/export', (req, res) => {
  try {
    const posts = db.getAll();
    res.set({
      'Content-Type':        'text/csv',
      'Content-Disposition': 'attachment; filename="dmag_classified.csv"',
    });
    res.send(stringify(posts, { header: true }));
  } catch (e) {
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

app.listen(PORT, () => {
  console.log(`Server → http://localhost:${PORT}`);

  // ── Auto-classify: every 30 minutes ────────────────────────────────────────
  // Checks for WP posts newer than the latest date in the DB. Only genuinely
  // new articles hit the Claude API (existing IDs are on the skip list).
  schedule.scheduleJob('*/30 * * * *', () => {
    const latestDate = db.getLatestPostDate();
    if (!latestDate) {
      console.log('[auto-classify] DB is empty — skipping');
      return;
    }
    const after  = latestDate;
    const before = new Date().toISOString().slice(0, 19);
    console.log(`[auto-classify] Checking for posts after ${after}`);
    runPipeline(after, before, 'auto');
  });

  // ── GA4 daily analytics refresh ────────────────────────────────────────────
  const GA4_HOUR = parseInt(process.env.GA4_REFRESH_HOUR || '6', 10);
  schedule.scheduleJob(`0 ${GA4_HOUR} * * *`, async () => {
    if (!isConfigured()) return;
    try {
      console.log('[ga4-scheduler] Running daily analytics refresh');
      const result = await refreshAnalytics();
      if (!result.skipped) {
        console.log(`[ga4-scheduler] Done — ${result.matched}/${result.total} matched`);
        broadcast({ type: 'analytics_merged', matched: result.matched, total: result.total, source: 'ga4_api', refreshedAt: result.refreshedAt });
      }
    } catch (e) {
      console.error('[ga4-scheduler] Error:', e.message);
    }
  });
});
