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
  const [filterNeed, setFilterNeed] = useState('all');
  const [filterConf, setFilterConf] = useState('all');
  const [search,   setSearch]   = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editValue, setEditValue] = useState('');
  const [page,     setPage]     = useState(1);

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
    if (filterNeed !== 'all') d = d.filter(p => p.user_need === filterNeed);
    if (filterConf !== 'all') d = d.filter(p => p.confidence === filterConf);
    if (search) {
      const s = search.toLowerCase();
      d = d.filter(p =>
        (p.title  || '').toLowerCase().includes(s) ||
        (p.slug   || '').toLowerCase().includes(s)
      );
    }
    return [...d].sort((a, b) => {
      let va = a[sortKey] ?? '', vb = b[sortKey] ?? '';
      if (sortKey === 'date') { va = new Date(va); vb = new Date(vb); }
      else if (typeof va === 'string') { va = va.toLowerCase(); vb = vb.toLowerCase(); }
      else { va = parseFloat(va) || 0; vb = parseFloat(vb) || 0; }
      return sortDir === 'asc' ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1);
    });
  }, [data, filterNeed, filterConf, search, sortKey, sortDir]);

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

        <span className="result-count">{filtered.length} articles</span>
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
              <tr key={post.id} className={post.manually_corrected ? 'corrected' : ''}>
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
                    <span
                      className="need-badge"
                      style={{
                        background:   (USER_NEED_COLORS[post.user_need] || '#9c9c9c') + '1a',
                        color:         USER_NEED_COLORS[post.user_need] || '#718096',
                        borderColor:   USER_NEED_COLORS[post.user_need] || '#9c9c9c',
                      }}
                    >
                      {USER_NEED_LABELS[post.user_need] || post.user_need || '—'}
                    </span>
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
                    <button className="btn-icon edit" onClick={() => startEdit(post)} title="Re-classify">✏</button>
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
