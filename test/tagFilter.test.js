// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');

// src/utils is ES module code (the React app's); Node loads it by syntax.
const load = () => import('../src/utils/tagFilter.js');

// Groups: 1 Setup, 2 Mistake. Tags: 10 FVG, 11 OB (Setup), 20 FOMO (Mistake), 30 loose (no group).
const tags = [
  { id: 10, name: 'FVG', group_id: 1 }, { id: 11, name: 'OB', group_id: 1 },
  { id: 20, name: 'FOMO', group_id: 2 }, { id: 30, name: 'loose', group_id: null },
];
const tagsById = new Map(tags.map(t => [t.id, t]));

test('matchesTagFilter: no filter lets everything through', async () => {
  const { matchesTagFilter } = await load();
  assert.equal(matchesTagFilter([], [], tagsById), true);
  assert.equal(matchesTagFilter(undefined, undefined, tagsById), true);
});

test('matchesTagFilter: includes are OR within a group, AND across groups', async () => {
  const { matchesTagFilter } = await load();
  const f = [{ kind: 'tag', id: 10, mode: 'include' }, { kind: 'tag', id: 11, mode: 'include' }];
  assert.equal(matchesTagFilter([10], f, tagsById), true);
  assert.equal(matchesTagFilter([11], f, tagsById), true);
  assert.equal(matchesTagFilter([20], f, tagsById), false);
  const g = [...f, { kind: 'tag', id: 20, mode: 'include' }];
  assert.equal(matchesTagFilter([10], g, tagsById), false);
  assert.equal(matchesTagFilter([10, 20], g, tagsById), true);
});

test('matchesTagFilter: a whole group, included or excluded', async () => {
  const { matchesTagFilter } = await load();
  const noMistakes = [{ kind: 'group', id: 2, mode: 'exclude' }];
  assert.equal(matchesTagFilter([10], noMistakes, tagsById), true);
  assert.equal(matchesTagFilter([10, 20], noMistakes, tagsById), false);
  const anySetup = [{ kind: 'group', id: 1, mode: 'include' }];
  assert.equal(matchesTagFilter([11], anySetup, tagsById), true);
  assert.equal(matchesTagFilter([30], anySetup, tagsById), false);
});

test('matchesTagFilter: excluding a tag', async () => {
  const { matchesTagFilter } = await load();
  const f = [{ kind: 'tag', id: 30, mode: 'exclude' }];
  assert.equal(matchesTagFilter([30, 10], f, tagsById), false);
  assert.equal(matchesTagFilter([10], f, tagsById), true);
});

test('cycleTagFilter: include, exclude, off', async () => {
  const { cycleTagFilter } = await load();
  let f = cycleTagFilter([], 'tag', 10);
  assert.deepEqual(f, [{ kind: 'tag', id: 10, mode: 'include' }]);
  f = cycleTagFilter(f, 'tag', 10);
  assert.deepEqual(f, [{ kind: 'tag', id: 10, mode: 'exclude' }]);
  assert.deepEqual(cycleTagFilter(f, 'tag', 10), []);
});

test('computeTagStats: per tag, and any / none of the group, over closed trades', async () => {
  const { computeTagStats } = await load();
  const groups = [{ id: 1, name: 'Setup' }, { id: 2, name: 'Mistake' }];
  const trades = [
    { status: 'WIN', return: 100, tag_ids: [10] },
    { status: 'LOSS', return: -50, tag_ids: [10, 20] },
    { status: 'LOSS', return: -30, tag_ids: [20] },
    { status: 'WIN', return: 40, tag_ids: [] },
    { status: 'OPEN', return: null, tag_ids: [20] },
  ];
  const [setup, mistake, loose] = computeTagStats(trades, tags, groups);
  assert.equal(setup.group.name, 'Setup');
  assert.deepEqual(setup.rows.map(r => [r.tag.name, r.trades, r.totalPnl]), [['FVG', 2, 50]]);
  assert.equal(setup.rows[0].winRate, 50);
  assert.equal(mistake.any.trades, 2);
  assert.equal(mistake.any.totalPnl, -80);
  assert.equal(mistake.none.trades, 2);
  assert.equal(mistake.none.totalPnl, 140);
  assert.equal(loose.group, null);
  assert.deepEqual(loose.rows, []);
});
