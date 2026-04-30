'use strict';

const { BetaAnalyticsDataClient } = require('@google-analytics/data');
const db = require('./db');

const PROPERTY_ID = process.env.GA4_PROPERTY_ID;

// Maps GA4 API metric names → display names matching the CSV export column headers.
// These keys end up stored in the analytics JSON blob (without ga_ prefix).
// rowToPost() in db.js adds ga_ when returning to the client, so the
// existing GA_DISPLAY map in ArticleTable.jsx picks them up automatically.
const METRIC_MAP = {
  screenPageViews:        'Views',
  activeUsers:            'Active users',
  totalUsers:             'Total users',
  userEngagementDuration: 'Average engagement time per active user', // sum ÷ activeUsers below
  eventCount:             'Event count',
  keyEvents:              'Key events',
  totalRevenue:           'Total revenue',
};

let _client = undefined;
function getClient() {
  if (_client !== undefined) return _client;
  const credJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!credJson || !PROPERTY_ID) { _client = null; return null; }
  try {
    _client = new BetaAnalyticsDataClient({ credentials: JSON.parse(credJson) });
    return _client;
  } catch (e) {
    console.warn('[analytics] Invalid GOOGLE_APPLICATION_CREDENTIALS_JSON:', e.message);
    _client = null;
    return null;
  }
}

function isConfigured() {
  return !!(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON && PROPERTY_ID);
}

async function refreshAnalytics(daysBack = 90) {
  const client = getClient();
  if (!client) {
    console.log('[analytics] GA4 not configured — skipping');
    return { skipped: true };
  }

  console.log(`[analytics] Fetching GA4 data (last ${daysBack} days)…`);
  const [response] = await client.runReport({
    property:   `properties/${PROPERTY_ID}`,
    dateRanges: [{ startDate: `${daysBack}daysAgo`, endDate: 'today' }],
    dimensions: [{ name: 'pagePath' }],
    metrics:    Object.keys(METRIC_MAP).map(name => ({ name })),
    limit:      100000,
  });

  // Build lookup: normalised path → analytics row object
  const byPath       = {};
  const metricNames  = (response.metricHeaders || []).map(h => h.name);

  for (const row of (response.rows || [])) {
    const pagePath = row.dimensionValues[0].value;
    const pathKey  = pagePath.replace(/^\/|\/$/g, '').toLowerCase();
    const analytics = {};

    for (let i = 0; i < metricNames.length; i++) {
      const apiName     = metricNames[i];
      const displayName = METRIC_MAP[apiName] || apiName;
      analytics[displayName] = row.metricValues[i].value;
    }

    // GA4 userEngagementDuration is total seconds (sum), not per-user.
    // Divide by activeUsers to match the CSV export's per-user average.
    const activeUsers = parseFloat(analytics['Active users'] || 0);
    const totalEngage = parseFloat(analytics['Average engagement time per active user'] || 0);
    analytics['Average engagement time per active user'] =
      activeUsers > 0 ? String((totalEngage / activeUsers).toFixed(1)) : '0';

    byPath[pathKey] = analytics;
  }

  console.log(`[analytics] GA4 returned ${Object.keys(byPath).length} page paths`);

  // Match posts by full path extracted from post.link (same logic as CSV merge)
  const posts      = db.getAll();
  const dbMatches  = [];
  let matched      = 0;

  for (const post of posts) {
    const postPath = (post.link || '')
      .replace(/^https?:\/\/[^/]+/, '')
      .replace(/^\/|\/$/g, '')
      .toLowerCase();
    if (postPath && byPath[postPath]) {
      matched++;
      dbMatches.push({ id: post.id, analytics: byPath[postPath] });
    }
  }

  db.updateAnalytics(dbMatches);
  const ts = new Date().toISOString();
  db.setAnalyticsRefreshedAt(ts);

  console.log(`[analytics] Matched ${matched}/${posts.length} posts`);
  return { matched, total: posts.length, refreshedAt: ts };
}

module.exports = { refreshAnalytics, isConfigured };
