import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, LabelList,
} from 'recharts';
import { USER_NEED_COLORS, USER_NEED_LABELS } from '../constants';

export default function NeedsBarChart({ data }) {
  const counts = {};
  for (const p of data) {
    const n = p.user_need || 'unclassified';
    counts[n] = (counts[n] || 0) + 1;
  }

  const chartData = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([need, count]) => ({
      need,
      label: USER_NEED_LABELS[need] || need,
      count,
      pct:   ((count / data.length) * 100).toFixed(1),
    }));

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart
        data={chartData}
        margin={{ top: 16, right: 16, left: 0, bottom: 72 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="#edf2f7" vertical={false} />
        <XAxis
          dataKey="label"
          angle={-38}
          textAnchor="end"
          tick={{ fontSize: 11, fill: '#718096' }}
          interval={0}
          tickLine={false}
        />
        <YAxis
          tick={{ fontSize: 11, fill: '#718096' }}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip
          cursor={{ fill: 'rgba(0,0,0,.04)' }}
          formatter={(value, _name, { payload }) => [
            `${value} articles (${payload.pct}%)`,
            'Count',
          ]}
          contentStyle={{ fontSize: 12, borderRadius: 6 }}
        />
        <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={48}>
          {chartData.map((entry) => (
            <Cell key={entry.need} fill={USER_NEED_COLORS[entry.need] || '#9c9c9c'} />
          ))}
          <LabelList
            dataKey="count"
            position="top"
            style={{ fontSize: 11, fill: '#718096', fontWeight: 600 }}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
