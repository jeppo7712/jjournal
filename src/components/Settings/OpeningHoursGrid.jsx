import React, { useEffect, useRef, useState } from 'react';
import styles from './OpeningHoursGrid.module.css';
import { DAY_NAMES, SLOTS_PER_DAY, slotTime, formatDayHours, cellRect, inRect, setRect, describeRect } from '../../utils/openingHours';

// The weekly opening-hours grid of an exchange (7 days × 48 half hours).
// Click a block to toggle it, or drag a rectangle across days and times: the
// first block decides whether the rectangle opens or closes.
//
// The cell under the pointer comes from its position in the grid, not from
// the element it's over, and the drag lives in a ref until it's applied on
// release: before, letting go over the gap between two rows dropped the
// selection, and a fast drag could lose its last row or column (the release
// saw the end cell of the render before).
export default function OpeningHoursGrid({ value, onChange }) {
  const cellsRef = useRef(null);
  const dragRef = useRef(null); // { pointerId, start, end, open }
  const [drag, setDrag] = useState(null); // { rect, open }: what's shown
  const [hover, setHover] = useState(null); // { day, slot }

  const cellAt = (e) => {
    const box = cellsRef.current.getBoundingClientRect();
    const clamp = (n, max) => Math.min(max, Math.max(0, n));
    return {
      day: clamp(Math.floor(((e.clientY - box.top) / box.height) * 7), 6),
      slot: clamp(Math.floor(((e.clientX - box.left) / box.width) * SLOTS_PER_DAY), SLOTS_PER_DAY - 1),
    };
  };

  const cancelDrag = () => {
    const current = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (current && cellsRef.current?.hasPointerCapture?.(current.pointerId)) {
      cellsRef.current.releasePointerCapture(current.pointerId);
    }
  };

  // Esc cancels a drag.
  useEffect(() => {
    if (!drag) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); cancelDrag(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [drag]);

  const handlePointerDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const cell = cellAt(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    const open = !value[cell.day][cell.slot];
    dragRef.current = { pointerId: e.pointerId, start: cell, end: cell, open };
    setDrag({ rect: cellRect(cell, cell), open });
    setHover(null);
  };

  const handlePointerMove = (e) => {
    const cell = cellAt(e);
    const current = dragRef.current;
    if (!current) {
      setHover(prev => (prev && prev.day === cell.day && prev.slot === cell.slot ? prev : cell));
      return;
    }
    if (current.pointerId !== e.pointerId || (current.end.day === cell.day && current.end.slot === cell.slot)) return;
    current.end = cell;
    setDrag({ rect: cellRect(current.start, cell), open: current.open });
  };

  const handlePointerUp = (e) => {
    const current = dragRef.current;
    if (!current || current.pointerId !== e.pointerId) return;
    // Where it's released, whatever the last move event said.
    const end = cellAt(e);
    dragRef.current = null;
    setDrag(null);
    setHover(end);
    onChange(setRect(value, cellRect(current.start, end), current.open));
  };

  const shown = drag ? setRect(value, drag.rect, drag.open) : value;

  let readout;
  if (drag) {
    readout = <><strong>{describeRect(drag.rect)}</strong> → {drag.open ? 'open' : 'closed'} <span className={styles.muted}>(Esc cancels)</span></>;
  } else if (hover) {
    readout = <><strong>{DAY_NAMES[hover.day]} {slotTime(hover.slot)}–{slotTime(hover.slot + 1)}</strong> · {value[hover.day][hover.slot] ? 'open' : 'closed'}</>;
  } else {
    readout = <span className={styles.muted}>Click a block to open or close it, or drag across days and times.</span>;
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.grid}>
        <div />
        <div className={styles.hours} aria-hidden="true">
          {Array.from({ length: 24 }, (_, hour) => (
            <span key={hour} className={hour % 6 === 0 ? styles.hourMajor : undefined}>{String(hour).padStart(2, '0')}</span>
          ))}
        </div>
        <div className={styles.summaryHead}>Open</div>

        <div className={styles.days} aria-hidden="true">
          {DAY_NAMES.map(name => <span key={name}>{name}</span>)}
        </div>
        <div
          ref={cellsRef}
          className={styles.cells}
          role="group"
          aria-label="Opening hours: click a half hour to toggle it, or drag to select several"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={cancelDrag}
          onPointerLeave={() => { if (!dragRef.current) setHover(null); }}
        >
          {shown.map((day, d) => day.map((open, s) => {
            const pending = drag && inRect(drag.rect, d, s);
            const hovered = !drag && hover && hover.day === d && hover.slot === s;
            return (
              <div
                key={`${d}-${s}`}
                className={[
                  styles.cell,
                  Math.floor(s / 2) % 2 ? styles.oddHour : '',
                  open ? styles.open : '',
                  pending ? styles.pending : '',
                  hovered ? styles.hovered : '',
                ].join(' ')}
              />
            );
          }))}
        </div>
        <div className={styles.summaries}>
          {shown.map((day, d) => {
            const text = formatDayHours(day);
            return <span key={d} title={`${DAY_NAMES[d]}: ${text}`}>{text.split(', ').map((part, i) => <span key={i}>{part}</span>)}</span>;
          })}
        </div>
      </div>
      <div className={styles.readout} aria-live="polite">{readout}</div>
    </div>
  );
}
