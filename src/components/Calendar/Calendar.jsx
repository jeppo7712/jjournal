import React, { useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { formatTotals, toTotalsList, totalsSign } from '../../utils/currencyTotals';
import { formatMoney } from '../../utils/formatMoney';
import { addMonths, calendarWeeks, compactMoney, mondayOf, monthKey, weekDays, weekMonth, weekSummary } from '../../utils/calendarWeeks';
import { TradeContext, matchLotsFIFO, getTickMultiplier } from '../../context/TradeContext';
import styles from './Calendar.module.css';
import { DateTime } from 'luxon';

// The height for a calendar's scroller that fills the page's scroll area
// down to its bottom (above the bottom bar on a phone), at least 360 px;
// null until measured. Measured again on resize and when `layoutKey`
// changes (something above it appeared or went).
export function useFillHeight(scrollerRef, layoutKey) {
  const [height, setHeight] = useState(null);
  useLayoutEffect(() => {
    const measure = () => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      let area = scroller.parentElement;
      while (area && !/(auto|scroll)/.test(getComputedStyle(area).overflowY)) area = area.parentElement;
      const bottom = area ? area.getBoundingClientRect().bottom : window.innerHeight;
      // Escaped: a CSS-module class can hold a "+" ("Calendar_calendar__vKx+D").
      const card = scroller.closest(`.${CSS.escape(styles.calendar)}`);
      const below = card ? card.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom : 0;
      let next = Math.max(360, Math.floor(bottom - scroller.getBoundingClientRect().top - below - 24));
      // What still runs past the area's bottom (the page's and the area's
      // padding) comes off too, so the page itself doesn't scroll.
      if (area) {
        scroller.style.height = `${next}px`;
        const over = area.scrollHeight - area.clientHeight;
        if (over > 0) next = Math.max(360, next - over);
      }
      setHeight(next);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [scrollerRef, layoutKey]);
  return height;
}

// Each currency figure is coloured by its own sign. Colouring the whole
// summary by its first currency told the opposite of the truth for the rest —
// a losing EUR day showed green because the USD on it was up.
function renderSignedTotals(totals, format = formatMoney) {
  const list = toTotalsList(totals);
  if (list.length === 0) return formatTotals(totals);
  return list.map(({ currency, amount }, i) => (
    <React.Fragment key={currency}>
      {i > 0 ? ' · ' : ''}
      <span style={{ color: amount >= 0 ? 'var(--ui-green-2)' : 'var(--accent-red)' }}>
        {format(amount, currency)}
      </span>
    </React.Fragment>
  ));
}

const signClass = (totals, positive, negative) => {
  const sign = totalsSign(totals);
  return sign === 'mixed' ? '' : sign === 'positive' ? positive : negative;
};

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const monthTitle = month => DateTime.fromISO(`${month}-01`).toFormat('LLLL yyyy');
const monthShort = key => DateTime.fromISO(key).toFormat('LLL');

// The trades' P&L per day in the chosen zone: `daily` (closed trades on their
// last fill's day, plus sales out of positions that stay open, as Stats'
// daily P&L counts them) and `closed` (the trades closed that day).
function bucketByDay(trades, zone) {
  const daily = {};
  const closed = {};
  const dayOf = key => (daily[key] = daily[key] || { totalByCurrency: {}, count: 0, trades: [] });
  trades.forEach(trade => {
    const code = String(trade.currency || 'USD').toUpperCase();
    if (trade.status === 'WIN' || trade.status === 'LOSS') {
      const key = trade.lastActionDate.setZone(zone).toFormat('yyyy-MM-dd');
      const day = dayOf(key);
      day.totalByCurrency[code] = (day.totalByCurrency[code] || 0) + (trade.return || 0);
      day.count += 1;
      day.trades.push(trade);
      (closed[key] = closed[key] || []).push(trade);
      return;
    }
    if (trade.status !== 'OPEN') return;
    let previous = 0;
    matchLotsFIFO(trade, getTickMultiplier(trade)).timeline.forEach(step => {
      const amount = step.realisedPnL - previous;
      previous = step.realisedPnL;
      if (Math.abs(amount) < 1e-9) return;
      const at = DateTime.fromISO(typeof step.dateTime === 'string' ? step.dateTime : new Date(step.dateTime).toISOString());
      if (!at.isValid) return;
      const day = dayOf(at.setZone(zone).toFormat('yyyy-MM-dd'));
      day.totalByCurrency[code] = (day.totalByCurrency[code] || 0) + amount;
      if (!day.trades.includes(trade)) {
        day.trades.push(trade);
        day.count += 1;
      }
    });
  });
  return { daily, closed };
}

// The calendar scrolls through the weeks continuously, like a phone's: the
// title follows the month in the middle of the view (other months' days are
// dimmed), the arrows jump a month, Today comes back to this month.
// `currentMonth`/`setCurrentMonth` keep the month in view while Stats shows
// another section. `items`: the trades to show; this account's own when not
// given.
const Calendar = ({ onDayClick, onWeekClick, currentMonth = new Date(), setCurrentMonth, zone = 'local', items }) => {
  const { scopedTrades: accountTrades, setTimeFilter, setCustomStartDate, setCustomEndDate, setRestrictToActionsInRange } = useContext(TradeContext);
  const trades = items || accountTrades;

  const { daily, closed } = useMemo(() => bucketByDay(trades, zone), [trades, zone]);
  const todayKey = DateTime.now().setZone(zone).toISODate();
  const weeks = useMemo(() => calendarWeeks(Object.keys(daily), todayKey), [daily, todayKey]);
  const summaries = useMemo(() => Object.fromEntries(weeks.map(w => [w, weekSummary(w, daily, closed)])), [weeks, daily, closed]);

  const startMonth = DateTime.fromJSDate(currentMonth).toFormat('yyyy-MM');
  const [focusMonth, setFocusMonth] = useState(startMonth);
  const focusRef = useRef(startMonth);
  const scrollerRef = useRef(null);
  const height = useFillHeight(scrollerRef);
  const frameRef = useRef(0);
  // The weeks start on the Monday on or before a month's 1st: its Sunday is in that month.
  const firstMonth = weeks.length ? monthKey(weekDays(weeks[0])[6]) : startMonth;
  const lastMonth = weeks.length ? weekMonth(weeks[weeks.length - 1]) : startMonth;

  const scrollToMonth = useCallback((month, smooth) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const row = scroller.querySelector(`[data-week="${mondayOf(`${month}-01`)}"]`);
    if (!row) return;
    scroller.scrollTo({ top: row.offsetTop, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  // The month of the week in the middle of the view.
  const updateFocus = useCallback(() => {
    frameRef.current = 0;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const rows = scroller.querySelectorAll('[data-week]');
    const middle = scroller.scrollTop + scroller.clientHeight / 2;
    let lo = 0;
    let hi = rows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (rows[mid].offsetTop <= middle) lo = mid; else hi = mid - 1;
    }
    const month = rows[lo] ? weekMonth(rows[lo].dataset.week) : focusRef.current;
    if (month !== focusRef.current) {
      focusRef.current = month;
      setFocusMonth(month);
      if (setCurrentMonth) setCurrentMonth(DateTime.fromISO(`${month}-01`).toJSDate());
    }
  }, [setCurrentMonth]);

  const handleScroll = () => {
    if (!frameRef.current) frameRef.current = requestAnimationFrame(updateFocus);
  };

  // Fill the page's scroll area, then open on the month Stats last showed.
  const openedRef = useRef(false);
  useLayoutEffect(() => {
    if (openedRef.current || height == null || !weeks.length) return;
    openedRef.current = true;
    scrollToMonth(startMonth, false);
    updateFocus();
  }, [height, weeks.length, scrollToMonth, startMonth, updateFocus]);

  useLayoutEffect(() => () => cancelAnimationFrame(frameRef.current), []);

  const handleDayClick = (dateKey) => {
    const dayData = daily[dateKey];
    if (dayData && dayData.count > 0) {
      // The day in the selected zone, as the cells group trades (the
      // browser's own midnight was another day's range in another zone).
      setCustomStartDate(DateTime.fromISO(dateKey, { zone }).startOf('day').toISO());
      setCustomEndDate(DateTime.fromISO(dateKey, { zone }).endOf('day').toISO());
      setTimeFilter('CUSTOM');
      setRestrictToActionsInRange(true);
      onDayClick(DateTime.fromISO(dateKey).toJSDate(), dayData.trades);
    }
  };

  const handleWeekClick = (monday) => {
    if (!(summaries[monday]?.count > 0)) return;
    const sunday = weekDays(monday)[6];
    setCustomStartDate(DateTime.fromISO(monday, { zone }).startOf('day').toISO());
    setCustomEndDate(DateTime.fromISO(sunday, { zone }).endOf('day').toISO());
    setTimeFilter('CUSTOM');
    setRestrictToActionsInRange(true);
    onWeekClick(DateTime.fromISO(monday).toJSDate(), DateTime.fromISO(sunday).toJSDate());
  };

  const thisMonth = monthKey(todayKey);

  return (
    <div className={styles.calendar}>
      <div className={styles.header}>
        <button
          onClick={() => scrollToMonth(addMonths(focusMonth, -1), true)}
          aria-label="Previous month"
          className={styles.navButton}
          disabled={focusMonth <= firstMonth}
        >
          ◄
        </button>
        <h2>{monthTitle(focusMonth)}</h2>
        <div className={styles.headerRight}>
          <button
            onClick={() => scrollToMonth(thisMonth, true)}
            className={styles.todayButton}
            disabled={focusMonth === thisMonth}
          >
            Today
          </button>
          <button
            onClick={() => scrollToMonth(addMonths(focusMonth, 1), true)}
            aria-label="Next month"
            className={styles.navButton}
            disabled={focusMonth >= lastMonth}
          >
            ►
          </button>
        </div>
      </div>
      <div className={`${styles.week} ${styles.dayNames}`}>
        {DAY_NAMES.map(name => <div key={name} className={styles.dayName}>{name}</div>)}
        <div className={`${styles.dayName} ${styles.weekName}`}>Week</div>
      </div>
      <div
        ref={scrollerRef}
        className={styles.scroller}
        style={height ? { height } : undefined}
        onScroll={handleScroll}
      >
        {weeks.map(monday => {
          const summary = summaries[monday];
          const hasWeek = summary.count > 0;
          return (
            <div key={monday} data-week={monday} className={styles.week}>
              {weekDays(monday).map(dateKey => {
                const day = daily[dateKey];
                const isFirst = dateKey.endsWith('-01');
                return (
                  <div
                    key={dateKey}
                    className={[
                      styles.dayCell,
                      monthKey(dateKey) !== focusMonth ? styles.outsideMonth : '',
                      day ? styles.clickable : '',
                      day ? signClass(day.totalByCurrency, styles.positiveDay, styles.negativeDay) : '',
                    ].join(' ')}
                    onClick={() => day && handleDayClick(dateKey)}
                  >
                    <span className={`${styles.dayNumber} ${dateKey === todayKey ? styles.today : ''} ${isFirst ? styles.monthStart : ''}`}>
                      {isFirst ? <><span className={styles.dayDigit}>1</span> {monthShort(dateKey)}</> : <span className={styles.dayDigit}>{Number(dateKey.slice(8))}</span>}
                    </span>
                    {day && (
                      <div className={styles.daySummary}>
                        <span className={styles.fullAmount}>{renderSignedTotals(day.totalByCurrency)}</span>
                        <span className={styles.compactAmount}>{renderSignedTotals(day.totalByCurrency, compactMoney)}</span>
                        <span className={styles.tradeCount}>{day.count} Trade{day.count !== 1 ? 's' : ''}</span>
                      </div>
                    )}
                  </div>
                );
              })}
              <div
                className={`${styles.weekSummaryCell} ${hasWeek ? styles.clickable : ''} ${hasWeek ? signClass(summary.totalByCurrency, styles.positiveWeek, styles.negativeWeek) : ''}`}
                onClick={() => handleWeekClick(monday)}
              >
                {hasWeek && (
                  <div className={styles.weekSummary}>
                    <div className={styles.weekSummaryContent}>
                      <span>P&L: </span>
                      <span>{renderSignedTotals(summary.totalByCurrency)}</span>
                    </div>
                    <div className={styles.weekSummaryContent}>
                      <span>Wins: </span>
                      <span style={{ color: 'var(--ui-green-2)' }}>{summary.wins}</span>
                    </div>
                    <div className={styles.weekSummaryContent}>
                      <span>Losses: </span>
                      <span style={{ color: 'var(--accent-red)' }}>{summary.losses}</span>
                    </div>
                    <div className={styles.weekSummaryContent}>
                      <span>Fees: </span>
                      <span style={{ color: 'var(--text-primary)' }}>{formatTotals(summary.feesByCurrency)}</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default Calendar;
