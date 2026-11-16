// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');

// src/utils is ES module code (the React app's); Node loads it by syntax.
const load = () => import('../src/utils/sheetGesture.js');

// A tiny stand-in for DOM elements: parent links, attributes for closest().
function el(tag, { attrs = {}, scrollTop = 0, parent = null } = {}) {
  const node = { tag, attrs, scrollTop, parentElement: parent };
  node.matches = (sel) => sel.split(',').map(x => x.trim()).some(x => {
    const attr = x.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
    if (attr) return attr[1] in attrs && (attr[2] === undefined || attrs[attr[1]] === attr[2]);
    return x === tag;
  });
  node.closest = (sel) => {
    for (let n = node; n; n = n.parentElement) if (n.matches(sel)) return n;
    return null;
  };
  node.contains = (other) => {
    for (let n = other; n; n = n.parentElement) if (n === node) return true;
    return false;
  };
  return node;
}

function windowTree({ bodyScroll = 0 } = {}) {
  const overlay = el('div');
  const sheet = el('div', { parent: overlay });
  const header = el('div', { attrs: { 'data-sheet-handle': '' }, parent: sheet });
  const title = el('span', { parent: header });
  const body = el('div', { scrollTop: bodyScroll, parent: sheet });
  const text = el('p', { parent: body });
  const input = el('input', { parent: body });
  const editor = el('div', { attrs: { contenteditable: 'true' }, parent: body });
  const canvas = el('canvas', { parent: body });
  const viewer = el('div', { attrs: { 'data-sheet-no-drag': '' }, parent: sheet });
  const photo = el('img', { parent: viewer });
  return { overlay, sheet, title, text, input, editor, canvas, photo };
}

test('dragStart: the title bar always, the content only at its top', async () => {
  const { dragStart } = await load();
  const top = windowTree();
  assert.equal(dragStart(top.title, top.sheet), 'handle');
  assert.equal(dragStart(top.text, top.sheet), 'content');
  const scrolled = windowTree({ bodyScroll: 40 });
  assert.equal(dragStart(scrolled.title, scrolled.sheet), 'handle');
  assert.equal(dragStart(scrolled.text, scrolled.sheet), null);
});

test('dragStart: never from a field, an editor, a chart or a marked overlay', async () => {
  const { dragStart } = await load();
  const t = windowTree();
  assert.equal(dragStart(t.input, t.sheet), null);
  assert.equal(dragStart(t.editor, t.sheet), null);
  assert.equal(dragStart(t.canvas, t.sheet), null);
  assert.equal(dragStart(t.photo, t.sheet), null);
  assert.equal(dragStart(t.overlay, t.sheet), null);
});

test('firstMoveIsDrag: content only downward, never sideways', async () => {
  const { firstMoveIsDrag } = await load();
  assert.equal(firstMoveIsDrag('content', 0, 3), true);
  assert.equal(firstMoveIsDrag('content', 0, -3), false);
  assert.equal(firstMoveIsDrag('content', 5, 2), false);
  assert.equal(firstMoveIsDrag('handle', 0, -3), true);
  assert.equal(firstMoveIsDrag('handle', 5, 2), false);
});

test('shouldDismiss: far enough down, or a flick', async () => {
  const { shouldDismiss } = await load();
  assert.equal(shouldDismiss(170, 0, 800), true);
  assert.equal(shouldDismiss(120, 0, 800), false);
  assert.equal(shouldDismiss(100, 0, 300), true); // a short card: 30% of it
  assert.equal(shouldDismiss(50, 0.8, 800), true);
  assert.equal(shouldDismiss(20, 2, 800), false);
  assert.equal(shouldDismiss(0, 2, 800), false);
});
