import React, { useMemo, useState } from 'react';
import { useTags, tagsApi } from '../../context/TagsContext';
import TagChip, { UNGROUPED_COLOR } from '../common/TagChip';
import IconButton from '../common/IconButton';
import { notify, confirmDialog, promptDialog } from '../common/Dialogs';
import own from './TagSettings.module.css';

// Settings → Tags: the tag groups (name, colour, one-per-trade, order) and
// the tags in them. Renaming or merging a tag changes it on every trade at
// once. Tags are shared by all accounts. Every change is saved straight away.
const PALETTE = ['#3B82F6', '#EF4444', '#F59E0B', '#22C55E', '#8B5CF6', '#EC4899', '#14B8A6', '#6B7280'];

function TagSettings({ styles }) {
  const { groups, tags, refreshTags } = useTags();
  const [newGroup, setNewGroup] = useState('');
  const [newTag, setNewTag] = useState({});
  const [colorFor, setColorFor] = useState(null);

  const run = async (fn, what) => {
    try {
      await fn();
    } catch (err) {
      notify(`Couldn't ${what}: ${err.message}`);
    } finally {
      await refreshTags();
    }
  };

  const sections = useMemo(() => {
    const byName = (a, b) => a.name.localeCompare(b.name);
    const list = groups.map(g => ({ key: g.id, group: g, tags: tags.filter(t => t.group_id === g.id).sort(byName) }));
    list.push({ key: 'none', group: null, tags: tags.filter(t => t.group_id == null).sort(byName) });
    return list;
  }, [groups, tags]);

  const json = (method, body) => ({ method, body: JSON.stringify(body) });

  const addGroup = () => {
    const name = newGroup.trim();
    if (!name) return;
    const color = PALETTE.find(c => !groups.some(g => g.color === c)) || PALETTE[groups.length % PALETTE.length];
    run(async () => { await tagsApi('/tag-groups', json('POST', { name, color })); setNewGroup(''); }, 'add the group');
  };

  const renameGroup = async (group) => {
    const name = await promptDialog('Group name', group.name, { title: 'Rename group', confirmLabel: 'Rename' });
    if (name && name.trim() && name.trim() !== group.name) run(() => tagsApi(`/tag-groups/${group.id}`, json('PUT', { name })), 'rename the group');
  };

  const deleteGroup = async (group, count) => {
    const ok = await confirmDialog(
      count > 0
        ? `Delete the group "${group.name}"? Its ${count} tag${count === 1 ? '' : 's'} stay on their trades, under "Other".`
        : `Delete the group "${group.name}"?`,
      { title: 'Delete group', confirmLabel: 'Delete', danger: true }
    );
    if (ok) run(() => tagsApi(`/tag-groups/${group.id}`, { method: 'DELETE' }), 'delete the group');
  };

  const moveGroup = (index, delta) => {
    const ids = groups.map(g => g.id);
    const [id] = ids.splice(index, 1);
    ids.splice(index + delta, 0, id);
    run(() => tagsApi('/tag-groups/order', json('PUT', { ids })), 'reorder the groups');
  };

  const addTag = (key) => {
    const name = (newTag[key] || '').trim();
    if (!name) return;
    const existing = tags.find(t => t.name.toLowerCase() === name.toLowerCase());
    if (existing) { notify(`There already is a tag "${existing.name}".`); return; }
    run(async () => {
      await tagsApi('/tags', json('POST', { name, group_id: key === 'none' ? null : key }));
      setNewTag(prev => ({ ...prev, [key]: '' }));
    }, 'add the tag');
  };

  const renameTag = async (tag) => {
    const name = await promptDialog(
      `New name for "${tag.name}". It changes on all ${tag.trade_count} trade${tag.trade_count === 1 ? '' : 's'} with it.`,
      tag.name, { title: 'Rename tag', confirmLabel: 'Rename' }
    );
    if (!name || !name.trim() || name.trim() === tag.name) return;
    try {
      await tagsApi(`/tags/${tag.id}`, json('PUT', { name }));
      await refreshTags();
    } catch (err) {
      if (err.status === 409 && err.body?.conflict_id) {
        const other = tags.find(t => t.id === err.body.conflict_id);
        const merge = await confirmDialog(
          `There already is a tag "${other?.name}". Merge "${tag.name}" into it? Its trades get "${other?.name}" instead.`,
          { title: 'Merge tags', confirmLabel: 'Merge' }
        );
        if (merge) run(() => tagsApi(`/tags/${tag.id}/merge`, json('POST', { into_id: err.body.conflict_id })), 'merge the tags');
      } else {
        notify(`Couldn't rename the tag: ${err.message}`);
      }
    }
  };

  const mergeTag = async (tag, intoId) => {
    const into = tags.find(t => t.id === intoId);
    if (!into) return;
    const ok = await confirmDialog(
      `Merge "${tag.name}" into "${into.name}"? Its ${tag.trade_count} trade${tag.trade_count === 1 ? '' : 's'} get "${into.name}" instead, and "${tag.name}" is deleted.`,
      { title: 'Merge tags', confirmLabel: 'Merge' }
    );
    if (ok) run(() => tagsApi(`/tags/${tag.id}/merge`, json('POST', { into_id: into.id })), 'merge the tags');
  };

  const deleteTag = async (tag) => {
    const ok = await confirmDialog(
      tag.trade_count > 0
        ? `Delete "${tag.name}"? It's removed from ${tag.trade_count} trade${tag.trade_count === 1 ? '' : 's'}.`
        : `Delete "${tag.name}"?`,
      { title: 'Delete tag', confirmLabel: 'Delete', danger: true }
    );
    if (ok) run(() => tagsApi(`/tags/${tag.id}`, { method: 'DELETE' }), 'delete the tag');
  };

  return (
    <div>
      <p className={own.intro}>
        Tags label your trades in their Journal tab (setups, mistakes, market conditions…) for the Dashboard's tag filter
        and Stats → Tags. They're shared by all accounts. A group's colour shows on its tags; in a one-per-trade group,
        picking a tag replaces the trade's other one.
      </p>

      <div className={own.groups}>
        {sections.map(({ key, group, tags: groupTags }, index) => {
          if (!group && groupTags.length === 0) return null;
          const color = group ? group.color : UNGROUPED_COLOR;
          return (
            <div key={key} className={`${styles.innerCard} ${own.group}`}>
              <div className={own.groupHead}>
                {group ? (
                  <>
                    <button
                      type="button"
                      className={own.swatch}
                      style={{ background: color }}
                      title="Colour"
                      aria-label={`Colour of ${group.name}`}
                      onClick={() => setColorFor(colorFor === group.id ? null : group.id)}
                    />
                    <button type="button" className={own.groupName} style={{ color }} onClick={() => renameGroup(group)} title="Rename">
                      {group.name}
                    </button>
                    <label className={own.single} title="At most one tag of this group per trade, e.g. its setup">
                      <input
                        type="checkbox"
                        checked={group.single_choice}
                        onChange={e => run(() => tagsApi(`/tag-groups/${group.id}`, json('PUT', { single_choice: e.target.checked })), 'change the group')}
                      />
                      One per trade
                    </label>
                    <span className={own.headActions}>
                      <button type="button" className={own.smallBtn} title="Move up" disabled={index === 0} onClick={() => moveGroup(index, -1)}>↑</button>
                      <button type="button" className={own.smallBtn} title="Move down" disabled={index === groups.length - 1} onClick={() => moveGroup(index, 1)}>↓</button>
                      <IconButton size="small" icon="trash" label={`Delete the group ${group.name}`} onClick={() => deleteGroup(group, groupTags.length)} />
                    </span>
                  </>
                ) : (
                  <span className={own.groupName} style={{ color }}>Other <span className={own.muted}>(no group)</span></span>
                )}
              </div>
              {group && colorFor === group.id && (
                <div className={own.palette}>
                  {PALETTE.map(c => (
                    <button
                      key={c}
                      type="button"
                      className={`${own.swatch} ${c === group.color ? own.swatchOn : ''}`}
                      style={{ background: c }}
                      aria-label={c}
                      onClick={() => { setColorFor(null); run(() => tagsApi(`/tag-groups/${group.id}`, json('PUT', { color: c })), 'change the colour'); }}
                    />
                  ))}
                </div>
              )}

              {groupTags.length === 0 && <p className={own.muted}>No tags yet.</p>}
              {groupTags.map(tag => (
                <div key={tag.id} className={own.tagRow}>
                  <TagChip name={tag.name} color={color} />
                  <span className={own.count}>{tag.trade_count} trade{tag.trade_count === 1 ? '' : 's'}</span>
                  <span className={own.tagActions}>
                    <select
                      className={own.select}
                      value=""
                      onChange={e => {
                        const v = e.target.value;
                        if (v.startsWith('g:')) run(() => tagsApi(`/tags/${tag.id}`, json('PUT', { group_id: v === 'g:none' ? null : Number(v.slice(2)) })), 'move the tag');
                        if (v.startsWith('m:')) mergeTag(tag, Number(v.slice(2)));
                      }}
                      aria-label={`Move or merge ${tag.name}`}
                    >
                      <option value="">Move / merge…</option>
                      <optgroup label="Move to group">
                        {groups.filter(g => g.id !== tag.group_id).map(g => <option key={g.id} value={`g:${g.id}`}>{g.name}</option>)}
                        {tag.group_id != null && <option value="g:none">Other (no group)</option>}
                      </optgroup>
                      {tags.length > 1 && (
                        <optgroup label="Merge into">
                          {tags.filter(t => t.id !== tag.id).sort((a, b) => a.name.localeCompare(b.name)).map(t => (
                            <option key={t.id} value={`m:${t.id}`}>{t.name}</option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                    <IconButton size="small" icon="pencil" label={`Rename ${tag.name}`} onClick={() => renameTag(tag)} />
                    <IconButton size="small" icon="trash" label={`Delete ${tag.name}`} onClick={() => deleteTag(tag)} />
                  </span>
                </div>
              ))}
              <div className={own.addRow}>
                <input
                  className={styles.inputBubble}
                  placeholder={group ? `Add a ${group.name.toLowerCase()} tag…` : 'Add a tag without a group…'}
                  value={newTag[key] || ''}
                  maxLength={60}
                  onChange={e => setNewTag(prev => ({ ...prev, [key]: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag(key); } }}
                />
                <button type="button" className={styles.actionBtn} onClick={() => addTag(key)}>Add</button>
              </div>
            </div>
          );
        })}
      </div>

      <div className={own.addRow} style={{ marginTop: 16, maxWidth: 420 }}>
        <input
          className={styles.inputBubble}
          placeholder="New group, e.g. Session or Emotion…"
          value={newGroup}
          maxLength={60}
          onChange={e => setNewGroup(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addGroup(); } }}
        />
        <button type="button" className={styles.actionBtn} onClick={addGroup}>Add group</button>
      </div>
    </div>
  );
}

export default TagSettings;
