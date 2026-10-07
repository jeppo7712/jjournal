// Every account below `accountId` in the parent/sub-account tree (children,
// their children, ...), not just direct children — the same recursive
// roll-up routes/accounts.js does for cash and holdings.
export function descendantAccountIds(accounts, accountId) {
  const list = Array.isArray(accounts) ? accounts : [];
  const ids = [];
  const frontier = [accountId];
  while (frontier.length > 0) {
    const parentId = frontier.pop();
    list
      .filter(a => String(a.parent_account_id) === String(parentId))
      .forEach(a => { ids.push(a.id); frontier.push(a.id); });
  }
  return ids;
}

// Accounts for a dropdown: Real first, then Paper (is_virtual — a sub-account
// always shares its parent's), each top-level account by name with its
// sub-accounts right below it. depth is how far down the tree it sits.
export function accountOptionGroups(accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  const ids = new Set(list.map(a => String(a.id)));
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  const groups = [
    { key: 'real', label: 'Real', options: [] },
    { key: 'paper', label: 'Paper', options: [] },
  ];
  const seen = new Set();
  const walk = (account, depth, group) => {
    if (seen.has(account.id)) return;
    seen.add(account.id);
    group.options.push({ account, depth });
    list.filter(a => String(a.parent_account_id) === String(account.id)).sort(byName)
      .forEach(child => walk(child, depth + 1, group));
  };
  list.filter(a => a.parent_account_id == null || !ids.has(String(a.parent_account_id)))
    .sort(byName)
    .forEach(a => walk(a, 0, a.is_virtual ? groups[1] : groups[0]));
  return groups.filter(g => g.options.length > 0);
}
