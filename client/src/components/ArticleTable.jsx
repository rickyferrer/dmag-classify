import { useState, useMemo } from 'react';
import { USER_NEED_COLORS, USER_NEED_LABELS, USER_NEEDS } from '../constants';

const PAGE_SIZE = 50;

// Columns that are always present (non-GA)
const CORE_COLS = ['date', 'title', 'user_need', 'confidence', 'un_reason'];

// GA columns we know how to format nicely
const GA_DISPLAY = {
  // GA4 export (page title dimensions)
  'ga_Views':                                    'Views',
  'ga_Active users':                             'Active Users',
  'ga_Total users':                              'Total Users',
  'ga_Views per active user':                    'Views/User',
  'ga_Average engagement time per active user':  'Avg Engagement',
  'ga_Event count':                              'Events',
  'ga_Key events':                               'Key Events',
  'ga_Total revenue':                            'Revenue',
  // generic GA4 / UA column names
  ga_pageviews:              'Pageviews',
  ga_sessions:               'Sessions',
  ga_screenPageViews:        'Page Views',
  ga_screen_page_views:      'Page Views',
  ga_avg_session_duration:   'Avg Time',
  ga_averageSessionDuration: 'Avg Time',
  ga_bounce_rate:            'Bounce %',
  ga_bounceRate:             'Bounce %',
};

function NeedBadge({ need, secondary }) {
  const color = USER_NEED_COLORS[need] || '#9c9c9c';
  return (
    <span
      className="need-badge"
      style={{
        background:  color + (secondary ? '11' : '1a'),
        color,
        borderColor: color,
        opacity:     secondary ? 0.75 : 1,
        fontSize:    secondary ? 10 : undefined,
        padding:     secondary ? '1px 6px' : undefined,
      }}
    >
      {USER_NEED_LABELS[need] || need}
    </span>
  );
}

function formatGa(col, val) {
  if (!val && val !== 0) return '–';
  const n = parseFloat(val);
  if (isNaN(n)) return val;
  if (col.toLowerCase().includes('duration') || col.toLowerCase().includes('engagement time')) {
    const mins = Math.floor(n / 60);
    const secs = Math.round(n % 60);
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }
  if (col.toLowerCase().includes('rate')) return `${(n * 100).toFixed(1)}%`;
  return n.toLocaleString();
}

export default function ArticleTable({ data, onReclassify }) {
  const [sortKey,  setSortKey]  = useState('date');
  const [sortDir,  setSortDir]  = useState('desc');
  const [filterNeed,    setFilterNeed]    = useState('all');
  const [filterConf,    setFilterConf]    = useState('all');
  const [filterMulti,   setFilterMulti]   = useState('all');
  const [filterSection, setFilterSection] = useState('all');
  const [filterType,    setFilterType]    = useState('all');
  const [search,   setSearch]   = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editValue, setEditValue] = useState('');
  const [page,     setPage]     = useState(1);
  const [hiddenIds,  setHiddenIds]  = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('dmag_hidden_ids') || '[]')); }
    catch { return new Set(); }
  });
  const [showHidden, setShowHidden] = useState(false);

  const toggleHide = (id) => {
    setHiddenIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      localStorage.setItem('dmag_hidden_ids', JSON.stringify([...next]));
      return next;
    });
  };

  // Derive unique sections and post types from the dataset
  const sections = useMemo(() => {
    const set = new Set();
    for (const p of data) {
      if (p.section_name) p.section_name.split('|').filter(Boolean).forEach(s => set.add(s));
    }
    return [...set].sort();
  }, [data]);

  const postTypes = useMemo(() => {
    const set = new Set();
    for (const p of data) if (p.type) set.add(p.type);
    return [...set].sort();
  }, [data]);

  // Derive which GA columns exist in the dataset
  const gaColumns = useMemo(() => {
    if (!data.length) return [];
    const keys = new Set();
    for (const p of data) {
      for (const k of Object.keys(p)) {
        if (k.startsWith('ga_') && k in GA_DISPLAY) keys.add(k);
      }
    }
    // de-dup friendly names (e.g. keep only first matching key per display name)
    const seen = new Set();
    return [...keys].filter(k => {
      const label = GA_DISPLAY[k];
      if (seen.has(label)) return false;
      seen.add(label);
      return true;
    });
  }, [data]);

  const handleSort = (key) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
    setPage(1);
  };

  const filtered = useMemo(() => {
    let d = data;
    if (!showHidden) d = d.filter(p => !hiddenIds.has(p.id));
    if (filterNeed    !== 'all') d = d.filter(p => p.user_need === filterNeed);
    if (filterConf    !== 'all') d = d.filter(p => p.confidence === filterConf);
    if (filterSection !== 'all') d = d.filter(p => p.section_name && p.section_name.split('|').includes(filterSection));
    if (filterType    !== 'all') d = d.filter(p => p.type === filterType);
    if (filterMulti === 'multi')  d = d.filter(p => p.secondary_needs && p.secondary_needs.length > 0);
    if (filterMulti === 'single') d = d.filter(p => !p.secondary_needs || p.secondary_needs.length === 0);
    if (search) {
      const s = search.toLowerCase();
      d = d.filter(p =>
        (p.title  || '').toLowerCase().includes(s) ||
        (p.slug   || '').toLowerCase().includes(s)
      );
    }
    return [...d].sort((a, b) => {
      let va = a[sortKey] ?? '', vb = b[sortKey] ?? '';
      if (sortKey === 'date') {
        va = new Date(va); vb = new Date(vb);
      } else if (sortKey.startsWith('ga_') || (!isNaN(parseFloat(va)) && !isNaN(parseFloat(vb)))) {
        va = parseFloat(va) || 0; vb = parseFloat(vb) || 0;
      } else {
        va = String(va).toLowerCase(); vb = String(vb).toLowerCase();
      }
      return sortDir === 'asc' ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1);
    });
  }, [data, filterNeed, filterConf, filterSection, filterType, filterMulti, search, sortKey, sortDir, hiddenIds, showHidden]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const startEdit = (post) => { setEditingId(post.id); setEditValue(post.user_need); };
  const cancelEdit = () => setEditingId(null);
  const saveEdit   = (post) => {
    if (editValue !== post.user_need) {
      onReclassify(post.id, { user_need: editValue, confidence: 'high', un_reason: 'manual' });
    }
    setEditingId(null);
  };

  const SortIcon = ({ col }) => (
    <span className={`sort-icon${sortKey !== col ? ' dim' : ''}`}>
      {sortKey === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ' ↕'}
    </span>
  );

  return (
    <div className="table-container">
      {/* Toolbar */}
      <div className="table-toolbar">
        <input
          className="search-input"
          placeholder="Search title or slug…"
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
        />
        <select
          className="filter-select"
          value={filterNeed}
          onChange={e => { setFilterNeed(e.target.value); setPage(1); }}
        >
          <option value="all">All needs</option>
          {USER_NEEDS.map(n => (
            <option key={n} value={n}>{USER_NEED_LABELS[n]}</option>
          ))}
        </select>
        <select
          className="filter-select"
          value={filterConf}
          onChange={e => { setFilterConf(e.target.value); setPage(1); }}
        >
          <option value="all">Any confidence</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        {sections.length > 0 && (
          <select
            className="filter-select"
            value={filterSection}
            onChange={e => { setFilterSection(e.target.value); setPage(1); }}
          >
            <option value="all">All sections</option>
            {sections.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        {postTypes.length > 1 && (
          <select
            className="filter-select"
            value={filterType}
            onChange={e => { setFilterType(e.target.value); setPage(1); }}
          >
            <option value="all">All types</option>
            {postTypes.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
        <select
          className="filter-select"
          value={filterMulti}
          onChange={e => { setFilterMulti(e.target.value); setPage(1); }}
        >
          <option value="all">All articles</option>
          <option value="multi">Multi-need only</option>
          <option value="single">Single-need only</option>
        </select>

        <span className="result-count">{filtered.length} articles</span>
        {(hiddenIds.size > 0 || showHidden) && (
          <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={() => setShowHidden(s => !s)}>
            {showHidden ? 'Hide hidden' : `Hidden (${hiddenIds.size})`}
          </button>
        )}
        <a className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: 12 }} href="/api/export" download>
          ⬇ Export CSV
        </a>
      </div>

      {/* Table */}
      <div className="table-scroll">
        <table className="articles-table">
          <thead>
            <tr>
              <th className="sortable col-date" onClick={() => handleSort('date')}>
                Date<SortIcon col="date" />
              </th>
              <th className="sortable col-title" onClick={() => handleSort('title')}>
                Title<SortIcon col="title" />
              </th>
              <th className="sortable col-need" onClick={() => handleSort('user_need')}>
                User Need<SortIcon col="user_need" />
              </th>
              <th className="sortable col-conf" onClick={() => handleSort('confidence')}>
                Conf.<SortIcon col="confidence" />
              </th>
              <th className="col-reason">Reason</th>
              {gaColumns.map(c => (
                <th key={c} className="sortable col-ga" onClick={() => handleSort(c)}>
                  {GA_DISPLAY[c]}<SortIcon col={c} />
                </th>
              ))}
              <th className="col-actions">Edit</th>
            </tr>
          </thead>
          <tbody>
            {paged.length === 0 ? (
              <tr>
                <td colSpan={6 + gaColumns.length} style={{ textAlign: 'center', padding: '40px', color: '#718096' }}>
                  No articles match the current filters.
                </td>
              </tr>
            ) : paged.map(post => (
              <tr key={post.id} className={[post.manually_corrected ? 'corrected' : '', hiddenIds.has(post.id) ? 'hidden-row' : ''].filter(Boolean).join(' ')}>
                <td className="col-date">{post.date?.slice(0, 10)}</td>
                <td className="col-title">
                  <a href={post.link} target="_blank" rel="noopener noreferrer" title={post.title}>
                    {post.title}
                  </a>
                </td>
                <td className="col-need">
                  {editingId === post.id ? (
                    <select
                      className="need-select"
                      value={editValue}
                      onChange={e => setEditValue(e.target.value)}
                      autoFocus
                    >
                      {USER_NEEDS.filter(n => n !== 'unclassified').map(n => (
                        <option key={n} value={n}>{USER_NEED_LABELS[n]}</option>
                      ))}
                    </select>
                  ) : (
                    <div className="need-cell">
                      <NeedBadge need={post.user_need} />
                      {post.secondary_needs && post.secondary_needs.length > 0 && (
                        <div className="secondary-needs">
                          {post.secondary_needs.split('|').filter(Boolean).map(n => (
                            <NeedBadge key={n} need={n} secondary />
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </td>
                <td className="col-conf">
                  <span className={`conf-badge conf-${post.confidence || 'low'}`}>
                    {post.confidence || '—'}
                  </span>
                </td>
                <td className="col-reason">{post.un_reason}</td>
                {gaColumns.map(c => (
                  <td key={c} className="col-ga">{formatGa(c, post[c])}</td>
                ))}
                <td className="col-actions">
                  {editingId === post.id ? (
                    <>
                      <button className="btn-icon save"   onClick={() => saveEdit(post)}  title="Save">✓</button>
                      <button className="btn-icon cancel" onClick={cancelEdit}             title="Cancel">✕</button>
                    </>
                  ) : (
                    <>
                      <button className="btn-icon edit" onClick={() => startEdit(post)} title="Re-classify">✏</button>
                      <button
                        className={`btn-icon ${hiddenIds.has(post.id) ? 'unhide' : 'hide'}`}
                        onClick={() => toggleHide(post.id)}
                        title={hiddenIds.has(post.id) ? 'Unhide' : 'Hide row'}
                      >
                        {hiddenIds.has(post.id) ? '👁' : '🙈'}
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="pagination">
          <button disabled={page === 1}          onClick={() => setPage(1)}>«</button>
          <button disabled={page === 1}          onClick={() => setPage(p => p - 1)}>‹</button>
          <span>Page {page} of {totalPages}</span>
          <button disabled={page === totalPages} onClick={() => setPage(p => p + 1)}>›</button>
          <button disabled={page === totalPages} onClick={() => setPage(totalPages)}>»</button>
        </div>
      )}
    </div>
  );
}
