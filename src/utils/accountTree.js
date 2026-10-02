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
