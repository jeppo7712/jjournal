// How numbers are displayed: the decimal mark and whether thousands are
// grouped. One app-wide choice (Settings → General), stored in the server's
// config so every device shows the same, and cached in this browser so the
// first paint already uses it.
//
// Display only. Input fields keep plain numbers (1234.56): a grouped or
// comma-decimal value typed into one would not parse back.

const STORAGE_KEY = 'jjournal_number_format';

export const NUMBER_FORMATS = [
  { value: 'plain', label: '123456.78', group: '', decimal: '.' },
  { value: 'comma', label: '1,234,567.89', group: ',', decimal: '.' },
  { value: 'dot', label: '1.234.567,89', group: '.', decimal: ',' },
];
const DEFAULT_FORMAT = 'plain';
const byValue = Object.fromEntries(NUMBER_FORMATS.map(f => [f.value, f]));

function loadStored() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return byValue[stored] ? stored : DEFAULT_FORMAT;
  } catch {
    return DEFAULT_FORMAT;
  }
}

let current = loadStored();
const listeners = new Set();

export function getNumberFormat() {
  return current;
}

// Applies a format (from the server config or the settings picker) and
// tells subscribers, so the app can redraw what's already on screen.
export function setNumberFormat(value) {
  const next = byValue[value] ? value : DEFAULT_FORMAT;
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Storage unavailable: the server config still has it.
  }
  listeners.forEach(fn => fn(next));
}

export function subscribeNumberFormat(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// formatNumber(1234567.891)        -> "1234567.89" / "1,234,567.89" / "1.234.567,89"
// formatNumber(0.5, 4)             -> "0.5000"
// formatNumber(21345.25, 8, true)  -> "21345.25" (trailing zeros dropped)
// Non-finite input comes back as toFixed would give it ("NaN", "Infinity").
export function formatNumber(value, decimals = 2, trimZeros = false) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(n);
  const { group, decimal } = byValue[current];
  let fixed = Math.abs(n).toFixed(decimals);
  if (trimZeros && fixed.includes('.')) fixed = fixed.replace(/\.?0+$/, '');
  const [intPart, fracPart] = fixed.split('.');
  const grouped = group ? intPart.replace(/\B(?=(\d{3})+(?!\d))/g, group) : intPart;
  // No minus on a value that rounds to zero ("-0.00").
  const sign = n < 0 && /[1-9]/.test(fixed) ? '-' : '';
  return `${sign}${grouped}${fracPart !== undefined ? decimal + fracPart : ''}`;
}

// For values that arrive already rounded as strings ("1234.50") or as
// placeholders ("N/A", "—", "Infinity"): numbers are reformatted keeping
// their decimals (counts stay whole), anything else is shown unchanged.
export function formatNumberText(value) {
  if (typeof value === 'number') return formatNumber(value, Number.isInteger(value) ? 0 : 2);
  const text = String(value ?? '');
  const match = /^-?\d+(?:\.(\d+))?$/.exec(text.trim());
  if (!match) return text;
  return formatNumber(Number(text), match[1] ? match[1].length : 0);
}
