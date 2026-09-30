// Tables marked with the `responsive-table` class turn into one card per
// row on phones (see styles.css): each cell on its own line, prefixed with
// its column's name. The CSS takes that name from a data-label attribute;
// this copies each column header onto the cells below it, so a table only
// needs the class, not a label on every cell.
function labelTable(table) {
  const headers = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
  if (!headers.length) return;
  table.querySelectorAll('tbody tr').forEach(row => {
    [...row.children].forEach((cell, i) => {
      const label = headers[i] || '';
      if (cell.getAttribute('data-label') !== label) cell.setAttribute('data-label', label);
    });
  });
}

function labelAll(root = document) {
  root.querySelectorAll('table.responsive-table').forEach(labelTable);
}

export function startResponsiveTables() {
  if (typeof window === 'undefined' || !window.MutationObserver) return;
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; labelAll(); });
  };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  schedule();
}
