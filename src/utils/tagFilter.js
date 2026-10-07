// The Dashboard's tag filter: a list of { kind: 'tag' | 'group', id, mode:
// 'include' | 'exclude' }, saved per account like the other filters.
//
// - exclude a tag: hide trades with it; exclude a group: hide trades with
//   any of its tags ("no mistakes").
// - include: within one group, a trade needs any of the picked tags (Setup
//   FVG or OB); across groups, it needs every group satisfied (FVG and a
//   news day). Including a whole group means any of its tags.

const keyOfTag = (tag) => (tag && tag.group_id != null ? `g${tag.group_id}` : `t${tag ? tag.id : '?'}`);

export function matchesTagFilter(tagIds, tagFilter, tagsById) {
  if (!Array.isArray(tagFilter) || tagFilter.length === 0) return true;
  const ids = new Set((tagIds || []).map(Number));
  const groupIdsOfTrade = new Set();
  ids.forEach(id => {
    const tag = tagsById.get(id);
    if (tag && tag.group_id != null) groupIdsOfTrade.add(tag.group_id);
  });
  const satisfies = f => (f.kind === 'group' ? groupIdsOfTrade.has(f.id) : ids.has(f.id));

  for (const f of tagFilter) {
    if (f.mode === 'exclude' && satisfies(f)) return false;
  }
  const includesByKey = new Map();
  for (const f of tagFilter) {
    if (f.mode !== 'include') continue;
    const key = f.kind === 'group' ? `g${f.id}` : keyOfTag(tagsById.get(f.id) || { id: f.id });
    if (!includesByKey.has(key)) includesByKey.set(key, []);
    includesByKey.get(key).push(f);
  }
  for (const list of includesByKey.values()) {
    if (!list.some(satisfies)) return false;
  }
  return true;
}

// include → exclude → off, like the status tiles.
export function cycleTagFilter(tagFilter, kind, id) {
  const list = Array.isArray(tagFilter) ? tagFilter : [];
  const existing = list.find(f => f.kind === kind && f.id === id);
  const others = list.filter(f => f !== existing);
  if (!existing) return [...others, { kind, id, mode: 'include' }];
  if (existing.mode === 'include') return [...others, { kind, id, mode: 'exclude' }];
  return others;
}

// Drops entries whose tag or group no longer exists.
export function cleanTagFilter(tagFilter, tagsById, groupsById) {
  return (Array.isArray(tagFilter) ? tagFilter : [])
    .filter(f => (f.kind === 'group' ? groupsById.has(f.id) : tagsById.has(f.id)));
}

// Per tag group: each tag's results over the trades carrying it, plus the
// trades with any tag of the group and those with none. `trades` are
// processed trades of one currency. Open positions (e.g. long-term
// holdings) count too: their realised part and unrealised P&L
// (currentReturn, null until the live price is in); win rate, average win
// and loss and P&L per trade are over the closed trades only.
// realisedOf(trade) gives a trade's realised P&L (TradeContext's
// getRealisedPnL; a closed trade's `return` by default).
export function computeTagStats(trades, tags, groups, { realisedOf } = {}) {
  const all = (trades || []).filter(t => t && t.status);
  const realised = realisedOf || (t => (t.status === 'OPEN' ? 0 : Number(t.return) || 0));
  const summarize = (list) => {
    const closed = list.filter(t => t.status !== 'OPEN');
    const open = list.filter(t => t.status === 'OPEN');
    const wins = closed.filter(t => t.status === 'WIN');
    const losses = closed.filter(t => t.status === 'LOSS');
    const sum = (arr, f) => arr.reduce((s, t) => s + (Number(f(t)) || 0), 0);
    const decided = wins.length + losses.length;
    const realisedPnl = sum(list, realised);
    const unrealisedPnl = sum(open, t => t.currentReturn);
    const pricesPending = open.some(t => t.currentReturn === null || t.currentReturn === undefined);
    // Return on the money put in: stocks only (a future's entry total is
    // its contract value, not money paid).
    const cost = sum(list, t => t.entryTotal);
    const returnPct = list.length && cost > 0 && list.every(t => t.type === 'STK')
      ? ((realisedPnl + unrealisedPnl) / cost) * 100 : null;
    return {
      trades: list.length,
      closed: closed.length,
      open: open.length,
      wins: wins.length,
      losses: losses.length,
      winRate: decided ? (wins.length / decided) * 100 : null,
      avgWin: wins.length ? sum(wins, t => t.return) / wins.length : null,
      avgLoss: losses.length ? sum(losses, t => t.return) / losses.length : null,
      expectancy: closed.length ? sum(closed, t => t.return) / closed.length : null,
      realisedPnl,
      unrealisedPnl,
      totalPnl: realisedPnl + unrealisedPnl,
      returnPct,
      pricesPending,
    };
  };
  const has = (t, id) => (t.tag_ids || []).map(Number).includes(id);
  const tagsOfGroup = groupId => tags.filter(tag => (tag.group_id ?? null) === groupId);

  const sections = [...groups.map(g => ({ group: g, tags: tagsOfGroup(g.id) })), { group: null, tags: tagsOfGroup(null) }]
    .filter(section => section.tags.length > 0);

  return sections.map(({ group, tags: groupTags }) => {
    const rows = groupTags
      .map(tag => ({ tag, ...summarize(all.filter(t => has(t, tag.id))) }))
      .filter(row => row.trades > 0)
      .sort((a, b) => b.trades - a.trades || a.tag.name.localeCompare(b.tag.name));
    const anyIds = new Set(groupTags.map(tag => tag.id));
    const withAny = all.filter(t => (t.tag_ids || []).some(id => anyIds.has(Number(id))));
    const withNone = all.filter(t => !(t.tag_ids || []).some(id => anyIds.has(Number(id))));
    return { group, rows, any: summarize(withAny), none: summarize(withNone) };
  });
}
