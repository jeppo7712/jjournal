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

// Per tag group: each tag's results over the closed trades carrying it,
// plus the trades with any tag of the group and those with none.
// `trades` are processed trades of one currency (status, return, tag_ids).
export function computeTagStats(trades, tags, groups) {
  const closed = (trades || []).filter(t => t.status && t.status !== 'OPEN');
  const summarize = (list) => {
    const wins = list.filter(t => t.status === 'WIN');
    const losses = list.filter(t => t.status === 'LOSS');
    const sum = arr => arr.reduce((s, t) => s + (Number(t.return) || 0), 0);
    const decided = wins.length + losses.length;
    const avgWin = wins.length ? sum(wins) / wins.length : 0;
    const avgLoss = losses.length ? sum(losses) / losses.length : 0;
    return {
      trades: list.length,
      wins: wins.length,
      losses: losses.length,
      winRate: decided ? (wins.length / decided) * 100 : null,
      avgWin: wins.length ? avgWin : null,
      avgLoss: losses.length ? avgLoss : null,
      expectancy: list.length ? sum(list) / list.length : null,
      totalPnl: sum(list),
    };
  };
  const has = (t, id) => (t.tag_ids || []).map(Number).includes(id);
  const tagsOfGroup = groupId => tags.filter(tag => (tag.group_id ?? null) === groupId);

  const sections = [...groups.map(g => ({ group: g, tags: tagsOfGroup(g.id) })), { group: null, tags: tagsOfGroup(null) }]
    .filter(section => section.tags.length > 0);

  return sections.map(({ group, tags: groupTags }) => {
    const rows = groupTags
      .map(tag => ({ tag, ...summarize(closed.filter(t => has(t, tag.id))) }))
      .filter(row => row.trades > 0)
      .sort((a, b) => b.trades - a.trades || a.tag.name.localeCompare(b.tag.name));
    const anyIds = new Set(groupTags.map(tag => tag.id));
    const withAny = closed.filter(t => (t.tag_ids || []).some(id => anyIds.has(Number(id))));
    const withNone = closed.filter(t => !(t.tag_ids || []).some(id => anyIds.has(Number(id))));
    return { group, rows, any: summarize(withAny), none: summarize(withNone) };
  });
}
