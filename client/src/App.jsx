import { useState, useEffect, useCallback } from 'react';
import NeedsBarChart from './components/NeedsBarChart';
import ScatterPlot   from './components/ScatterPlot';
import ArticleTable  from './components/ArticleTable';
import RunPanel      from './components/RunPanel';

export default function App() {
  const [tab,            setTab]            = useState('dashboard');
  const [results,        setResults]        = useState([]);
  const [pipelineStatus, setPipelineStatus] = useState('idle');
  const [logLines,       setLogLines]       = useState([]);
  const [hasAnalytics,   setHasAnalytics]   = useState(false);

  const loadResults = useCallback(async () => {
    try {
      const r    = await fetch('/api/results');
      const data = await r.json();
      setResults(data);
      setHasAnalytics(data.some(p => Object.keys(p).some(k => k.startsWith('ga_'))));
    } catch {}
  }, []);

  // SSE — subscribe once on mount, reconnect automatically on close
  useEffect(() => {
    loadResults();
    let es;
    let retryTimer;

    function connect() {
      es = new EventSource('/api/status');

      es.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'snapshot') {
          setPipelineStatus(msg.status);
          setLogLines(msg.log || []);
        } else if (msg.type === 'log') {
          setLogLines(prev => [...prev, msg.line]);
        } else if (msg.type === 'start') {
          setPipelineStatus('running');
          setLogLines([]);
        } else if (msg.type === 'done') {
          setPipelineStatus(msg.status);
          loadResults();
        } else if (msg.type === 'analytics_merged') {
          loadResults();
        }
      };

      es.onerror = () => {
        es.close();
        retryTimer = setTimeout(connect, 3000);
      };
    }

    connect();
    return () => { es?.close(); clearTimeout(retryTimer); };
  }, [loadResults]);

  const handleReclassify = async (id, updates) => {
    const r = await fetch(`/api/results/${id}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(updates),
    });
    if (r.ok) {
      const updated = await r.json();
      setResults(prev => prev.map(p => p.id === updated.id ? updated : p));
    }
  };

  const articleCount     = results.length;
  const classifiedCount  = results.filter(p => p.user_need && p.user_need !== 'unclassified').length;
  const highConfCount    = results.filter(p => p.confidence === 'high').length;
  const analyticsCount   = hasAnalytics
    ? results.filter(p => Object.keys(p).some(k => k.startsWith('ga_'))).length
    : null;

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-brand">
          <span className="header-logo">D/</span>
          <span className="header-title">User Needs Classifier</span>
        </div>
        <nav className="header-nav">
          {[
            { id: 'dashboard', label: 'Dashboard' },
            { id: 'articles',  label: 'Articles'  },
            { id: 'run',       label: 'Run Pipeline' },
          ].map(({ id, label }) => (
            <button
              key={id}
              className={`nav-tab ${tab === id ? 'active' : ''}`}
              onClick={() => setTab(id)}
            >
              {label}
              {id === 'run' && pipelineStatus === 'running' && <span className="pill running">running</span>}
              {id === 'run' && pipelineStatus === 'done'    && <span className="pill done">done</span>}
              {id === 'run' && pipelineStatus === 'error'   && <span className="pill error">error</span>}
            </button>
          ))}
        </nav>
      </header>

      <main className="app-main">
        {/* ── Dashboard ── */}
        {tab === 'dashboard' && (
          <div className="dashboard">
            {results.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">📊</div>
                <p>No results yet.</p>
                <button className="btn btn-primary" onClick={() => setTab('run')}>
                  Run the classification pipeline
                </button>
              </div>
            ) : (
              <>
                <div className="stats-row">
                  <StatCard label="Total Articles"   value={articleCount} />
                  <StatCard label="Classified"        value={classifiedCount} sub={`${((classifiedCount / articleCount) * 100).toFixed(0)}%`} />
                  <StatCard label="High Confidence"   value={highConfCount} />
                  <StatCard label="With Analytics"    value={analyticsCount ?? '—'} />
                </div>

                <div className="chart-grid">
                  <section className="chart-card">
                    <h2>User Needs Distribution</h2>
                    <p className="chart-sub">Articles published by need category (March 2026)</p>
                    <NeedsBarChart data={results} />
                  </section>

                  <section className="chart-card">
                    <h2>Supply vs. Demand</h2>
                    <p className="chart-sub">
                      Where are we over-producing relative to audience demand?
                      (Shishkin insight — bottom-right = wasted effort)
                    </p>
                    {hasAnalytics ? (
                      <ScatterPlot data={results} />
                    ) : (
                      <div className="no-data-placeholder">
                        <span>📥</span>
                        <p>Upload a GA4 analytics CSV in the <button className="link-btn" onClick={() => setTab('run')}>Run tab</button> to see this chart.</p>
                      </div>
                    )}
                  </section>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Articles table ── */}
        {tab === 'articles' && (
          <ArticleTable
            data={results}
            hasAnalytics={hasAnalytics}
            onReclassify={handleReclassify}
          />
        )}

        {/* ── Run pipeline ── */}
        {tab === 'run' && (
          <RunPanel status={pipelineStatus} logLines={logLines} />
        )}
      </main>
    </div>
  );
}

function StatCard({ label, value, sub }) {
  return (
    <div className="stat-card">
      <div className="stat-value">{value}{sub && <span className="stat-sub">{sub}</span>}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
