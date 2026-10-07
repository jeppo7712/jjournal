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
// always shares its parent's), then Archived; each top-level account by name
// with its sub-accounts right below it. depth is how far down the tree it
// sits. An archived account takes its sub-accounts along; an archived
// sub-account of an account in use goes to Archived on its own.
export function accountOptionGroups(accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  const ids = new Set(list.map(a => String(a.id)));
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  const groups = [
    { key: 'real', label: 'Real', options: [] },
    { key: 'paper', label: 'Paper', options: [] },
    { key: 'archived', label: 'Archived', options: [] },
  ];
  const groupOf = a => (a.archived ? groups[2] : a.is_virtual ? groups[1] : groups[0]);
  const seen = new Set();
  const walk = (account, depth, group) => {
    if (seen.has(account.id)) return;
    seen.add(account.id);
    group.options.push({ account, depth });
    list.filter(a => String(a.parent_account_id) === String(account.id))
      .filter(child => group === groups[2] || !child.archived)
      .sort(byName)
      .forEach(child => walk(child, depth + 1, group));
  };
  const isRoot = a => a.parent_account_id == null || !ids.has(String(a.parent_account_id));
  list.filter(isRoot).sort(byName).forEach(a => walk(a, 0, groupOf(a)));
  // Archived sub-accounts whose parent is still in use.
  list.filter(a => !seen.has(a.id)).sort(byName).forEach(a => walk(a, 0, groups[2]));
  return groups.filter(g => g.options.length > 0);
}
