// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');

// src/utils is ES module code (the React app's); Node loads it by syntax.
const load = () => import('../src/utils/chartWaiting.js');

const task = (symbol, timeframe, phase) => ({ symbol, timeframe, phase, contractMonth: null, type: 'STK' });

test('describeFetchStatus: this chart\'s download running, from Yahoo or IBKR', async () => {
  const { describeFetchStatus } = await load();
  assert.equal(
    describeFetchStatus({ currentTask: task('STKA.L', '1H', 'yahoo_only'), pendingCount: 1, pendingPreview: [task('STKA.L', '1H', 'ibkr_only')], activeChunks: [] }, 'stka.l', '1H'),
    'Downloading from Yahoo…'
  );
  assert.equal(
    describeFetchStatus({ currentTask: task('STKA.L', '1H', 'ibkr_only'), pendingCount: 0, pendingPreview: [], activeChunks: [] }, 'STKA.L', '1H'),
    'Downloading from IBKR…'
  );
  // Chunks carry IBKR's symbol (no .L); one chunk's range, by month above intraday.
  assert.equal(
    describeFetchStatus({
      currentTask: task('STKA.L', '1H', 'ibkr_only'), pendingCount: 0, pendingPreview: [],
      activeChunks: [{ symbol: 'STKA', timeframe: '1H', chunkStart: '2023-05-16T08:45:04.276+01:00', chunkEnd: '2023-11-16T08:45:04.276+00:00' }],
    }, 'STKA.L', '1H'),
    'Downloading from IBKR: May 2023 – Nov 2023'
  );
  // Several contracts in parallel: the whole span; days for minute bars.
  assert.equal(
    describeFetchStatus({
      currentTask: task('FUTA', '1M', 'ibkr_only'), pendingCount: 0, pendingPreview: [],
      activeChunks: [
        { timeframe: '1M', chunkStart: '2026-11-02T00:00:00.000Z', chunkEnd: '2026-11-09T00:00:00.000Z' },
        { timeframe: '1M', chunkStart: '2026-11-05T00:00:00.000Z', chunkEnd: '2026-11-12T00:00:00.000Z' },
      ],
    }, 'FUTA', '1M'),
    'Downloading from IBKR: 2 Nov 2026 – 12 Nov 2026'
  );
});

test('describeFetchStatus: queued behind another download, or nothing running for it', async () => {
  const { describeFetchStatus } = await load();
  assert.equal(
    describeFetchStatus({ currentTask: task('STKA.L', '1D', 'ibkr_only'), pendingCount: 2, pendingPreview: [task('STKA.L', '1H', 'yahoo_only'), task('STKA.L', '1H', 'ibkr_only')], activeChunks: [] }, 'STKA.L', '1H'),
    'Queued: STKA.L 1D is downloading first'
  );
  assert.equal(describeFetchStatus({ currentTask: null, pendingCount: 1, pendingPreview: [task('STKA.L', '1H', 'yahoo_only')] }, 'STKA.L', '1H'), 'Queued…');
  // Another symbol's download, and this one may be past the 8-task preview.
  assert.equal(
    describeFetchStatus({ currentTask: task('STKB', '1M', 'full'), pendingCount: 9, pendingPreview: Array(8).fill(task('STKB', '5M', 'full')) }, 'STKA.L', '1H'),
    'Waiting for other downloads to finish…'
  );
  // Nothing queued for it at all: its download ended without bars.
  assert.equal(
    describeFetchStatus({ currentTask: task('STKB', '1M', 'full'), pendingCount: 0, pendingPreview: [] }, 'STKA.L', '15M'),
    'Nothing is downloading for 15m now: Yahoo and IBKR may have no bars for it'
  );
  assert.equal(
    describeFetchStatus({ currentTask: null, pendingCount: 0, pendingPreview: [] }, 'STKA.L', '1H'),
    'Nothing is downloading for 1H now: Yahoo and IBKR may have no bars for it'
  );
});

test('formatElapsed', async () => {
  const { formatElapsed } = await load();
  assert.equal(formatElapsed(0), '0:00');
  assert.equal(formatElapsed(75_400), '1:15');
  assert.equal(formatElapsed(-5), '0:00');
});

test('nearestWindow: bars ending at the stored bar before, else starting at the one after', async () => {
  const { nearestWindow } = await load();
  const hour = 3600;
  const before = nearestWindow({ before: '2026-11-13T16:00:00.000Z' }, 10, hour);
  assert.equal(Date.parse(before.startDate), Date.parse('2026-11-13T06:00:00.000Z'));
  assert.equal(Date.parse(before.endDate), Date.parse('2026-11-13T16:00:01.000Z'));
  const after = nearestWindow({ after: '2026-11-16T08:00:00.000Z' }, 10, hour);
  assert.equal(Date.parse(after.startDate), Date.parse('2026-11-16T07:59:59.000Z'));
  assert.equal(Date.parse(after.endDate), Date.parse('2026-11-16T18:00:00.000Z'));
  assert.equal(nearestWindow({}, 10, hour), null);
});
