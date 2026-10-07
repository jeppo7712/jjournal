import React, { useMemo } from 'react';
import { useTags } from '../../context/TagsContext';
import { computeTagStats } from '../../utils/tagFilter';
import TagChip from '../common/TagChip';
import { formatNumber } from '../../utils/numberFormat';
import styles from './Stats.module.css';

// Stats → Tags: per tag group, how the closed trades with each tag did, and
// the trades with any of the group's tags against those with none. A group
// called "Mistake(s)" gets its cost up top. Clicking a tag filters the
// Dashboard on it.
const pct = v => (v === null ? '—' : `${formatNumber(v, 0)}%`);

function TagStats({ trades, mark, onFilterTag }) {
  const { groups, tags } = useTags();
  const sections = useMemo(() => computeTagStats(trades, tags, groups), [trades, tags, groups]);
  const money = (v, signed = true) => {
    if (v === null || v === undefined) return '—';
    const tone = v > 0 ? styles.valuePos : v < 0 ? styles.valueNeg : '';
    return <span className={tone}>{signed && v < 0 ? '−' : ''}{mark}{formatNumber(Math.abs(v), 2)}</span>;
  };

  const tagged = trades.filter(t => t.status !== 'OPEN' && (t.tag_ids || []).length > 0).length;
  const closed = trades.filter(t => t.status !== 'OPEN').length;
  const mistakes = sections.find(s => s.group && /^mistakes?$/i.test(s.group.name.trim()));

  if (tags.length === 0 || tagged === 0) {
    return (
      <div className={styles.tagStatsEmpty}>
        <h3>Tags</h3>
        <p>
          {tags.length === 0 ? 'No tags yet.' : `None of these ${closed} closed trades has a tag yet.`}{' '}
          Tag your trades in their Journal tab (setups, mistakes, market conditions…), and this page shows how each one does:
          win rate, average win and loss, and P&L per tag.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.tagStats}>
      <p className={styles.tagStatsNote}>
        Closed trades with the Dashboard's filters: {tagged} of {closed} have a tag. Click a tag to see its trades on the Dashboard.
      </p>
      {mistakes && mistakes.any.trades > 0 && (
        <div className={styles.statsGrid}>
          <div className={styles.statBox}>
            <div className={styles.statLabel}>Trades with a {mistakes.group.name.toLowerCase()}</div>
            <div className={styles.statValue}>{money(mistakes.any.totalPnl)}</div>
            <div className={styles.tagStatsSub}>{mistakes.any.trades} trade{mistakes.any.trades === 1 ? '' : 's'} · win rate {pct(mistakes.any.winRate)}</div>
          </div>
          <div className={styles.statBox}>
            <div className={styles.statLabel}>Without one</div>
            <div className={styles.statValue}>{money(mistakes.none.totalPnl)}</div>
            <div className={styles.tagStatsSub}>{mistakes.none.trades} trade{mistakes.none.trades === 1 ? '' : 's'} · win rate {pct(mistakes.none.winRate)}</div>
          </div>
        </div>
      )}
      {sections.filter(s => s.rows.length > 0).map(({ group, rows, any, none }) => (
        <div key={group ? group.id : 'none'} className={styles.tagSection}>
          <h3 style={group ? { color: group.color } : undefined}>{group ? group.name : 'Other tags'}</h3>
          {group && (
            <p className={styles.tagStatsNote}>
              Any {group.name.toLowerCase()} tag: {any.trades} trades, win rate {pct(any.winRate)}, {money(any.totalPnl)}
              {' · '}none: {none.trades} trades, win rate {pct(none.winRate)}, {money(none.totalPnl)}
            </p>
          )}
          <div className={styles.tagTableWrap}>
            <table className={styles.statsTable}>
              <thead>
                <tr>
                  <th>Tag</th>
                  <th>Trades</th>
                  <th>Win rate</th>
                  <th>Avg win</th>
                  <th>Avg loss</th>
                  <th title="Average P&L per trade">Per trade</th>
                  <th>Total P&L</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.tag.id}>
                    <td>
                      <TagChip
                        name={row.tag.name}
                        color={group?.color}
                        onClick={() => onFilterTag(row.tag.id)}
                        title="Show these trades on the Dashboard"
                      />
                    </td>
                    <td>{row.trades} <span className={styles.tagStatsSub}>({row.wins}W / {row.losses}L)</span></td>
                    <td>{pct(row.winRate)}</td>
                    <td>{money(row.avgWin)}</td>
                    <td>{money(row.avgLoss)}</td>
                    <td>{money(row.expectancy)}</td>
                    <td>{money(row.totalPnl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      <p className={styles.tagStatsNote}>
        A trade with several tags counts under each of them, so the rows of a group can add up to more than its trades.
      </p>
    </div>
  );
}

export default TagStats;
