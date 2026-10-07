import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { TradeContext } from '../../context/TradeContext';
import { useTags } from '../../context/TagsContext';
import { cycleTagFilter, cleanTagFilter } from '../../utils/tagFilter';
import TagChip from '../common/TagChip';
import styles from './TagFilterMenu.module.css';

// The Dashboard's tag filter (rules in src/utils/tagFilter.js): a button in
// the filter bar opening every group's tags. A click cycles a tag, or a
// whole group, through only → hidden → off.
function TagFilterMenu() {
  const { tagFilter, setTagFilter } = useContext(TradeContext);
  const { groups, tags, tagsById, groupsById, loaded } = useTags();
  const [open, setOpen] = useState(false);
  // Where the menu starts on phones, where it spans the screen (CSS).
  const [menuTop, setMenuTop] = useState(0);
  const wrapRef = useRef(null);

  // A tag or group deleted since the filter was saved.
  useEffect(() => {
    if (!loaded) return;
    const clean = cleanTagFilter(tagFilter, tagsById, groupsById);
    if (clean.length !== tagFilter.length) setTagFilter(clean);
  }, [loaded, tagFilter, tagsById, groupsById, setTagFilter]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const stateOf = (kind, id) => tagFilter.find(f => f.kind === kind && f.id === id)?.mode;
  const toggle = (kind, id) => setTagFilter(cycleTagFilter(tagFilter, kind, id));

  const sections = useMemo(() => {
    const byName = (a, b) => a.name.localeCompare(b.name);
    const list = groups.map(g => ({ key: g.id, group: g, tags: tags.filter(t => t.group_id === g.id).sort(byName) }));
    const loose = tags.filter(t => t.group_id == null).sort(byName);
    if (loose.length) list.push({ key: 'none', group: null, tags: loose });
    return list.filter(s => s.tags.length > 0);
  }, [groups, tags]);

  const label = useMemo(() => {
    if (tagFilter.length === 0) return 'Tags';
    const names = tagFilter.map(f => {
      const name = f.kind === 'group' ? `any ${groupsById.get(f.id)?.name || '?'}` : (tagsById.get(f.id)?.name || '?');
      return f.mode === 'exclude' ? `no ${name.replace(/^any /, '')}` : name;
    });
    return names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ');
  }, [tagFilter, tagsById, groupsById]);

  const active = tagFilter.length > 0;

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        type="button"
        className={`${styles.button} ${active ? styles.active : ''}`}
        onClick={() => {
          setMenuTop((wrapRef.current?.getBoundingClientRect().bottom || 0) + 6);
          setOpen(o => !o);
        }}
        title={active ? `Tag filter: ${label}` : 'Filter by tag'}
        aria-expanded={open}
      >
        <svg className={styles.icon} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fillRule="evenodd" clipRule="evenodd" d="M17.707 9.293a1 1 0 010 1.414l-7 7a1 1 0 01-1.414 0l-7-7A.997.997 0 012 10V5a3 3 0 013-3h5c.256 0 .512.098.707.293l7 7zM5 6a1 1 0 100-2 1 1 0 000 2z" />
        </svg>
        <span className={styles.label}>{label}</span>
        {active && <span className={styles.count}>{tagFilter.length}</span>}
      </button>
      {active && (
        <button type="button" className={styles.clear} onClick={() => setTagFilter([])} title="Clear the tag filter" aria-label="Clear the tag filter">×</button>
      )}
      {open && (
        <div className={styles.menu} style={{ '--menu-top': `${menuTop}px` }} role="dialog" aria-label="Filter by tag">
          <div className={styles.menuHead}>
            <span>Click: <b>only</b> → <b>hide</b> → off</span>
            {active && <button type="button" className={styles.linkBtn} onClick={() => setTagFilter([])}>Clear</button>}
          </div>
          {sections.length === 0 && (
            <p className={styles.empty}>No tags yet. Add them in a trade's Journal tab.</p>
          )}
          {sections.map(({ key, group, tags: groupTags }) => (
            <div key={key} className={styles.section}>
              {group ? (
                <TagChip
                  small
                  name={`Any ${group.name.toLowerCase()}`}
                  color={group.color}
                  state={stateOf('group', group.id) || 'off'}
                  onClick={() => toggle('group', group.id)}
                  title={`Trades with any ${group.name.toLowerCase()} tag, or (click again) without one`}
                />
              ) : (
                <span className={styles.groupLabel}>Other</span>
              )}
              <div className={styles.chips}>
                {groupTags.map(tag => (
                  <TagChip
                    key={tag.id}
                    name={tag.name}
                    color={group?.color}
                    state={stateOf('tag', tag.id) || 'off'}
                    onClick={() => toggle('tag', tag.id)}
                    title={`${tag.trade_count} trade${tag.trade_count === 1 ? '' : 's'} in all accounts`}
                  />
                ))}
              </div>
            </div>
          ))}
          {sections.length > 0 && (
            <p className={styles.footnote}>Several tags of one group: any of them. Tags of different groups: all of them.</p>
          )}
        </div>
      )}
    </div>
  );
}

export default TagFilterMenu;
