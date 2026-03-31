import { useState, useEffect, useRef } from 'react';

export default function RunPanel({ status, logLines }) {
  const [uploadMsg,   setUploadMsg]   = useState(null);
  const [uploading,   setUploading]   = useState(false);
  const logRef = useRef(null);

  // Auto-scroll log to bottom when new lines arrive
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logLines]);

  const handleRun = async () => {
    await fetch('/api/run', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({}),
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

  const isRunning = status === 'running';

  return (
    <div className="run-panel">
      {/* ── Controls ── */}
      <div className="run-controls">
        <div className="control-card">
          <h3>Classification Pipeline</h3>
          <p className="control-desc">
            Fetches March 2026 posts from the WordPress API, then classifies each article
            by User Need using Claude (batches of 10 via the Anthropic API). Progress
            streams live in the log panel.
          </p>
          <div className="control-footer">
            <button
              className="btn btn-primary"
              onClick={handleRun}
              disabled={isRunning}
            >
              {isRunning ? '⏳ Running…' : '▶ Run Classification'}
            </button>
            {status === 'done'  && <span className="badge badge-success">Completed</span>}
            {status === 'error' && <span className="badge badge-error">Error — see log</span>}
          </div>
        </div>

        <div className="control-card">
          <h3>Upload Analytics CSV</h3>
          <p className="control-desc">
            Upload a GA4 export containing a <code>page_path</code> (or <code>slug</code>)
            column plus metrics like <code>pageviews</code> and <code>avg_session_duration</code>.
            Analytics columns are added to existing classified data without re-running
            classification. Run classification first.
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
            <a className="btn btn-secondary" href="/api/export" download>
              ⬇ Export CSV
            </a>
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
