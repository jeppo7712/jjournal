import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DateTime } from 'luxon';
import AppWindow from '../common/AppWindow';
import { mondayOf, monthKey, weekDays, weekMonth, addMonths } from '../../utils/calendarWeeks';
import { itemsByDay, todoCalendarWeeks, dayHeading, CLOSED_STATUSES } from '../../utils/todos';
import { useFillHeight } from '../Calendar/Calendar';
import cal from '../Calendar/Calendar.module.css';
import styles from './Todo.module.css';

// The Todo list by day: its own calendar (not the trade calendar), with the
// trade calendar's look and its continuous run of weeks. Todos on their
// due_at, orders on their good-till date, fired alerts on the day they
// fired (utils/todos.js, calendarDayOf). A day opens a window with its
// items (a swipe card on a phone), where one can be added on that day.
//   items     the items in scope
//   list      renders rows (useTodoRows)
//   openForm  the add/edit form (useTodoRows)

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const SHOWN_PER_DAY = 3;
const monthTitle = month => DateTime.fromISO(`${month}-01`).toFormat('LLLL yyyy');
const monthShort = key => DateTime.fromISO(key).toFormat('LLL');

//   layoutKey  changes when something above the calendar appears or goes
//             (the page's note): the scroller is measured again
export default function TodoCalendar({ items, zone, now, list, openForm, layoutKey }) {
  const byDay = useMemo(() => itemsByDay(items, zone), [items, zone]);
  const todayKey = DateTime.fromJSDate(now, { zone }).toISODate();
  const weeks = useMemo(() => todoCalendarWeeks(Object.keys(byDay), todayKey), [byDay, todayKey]);
  const thisMonth = monthKey(todayKey);
  const [focusMonth, setFocusMonth] = useState(thisMonth);
  const [openDay, setOpenDay] = useState(null);
  const scrollerRef = useRef(null);
  const frameRef = useRef(0);
  const firstMonth = weeks.length ? monthKey(weekDays(weeks[0])[6]) : thisMonth;
  const lastMonth = weeks.length ? weekMonth(weeks[weeks.length - 1]) : thisMonth;

  const scrollToMonth = useCallback((month, smooth) => {
    const scroller = scrollerRef.current;
    const row = scroller && scroller.querySelector(`[data-week="${mondayOf(`${month}-01`)}"]`);
    if (!row) return;
    scroller.scrollTo({ top: row.offsetTop, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  // The title follows the month of the week in the middle of the view.
  const updateFocus = useCallback(() => {
    frameRef.current = 0;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const middle = scroller.scrollTop + scroller.clientHeight / 2;
    let found = null;
    for (const row of scroller.querySelectorAll('[data-week]')) {
      if (row.offsetTop > middle) break;
      found = row;
    }
    if (found) setFocusMonth(weekMonth(found.dataset.week));
  }, []);

  // Fill the page, then open on this month.
  const height = useFillHeight(scrollerRef, layoutKey);
  const opened = useRef(false);
  useLayoutEffect(() => {
    if (opened.current || height == null || !weeks.length) return;
    opened.current = true;
    scrollToMonth(thisMonth, false);
    updateFocus();
  }, [height, weeks.length, scrollToMonth, thisMonth, updateFocus]);
  useLayoutEffect(() => () => cancelAnimationFrame(frameRef.current), []);

  const dayItems = openDay ? (byDay[openDay] || []) : [];

  return (
    <div className={`${cal.calendar} ${styles.todoCalendar}`}>
      <div className={cal.header}>
        <button type="button" onClick={() => scrollToMonth(addMonths(focusMonth, -1), true)} aria-label="Previous month" className={cal.navButton} disabled={focusMonth <= firstMonth}>◄</button>
        <h2>{monthTitle(focusMonth)}</h2>
        <div className={cal.headerRight}>
          <button type="button" onClick={() => scrollToMonth(thisMonth, true)} className={cal.todayButton} disabled={focusMonth === thisMonth}>Today</button>
          <button type="button" onClick={() => scrollToMonth(addMonths(focusMonth, 1), true)} aria-label="Next month" className={cal.navButton} disabled={focusMonth >= lastMonth}>►</button>
        </div>
      </div>
      <div className={`${cal.week} ${styles.todoWeek} ${cal.dayNames}`}>
        {DAY_NAMES.map(name => <div key={name} className={cal.dayName}>{name}</div>)}
      </div>
      <div
        ref={scrollerRef}
        className={cal.scroller}
        style={height ? { height } : undefined}
        onScroll={() => { if (!frameRef.current) frameRef.current = requestAnimationFrame(updateFocus); }}
      >
        {weeks.map(monday => (
          <div key={monday} data-week={monday} className={`${cal.week} ${styles.todoWeek}`}>
            {weekDays(monday).map(dateKey => {
              const dayList = byDay[dateKey] || [];
              const open = dayList.filter(i => !CLOSED_STATUSES.includes(i.status));
              const isFirst = dateKey.endsWith('-01');
              const late = open.some(i => i.status === 'fired' || (i.due_at && Date.parse(i.due_at) <= now.getTime()));
              return (
                <div
                  key={dateKey}
                  className={[
                    cal.dayCell,
                    styles.todoDay,
                    monthKey(dateKey) !== focusMonth ? cal.outsideMonth : '',
                    cal.clickable,
                    open.length ? styles.todoDayBusy : '',
                    late ? styles.todoDayLate : '',
                  ].join(' ')}
                  onClick={() => setOpenDay(dateKey)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenDay(dateKey); } }}
                  aria-label={`${DateTime.fromISO(dateKey).toFormat('cccc d LLLL')}: ${dayList.length} item${dayList.length === 1 ? '' : 's'}`}
                >
                  <span className={`${cal.dayNumber} ${dateKey === todayKey ? cal.today : ''} ${isFirst ? cal.monthStart : ''}`}>
                    {isFirst ? <><span className={cal.dayDigit}>1</span> {monthShort(dateKey)}</> : <span className={cal.dayDigit}>{Number(dateKey.slice(8))}</span>}
                  </span>
                  {dayList.length > 0 && (
                    <>
                      <ul className={styles.dayItems}>
                        {dayList.slice(0, SHOWN_PER_DAY).map(i => (
                          <li key={i.id} className={`${styles.dayItem} ${styles[`dayItem_${i.kind}`]} ${CLOSED_STATUSES.includes(i.status) ? styles.dayItemClosed : ''}`}>
                            {i.title}
                          </li>
                        ))}
                        {dayList.length > SHOWN_PER_DAY && <li className={styles.dayMore}>+{dayList.length - SHOWN_PER_DAY} more</li>}
                      </ul>
                      <span className={styles.dayDots} aria-hidden="true">
                        {dayList.slice(0, 4).map(i => <span key={i.id} className={`${styles.dot} ${styles[`dayItem_${i.kind}`]} ${CLOSED_STATUSES.includes(i.status) ? styles.dayItemClosed : ''}`} />)}
                      </span>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {openDay && (
        <AppWindow
          title={dayHeading(openDay, now, zone)}
          subtitle={DateTime.fromISO(openDay).toFormat('cccc d LLLL yyyy')}
          onClose={() => setOpenDay(null)}
          storageKey="todoDayPosition"
          width={640}
          footer={(
            <button
              type="button"
              className={styles.addBtn}
              onClick={() => { const day = openDay; setOpenDay(null); openForm(null, { kind: 'todo', dueDate: day }); }}
            >
              + Add on this day
            </button>
          )}
        >
          {dayItems.length > 0 ? list(dayItems) : <p className={styles.emptyLine}>Nothing on this day.</p>}
        </AppWindow>
      )}
    </div>
  );
}
