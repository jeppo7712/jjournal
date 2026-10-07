import React from 'react';
import { accountOptionGroups } from '../../utils/accountTree';

// The <option>s of an account dropdown, grouped Real / Paper with each
// sub-account indented under its parent (accountOptionGroups). A native
// <select> keeps the phone's own picker; leading spaces in an option collapse,
// hence the non-breaking ones.
const indent = depth => (depth > 0 ? `${'   '.repeat(depth - 1)} ↳ ` : '');

export default function AccountOptions({ accounts, exclude, label = a => a.name }) {
  const show = ({ account }) => exclude == null || String(account.id) !== String(exclude);
  return accountOptionGroups(accounts)
    .map(group => ({ ...group, options: group.options.filter(show) }))
    .filter(group => group.options.length > 0)
    .map(group => (
      <optgroup key={group.key} label={group.label}>
        {group.options.map(({ account, depth }) => (
          <option key={account.id} value={String(account.id)}>{indent(depth)}{label(account)}</option>
        ))}
      </optgroup>
    ));
}
