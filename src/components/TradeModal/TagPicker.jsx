import React, { useMemo, useRef, useState } from 'react';
import { useTags } from '../../context/TagsContext';
import TagChip from '../common/TagChip';
import { notify } from '../common/Dialogs';
import styles from './TagPicker.module.css';

// A trade's tags in its Journal tab: each group's tags as chips to tap on or
// off, most used first, and "+" to add one (picking an existing tag of the
// same name instead of making a second). In a one-per-trade group, picking
// a tag replaces the group's other one. Groups and tags are managed in
// Settings → Tags.
function TagPicker({ value, onChange }) {
  const { groups, tags, tagsById, createTag } = useTags();
  const picked = useMemo(() => new Set((value || []).map(Number)), [value]);
  const [adding, setAdding] = useState(null); // group id, or 'none'
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  const sections = useMemo(() => {
    const byUse = (a, b) => b.trade_count - a.trade_count || a.name.localeCompare(b.name);
    const list = groups.map(g => ({ key: g.id, group: g, tags: tags.filter(t => t.group_id === g.id).sort(byUse) }));
    const loose = tags.filter(t => t.group_id == null).sort(byUse);
    if (loose.length > 0 || groups.length === 0) list.push({ key: 'none', group: null, tags: loose });
    return list;
  }, [groups, tags]);

  const toggle = (tag) => {
    const next = new Set(picked);
    if (next.has(tag.id)) {
      next.delete(tag.id);
    } else {
      const group = groups.find(g => g.id === tag.group_id);
      if (group?.single_choice) {
        tags.filter(t => t.group_id === group.id).forEach(t => next.delete(t.id));
      }
      next.add(tag.id);
    }
    onChange([...next]);
  };

  const startAdding = (key) => {
    setAdding(key);
    setText('');
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const suggestions = useMemo(() => {
    const q = text.trim().replace(/^#+/, '').toLowerCase();
    if (!q) return [];
    return tags
      .filter(t => t.name.toLowerCase().includes(q) && !picked.has(t.id))
      .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) || b.trade_count - a.trade_count)
      .slice(0, 6);
  }, [text, tags, picked]);

  const pickExisting = (tag) => {
    if (!picked.has(tag.id)) toggle(tag);
    setAdding(null);
    setText('');
  };

  const submit = async (groupKey) => {
    const name = text.trim().replace(/^#+/, '').trim();
    if (!name || busy) return;
    const same = tags.find(t => t.name.toLowerCase() === name.toLowerCase());
    if (same) { pickExisting(same); return; }
    setBusy(true);
    try {
      const tag = await createTag(name, groupKey === 'none' ? null : groupKey);
      const group = groups.find(g => g.id === tag.group_id);
      const next = new Set(picked);
      if (group?.single_choice) tags.filter(t => t.group_id === group.id).forEach(t => next.delete(t.id));
      next.add(tag.id);
      onChange([...next]);
      setAdding(null);
      setText('');
    } catch (err) {
      notify(`Couldn't add the tag: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  // Tags picked on this trade that the list no longer has (deleted meanwhile).
  const unknown = [...picked].filter(id => !tagsById.has(id));

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>Tags</span>
        <span className={styles.hint}>Groups and colours: Settings → Tags</span>
      </div>
      {sections.map(({ key, group, tags: groupTags }) => (
        <div key={key} className={styles.row}>
          <div className={styles.groupName} style={group ? { color: group.color } : undefined}>
            {group ? group.name : (groups.length ? 'Other' : 'Tags')}
            {group?.single_choice && <span className={styles.single} title="One per trade">1</span>}
          </div>
          <div className={styles.chips}>
            {groupTags.map(tag => (
              <TagChip
                key={tag.id}
                name={tag.name}
                color={group?.color}
                state={picked.has(tag.id) ? 'on' : 'off'}
                onClick={() => toggle(tag)}
                title={picked.has(tag.id) ? 'Remove from this trade' : 'Add to this trade'}
              />
            ))}
            {adding === key ? (
              <div className={styles.addBox}>
                <input
                  ref={inputRef}
                  className={styles.addInput}
                  value={text}
                  maxLength={60}
                  placeholder={group ? `New ${group.name.toLowerCase()} tag` : 'New tag'}
                  onChange={e => setText(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); submit(key); }
                    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setAdding(null); }
                  }}
                  onBlur={() => setTimeout(() => setAdding(current => (current === key && !text.trim() ? null : current)), 150)}
                  disabled={busy}
                  aria-label={group ? `New tag in ${group.name}` : 'New tag'}
                />
                {suggestions.length > 0 && (
                  <div className={styles.suggestions} role="listbox">
                    {suggestions.map(tag => (
                      <button key={tag.id} type="button" className={styles.suggestion} onMouseDown={e => e.preventDefault()} onClick={() => pickExisting(tag)}>
                        {tag.name}
                        <span className={styles.suggestionGroup}>{groups.find(g => g.id === tag.group_id)?.name || ''}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <button type="button" className={styles.addBtn} onClick={() => startAdding(key)} title={group ? `Add a ${group.name.toLowerCase()} tag` : 'Add a tag'}>+</button>
            )}
          </div>
        </div>
      ))}
      {unknown.length > 0 && (
        <p className={styles.hint}>{unknown.length} tag{unknown.length > 1 ? 's were' : ' was'} deleted meanwhile; saving drops {unknown.length > 1 ? 'them' : 'it'}.</p>
      )}
    </div>
  );
}

export default TagPicker;
