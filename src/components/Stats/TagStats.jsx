import React, { useMemo } from 'react';
import { useTags } from '../../context/TagsContext';
import { getRealisedPnL } from '../../context/TradeContext';
import { computeTagStats } from '../../utils/tagFilter';
import TagChip from '../common/TagChip';
import { formatNumber } from '../../utils/numberFormat';
import styles from './Stats.module.css';

// Stats → Tags: per tag group, how the trades with each tag did, open
// positions (e.g. long-term holdings) included, and the trades with any of
// the group's tags against those with none. A group called "Mistake(s)"
// gets its cost up top. Clicking a tag filters the Dashboard on it.
const pct = v => (v === null || v === undefined ? '—' : `${formatNumber(v, 0)}%`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function TagStats({ trades, mark, onFilterTag }) {
  const { groups, tags } = useTags();
  const sections = useMemo(
    () => computeTagStats(trades, tags, groups, { realisedOf: getRealisedPnL }),
    [trades, tags, groups]
  );
  const money = (v, signed = true) => {
    if (v === null || v === undefined) return '—';
    const tone = v > 0 ? styles.valuePos : v < 0 ? styles.valueNeg : '';
    return <span className={tone}>{signed && v < 0 ? '−' : ''}{mark}{formatNumber(Math.abs(v), 2)}</span>;
  };
  const signedPct = v => {
    if (v === null || v === undefined) return '—';
    const tone = v > 0 ? styles.valuePos : v < 0 ? styles.valueNeg : '';
    return <span className={tone}>{v < 0 ? '−' : ''}{formatNumber(Math.abs(v), 2)}%</span>;
  };
  // "12 trades (5W / 4L, 3 open)"
  const counts = s => {
    const parts = [];
    if (s.closed) parts.push(`${s.wins}W / ${s.losses}L`);
    if (s.open) parts.push(`${s.open} open`);
    return <>{s.trades} <span className={styles.tagStatsSub}>({parts.join(', ')})</span></>;
  };
  // A group's summary: win rate only when something closed.
  const summary = s => (
    <>
      {plural(s.trades, 'trade')}{s.closed > 0 && <>, win rate {pct(s.winRate)}</>}, {money(s.totalPnl)}
      {s.returnPct !== null && <> ({signedPct(s.returnPct)})</>}
    </>
  );

  const tagged = trades.filter(t => (t.tag_ids || []).length > 0).length;
  const mistakes = sections.find(s => s.group && /^mistakes?$/i.test(s.group.name.trim()));
  const pending = sections.some(s => s.rows.some(r => r.pricesPending));

  if (tags.length === 0 || tagged === 0) {
    return (
      <div className={styles.tagStatsEmpty}>
        <h3>Tags</h3>
        <p>
          {tags.length === 0 ? 'No tags yet.' : `None of these ${trades.length} trades has a tag yet.`}{' '}
          Tag your trades in their Journal tab (setups, mistakes, market conditions…), and this page shows how each one does:
          win rate, average win and loss, and P&L per tag.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.tagStats}>
      <p className={styles.tagStatsNote}>
        Trades with the Dashboard's filters, open positions included: {tagged} of {trades.length} have a tag.
        Click a tag to see its trades on the Dashboard.
        {pending && ' Some live prices are still loading, so unrealised P&L may be missing a position.'}
      </p>
      {mistakes && mistakes.any.trades > 0 && (
        <div className={styles.statsGrid}>
          <div className={styles.statBox}>
            <div className={styles.statLabel}>Trades with a {mistakes.group.name.toLowerCase()}</div>
            <div className={styles.statValue}>{money(mistakes.any.totalPnl)}</div>
            <div className={styles.tagStatsSub}>{plural(mistakes.any.trades, 'trade')}{mistakes.any.closed > 0 && <> · win rate {pct(mistakes.any.winRate)}</>}</div>
          </div>
          <div className={styles.statBox}>
            <div className={styles.statLabel}>Without one</div>
            <div className={styles.statValue}>{money(mistakes.none.totalPnl)}</div>
            <div className={styles.tagStatsSub}>{plural(mistakes.none.trades, 'trade')}{mistakes.none.closed > 0 && <> · win rate {pct(mistakes.none.winRate)}</>}</div>
          </div>
        </div>
      )}
      {sections.filter(s => s.rows.length > 0).map(({ group, rows, any, none }) => {
        // Only the columns that say something for this group's trades.
        const anyClosed = rows.some(r => r.closed > 0);
        const anyOpen = rows.some(r => r.open > 0);
        const anyReturn = rows.some(r => r.returnPct !== null);
        return (
          <div key={group ? group.id : 'none'} className={styles.tagSection}>
            <h3 style={group ? { color: group.color } : undefined}>{group ? group.name : 'Other tags'}</h3>
            {group && (
              <p className={styles.tagStatsNote}>
                Any {group.name.toLowerCase()} tag: {summary(any)}{' · '}none: {summary(none)}
              </p>
            )}
            <div className={styles.tagTableWrap}>
              <table className={styles.statsTable}>
                <thead>
                  <tr>
                    <th>Tag</th>
                    <th>Trades</th>
                    {anyClosed && <th title="Closed trades">Win rate</th>}
                    {anyClosed && <th title="Closed trades">Avg win</th>}
                    {anyClosed && <th title="Closed trades">Avg loss</th>}
                    {anyClosed && <th title="Average P&L per closed trade">Per trade</th>}
                    {anyOpen && <th>Realised</th>}
                    {anyOpen && <th title="Open positions at their live price">Unrealised</th>}
                    <th>Total P&L</th>
                    {anyReturn && <th title="Total P&L over what was paid in (stocks and ETFs)">Return</th>}
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
                      <td>{counts(row)}</td>
                      {anyClosed && <td>{row.closed ? pct(row.winRate) : '—'}</td>}
                      {anyClosed && <td>{money(row.avgWin)}</td>}
                      {anyClosed && <td>{money(row.avgLoss)}</td>}
                      {anyClosed && <td>{money(row.expectancy)}</td>}
                      {anyOpen && <td>{money(row.realisedPnl)}</td>}
                      {anyOpen && <td>{row.open ? money(row.unrealisedPnl) : '—'}{row.pricesPending && <span className={styles.tagStatsSub} title="Live price still loading"> ···</span>}</td>}
                      <td>{money(row.totalPnl)}</td>
                      {anyReturn && <td>{signedPct(row.returnPct)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
      <p className={styles.tagStatsNote}>
        A trade with several tags counts under each of them, so the rows of a group can add up to more than its trades.
        Win rate, average win and loss and P&L per trade are over closed trades.
      </p>
    </div>
  );
}

export default TagStats;
