import { useState, useEffect, useCallback, useMemo } from 'react';
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
  const [filterSection,  setFilterSection]  = useState('all');
  const [filterType,     setFilterType]     = useState('all');

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

  // Derive filter options from the full results
  const sections = useMemo(() => {
    const set = new Set();
    for (const p of results) {
      if (p.section_name) p.section_name.split('|').filter(Boolean).forEach(s => set.add(s));
    }
    return [...set].sort();
  }, [results]);

  const postTypes = useMemo(() => {
    const set = new Set();
    for (const p of results) if (p.type) set.add(p.type);
    return [...set].sort();
  }, [results]);

  // Apply global filters
  const filteredResults = useMemo(() => {
    let d = results;
    if (filterSection !== 'all') d = d.filter(p => p.section_name && p.section_name.split('|').includes(filterSection));
    if (filterType    !== 'all') d = d.filter(p => p.type === filterType);
    return d;
  }, [results, filterSection, filterType]);

  const articleCount    = filteredResults.length;
  const classifiedCount = filteredResults.filter(p => p.user_need && p.user_need !== 'unclassified').length;
  const multiNeedCount  = filteredResults.filter(p => p.secondary_needs && p.secondary_needs.length > 0).length;
  const analyticsCount  = hasAnalytics
    ? filteredResults.filter(p => Object.keys(p).some(k => k.startsWith('ga_'))).length
    : null;

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-brand">
          <img src="/d-logo.svg" alt="D Magazine" className="header-logo-img" />
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

      {/* ── Global filter bar ── */}
      {results.length > 0 && (sections.length > 0 || postTypes.length > 1) && (
        <div className="global-filter-bar">
          <span className="global-filter-label">Filter:</span>
          {sections.length > 0 && (
            <select
              className="filter-select"
              value={filterSection}
              onChange={e => setFilterSection(e.target.value)}
            >
              <option value="all">All sections</option>
              {sections.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
          {postTypes.length > 1 && (
            <select
              className="filter-select"
              value={filterType}
              onChange={e => setFilterType(e.target.value)}
            >
              <option value="all">All types</option>
              {postTypes.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          )}
          {(filterSection !== 'all' || filterType !== 'all') && (
            <button
              className="btn-clear-filters"
              onClick={() => { setFilterSection('all'); setFilterType('all'); }}
            >
              Clear
            </button>
          )}
          <span className="global-filter-count">
            {filteredResults.length === results.length
              ? `${results.length} articles`
              : `${filteredResults.length} of ${results.length} articles`}
          </span>
        </div>
      )}

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
                  <StatCard label="Total Articles"    value={articleCount} />
                  <StatCard label="Classified"         value={classifiedCount} sub={`${((classifiedCount / articleCount) * 100).toFixed(0)}%`} />
                  <StatCard label="Multi-need"         value={multiNeedCount} sub={multiNeedCount ? `${((multiNeedCount / articleCount) * 100).toFixed(0)}%` : null} title="Articles serving more than one user need — candidates for splitting" />
                  <StatCard label="With Analytics"     value={analyticsCount ?? '—'} />
                </div>

                <div className="chart-grid">
                  <section className="chart-card">
                    <h2>User Needs Distribution</h2>
                    <p className="chart-sub">Articles published by need category</p>
                    <NeedsBarChart data={filteredResults} />
                  </section>

                  <section className="chart-card">
                    <h2>Supply vs. Demand</h2>
                    <p className="chart-sub">
                      Where are we over-producing relative to audience demand?
                      (Shishkin insight — bottom-right = wasted effort)
                    </p>
                    {hasAnalytics ? (
                      <ScatterPlot data={filteredResults} />
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
            data={filteredResults}
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

function StatCard({ label, value, sub, title }) {
  return (
    <div className="stat-card" title={title}>
      <div className="stat-value">{value}{sub && <span className="stat-sub">{sub}</span>}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
