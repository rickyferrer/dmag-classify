import {
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Label,
} from 'recharts';
import { USER_NEED_COLORS, USER_NEED_LABELS } from '../constants';

// Detect whichever numeric pageviews/sessions column is present in the data
function extractPageviews(post) {
  const candidates = [
    'ga_Views', 'ga_pageviews', 'ga_sessions', 'ga_screenPageViews',
    'ga_screen_page_views', 'ga_views', 'ga_total_pageviews',
  ];
  for (const k of candidates) {
    const v = parseFloat(post[k]);
    if (!isNaN(v) && v > 0) return v;
  }
  // last-resort: first ga_ column that looks numeric
  for (const [k, v] of Object.entries(post)) {
    if (k.startsWith('ga_') && !isNaN(parseFloat(v)) && parseFloat(v) >= 0) return parseFloat(v);
  }
  return 0;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Custom scatter dot: filled circle + label above
function Dot({ cx, cy, payload }) {
  const color = USER_NEED_COLORS[payload.need] || '#9c9c9c';
  return (
    <g>
      <circle cx={cx} cy={cy} r={12} fill={color} fillOpacity={0.85} stroke="#fff" strokeWidth={1.5} />
      <text
        x={cx} y={cy - 17}
        textAnchor="middle"
        fontSize={10}
        fill="#4a5568"
        fontWeight={500}
      >
        {payload.label}
      </text>
    </g>
  );
}

function quadrantHint(count, avgPv, medCount, medPv) {
  const highSupply  = count  > medCount;
  const highDemand  = avgPv  > medPv;
  if  ( highSupply &&  highDemand) return 'High supply, high demand — healthy';
  if  ( highSupply && !highDemand) return 'Over-produced relative to demand';
  if  (!highSupply &&  highDemand) return 'Under-served — audience wants more';
  return 'Low supply, low demand';
}

export default function ScatterPlot({ data }) {
  // Aggregate per user need
  const agg = {};
  for (const p of data) {
    const n = p.user_need || 'unclassified';
    if (!agg[n]) agg[n] = { need: n, count: 0, totalPv: 0, pvArticles: 0 };
    agg[n].count++;
    const pv = extractPageviews(p);
    if (pv > 0) { agg[n].totalPv += pv; agg[n].pvArticles++; }
  }

  const chartData = Object.values(agg).map(d => ({
    need:       d.need,
    label:      USER_NEED_LABELS[d.need] || d.need,
    count:      d.count,
    avgPv:      d.pvArticles > 0 ? Math.round(d.totalPv / d.pvArticles) : 0,
    totalPv:    Math.round(d.totalPv),
    pvArticles: d.pvArticles,
  }));

  const medCount = median(chartData.map(d => d.count));
  const medPv    = median(chartData.map(d => d.avgPv));

  return (
    <ResponsiveContainer width="100%" height={360}>
      <ScatterChart margin={{ top: 30, right: 24, bottom: 40, left: 24 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#edf2f7" />

        <XAxis dataKey="count" type="number" name="Articles" tick={{ fontSize: 11 }} tickLine={false}>
          <Label value="Articles published (supply)" position="insideBottom" offset={-12} fontSize={11} fill="#718096" />
        </XAxis>
        <YAxis dataKey="avgPv" type="number" name="Avg pageviews" tick={{ fontSize: 11 }} tickLine={false} axisLine={false}>
          <Label value="Avg pageviews (demand)" angle={-90} position="insideLeft" offset={16} fontSize={11} fill="#718096" />
        </YAxis>

        {/* Quadrant lines at median */}
        <ReferenceLine x={medCount} stroke="#cbd5e0" strokeDasharray="5 4" />
        <ReferenceLine y={medPv}    stroke="#cbd5e0" strokeDasharray="5 4" />

        <Tooltip
          cursor={{ strokeDasharray: '3 3' }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const d = payload[0].payload;
            const hint = quadrantHint(d.count, d.avgPv, medCount, medPv);
            return (
              <div className="scatter-tooltip">
                <strong style={{ color: USER_NEED_COLORS[d.need] }}>{d.label}</strong>
                <div>Articles published: <b>{d.count}</b></div>
                <div>Avg pageviews: <b>{d.avgPv.toLocaleString()}</b></div>
                <div>Total pageviews: <b>{d.totalPv.toLocaleString()}</b></div>
                <div className="quad-hint">{hint}</div>
              </div>
            );
          }}
        />

        <Scatter data={chartData} shape={<Dot />} />
      </ScatterChart>
    </ResponsiveContainer>
  );
}
