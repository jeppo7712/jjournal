import { DateTime } from 'luxon';
import { formatNumber } from '../../utils/numberFormat';

// One look for every chart on the Stats page: recessive axes and grid, thin
// 2px lines over a soft gradient wash, a dot on the latest value, a hairline
// crosshair and a card-style tooltip. Colours follow the app's tokens
// (src/styles.css); green/red keep their meaning (above/below a baseline).

export const COLORS = {
  text: '#E5E7EB',
  muted: '#8B93A3',
  faint: '#6B7280',
  grid: 'rgba(255, 255, 255, 0.05)',
  baseline: 'rgba(255, 255, 255, 0.16)',
  surface: '#1D2130',
  accent: '#3B82F6',
  green: '#4ADE80',
  red: '#F87171',
  amber: '#F59E0B',
  slate: '#8B93A3',
  other: '#4B5263',
};

// Fixed order, never cycled: past eight, the rest folds into "Other".
// Validated as a set (CVD and normal-vision separation, contrast) against
// the card surface #1D2130.
export const CATEGORICAL = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

const FONT_FAMILY = "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const tickFont = { family: FONT_FAMILY, size: 11 };

export const rgba = (hex, alpha) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};

const clamp01 = v => Math.min(1, Math.max(0, v));

// Where `value` sits between the plot's top (0) and bottom (1).
const offsetOf = (chart, value) => {
  const { chartArea, scales: { y } } = chart;
  return clamp01((y.getPixelForValue(value) - chartArea.top) / (chartArea.bottom - chartArea.top));
};

// Line colour that turns from green to red exactly where it crosses
// `baseline` (0 for returns and P&L, 50 for a win rate).
export const polarityStroke = (baseline = 0) => ({ chart }) => {
  if (!chart.chartArea) return COLORS.green;
  const t = offsetOf(chart, baseline);
  const g = chart.ctx.createLinearGradient(0, chart.chartArea.top, 0, chart.chartArea.bottom);
  g.addColorStop(0, COLORS.green);
  g.addColorStop(t, COLORS.green);
  g.addColorStop(t, COLORS.red);
  g.addColorStop(1, COLORS.red);
  return g;
};

// The matching wash: strongest far from the baseline, fading into it.
export const polarityFill = (baseline = 0) => ({ chart }) => {
  if (!chart.chartArea) return 'transparent';
  const t = offsetOf(chart, baseline);
  const g = chart.ctx.createLinearGradient(0, chart.chartArea.top, 0, chart.chartArea.bottom);
  g.addColorStop(0, rgba(COLORS.green, 0.26));
  g.addColorStop(t, rgba(COLORS.green, 0.02));
  g.addColorStop(t, rgba(COLORS.red, 0.02));
  g.addColorStop(1, rgba(COLORS.red, 0.26));
  return g;
};

// A single-hue wash from the top of the plot down to nothing.
export const areaFill = hex => ({ chart }) => {
  if (!chart.chartArea) return 'transparent';
  const g = chart.ctx.createLinearGradient(0, chart.chartArea.top, 0, chart.chartArea.bottom);
  g.addColorStop(0, rgba(hex, 0.24));
  g.addColorStop(1, rgba(hex, 0));
  return g;
};

// Only the latest point gets a dot, ringed in the card colour so it stays
// legible on top of the line.
export const endDot = colorFor => ({
  pointRadius: ctx => (ctx.dataIndex === ctx.dataset.data.length - 1 ? 4 : 0),
  pointHoverRadius: 5,
  pointBackgroundColor: ctx => colorFor(ctx.raw),
  pointHoverBackgroundColor: ctx => colorFor(ctx.raw),
  pointBorderColor: COLORS.surface,
  pointHoverBorderColor: COLORS.surface,
  pointBorderWidth: 2,
  pointHoverBorderWidth: 2,
});

export const lineStyle = {
  borderWidth: 2,
  borderJoinStyle: 'round',
  borderCapStyle: 'round',
  tension: 0.35,
  cubicInterpolationMode: 'monotone',
};

// Hairline that follows the hovered point. Passed per chart (`plugins`
// prop), so it never touches the Dashboard's charts.
export const crosshairPlugin = {
  id: 'jjCrosshair',
  afterDatasetsDraw(chart) {
    const active = chart.tooltip && chart.tooltip.getActiveElements();
    if (!active || !active.length) return;
    const { ctx, chartArea } = chart;
    const x = active[0].element.x;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.stroke();
    ctx.restore();
  },
};

const tooltipBase = {
  enabled: true,
  backgroundColor: 'rgba(20, 24, 34, 0.96)',
  borderColor: '#2C3244',
  borderWidth: 1,
  cornerRadius: 10,
  padding: { x: 12, y: 10 },
  caretSize: 0,
  caretPadding: 12,
  titleColor: COLORS.muted,
  titleFont: { family: FONT_FAMILY, size: 11, weight: '500' },
  titleMarginBottom: 6,
  bodyColor: COLORS.text,
  bodyFont: { family: FONT_FAMILY, size: 13, weight: '600' },
  bodySpacing: 6,
  boxWidth: 8,
  boxHeight: 8,
  boxPadding: 6,
  usePointStyle: true,
  displayColors: false,
};

// The zero line (or another baseline) is drawn a step brighter than the
// rest of the grid, so above/below reads at a glance.
const gridColor = baseline => ctx => (
  baseline !== null && ctx.tick && ctx.tick.value === baseline ? COLORS.baseline : COLORS.grid
);

export const scaleX = (extra = {}) => ({
  grid: { display: false },
  border: { display: false },
  ...extra,
  ticks: { color: COLORS.faint, font: tickFont, maxRotation: 0, autoSkipPadding: 28, padding: 6, ...(extra.ticks || {}) },
});

export const scaleY = ({ baseline = 0, ...extra } = {}) => ({
  position: 'right',
  grid: { color: gridColor(baseline), drawTicks: false },
  border: { display: false },
  ...extra,
  ticks: { color: COLORS.faint, font: tickFont, maxTicksLimit: 6, padding: 10, ...(extra.ticks || {}) },
});

export const baseOptions = ({ tooltip = {}, scales, multi = false, ...rest } = {}) => ({
  responsive: true,
  maintainAspectRatio: false,
  animation: { duration: 650, easing: 'easeOutQuart' },
  interaction: { mode: 'index', intersect: false },
  layout: { padding: { top: 8, right: 4, bottom: 0, left: 0 } },
  scales,
  plugins: {
    legend: { display: false },
    tooltip: { ...tooltipBase, displayColors: multi, ...tooltip },
    // The Dashboard registers its own crosshair globally; it stays off here.
    verticalLine: { enabled: false },
  },
  ...rest,
});

// --- Number and date formatting for axes and tooltips ---

export const signed = (value, decimals = 2) => `${value > 0 ? '+' : ''}${formatNumber(value, decimals)}`;

export const percentTick = value => `${formatNumber(value, Math.abs(value) >= 10 || Number.isInteger(value) ? 0 : 1)}%`;

// Compact money for an axis: $950, $12.5k, $1.2M.
export const moneyTick = mark => value => {
  const a = Math.abs(value);
  const body = a >= 1e6 ? `${formatNumber(a / 1e6, 1, true)}M`
    : a >= 1e4 ? `${formatNumber(a / 1e3, 1, true)}k`
      : formatNumber(a, a >= 100 || Number.isInteger(a) ? 0 : 2);
  return `${value < 0 ? '-' : ''}${mark}${body}`;
};

const parseLabel = label => {
  if (typeof label !== 'string') return null;
  const day = DateTime.fromFormat(label, 'dd/MM/yyyy');
  if (day.isValid) return { dt: day, unit: 'day' };
  const month = DateTime.fromFormat(label, 'yyyy-MM');
  if (month.isValid) return { dt: month, unit: 'month' };
  return null;
};

// Short x-axis labels ("12 Jun", or "Jun '26" over longer spans) from the
// dd/MM/yyyy and yyyy-MM labels the series carry.
export const dateTick = labels => {
  const first = parseLabel(labels[0]);
  const last = parseLabel(labels[labels.length - 1]);
  const long = first && last && last.dt.diff(first.dt, 'months').months > 10;
  return function tick(value) {
    const label = this.getLabelForValue(value);
    const parsed = parseLabel(label);
    if (!parsed) return label;
    return parsed.unit === 'month' || long ? parsed.dt.toFormat("LLL ''yy") : parsed.dt.toFormat('d LLL');
  };
};

// Tooltip title: the full date.
export const dateTitle = items => {
  const parsed = items.length ? parseLabel(items[0].label) : null;
  if (!parsed) return items.length ? items[0].label : '';
  return parsed.unit === 'month' ? parsed.dt.toFormat('LLLL yyyy') : parsed.dt.toFormat('ccc d LLL yyyy');
};

// Hold time in hours → "45m", "6.5h", "3.2d".
export const formatHold = hours => {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${formatNumber(hours, 1, true)}h`;
  return `${formatNumber(hours / 24, 1, true)}d`;
};

// Ticks for a logarithmic hold-time axis, at durations people think in.
export const HOLD_TICKS = [
  [1 / 60, '1m'], [5 / 60, '5m'], [0.25, '15m'], [0.5, '30m'], [1, '1h'], [2, '2h'], [4, '4h'], [8, '8h'],
  [24, '1d'], [48, '2d'], [96, '4d'], [168, '1w'], [336, '2w'], [720, '1mo'], [2160, '3mo'], [4380, '6mo'], [8760, '1y'],
];
