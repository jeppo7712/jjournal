// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');

// src/utils is ES module code (the React app's); Node loads it by syntax.
const load = () => import('../src/utils/accountTree.js');

const accounts = [
  { id: 1, name: 'Stocks', parent_account_id: 4 },
  { id: 2, name: 'Paper 2025', is_virtual: true },
  { id: 3, name: 'crypto' },
  { id: 4, name: 'Main' },
  { id: 5, name: 'Paper 2026', is_virtual: true },
  { id: 6, name: 'Allocation', parent_account_id: 4 },
  { id: 7, name: 'Orphan', parent_account_id: 99 },
];

test('accountOptionGroups: Real before Paper, by name, sub-accounts under their parent', async () => {
  const { accountOptionGroups } = await load();
  const flat = accountOptionGroups(accounts).map(g => [g.label, g.options.map(o => `${o.depth}:${o.account.name}`)]);
  assert.deepEqual(flat, [
    ['Real', ['0:crypto', '0:Main', '1:Allocation', '1:Stocks', '0:Orphan']],
    ['Paper', ['0:Paper 2025', '0:Paper 2026']],
  ]);
});

test('accountOptionGroups: an empty group is left out', async () => {
  const { accountOptionGroups } = await load();
  assert.deepEqual(accountOptionGroups([{ id: 1, name: 'A' }]).map(g => g.label), ['Real']);
  assert.deepEqual(accountOptionGroups(null), []);
});

test('accountOptionGroups: archived accounts last, a parent taking its sub-accounts along', async () => {
  const { accountOptionGroups } = await load();
  const list = [
    { id: 1, name: 'Main' },
    { id: 2, name: 'Old sub', parent_account_id: 1, archived: true },
    { id: 3, name: 'Paper 2025', is_virtual: true, archived: true },
    { id: 4, name: 'Paper 2025 sub', parent_account_id: 3, is_virtual: true },
    { id: 5, name: 'Paper 2026', is_virtual: true },
  ];
  const flat = accountOptionGroups(list).map(g => [g.label, g.options.map(o => `${o.depth}:${o.account.name}`)]);
  assert.deepEqual(flat, [
    ['Real', ['0:Main']],
    ['Paper', ['0:Paper 2026']],
    ['Archived', ['0:Paper 2025', '1:Paper 2025 sub', '0:Old sub']],
  ]);
});
