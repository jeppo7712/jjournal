// An exchange's weekly opening hours: 7 days (Mon..Sun) of 48 half-hour
// slots, true = open, in the exchange's own timezone. Helpers for the
// Settings grid (OpeningHoursGrid.jsx).

export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const SLOTS_PER_DAY = 48;

// Slot 0 = 00:00, slot 48 = 24:00 (the end of the last slot).
export function slotTime(slot) {
  const hour = Math.floor(slot / 2);
  return `${String(hour).padStart(2, '0')}:${slot % 2 === 0 ? '00' : '30'}`;
}

// A day's open stretches as "08:30–16:00, 17:00–24:00", or "closed" / "24h".
export function formatDayHours(day) {
  const ranges = [];
  let start = null;
  [...day, false].forEach((open, slot) => {
    if (open && start === null) start = slot;
    if (!open && start !== null) {
      ranges.push(`${slotTime(start)}–${slotTime(slot)}`);
      start = null;
    }
  });
  if (ranges.length === 0) return 'closed';
  if (ranges.length === 1 && ranges[0] === '00:00–24:00') return '24h';
  return ranges.join(', ');
}

// The rectangle between two cells ({ day, slot }), corners in any order.
export function cellRect(a, b) {
  return {
    fromDay: Math.min(a.day, b.day), toDay: Math.max(a.day, b.day),
    fromSlot: Math.min(a.slot, b.slot), toSlot: Math.max(a.slot, b.slot),
  };
}

export function inRect(rect, day, slot) {
  return day >= rect.fromDay && day <= rect.toDay && slot >= rect.fromSlot && slot <= rect.toSlot;
}

// A copy of the hours with every slot in the rectangle set to `open`.
export function setRect(hours, rect, open) {
  return hours.map((day, d) => day.map((value, s) => (inRect(rect, d, s) ? open : value)));
}

// "Mon–Fri 08:30–16:00" (the end is the end of the last slot).
export function describeRect(rect) {
  const days = rect.fromDay === rect.toDay
    ? DAY_NAMES[rect.fromDay]
    : `${DAY_NAMES[rect.fromDay]}–${DAY_NAMES[rect.toDay]}`;
  return `${days} ${slotTime(rect.fromSlot)}–${slotTime(rect.toSlot + 1)}`;
}
