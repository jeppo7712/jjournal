// Run with: npm test
const os = require('os');
process.env.USER_PATH = process.env.USER_PATH || os.tmpdir();

const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');
const { logger } = require('../modules/logger.js');
const { _buildAndStoreContinuousSeries } = require('../modules/historical-data-service.js');

logger.silent = true;

const SETTING_ID = 7;
const TIMEFRAME = '1H';
const TZ = 'America/Chicago';
const EXCHANGE_INFO = { timezone: TZ, opening_hours: null };

// In-memory stand-in for the historical_data queries the rebuild runs.
// Matches each query by its text, so a changed query fails loudly here.
function createFakeClient(rawRows) {
    let continuous = [];
    const rawQueries = [];
    const volumeQueries = [];
    const raw = () => rawRows.filter(r => r.timeframe === TIMEFRAME);
    const since = (rows, iso) => (iso ? rows.filter(r => r.time >= new Date(iso)) : rows);

    async function query(sql, params = []) {
        if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] };
        if (sql.includes('FROM futures_rollover_overrides')) return { rows: [] };
        if (sql.includes('WITH RECURSIVE months')) {
            const months = [...new Set(raw().map(r => r.contract_month).filter(Boolean))].sort();
            return { rows: months.map(cm => ({ cm })) };
        }
        if (sql.includes('GROUP BY day, contract_month')) {
            const windowed = sql.includes('time >= $4');
            volumeQueries.push({ windowed, from: params[3] });
            const sums = new Map();
            for (const r of since(raw(), windowed ? params[3] : null)) {
                if (!r.contract_month) continue;
                const day = DateTime.fromJSDate(r.time, { zone: params[2] }).toISODate();
                const key = `${day}|${r.contract_month}`;
                sums.set(key, (sums.get(key) || 0) + r.volume);
            }
            return {
                rows: [...sums].map(([key, volume]) => {
                    const [day, contract_month] = key.split('|');
                    return { day: new Date(`${day}T00:00:00Z`), contract_month, volume: String(volume) };
                }),
            };
        }
        if (sql.includes('SELECT time, open, high, low, close, volume, source, contract_month')) {
            const windowed = sql.includes('time >= $3');
            rawQueries.push({ windowed, from: params[2] });
            const rows = since(raw(), windowed ? params[2] : null).sort((a, b) => a.time - b.time);
            return { rows: rows.map(r => ({ ...r, open: String(r.open), high: String(r.high), low: String(r.low), close: String(r.close), volume: String(r.volume) })) };
        }
        if (sql.includes('SELECT contract_month FROM historical_data') && sql.includes('time < $3')) {
            const before = continuous.filter(r => r.time < new Date(params[2])).sort((a, b) => b.time - a.time);
            return { rows: before.slice(0, 1).map(r => ({ contract_month: r.contract_month })) };
        }
        if (sql.includes('is_rollover = TRUE AND time < $3')) {
            const before = continuous.filter(r => r.is_rollover && r.time < new Date(params[2])).sort((a, b) => b.time - a.time);
            return { rows: before.slice(0, 1).map(r => ({ time: r.time })) };
        }
        if (sql.includes('DELETE FROM historical_data')) {
            const cutoff = sql.includes('time >= $3') ? new Date(params[2]) : null;
            const kept = continuous.filter(r => cutoff && r.time < cutoff);
            const rowCount = continuous.length - kept.length;
            continuous = kept;
            return { rows: [], rowCount };
        }
        if (sql.includes('INSERT INTO historical_data')) {
            const [, months, times, opens, highs, lows, closes, volumes, , sources, rollovers, types] = params;
            for (let i = 0; i < times.length; i++) {
                const row = {
                    contract_month: months[i], time: new Date(times[i]),
                    open: opens[i], high: highs[i], low: lows[i], close: closes[i], volume: volumes[i],
                    source: sources[i], is_rollover: rollovers[i], rollover_type: types[i],
                };
                continuous = continuous.filter(r => !(r.time.getTime() === row.time.getTime() && r.contract_month === row.contract_month));
                continuous.push(row);
            }
            return { rows: [], rowCount: times.length };
        }
        throw new Error(`Fake client: unexpected query: ${sql.slice(0, 120)}`);
    }

    return {
        query,
        rawQueries,
        volumeQueries,
        series: () => continuous
            .map(r => ({ ...r, time: r.time.toISOString() }))
            .sort((a, b) => a.time.localeCompare(b.time)),
    };
}

// Hourly bars for three quarterly contracts. Each one's volume overtakes
// the previous one's on a set day, which is when the series should roll.
function makeRawBars(untilIso) {
    const contracts = [
        { month: '202603', from: '2026-01-05', leadFrom: '2026-01-05', leadUntil: '2026-03-11' },
        { month: '202606', from: '2026-01-05', leadFrom: '2026-03-12', leadUntil: '2026-06-10' },
        { month: '202609', from: '2026-03-01', leadFrom: '2026-06-11', leadUntil: '2026-09-30' },
    ];
    const until = DateTime.fromISO(untilIso, { zone: 'utc' });
    const rows = [];
    for (const c of contracts) {
        let t = DateTime.fromISO(c.from, { zone: TZ });
        const expiry = DateTime.fromFormat(c.month, 'yyyyMM', { zone: TZ }).endOf('month');
        let i = 0;
        while (t < until && t < expiry) {
            const day = t.toISODate();
            const leads = day >= c.leadFrom && day <= c.leadUntil;
            const price = 100 + Number(c.month.slice(4)) + (i % 7);
            rows.push({
                futures_setting_id: SETTING_ID, timeframe: TIMEFRAME, source: 'IBKR', is_continuous: false,
                contract_month: c.month, time: t.toJSDate(),
                open: price, high: price + 1, low: price - 1, close: price + 0.5,
                volume: leads ? 1000 + (i % 13) : 10 + (i % 5),
            });
            t = t.plus({ hours: 1 });
            i++;
        }
    }
    return rows;
}

async function fullBuild(rawRows) {
    const client = createFakeClient(rawRows);
    await _buildAndStoreContinuousSeries(client, SETTING_ID, TIMEFRAME, [3, 6, 9, 12], EXCHANGE_INFO, null);
    return client;
}

test('full build rolls on the days volume moves to the next contract', async () => {
    const client = await fullBuild(makeRawBars('2026-07-15T00:00:00Z'));
    const rolls = client.series().filter(r => r.is_rollover);
    assert.deepEqual(
        rolls.map(r => [DateTime.fromISO(r.time, { zone: TZ }).toISODate(), r.contract_month, r.rollover_type]),
        [['2026-03-12', '202606', 'VOLUME'], ['2026-06-11', '202609', 'VOLUME']]
    );
});

test('incremental rebuild reads only from the invalidation day and matches a full build', async () => {
    const invalidationPoints = [
        '2026-03-09T15:30:00Z', // a few days before the first roll
        '2026-03-12T05:00:00Z', // on the first roll day (Chicago), before its first bar there
        '2026-06-11T14:00:00Z', // during the second roll day
        '2026-06-20T22:15:00Z', // after the last roll
    ];
    for (const iso of invalidationPoints) {
        // The series was built before the newest bars arrived...
        const allBars = makeRawBars('2026-07-15T00:00:00Z');
        const invalidation = DateTime.fromISO(iso, { zone: 'utc' });
        const stored = allBars.filter(r => r.time < invalidation.toJSDate());
        const client = createFakeClient(stored);
        await _buildAndStoreContinuousSeries(client, SETTING_ID, TIMEFRAME, [3, 6, 9, 12], EXCHANGE_INFO, null);

        // ...then bars from the invalidation point on came in.
        stored.push(...allBars.filter(r => r.time >= invalidation.toJSDate()));
        client.rawQueries.length = 0;
        client.volumeQueries.length = 0;
        await _buildAndStoreContinuousSeries(client, SETTING_ID, TIMEFRAME, [3, 6, 9, 12], EXCHANGE_INFO, invalidation);

        const dayStart = invalidation.setZone(TZ).startOf('day').toUTC().toISO();
        assert.deepEqual(client.rawQueries, [{ windowed: true, from: dayStart }], `raw read for ${iso}`);
        assert.deepEqual(client.volumeQueries, [{ windowed: true, from: dayStart }], `volume read for ${iso}`);

        const expected = (await fullBuild(allBars)).series();
        assert.deepEqual(client.series(), expected, `series after incremental rebuild from ${iso}`);
    }
});

test('without a stored series before the invalidation point it reads the whole history', async () => {
    const client = createFakeClient(makeRawBars('2026-04-01T00:00:00Z'));
    await _buildAndStoreContinuousSeries(client, SETTING_ID, TIMEFRAME, [3, 6, 9, 12], EXCHANGE_INFO, DateTime.fromISO('2026-03-01T00:00:00Z', { zone: 'utc' }));
    assert.deepEqual(client.rawQueries, [{ windowed: false, from: undefined }]);
    assert.deepEqual(client.volumeQueries, [{ windowed: false, from: undefined }]);
});

test('incremental rebuild uses the whole invalidation day\'s volume', async () => {
    // Sessions open at 17:00 (closed 16:00-17:00), so a roll takes effect at
    // the open. On the roll day the new contract trades most of its volume
    // before 10:00; from 10:00 on, the old one trades slightly more. Over
    // the whole day the new contract wins, so the series rolls at 17:00.
    const day = Array.from({ length: 48 }, (_, slot) => slot < 32 || slot > 33);
    const exchangeInfo = { timezone: TZ, opening_hours: Array(7).fill(day) };
    const rows = [];
    for (let t = DateTime.fromISO('2026-03-02', { zone: TZ }); t < DateTime.fromISO('2026-03-20', { zone: TZ }); t = t.plus({ hours: 1 })) {
        const date = t.toISODate();
        const volumes = date < '2026-03-12' ? { 202603: 1000, 202606: 10 }
            : date > '2026-03-12' ? { 202603: 10, 202606: 1000 }
            : t.hour < 10 ? { 202603: 10, 202606: 5000 } : { 202603: 300, 202606: 200 };
        for (const [month, volume] of Object.entries(volumes)) {
            rows.push({
                futures_setting_id: SETTING_ID, timeframe: TIMEFRAME, source: 'IBKR', is_continuous: false,
                contract_month: month, time: t.toJSDate(), open: 1, high: 2, low: 0.5, close: 1.5, volume,
            });
        }
    }
    const client = createFakeClient(rows);
    await _buildAndStoreContinuousSeries(client, SETTING_ID, TIMEFRAME, [3, 6, 9, 12], exchangeInfo, null);
    const full = client.series();
    const roll = full.find(r => r.is_rollover);
    assert.equal(DateTime.fromISO(roll.time, { zone: TZ }).toFormat('yyyy-MM-dd HH:mm'), '2026-03-12 17:00');

    const invalidation = DateTime.fromISO('2026-03-12T10:00', { zone: TZ }).toUTC();
    await _buildAndStoreContinuousSeries(client, SETTING_ID, TIMEFRAME, [3, 6, 9, 12], exchangeInfo, invalidation);
    assert.deepEqual(client.series(), full);
});
