'use strict';
const Database = require('better-sqlite3');
const path     = require('path');

const DB_PATH = process.env.DB_PATH
  || path.join(__dirname, '..', 'dmag_classified.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`CREATE TABLE IF NOT EXISTS articles (
  id                INTEGER PRIMARY KEY,
  date              TEXT,
  slug              TEXT,
  title             TEXT,
  excerpt           TEXT,
  link              TEXT,
  type              TEXT,
  section_name      TEXT,
  category_names    TEXT,
  categories        TEXT,
  tags              TEXT,
  section           TEXT,
  user_need         TEXT,
  secondary_needs   TEXT,
  confidence        TEXT,
  un_reason         TEXT,
  manually_corrected INTEGER NOT NULL DEFAULT 0,
  analytics         TEXT
)`);

// DB row → client post object (spreads ga_-prefixed analytics keys)
function rowToPost(row) {
  const { analytics, manually_corrected, ...rest } = row;
  const post = { ...rest, manually_corrected: !!manually_corrected };
  const gaData = analytics ? JSON.parse(analytics) : {};
  for (const [k, v] of Object.entries(gaData)) post[`ga_${k}`] = v;
  return post;
}

// Client post object → DB row (collects ga_* keys into analytics blob)
function postToRow(post) {
  const analytics = {};
  const row = {};
  for (const [k, v] of Object.entries(post)) {
    if (k.startsWith('ga_')) analytics[k.slice(3)] = v;
    else row[k] = v;
  }
  row.analytics          = Object.keys(analytics).length ? JSON.stringify(analytics) : null;
  row.manually_corrected = row.manually_corrected ? 1 : 0;
  return row;
}

const UPSERT = db.prepare(`
  INSERT INTO articles
    (id,date,slug,title,excerpt,link,type,section_name,category_names,
     categories,tags,section,user_need,secondary_needs,confidence,
     un_reason,manually_corrected,analytics)
  VALUES
    (@id,@date,@slug,@title,@excerpt,@link,@type,@section_name,@category_names,
     @categories,@tags,@section,@user_need,@secondary_needs,@confidence,
     @un_reason,@manually_corrected,@analytics)
  ON CONFLICT(id) DO UPDATE SET
    date=excluded.date, slug=excluded.slug, title=excluded.title,
    excerpt=excluded.excerpt, link=excluded.link, type=excluded.type,
    section_name=excluded.section_name, category_names=excluded.category_names,
    categories=excluded.categories, tags=excluded.tags, section=excluded.section,
    -- preserve classification if this post was manually corrected
    user_need       = CASE WHEN articles.manually_corrected=1 THEN articles.user_need       ELSE excluded.user_need       END,
    secondary_needs = CASE WHEN articles.manually_corrected=1 THEN articles.secondary_needs ELSE excluded.secondary_needs END,
    confidence      = CASE WHEN articles.manually_corrected=1 THEN articles.confidence      ELSE excluded.confidence      END,
    un_reason       = CASE WHEN articles.manually_corrected=1 THEN articles.un_reason       ELSE excluded.un_reason       END
`);

const upsertMany = db.transaction((posts) => {
  for (const p of posts) UPSERT.run(postToRow(p));
});

module.exports = {
  getAll() {
    return db.prepare('SELECT * FROM articles ORDER BY date DESC').all().map(rowToPost);
  },

  getById(id) {
    const row = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
    return row ? rowToPost(row) : null;
  },

  upsertMany(posts) {
    upsertMany(posts);
  },

  updateOne(id, fields) {
    const allowed = ['user_need', 'secondary_needs', 'confidence', 'un_reason', 'manually_corrected'];
    const sets = allowed.filter(k => k in fields).map(k => `${k}=@${k}`).join(', ');
    if (!sets) return null;
    const params = { id };
    for (const k of allowed) if (k in fields) params[k] = fields[k];
    db.prepare(`UPDATE articles SET ${sets} WHERE id=@id`).run(params);
    return this.getById(id);
  },

  updateAnalytics(matches) {
    // matches: [{ id, analytics: { "Views": "49224", ... } }]
    const stmt = db.prepare('UPDATE articles SET analytics=@analytics WHERE id=@id');
    const run  = db.transaction(matches => {
      for (const { id, analytics } of matches)
        stmt.run({ id, analytics: JSON.stringify(analytics) });
    });
    run(matches);
  },

  // IDs that already have a real classification (used for incremental skip list)
  getClassifiedIds() {
    return db.prepare(`SELECT id FROM articles WHERE user_need IS NOT NULL AND user_need != 'unclassified'`)
      .all().map(r => r.id);
  },

  count() {
    return db.prepare('SELECT COUNT(*) as n FROM articles').get().n;
  },
};
