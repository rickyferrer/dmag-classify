import { useState } from 'react';
import {
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Label,
} from 'recharts';
import { USER_NEED_COLORS, USER_NEED_LABELS } from '../constants';

const METRICS = [
  { key: 'ga_Views',                                       label: 'Views',               agg: 'avg' },
  { key: 'ga_Active users',                                label: 'Active Users',         agg: 'avg' },
  { key: 'ga_Total users',                                 label: 'Total Users',          agg: 'sum' },
  { key: 'ga_Average engagement time per active user',     label: 'Avg Engagement (s)',   agg: 'avg' },
];

function extractMetric(post, key) {
  const v = parseFloat(post[key]);
  return isNaN(v) ? 0 : v;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function Dot({ cx, cy, payload }) {
  const color = USER_NEED_COLORS[payload.need] || '#9c9c9c';
  return (
    <g>
      <circle cx={cx} cy={cy} r={12} fill={color} fillOpacity={0.85} stroke="#fff" strokeWidth={1.5} />
      <text x={cx} y={cy - 17} textAnchor="middle" fontSize={10} fill="#4a5568" fontWeight={500}>
        {payload.label}
      </text>
    </g>
  );
}

function quadrantHint(count, avgMetric, medCount, medMetric) {
  const highSupply = count      > medCount;
  const highDemand = avgMetric  > medMetric;
  if  ( highSupply &&  highDemand) return 'High supply, high demand — healthy';
  if  ( highSupply && !highDemand) return 'Over-produced relative to demand';
  if  (!highSupply &&  highDemand) return 'Under-served — audience wants more';
  return 'Low supply, low demand';
}

export default function ScatterPlot({ data }) {
  const [metricKey, setMetricKey] = useState('ga_Views');
  const selectedMetric = METRICS.find(m => m.key === metricKey) || METRICS[0];

  // Aggregate per user need
  const agg = {};
  for (const p of data) {
    const n = p.user_need || 'unclassified';
    if (!agg[n]) agg[n] = { need: n, count: 0, totalMetric: 0, metricArticles: 0 };
    agg[n].count++;
    const val = extractMetric(p, selectedMetric.key);
    if (val > 0) { agg[n].totalMetric += val; agg[n].metricArticles++; }
  }

  const chartData = Object.values(agg).map(d => ({
    need:         d.need,
    label:        USER_NEED_LABELS[d.need] || d.need,
    count:        d.count,
    avgMetric:    d.metricArticles > 0
      ? (selectedMetric.agg === 'sum'
          ? Math.round(d.totalMetric)
          : Math.round(d.totalMetric / d.metricArticles))
      : 0,
    totalMetric:  Math.round(d.totalMetric),
    metricArticles: d.metricArticles,
  }));

  const medCount  = median(chartData.map(d => d.count));
  const medMetric = median(chartData.map(d => d.avgMetric));

  return (
    <>
      <div className="metric-selector-row">
        <span className="metric-selector-label">Y axis:</span>
        <select
          className="filter-select"
          value={metricKey}
          onChange={e => setMetricKey(e.target.value)}
        >
          {METRICS.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
        </select>
      </div>

      <ResponsiveContainer width="100%" height={340}>
        <ScatterChart margin={{ top: 30, right: 24, bottom: 40, left: 24 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#edf2f7" />

          <XAxis dataKey="count" type="number" name="Articles" tick={{ fontSize: 11 }} tickLine={false}>
            <Label value="Articles published (supply)" position="insideBottom" offset={-12} fontSize={11} fill="#718096" />
          </XAxis>
          <YAxis dataKey="avgMetric" type="number" name={selectedMetric.label} tick={{ fontSize: 11 }} tickLine={false} axisLine={false}>
            <Label value={selectedMetric.label} angle={-90} position="insideLeft" offset={16} fontSize={11} fill="#718096" />
          </YAxis>

          <ReferenceLine x={medCount}  stroke="#cbd5e0" strokeDasharray="5 4" />
          <ReferenceLine y={medMetric} stroke="#cbd5e0" strokeDasharray="5 4" />

          <Tooltip
            cursor={{ strokeDasharray: '3 3' }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0].payload;
              const hint = quadrantHint(d.count, d.avgMetric, medCount, medMetric);
              const label = selectedMetric.agg === 'sum' ? `Total ${selectedMetric.label}` : `Avg ${selectedMetric.label}`;
              return (
                <div className="scatter-tooltip">
                  <strong style={{ color: USER_NEED_COLORS[d.need] }}>{d.label}</strong>
                  <div>Articles published: <b>{d.count}</b></div>
                  <div>{label}: <b>{d.avgMetric.toLocaleString()}</b></div>
                  {selectedMetric.agg === 'avg' && (
                    <div>Total {selectedMetric.label}: <b>{d.totalMetric.toLocaleString()}</b></div>
                  )}
                  <div className="quad-hint">{hint}</div>
                </div>
              );
            }}
          />

          <Scatter data={chartData} shape={<Dot />} />
        </ScatterChart>
      </ResponsiveContainer>
    </>
  );
}
