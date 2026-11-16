import { DateTime } from 'luxon';

// Set at build time from package.json and the build's clock (craco.config.js).
export const APP_VERSION = process.env.REACT_APP_VERSION || '';
const BUILD_TIME = process.env.REACT_APP_BUILD_TIME || '';

// "16/11/2026, 14:20" in the device's zone, or '' when unknown.
export function builtLabel(iso = BUILD_TIME) {
  if (!iso) return '';
  const dt = DateTime.fromISO(iso);
  return dt.isValid ? dt.toLocal().toFormat('dd/MM/yyyy, HH:mm') : '';
}

// Shown in the About card, one at a time; a tap shows another.
export const QUOTES = [
  { text: 'Plan the trade and trade the plan.', by: 'Trading proverb' },
  { text: 'Cut your losses short and let your profits run.', by: 'Trading proverb' },
  { text: 'The elements of good trading are: cutting losses, cutting losses, and cutting losses.', by: 'Ed Seykota' },
  { text: 'Win or lose, everybody gets what they want out of the market.', by: 'Ed Seykota' },
  { text: 'There is a time to go long, a time to go short, and a time to go fishing.', by: 'Jesse Livermore' },
  { text: 'Markets can remain irrational longer than you can remain solvent.', by: 'Attributed to John Maynard Keynes' },
  { text: 'The stock market is a device for transferring money from the impatient to the patient.', by: 'Warren Buffett' },
  { text: 'Risk comes from not knowing what you’re doing.', by: 'Warren Buffett' },
  { text: 'The four most dangerous words in investing are: ‘this time it’s different.’', by: 'Sir John Templeton' },
  { text: 'Amateurs think about how much money they can make. Professionals think about how much money they could lose.', by: 'Jack Schwager' },
  { text: 'Don’t focus on making money; focus on protecting what you have.', by: 'Paul Tudor Jones' },
  { text: 'Bulls make money, bears make money, pigs get slaughtered.', by: 'Wall Street saying' },
  { text: 'Don’t fight the tape.', by: 'Wall Street saying' },
  { text: 'The journal remembers what you’d rather forget. That’s the point.', by: 'Jay’s Journal' },
];

// A random quote other than the one showing (`current`, an index or -1).
export function nextQuoteIndex(current, random = Math.random) {
  if (current < 0 || QUOTES.length < 2) return Math.floor(random() * QUOTES.length);
  const pick = Math.floor(random() * (QUOTES.length - 1));
  return pick >= current ? pick + 1 : pick;
}
