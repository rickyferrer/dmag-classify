import { useState, useEffect, useRef } from 'react';

const PRESET_LABELS = {
  yesterday:  'Yesterday',
  this_week:  'This week',
  this_month: 'This month',
  this_year:  'This year',
  custom:     'Custom',
};

// Computes ISO datetime strings for the WP API after/before params.
// The WP API treats `after` as exclusive (posts published AFTER this moment).
function computeDateRange(preset, customAfter, customBefore) {
  const d   = new Date();
  const fmt = (dt) => dt.toISOString().slice(0, 19);

  if (preset === 'yesterday') {
    return {
      after:  fmt(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 2, 23, 59, 59)),
      before: fmt(new Date(d.getFullYear(), d.getMonth(), d.getDate(),     0,  0,  0)),
    };
  }
  if (preset === 'this_week') {
    // Week starts Monday (ISO standard)
    const dayOfWeek = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
    return {
      after:  fmt(new Date(d.getFullYear(), d.getMonth(), d.getDate() - dayOfWeek - 1, 23, 59, 59)),
      before: fmt(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0)),
    };
  }
  if (preset === 'this_month') {
    return {
      after:  fmt(new Date(d.getFullYear(), d.getMonth(),     0,  23, 59, 59)), // last day of prev month
      before: fmt(new Date(d.getFullYear(), d.getMonth() + 1, 1,  0,  0,  0)), // 1st of next month
    };
  }
  if (preset === 'this_year') {
    return {
      after:  fmt(new Date(d.getFullYear() - 1, 11, 31, 23, 59, 59)),
      before: fmt(new Date(d.getFullYear() + 1,  0,  1,  0,  0,  0)),
    };
  }
  if (preset === 'custom') {
    return {
      after:  customAfter  ? `${customAfter}T00:00:00`  : '',
      before: customBefore ? `${customBefore}T23:59:59` : '',
    };
  }
  return { after: '', before: '' };
}

export default function RunPanel({ status, logLines, ga4Configured, analyticsRefreshedAt }) {
  const [datePreset,   setDatePreset]   = useState('this_month');
  const [customAfter,  setCustomAfter]  = useState('');
  const [customBefore, setCustomBefore] = useState('');
  const [runMsg,       setRunMsg]       = useState(null);
  const [uploadMsg,    setUploadMsg]    = useState(null);
  const [uploading,    setUploading]    = useState(false);
  const [refreshing,   setRefreshing]   = useState(false);
  const [refreshMsg,   setRefreshMsg]   = useState(null);
  const logRef = useRef(null);

  // Auto-scroll log to bottom when new lines arrive
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logLines]);

  const handleRun = async () => {
    if (datePreset === 'custom' && (!customAfter || !customBefore)) {
      setRunMsg({ ok: false, text: 'Select both a start and end date' });
      return;
    }
    setRunMsg(null);
    const { after, before } = computeDateRange(datePreset, customAfter, customBefore);
    await fetch('/api/run', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ after, before }),
    });
  };

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadMsg(null);
    const form = new FormData();
    form.append('analytics', file);
    try {
      const r    = await fetch('/api/upload-analytics', { method: 'POST', body: form });
      const data = await r.json();
      setUploadMsg(r.ok
        ? { ok: true,  text: `Merged: ${data.matched} of ${data.total} articles matched` }
        : { ok: false, text: data.error || 'Upload failed' }
      );
    } catch {
      setUploadMsg({ ok: false, text: 'Network error' });
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const handleRefreshAnalytics = async () => {
    setRefreshing(true);
    setRefreshMsg(null);
    try {
      const r    = await fetch('/api/refresh-analytics', { method: 'POST' });
      const data = await r.json();
      setRefreshMsg(r.ok
        ? { ok: true,  text: `Merged: ${data.matched} of ${data.total} articles matched` }
        : { ok: false, text: data.error || 'Refresh failed' }
      );
    } catch {
      setRefreshMsg({ ok: false, text: 'Network error' });
    } finally {
      setRefreshing(false);
    }
  };

  const isRunning = status === 'running';

  return (
    <div className="run-panel">
      {/* ── Controls ── */}
      <div className="run-controls">
        <div className="control-card">
          <h3>Classification Pipeline</h3>
          <p className="control-desc">
            Fetches posts from the WordPress API for the selected date range, then classifies
            each article by User Need using Claude (batches of 10). Progress streams live in
            the log panel.
          </p>

          {/* Date range presets */}
          <div className="date-range-row">
            {Object.keys(PRESET_LABELS).map(p => (
              <button
                key={p}
                className={`preset-btn ${datePreset === p ? 'active' : ''}`}
                onClick={() => setDatePreset(p)}
                disabled={isRunning}
              >
                {PRESET_LABELS[p]}
              </button>
            ))}
          </div>

          {datePreset === 'custom' && (
            <div className="custom-dates">
              <input
                type="date"
                value={customAfter}
                onChange={e => setCustomAfter(e.target.value)}
                disabled={isRunning}
              />
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>to</span>
              <input
                type="date"
                value={customBefore}
                onChange={e => setCustomBefore(e.target.value)}
                disabled={isRunning}
              />
            </div>
          )}

          <div className="control-footer">
            <button className="btn btn-primary" onClick={handleRun} disabled={isRunning}>
              {isRunning ? '⏳ Running…' : '▶ Run Classification'}
            </button>
            {status === 'done'  && !runMsg && <span className="badge badge-success">Completed</span>}
            {status === 'error' && !runMsg && <span className="badge badge-error">Error — see log</span>}
            {runMsg && <span className={`badge ${runMsg.ok ? 'badge-success' : 'badge-error'}`}>{runMsg.text}</span>}
          </div>
        </div>

        {ga4Configured && (
          <div className="control-card">
            <h3>Analytics — GA4 API</h3>
            <p className="control-desc">
              Pull the latest pageview and engagement metrics directly from the GA4 Data API.
              Covers the last 90 days, matched by page path. Refreshes automatically every day at 6 AM.
            </p>
            {analyticsRefreshedAt && (
              <p style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>
                Last refreshed: {new Date(analyticsRefreshedAt).toLocaleString()}
              </p>
            )}
            <div className="control-footer">
              <button className="btn btn-secondary" onClick={handleRefreshAnalytics} disabled={refreshing}>
                {refreshing ? 'Refreshing…' : '↻ Refresh Analytics'}
              </button>
              {refreshMsg && (
                <span className={`badge ${refreshMsg.ok ? 'badge-success' : 'badge-error'}`}>
                  {refreshMsg.text}
                </span>
              )}
            </div>
          </div>
        )}

        <div className="control-card">
          <h3>Upload Analytics CSV</h3>
          <p className="control-desc">
            Upload a GA4 export (page title dimension with Views, Active users, etc.).
            Analytics are merged into existing classified data without re-running classification.
            Run classification first.
          </p>
          <div className="control-footer">
            <label className={`btn btn-secondary ${uploading ? 'disabled' : ''}`} style={{ cursor: uploading ? 'not-allowed' : 'pointer' }}>
              {uploading ? 'Uploading…' : '📂 Choose CSV…'}
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={handleUpload}
                disabled={uploading}
                style={{ display: 'none' }}
              />
            </label>
            {uploadMsg && (
              <span className={`badge ${uploadMsg.ok ? 'badge-success' : 'badge-error'}`}>
                {uploadMsg.text}
              </span>
            )}
          </div>
        </div>

        <div className="control-card">
          <h3>Export</h3>
          <p className="control-desc">
            Download the full classified dataset (with any analytics columns) as a CSV.
          </p>
          <div className="control-footer">
            <a className="btn btn-secondary" href="/api/export" download>⬇ Export CSV</a>
          </div>
        </div>
      </div>

      {/* ── Log ── */}
      <div className="log-panel">
        <div className="log-header">
          Pipeline Log
          {isRunning && <span className="log-spinner" />}
          {logLines.length > 0 && (
            <span style={{ marginLeft: 'auto', fontWeight: 400, opacity: .6 }}>
              {logLines.length} lines
            </span>
          )}
        </div>
        <div className="log-body" ref={logRef}>
          {logLines.length === 0
            ? <span className="log-empty">Waiting for pipeline output…</span>
            : logLines.map((line, i) => (
                <div key={i} className={`log-line${line.startsWith('[err]') ? ' err' : ''}`}>
                  {line}
                </div>
              ))
          }
        </div>
      </div>
    </div>
  );
}
