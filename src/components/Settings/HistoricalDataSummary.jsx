import React, { useMemo, useState } from 'react';
import { DateTime } from 'luxon';
import { FaPencilAlt } from 'react-icons/fa';
import IconButton from '../common/IconButton';
import { formatNumber } from '../../utils/numberFormat';
import styles from './HistoricalDataSummary.module.css';

// What's stored for one symbol (Settings → Historical Data): per timeframe,
// each source's first and last bar drawn as a bar on a shared timeline, so
// gaps and stale sources stand out, with the continuous series' rollovers
// below. Contracts are shown newest first; older ones fold away.

const TIMEFRAMES = ['1M', '5M', '15M', '1H', '4H', '1D', '1W'];
const CONTRACTS_SHOWN = 6;
const ROLLOVERS_SHOWN = 8;

const hasData = (tfData) => tfData && Object.keys(tfData).length > 0;

// "202612" -> "Dec 2026"
const contractLabel = (month) => {
  const dt = DateTime.fromFormat(String(month), 'yyyyMM');
  return dt.isValid ? dt.toFormat('LLL yyyy') : String(month);
};

// The rows of one timeframe: sources first, then contracts newest first.
function coverageRows(tfData, type) {
  const rows = [];
  if (tfData.ibkrContinuous) {
    rows.push({
      key: 'continuous', label: 'IBKR continuous', tone: 'continuous', ...tfData.ibkrContinuous,
      exportArgs: { source: 'IBKR', label: 'IBKR_Continuous', isContinuous: true, contractMonth: null },
    });
  }
  if (type === 'STK' && tfData.ibkr) {
    rows.push({
      key: 'ibkr', label: 'IBKR', tone: 'ibkr', ...tfData.ibkr,
      exportArgs: { source: 'IBKR', label: 'IBKR_Stock', isContinuous: false, contractMonth: null },
    });
  }
  if (tfData.yahoo) {
    rows.push({
      key: 'yahoo', label: 'Yahoo Finance', tone: 'yahoo', ...tfData.yahoo,
      exportArgs: { source: 'YAHOO', label: 'Yahoo', isContinuous: false, contractMonth: null },
    });
  }
  const contracts = type === 'FUT' && tfData.ibkrContracts
    ? Object.entries(tfData.ibkrContracts)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([month, range]) => ({
        key: `c-${month}`, label: contractLabel(month), code: month, tone: 'contract', ...range,
        exportArgs: { source: 'IBKR', label: `IBKR_${month}`, isContinuous: false, contractMonth: month },
      }))
    : [];
  return { sources: rows, contracts };
}

// Labels along the shared axis: years for long spans, quarters otherwise.
function axisTicks(start, end) {
  const years = end.diff(start, 'years').years;
  // At most about ten labels: every year, or every 2, 3… for long spans.
  const step = years > 2.5 ? { years: Math.ceil(years / 10) } : years > 0.75 ? { months: 3 } : { months: 1 };
  const unit = step.years ? 'year' : step.months === 3 ? 'quarter' : 'month';
  const ticks = [];
  let t = start.startOf(unit).plus({ [unit === 'quarter' ? 'months' : `${unit}s`]: unit === 'quarter' ? 3 : 1 });
  if (step.years > 1) t = t.set({ year: Math.ceil(t.year / step.years) * step.years });
  while (t < end) {
    ticks.push(t);
    t = t.plus(step);
  }
  return ticks.map(dt => ({ dt, label: unit === 'year' ? dt.toFormat('yyyy') : dt.toFormat('LLL yy') }));
}

function CoverageRow({ row, range, zone, onExport }) {
  const start = DateTime.fromISO(row.earliest, { zone });
  const end = DateTime.fromISO(row.latest, { zone });
  const span = range.end.toMillis() - range.start.toMillis() || 1;
  const left = ((start.toMillis() - range.start.toMillis()) / span) * 100;
  const width = Math.max(((end.toMillis() - start.toMillis()) / span) * 100, 0.8);
  return (
    <div className={styles.row}>
      <div className={styles.rowLabel}>
        <span className={`${styles.dot} ${styles[row.tone]}`} />
        <span className={styles.rowName}>{row.label}</span>
        {row.code && <span className={styles.rowCode}>{row.code}</span>}
      </div>
      <div className={styles.track} title={`${start.toFormat('d LLL yyyy')} → ${end.toFormat('d LLL yyyy')}`}>
        <div className={`${styles.bar} ${styles[row.tone]}`} style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }} />
      </div>
      <div className={styles.rowDates}>
        {start.toFormat('d LLL yy')} <span className={styles.arrow}>→</span> {end.toFormat('d LLL yy')}
      </div>
      {onExport && (
        <IconButton
          icon="download"
          size="small"
          label={`Export ${row.label} to CSV`}
          onClick={() => onExport(row.exportArgs)}
        />
      )}
    </div>
  );
}

export default function HistoricalDataSummary({ summary, type, onEditRollover, onExportCsv }) {
  const available = TIMEFRAMES.filter(tf => hasData(summary?.timeframes?.[tf]));
  const [chosen, setChosen] = useState(null);
  const [showAllContracts, setShowAllContracts] = useState(false);
  const [showAllRollovers, setShowAllRollovers] = useState(false);
  const timeframe = available.includes(chosen) ? chosen : (available.includes('1H') ? '1H' : available[0]);
  const zone = summary?.exchangeTimezone || 'utc';
  const tfData = timeframe ? summary.timeframes[timeframe] : null;

  const { sources, contracts } = useMemo(
    () => (tfData ? coverageRows(tfData, type) : { sources: [], contracts: [] }),
    [tfData, type]
  );
  const allRows = useMemo(() => [...sources, ...contracts], [sources, contracts]);
  const range = useMemo(() => {
    if (allRows.length === 0) return null;
    const starts = allRows.map(r => DateTime.fromISO(r.earliest, { zone }).toMillis());
    const ends = allRows.map(r => DateTime.fromISO(r.latest, { zone }).toMillis());
    return { start: DateTime.fromMillis(Math.min(...starts), { zone }), end: DateTime.fromMillis(Math.max(...ends), { zone }) };
  }, [allRows, zone]);

  if (available.length === 0) {
    return <div className={styles.empty}>No historical data stored for this symbol yet.</div>;
  }

  const rollovers = [...(tfData?.ibkrContinuous?.rollovers || [])].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const shownContracts = showAllContracts ? contracts : contracts.slice(0, CONTRACTS_SHOWN);
  const shownRollovers = showAllRollovers ? rollovers : rollovers.slice(0, ROLLOVERS_SHOWN);
  const latest = range ? range.end : null;
  const ageDays = latest ? DateTime.now().diff(latest, 'days').days : null;
  const exportFor = onExportCsv ? (args) => onExportCsv({ timeframe, ...args }) : null;
  const ticks = range ? axisTicks(range.start, range.end) : [];
  const spanMs = range ? (range.end.toMillis() - range.start.toMillis()) || 1 : 1;

  return (
    <div className={styles.summary}>
      <div className={styles.pills} role="tablist" aria-label="Timeframe">
        {TIMEFRAMES.map(tf => (
          <button
            key={tf}
            type="button"
            role="tab"
            aria-selected={tf === timeframe}
            className={`${styles.pill} ${tf === timeframe ? styles.pillActive : ''}`}
            disabled={!available.includes(tf)}
            onClick={() => setChosen(tf)}
          >
            {tf}
          </button>
        ))}
      </div>

      {range && (
        <div className={styles.stats}>
          <div className={styles.stat}>
            <span className={styles.statLabel}>First bar</span>
            <span className={styles.statValue}>{range.start.toFormat('d LLL yyyy')}</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>Last bar</span>
            <span className={styles.statValue}>
              {latest.toFormat('d LLL yyyy')}
              <span className={`${styles.fresh} ${ageDays < 4 ? styles.freshOk : styles.freshOld}`}>
                {ageDays < 1 ? 'today' : `${Math.floor(ageDays)}d ago`}
              </span>
            </span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>Span</span>
            <span className={styles.statValue}>
              {(() => {
                const years = range.end.diff(range.start, 'years').years;
                return years >= 1 ? `${formatNumber(years, 1)} years` : `${Math.max(1, Math.round(range.end.diff(range.start, 'days').days))} days`;
              })()}
            </span>
          </div>
          {type === 'FUT' && (
            <div className={styles.stat}>
              <span className={styles.statLabel}>Contracts</span>
              <span className={styles.statValue}>{contracts.length}</span>
            </div>
          )}
        </div>
      )}

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h4>Coverage</h4>
          <span className={styles.cardHint}>Exchange time ({zone})</span>
        </div>
        <div className={styles.axisRow}>
          <div className={styles.rowLabel} />
          <div className={styles.axis}>
            {ticks.map(t => (
              <span key={t.dt.toMillis()} className={styles.tick} style={{ left: `${((t.dt.toMillis() - range.start.toMillis()) / spanMs) * 100}%` }}>
                {t.label}
              </span>
            ))}
          </div>
          <div className={styles.rowDates} />
          {exportFor && <span className={styles.exportSpacer} />}
        </div>
        {sources.map(row => <CoverageRow key={row.key} row={row} range={range} zone={zone} onExport={exportFor} />)}
        {contracts.length > 0 && (
          <>
            <div className={styles.groupTitle}>Contracts</div>
            {shownContracts.map(row => <CoverageRow key={row.key} row={row} range={range} zone={zone} onExport={exportFor} />)}
            {contracts.length > CONTRACTS_SHOWN && (
              <button type="button" className={styles.more} onClick={() => setShowAllContracts(v => !v)}>
                {showAllContracts ? 'Show fewer' : `Show all ${contracts.length} contracts`}
              </button>
            )}
          </>
        )}
      </section>

      {rollovers.length > 0 && (
        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <h4>Rollovers</h4>
            <span className={styles.cardHint}>{rollovers.length} in the continuous series</span>
          </div>
          <ul className={styles.rollovers}>
            {shownRollovers.map(r => (
              <li key={r.date} className={styles.rollover}>
                <span className={styles.rolloverDate}>{DateTime.fromISO(r.date, { zone: 'utc' }).setZone(zone).toFormat('d LLL yyyy')}</span>
                <span className={styles.rolloverPair}>
                  <span>{r.from}</span>
                  <span className={styles.arrow}>→</span>
                  <span>{r.to}</span>
                </span>
                {r.rollover_type && (
                  <span className={`${styles.tag} ${styles[`tag${r.rollover_type.charAt(0)}${r.rollover_type.slice(1).toLowerCase()}`] || ''}`}>
                    {r.rollover_type.charAt(0) + r.rollover_type.slice(1).toLowerCase()}
                  </span>
                )}
                <button type="button" className={styles.editBtn} onClick={() => onEditRollover(r)} title="Edit rollover date" aria-label="Edit rollover date">
                  <FaPencilAlt />
                </button>
              </li>
            ))}
          </ul>
          {rollovers.length > ROLLOVERS_SHOWN && (
            <button type="button" className={styles.more} onClick={() => setShowAllRollovers(v => !v)}>
              {showAllRollovers ? 'Show fewer' : `Show all ${rollovers.length} rollovers`}
            </button>
          )}
        </section>
      )}
    </div>
  );
}
