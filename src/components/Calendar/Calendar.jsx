import React, { useContext, useState } from 'react';
import { TradeContext } from '../../context/TradeContext';
import styles from './Calendar.module.css';
import { format, startOfMonth, endOfMonth, startOfWeek, endOfWeek, eachDayOfInterval, addMonths, subMonths, eachWeekOfInterval, startOfDay, endOfDay } from 'date-fns';
import { DateTime } from 'luxon';

const Calendar = ({ onDayClick, onWeekClick, currentMonth = new Date(), setCurrentMonth, zone = 'local' }) => {
  const { trades, setTimeFilter, setCustomStartDate, setCustomEndDate, setRestrictToActionsInRange } = useContext(TradeContext);

  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(currentMonth);
  const startDate = startOfWeek(monthStart, { weekStartsOn: 1 });
  const endDate = endOfWeek(monthEnd, { weekStartsOn: 1 });
  const days = eachDayOfInterval({ start: startDate, end: endDate });
  const weeks = eachWeekOfInterval({ start: startDate, end: endDate }, { weekStartsOn: 1 });
  const numWeeks = weeks.length;

  // Calculate daily summaries and collect trades for each day. Bucketed by
  // the selected display zone, not the browser's — trade.lastActionDate is
  // re-zoned via Luxon rather than going through a plain JS Date (which
  // date-fns' `format` would render in the browser's own local zone
  // regardless of what's selected).
  const dailyData = trades.reduce((acc, trade) => {
    if (trade.status === 'WIN' || trade.status === 'LOSS') {
      const dateKey = trade.lastActionDate.setZone(zone).toFormat('yyyy-MM-dd');
      if (!acc[dateKey]) {
        acc[dateKey] = { total: 0, count: 0, trades: [] };
      }
      acc[dateKey].total += trade.return || 0;
      acc[dateKey].count += 1;
      acc[dateKey].trades.push(trade);
    }
    return acc;
  }, {});

  const weeklySummaries = weeks.reduce((acc, weekStart) => {
    const weekEnd = endOfWeek(weekStart, { weekStartsOn: 1 });
    // Compare by formatted date-key rather than raw Date, for the same
    // zone-consistency reason as dailyData above — ISO 'yyyy-MM-dd' strings
    // sort/compare correctly lexicographically.
    const weekStartKey = format(weekStart, 'yyyy-MM-dd');
    const weekEndKey = format(weekEnd, 'yyyy-MM-dd');
    const weekTrades = trades.filter(trade => {
      if (trade.status !== 'WIN' && trade.status !== 'LOSS') return false;
      const tradeDateKey = trade.lastActionDate.setZone(zone).toFormat('yyyy-MM-dd');
      return tradeDateKey >= weekStartKey && tradeDateKey <= weekEndKey;
    });
    const total = weekTrades.reduce((sum, trade) => sum + (trade.return || 0), 0);
    const fees = weekTrades.reduce((sum, trade) => sum + (trade.buyFee || 0) + (trade.sellFee || 0), 0);
    const count = weekTrades.length;
    const wins = weekTrades.filter(trade => trade.status === 'WIN').length;
    const losses = weekTrades.filter(trade => trade.status === 'LOSS').length;
    const weekKey = format(weekStart, 'yyyy-MM-dd');
    acc[weekKey] = { total, fees, wins, losses, count, weekStart, weekEnd };
    return acc;
  }, {});

  const handleDayClick = (day) => {
    const dateKey = format(day, 'yyyy-MM-dd');
    const dayData = dailyData[dateKey];
    if (dayData && dayData.count > 0) {
      const start = DateTime.fromJSDate(startOfDay(day), { zone }).toISO();
      const end = DateTime.fromJSDate(endOfDay(day), { zone }).toISO();
      setCustomStartDate(start);
      setCustomEndDate(end);
      setTimeFilter('CUSTOM');
      setRestrictToActionsInRange(true);
      onDayClick(day, dayData.trades);
    }
  };

  const handleWeekClick = (weekKey) => {
    const weekData = weeklySummaries[weekKey];
    if (weekData && weekData.count > 0) {
      const start = DateTime.fromJSDate(startOfWeek(weekData.weekStart, { weekStartsOn: 1 }), { zone }).toISO();
      const end = DateTime.fromJSDate(endOfWeek(weekData.weekEnd, { weekStartsOn: 1 }), { zone }).toISO();
      setCustomStartDate(start);
      setCustomEndDate(end);
      setTimeFilter('CUSTOM');
      setRestrictToActionsInRange(true);
      onWeekClick(weekData.weekStart, weekData.weekEnd);
    }
  };

  return (
    <div className={styles.calendar}>
      <div className={styles.header}>
        <button
          onClick={() => setCurrentMonth(subMonths(currentMonth, 1))}
          aria-label="Previous month"
          className={styles.navButton}
        >
          ◄
        </button>
        <h2>{format(currentMonth, 'MMMM yyyy')}</h2>
        <button
          onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}
          aria-label="Next month"
          className={styles.navButton}
        >
          ►
        </button>
      </div>
      <div className={styles.originalGrid}>
        <div className={styles.dayNames}>
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', ''].map((day, idx) => (
            <div key={idx} className={styles.dayName}>{day}</div>
          ))}
        </div>
        <div className={styles.grid}>
          {days.map((day, index) => {
            const dateKey = format(day, 'yyyy-MM-dd');
            const summary = dailyData[dateKey];
            const isCurrentMonth = day.getMonth() === currentMonth.getMonth();
            const weekIndex = Math.floor(index / 7);
            const weekStart = weeks[weekIndex];
            const weekKey = weekStart ? format(weekStart, 'yyyy-MM-dd') : null;
            const weekSummary = weekKey ? weeklySummaries[weekKey] : null;

            return (
              <React.Fragment key={dateKey}>
                <div
                  className={`${styles.dayCell} ${!isCurrentMonth ? styles.outsideMonth : ''} ${summary ? styles.clickable : ''
                    } ${summary ? (summary.total >= 0 ? styles.positiveDay : styles.negativeDay) : ''}`}
                  onClick={() => summary && handleDayClick(day)}
                >
                  <span className={styles.dayNumber}>{format(day, 'd')}</span>
                  {summary && (
                    <div className={styles.daySummary}>
                      <span style={{ color: summary.total >= 0 ? '#22C55E' : '#EF4444' }}>
                        ${Math.abs(summary.total).toFixed(2)}
                      </span>
                      <span>
                        {summary.count} Trade{summary.count !== 1 ? 's' : ''}
                      </span>
                    </div>
                  )}
                </div>
                {index % 7 === 6 && (
                  <div
                    className={`${styles.weekSummaryCell} ${weekSummary && weekSummary.count > 0 ? styles.clickable : ''
                      } ${weekSummary && weekSummary.count > 0 ? (weekSummary.total >= 0 ? styles.positiveWeek : styles.negativeWeek) : ''}`}
                    onClick={() => weekKey && weekSummary && weekSummary.count > 0 && handleWeekClick(weekKey)}
                  >
                    {weekSummary && weekSummary.count > 0 && (
                      <div className={styles.weekSummary}>
                        <div className={styles.weekSummaryContent}>
                          <span>P&L: </span>
                          <span style={{ color: weekSummary.total >= 0 ? '#22C55E' : '#EF4444' }}>
                            ${Math.abs(weekSummary.total).toFixed(2)}
                          </span>
                        </div>
                        <div className={styles.weekSummaryContent}>
                          <span>Wins: </span>
                          <span style={{ color: '#22C55E' }}>{weekSummary.wins}</span>
                        </div>
                        <div className={styles.weekSummaryContent}>
                          <span>Losses: </span>
                          <span style={{ color: '#EF4444' }}>{weekSummary.losses}</span>
                        </div>
                        <div className={styles.weekSummaryContent}>
                          <span>Fees: </span>
                          <span style={{ color: '#F3F4F6' }}>${weekSummary.fees.toFixed(2)}</span>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>
      </div>
      <div className={styles.transposedGrid}>
        <div className={styles.grid} style={{ gridTemplateRows: 'repeat(8, 1fr)', gridTemplateColumns: `repeat(${numWeeks + 1}, 1fr)` }}>
          {[...Array(8)].map((_, rowIndex) => (
            [
              <div key={`header-${rowIndex}`} className={styles.rowHeader}>
                {rowIndex < 7 ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][rowIndex] : 'Sum'}
              </div>,
              ...weeks.map((weekStart, weekIndex) => {
                if (rowIndex < 7) {
                  const dayIndex = weekIndex * 7 + rowIndex;
                  if (dayIndex >= days.length) return null;
                  const day = days[dayIndex];
                  const dateKey = format(day, 'yyyy-MM-dd');
                  const summary = dailyData[dateKey];
                  const isCurrentMonth = day.getMonth() === currentMonth.getMonth();
                  return (
                    <div
                      key={`${rowIndex}-${weekIndex}`}
                      className={`${styles.dayCell} ${!isCurrentMonth ? styles.outsideMonth : ''} ${summary ? styles.clickable : ''} ${summary ? (summary.total >= 0 ? styles.positiveDay : styles.negativeDay) : ''}`}
                      onClick={() => summary && handleDayClick(day)}
                    >
                      <span className={styles.dayNumber}>{format(day, 'd')}</span>
                      {summary && (
                        <div className={styles.daySummary}>
                          <span style={{ color: summary.total >= 0 ? '#22C55E' : '#EF4444' }}>
                            ${Math.abs(summary.total).toFixed(2)}
                          </span>
                          <span>
                            {summary.count} Trade{summary.count !== 1 ? 's' : ''}
                          </span>
                        </div>
                      )}
                    </div>
                  );
                } else {
                  const weekKey = format(weekStart, 'yyyy-MM-dd');
                  const weekSummary = weeklySummaries[weekKey];
                  return (
                    <div
                      key={`${rowIndex}-${weekIndex}`}
                      className={`${styles.weekSummaryCell} ${weekSummary && weekSummary.count > 0 ? styles.clickable : ''} ${weekSummary && weekSummary.count > 0 ? (weekSummary.total >= 0 ? styles.positiveWeek : styles.negativeWeek) : ''}`}
                      onClick={() => weekSummary && weekSummary.count > 0 && handleWeekClick(weekKey)}
                    >
                      {weekSummary && weekSummary.count > 0 && (
                        <div className={styles.weekSummary}>
                          <div className={styles.weekSummaryContent}>
                            <span>P&L: </span>
                            <span style={{ color: weekSummary.total >= 0 ? '#22C55E' : '#EF4444' }}>
                              ${Math.abs(weekSummary.total).toFixed(2)}
                            </span>
                          </div>
                          <div className={styles.weekSummaryContent}>
                            <span>Wins: </span>
                            <span style={{ color: '#22C55E' }}>{weekSummary.wins}</span>
                          </div>
                          <div className={styles.weekSummaryContent}>
                            <span>Losses: </span>
                            <span style={{ color: '#EF4444' }}>{weekSummary.losses}</span>
                          </div>
                          <div className={styles.weekSummaryContent}>
                            <span>Fees: </span>
                            <span style={{ color: '#F3F4F6' }}>${weekSummary.fees.toFixed(2)}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                }
              })
            ]
          )).flat()}
        </div>
      </div>
    </div>
  );
};

export default Calendar;