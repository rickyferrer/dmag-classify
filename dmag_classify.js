/**
 * D Magazine — User Needs Classification Pipeline
 *
 * Usage:
 *   node dmag_classify.js                          # fetches March posts + classifies
 *   node dmag_classify.js --input posts.json       # classifies an existing JSON file
 *   node dmag_classify.js --merge analytics.csv    # merges analytics after classification
 *
 * Output:
 *   dmag_march_classified.json   — full data with user_need field
 *   dmag_march_classified.csv    — flat CSV ready for spreadsheet / BI tool merge
 *
 * Requirements:
 *   npm install node-fetch csv-parse csv-stringify
 *   ANTHROPIC_API_KEY env var must be set
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ─── install deps quietly if missing ────────────────────────────────────────
function ensureDeps() {
  const needed = ['node-fetch', 'csv-parse', 'csv-stringify'];
  for (const dep of needed) {
    try { require.resolve(dep); }
    catch {
      console.log(`Installing ${dep}...`);
      execSync(`npm install ${dep} --save-quiet`, { stdio: 'inherit' });
    }
  }
}
ensureDeps();

const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

// ─── config ──────────────────────────────────────────────────────────────────
const WP_BASE       = 'https://www.dmagazine.com/wp-json/wp/v2';
const WP_FIELDS     = 'id,date,slug,title,excerpt,link,type,categories,tags,section';
const WP_HEADERS    = { 'Content-Type': 'application/json', 'User-Agent': 'SEO DMAG Crawl' };
const AFTER         = '2026-02-28T23:59:59';
const BEFORE        = '2026-04-01T00:00:00';
const BATCH_SIZE    = 10;   // articles per Anthropic API call
const DELAY_MS      = 300;  // polite delay between WP pages

// Default date window (March 2026) — overridden by --after / --before CLI flags
const DEFAULT_AFTER  = '2026-02-28T23:59:59';
const DEFAULT_BEFORE = '2026-04-01T00:00:00';

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY environment variable is not set.');
  process.exit(1);
}

// ─── user needs definitions (passed to the model as context) ─────────────────
const USER_NEEDS_CONTEXT = `
You are classifying news articles using the User Needs Model 2.0 developed by Dmitry Shishkin.
Assign ONE primary user need and up to 2 secondary user needs per article, based on its title and excerpt.

USER NEEDS:
1. update_me        — Breaking news, what happened, factual updates, announcements, results
2. educate_me       — Explainers, how-things-work, backgrounders, deep dives, context-building
3. give_me_perspective — Analysis, opinion, expert commentary, what-it-means pieces
4. divert_me        — Entertainment, lifestyle, fun, lighter fare, things to do, culture
5. inspire_me       — Profiles of achievement, solution journalism, feel-good, human interest
6. help_me          — Service journalism, guides, how-to, recommendations, directories, tools
7. connect_me       — Community identity, shared experience, belonging, civic pride
8. keep_me_engaged  — Conversation starters, trending topics, reader participation, debate

CLASSIFICATION RULES:
- If a piece is a ranked list / guide (50 Best, Top 10) → help_me
- If a piece announces a personnel move, award, or event result → update_me
- If a piece is a restaurant/arts/culture review with recommendations → divert_me
- If a piece profiles a person overcoming odds or achieving something → inspire_me
- If a piece explains WHY something is happening or provides background → educate_me
- If a piece is a political/business analysis or columnist take → give_me_perspective
- If a piece is explicitly a "things to do" or event calendar → help_me
- "Leading Off" daily news digests → update_me
- Obituaries → inspire_me (unless pure announcement → update_me)

SECONDARY NEEDS — only assign if the article GENUINELY serves a second audience intent,
not just because a topic is tangentially mentioned. An article mixing a news announcement
with deep background context warrants update_me + educate_me. A pure breaking news story
warrants no secondary need. Limit to 2 secondary needs maximum; use [] if none apply.

Respond ONLY with a JSON array, no markdown, no explanation. Each element:
{ "id": <post_id>, "user_need": "<need_slug>", "secondary_needs": ["<need_slug>"], "confidence": "high|medium|low", "reason": "<10 words max>" }
`.trim();

// ─── WP fetch ────────────────────────────────────────────────────────────────
async function wpFetchPage(after, before, pageNum) {
  const url = `${WP_BASE}/posts?after=${after}&before=${before}&per_page=100&page=${pageNum}&_fields=${WP_FIELDS}&status=publish`;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: WP_HEADERS }, (res) => {
      let data = '';
      const totalPages = parseInt(res.headers['x-wp-totalpages'] || '1', 10);
      const totalPosts = parseInt(res.headers['x-wp-total'] || '0', 10);
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ posts: JSON.parse(data), totalPages, totalPosts }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
  });
}

async function fetchPosts(after, before) {
  console.log(`\n── Fetching posts ${after.slice(0, 10)} → ${before.slice(0, 10)} from WP API ──`);
  const first = await wpFetchPage(after, before, 1);
  console.log(`  Total: ${first.totalPosts} posts across ${first.totalPages} pages`);
  let all = [...first.posts];
  for (let p = 2; p <= first.totalPages; p++) {
    process.stdout.write(`  Page ${p}/${first.totalPages}...\r`);
    const { posts } = await wpFetchPage(after, before, p);
    all = all.concat(posts);
    await sleep(DELAY_MS);
  }
  console.log(`\n  Retrieved: ${all.length} posts`);
  return all.map(p => ({
    id: p.id,
    date: p.date,
    slug: p.slug,
    title: strip(p.title?.rendered ?? ''),
    excerpt: strip(p.excerpt?.rendered ?? ''),
    link: p.link,
    type: p.type,
    categories: (p.categories || []).join('|'),
    tags: (p.tags || []).join('|'),
    section: (p.section || []).join('|'),
  }));
}

// ─── classification ───────────────────────────────────────────────────────────
async function classifyBatch(articles) {
  const items = articles.map(a => ({
    id: a.id,
    title: a.title,
    excerpt: a.excerpt.slice(0, 300),
  }));

  const prompt = `${USER_NEEDS_CONTEXT}\n\nARTICLES TO CLASSIFY:\n${JSON.stringify(items, null, 2)}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const raw = data.content.find(b => b.type === 'text')?.text ?? '[]';

  // strip any accidental markdown fences
  const clean = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

async function classifyAll(posts) {
  console.log('\n── Classifying with Claude ──');
  const results = {};
  const batches = chunk(posts, BATCH_SIZE);

  for (let i = 0; i < batches.length; i++) {
    process.stdout.write(`  Batch ${i + 1}/${batches.length} (${batches[i].length} articles)...\r`);
    try {
      const classified = await classifyBatch(batches[i]);
      for (const c of classified) results[c.id] = c;
    } catch (e) {
      console.warn(`\n  Batch ${i + 1} failed: ${e.message} — marking as unclassified`);
      for (const a of batches[i]) {
        results[a.id] = { id: a.id, user_need: 'unclassified', confidence: 'low', reason: 'api error' };
      }
    }
    await sleep(500);
  }

  console.log(`\n  Classified: ${Object.keys(results).length} articles`);
  return results;
}

// ─── analytics merge ──────────────────────────────────────────────────────────
function mergeAnalytics(posts, csvPath) {
  console.log(`\n── Merging analytics from ${csvPath} ──`);
  const raw = fs.readFileSync(csvPath, 'utf8');
  const analytics = parse(raw, { columns: true, skip_empty_lines: true });

  // build lookup by slug or page path
  const bySlug = {};
  for (const row of analytics) {
    // handles GA4 "page_path" like /guides/55-date-ideas-in-dallas-and-beyond/
    const key = (row.slug || row.page_path || row.url || '')
      .replace(/^\/|\/$/g, '')   // strip leading/trailing slashes
      .split('/')
      .pop();                     // take last segment as slug
    if (key) bySlug[key] = row;
  }

  let matched = 0;
  for (const post of posts) {
    const slugKey = post.slug.replace(/^\/|\/$/g, '').split('/').pop();
    const row = bySlug[slugKey] || bySlug[post.slug];
    if (row) {
      matched++;
      // copy all analytics columns, prefixed with "ga_" to avoid collisions
      for (const [k, v] of Object.entries(row)) {
        post[`ga_${k}`] = v;
      }
    }
  }
  console.log(`  Matched ${matched}/${posts.length} posts to analytics rows`);
  return posts;
}

// ─── output ───────────────────────────────────────────────────────────────────
function writeOutputs(posts) {
  const jsonPath = 'dmag_march_classified.json';
  const csvPath  = 'dmag_march_classified.csv';

  fs.writeFileSync(jsonPath, JSON.stringify(posts, null, 2));
  console.log(`\n  JSON → ${jsonPath}`);

  if (posts.length > 0) {
    const csv = stringify(posts, { header: true });
    fs.writeFileSync(csvPath, csv);
    console.log(`  CSV  → ${csvPath}`);
  }

  // summary breakdown
  const counts = {};
  for (const p of posts) {
    const n = p.user_need || 'unclassified';
    counts[n] = (counts[n] || 0) + 1;
  }
  console.log('\n── Distribution ──');
  const total = posts.length;
  for (const [need, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    const pct = ((count / total) * 100).toFixed(1);
    const bar = '█'.repeat(Math.round(pct / 2));
    console.log(`  ${need.padEnd(22)} ${String(count).padStart(4)}  ${pct.padStart(5)}%  ${bar}`);
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────
function strip(html) { return html.replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&#8217;/g,"'").trim(); }
function sleep(ms)   { return new Promise(r => setTimeout(r, ms)); }
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ─── main ────────────────────────────────────────────────────────────────────
(async () => {
  const args = process.argv.slice(2);
  const inputFlag  = args.indexOf('--input');
  const mergeFlag  = args.indexOf('--merge');
  const afterFlag  = args.indexOf('--after');
  const beforeFlag = args.indexOf('--before');

  const after  = afterFlag  !== -1 ? args[afterFlag  + 1] : DEFAULT_AFTER;
  const before = beforeFlag !== -1 ? args[beforeFlag + 1] : DEFAULT_BEFORE;

  let posts;

  if (inputFlag !== -1) {
    // skip WP fetch, load from existing file
    const inputPath = args[inputFlag + 1];
    console.log(`\nLoading posts from ${inputPath}...`);
    posts = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  } else {
    posts = await fetchPosts(after, before);
  }

  // classify
  const classifications = await classifyAll(posts);
  for (const post of posts) {
    const c = classifications[post.id] || {};
    post.user_need       = c.user_need       ?? 'unclassified';
    post.secondary_needs = (c.secondary_needs || []).join('|');
    post.confidence      = c.confidence      ?? 'low';
    post.un_reason       = c.reason          ?? '';
  }

  // optional analytics merge
  if (mergeFlag !== -1) {
    const csvPath = args[mergeFlag + 1];
    if (!csvPath || !fs.existsSync(csvPath)) {
      console.error(`Analytics file not found: ${csvPath}`);
      process.exit(1);
    }
    mergeAnalytics(posts, csvPath);
  }

  writeOutputs(posts);
  console.log('\nDone.\n');
})();
