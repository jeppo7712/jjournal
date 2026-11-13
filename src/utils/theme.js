// The app's colour theme: dark (the default), light, or whatever the device
// is set to ('system', which follows a change live). Chosen per device, so
// it lives in this browser's storage, not in the server's config.
//
// public/index.html applies the stored choice before the page draws (no dark
// flash before a light page, or the other way round); this module keeps it
// applied afterwards and tells subscribers, so what's drawn in JavaScript
// (charts) can follow. The colours themselves are CSS variables: dark in
// src/styles.css :root, light under :root[data-theme="light"].

export const THEME_STORAGE_KEY = 'jjournal_theme';
export const THEME_CHOICES = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'Match the system' },
];
const DEFAULT_CHOICE = 'dark';
const isChoice = value => THEME_CHOICES.some(c => c.value === value);

// The browser's bar colour (installed app, mobile Safari) per theme: the
// app's background, as the page under it.
export const THEME_BAR_COLORS = { dark: '#1E1E2E', light: '#E7EBF1' };

// 'dark' | 'light' for a choice and whether the device prefers light.
export function resolveTheme(choice, systemPrefersLight) {
  if (choice === 'light') return 'light';
  if (choice === 'system') return systemPrefersLight ? 'light' : 'dark';
  return 'dark';
}

const listeners = new Set();
const lightQuery = () => (typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-color-scheme: light)')
  : null);

export function getThemeChoice() {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isChoice(stored) ? stored : DEFAULT_CHOICE;
  } catch {
    return DEFAULT_CHOICE;
  }
}

export function getTheme() {
  return resolveTheme(getThemeChoice(), !!lightQuery()?.matches);
}

// Puts the resolved theme on <html> (what the CSS keys on) and on the
// browser bar, then tells subscribers if it changed.
function apply() {
  const theme = getTheme();
  const root = document.documentElement;
  const changed = root.dataset.theme !== theme;
  root.dataset.theme = theme;
  const bar = document.querySelector('meta[name="theme-color"]');
  if (bar) bar.setAttribute('content', THEME_BAR_COLORS[theme]);
  if (changed) listeners.forEach(fn => fn(theme));
}

export function setThemeChoice(choice) {
  const next = isChoice(choice) ? choice : DEFAULT_CHOICE;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // Storage unavailable: applies for this visit only.
  }
  apply();
}

export function subscribeTheme(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Once, at startup: keeps 'system' in step with the device (dark mode
// switching at sunset, say) and another tab's choice in step with this one.
let started = false;
export function startTheme() {
  if (started || typeof window === 'undefined') return;
  started = true;
  apply();
  const query = lightQuery();
  if (query) {
    const onChange = () => { if (getThemeChoice() === 'system') apply(); };
    if (query.addEventListener) query.addEventListener('change', onChange);
    else if (query.addListener) query.addListener(onChange); // Safari < 14
  }
  window.addEventListener('storage', e => { if (e.key === THEME_STORAGE_KEY) apply(); });
}

// A CSS variable's current value ('--ui-text' → '#E5E7EB'), for colours
// drawn in JavaScript.
export function themeColor(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// The same as six-digit hex, for code that adds an alpha byte or parses it
// ('#FFFFFF' can come back as '#fff' from WebKit).
export function themeHex(name) {
  const value = themeColor(name);
  return /^#[0-9a-f]{3}$/i.test(value) ? `#${value.slice(1).split('').map(c => c + c).join('')}` : value;
}
