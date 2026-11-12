// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// src/utils is ES module code (the React app's); Node loads it by syntax.
const load = () => import('../src/utils/theme.js');

test('resolveTheme: dark by default, light when chosen, the system\'s for "system"', async () => {
  const { resolveTheme } = await load();
  assert.equal(resolveTheme('dark', true), 'dark');
  assert.equal(resolveTheme('light', false), 'light');
  assert.equal(resolveTheme('system', true), 'light');
  assert.equal(resolveTheme('system', false), 'dark');
  assert.equal(resolveTheme(undefined, true), 'dark');
  assert.equal(resolveTheme('bogus', true), 'dark');
});

// The early script in public/index.html repeats the storage key and the
// light bar colour; theme.js must agree with it.
test('public/index.html uses the same storage key and bar colour as theme.js', async () => {
  const { THEME_STORAGE_KEY, THEME_BAR_COLORS } = await load();
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.ok(html.includes(`localStorage.getItem('${THEME_STORAGE_KEY}')`));
  assert.ok(html.includes(`'${THEME_BAR_COLORS.light}'`));
  assert.ok(html.includes(`content="${THEME_BAR_COLORS.dark}"`));
});

// Every token the dark theme defines has a light value, so nothing drawn
// from a token stays dark on a light page.
test('styles.css: the light theme overrides every colour token of :root', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/styles.css'), 'utf8');
  const block = (selector) => {
    const start = css.indexOf(`${selector} {`);
    assert.ok(start >= 0, `${selector} block missing`);
    return css.slice(start, css.indexOf('}', start));
  };
  const names = (text) => new Set([...text.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)]
    .filter(([, , value]) => /#|rgba?\(/.test(value))
    .map(([, name]) => name));
  const dark = names(block(':root'));
  const light = names(block(':root[data-theme="light"]'));
  const missing = [...dark].filter(name => !light.has(name));
  assert.deepEqual(missing, []);
});
