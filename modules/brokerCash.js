const { logger } = require('./logger.js');
const { syncDividendLedger } = require('./dividends.js');

// Broker cash activity (IBKR Flex "Cash Transactions"): deposits and
// withdrawals, fees, interest, dividends and the tax withheld on them.
//
// Every row IBKR reports is kept in broker_cash_items, keyed by its
// transaction ID, so it is never imported twice. A row is then
//   MATCHED   — already in the journal: an entry the user made themselves
//               covers it (linked, nothing booked),
//   BOOKED    — added to the journal by this sync (on the user's accept, or
//               straight away in Automatic mode),
//   PENDING   — waiting in the Capital page's inbox, or
//   DISMISSED — the user said it doesn't belong in the journal.
// The user's own entries are never changed or deleted by a sync. Per account
// (accounts.broker_sync_mode): OFF (the default — the journal is its own
// ledger), SUGGEST (inbox) or AUTO. Only activity from broker_sync_from on
// is read: capital tracking starts from an opening balance that already
// contains everything earlier (docs/CAPITAL_TRACKING_DESIGN.md).

const KIND_BY_TYPE = {
    'dividends': 'DIVIDEND',
    'payment in lieu of dividends': 'PAYMENT_IN_LIEU',
    'withholding tax': 'WITHHOLDING_TAX',
    '871(m) withholding': 'WITHHOLDING_TAX',
    'broker interest received': 'INTEREST',
    'broker interest paid': 'INTEREST',
    'bond interest received': 'INTEREST',
    'bond interest paid': 'INTEREST',
    'other fees': 'FEE',
    'broker fees': 'FEE',
    'advisor fees': 'FEE',
    'commission adjustments': 'FEE',
};

// What a Flex cash row is, in the journal's terms.
function classifyCashType(type, amount) {
    const key = String(type || '').trim().toLowerCase();
    if (key === 'deposits/withdrawals' || key === 'deposits & withdrawals') {
        return Number(amount) < 0 ? 'WITHDRAWAL' : 'DEPOSIT';
    }
    return KIND_BY_TYPE[key] || 'OTHER';
}

const DIVIDEND_KINDS = new Set(['DIVIDEND', 'PAYMENT_IN_LIEU', 'WITHHOLDING_TAX']);

// The ledger type an item books as, for those that become a plain row.
const LEDGER_TYPE = {
    DEPOSIT: 'DEPOSIT',
    WITHDRAWAL: 'WITHDRAWAL',
    INTEREST: 'INTEREST',
    FEE: 'FEE',
    OTHER: 'OTHER',
    WITHHOLDING_TAX: 'WITHHOLDING_TAX',
};

// "20260918" / "20260918;172558" / "2026-09-18, 17:25:58" -> "2026-09-18"
function flexDate(raw) {
    const digits = String(raw || '').replace(/[^0-9]/g, '');
    if (digits.length < 8) return null;
    const date = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
    return /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(date) ? date : null;
}

function rowsOf(statement, section, row) {
    const rows = statement?.[section]?.[row];
    if (!rows) return [];
    return Array.isArray(rows) ? rows : [rows];
}

/**
 * The cash rows of Flex statements, normalized. Summary rows (a query set to
 * "Summary" instead of "Detail") carry no transaction ID and are skipped:
 * without one they can't be told apart or deduplicated.
 */
function parseCashItems(statements) {
    const items = [];
    for (const statement of statements || []) {
        for (const row of rowsOf(statement, 'CashTransactions', 'CashTransaction')) {
            const externalId = String(row.transactionID || '').trim();
            const date = flexDate(row.dateTime || row.settleDate || row.reportDate);
            const amount = Number(row.amount);
            if (!externalId || !date || !Number.isFinite(amount) || amount === 0) continue;
            items.push({
                brokerAccountId: String(row.accountId || statement.accountId || '').toUpperCase(),
                externalId,
                brokerType: String(row.type || ''),
                kind: classifyCashType(row.type, amount),
                date,
                currency: String(row.currency || '').toUpperCase(),
                amount,
                symbol: row.symbol ? String(row.symbol).toUpperCase() : null,
                description: row.description ? String(row.description) : null,
                actionId: row.actionID ? String(row.actionID) : null,
                exDate: flexDate(row.exDate),
            });
        }
    }
    return items;
}

// The account's base currency, from the statement itself: a row whose rate
// to the base currency is exactly 1 is in it.
function baseCurrencyOf(statement) {
    const rows = [
        ...rowsOf(statement, 'CashTransactions', 'CashTransaction'),
        ...rowsOf(statement, 'Trades', 'Trade'),
    ];
    const row = rows.find(r => Number(r.fxRateToBase) === 1 && /^[A-Z]{3}$/.test(String(r.currency || '')));
    return row ? String(row.currency).toUpperCase() : null;
}

/**
 * IBKR's ending cash per account and currency (the Cash Report section),
 * as of the statement's last day. The BASE_SUMMARY row (everything
 * converted to the base currency) isn't a balance anyone holds — except
 * when it's the only row: an account holding just its base currency gets
 * no per-currency breakdown, so then it is that currency's cash.
 */
function parseCashReport(statements) {
    const rows = [];
    for (const statement of statements || []) {
        const brokerAccountId = String(statement.accountId || '').toUpperCase();
        const own = [];
        let summary = null;
        for (const row of rowsOf(statement, 'CashReport', 'CashReportCurrency')) {
            const currency = String(row.currency || '').toUpperCase();
            const endingCash = Number(row.endingCash);
            const asOf = flexDate(row.toDate || statement.toDate);
            if (!Number.isFinite(endingCash) || !asOf) continue;
            const account = String(row.accountId || brokerAccountId).toUpperCase();
            if (currency === 'BASE_SUMMARY') summary = { brokerAccountId: account, asOf, endingCash };
            else if (/^[A-Z]{3}$/.test(currency)) own.push({ brokerAccountId: account, currency, asOf, endingCash });
        }
        if (own.length === 0 && summary) {
            const base = baseCurrencyOf(statement);
            if (base) own.push({ ...summary, currency: base });
        }
        rows.push(...own);
    }
    return rows;
}

// Differences under this are rounding: IBKR reports cash to many decimals.
const BALANCE_TOLERANCE = 0.05;

/**
 * The journal's cash against IBKR's, per currency, as of IBKR's statement
 * day. Part of a difference can be broker items still waiting in the inbox;
 * only the rest (`unexplained`) is something to align. Pure.
 *
 * @param {{ currency, asOf, endingCash }[]} reports
 * @param {Object<string, number>} journal   journal cash per currency as of each report's day
 * @param {Object<string, number>} pending   pending inbox items per currency up to that day
 */
function compareBalances(reports, journal, pending) {
    return reports.map(r => {
        const journalCash = Number(journal[r.currency] || 0);
        const waiting = Number(pending[r.currency] || 0);
        const difference = r.endingCash - journalCash;
        const unexplained = Math.round((difference - waiting) * 100) / 100;
        return {
            currency: r.currency,
            asOf: r.asOf,
            broker: r.endingCash,
            journal: journalCash,
            difference,
            waiting,
            unexplained,
            inLine: Math.abs(unexplained) < BALANCE_TOLERANCE,
        };
    });
}

const cents = value => Math.round(Number(value) * 100);
const dayGap = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;
const toISODate = value => (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);

const MATCH_DAYS = 3;
const DIVIDEND_MATCH_DAYS = 5;
const DEPOSIT_ROW_TYPES = new Set(['DEPOSIT', 'WITHDRAWAL', 'TRANSFER_IN', 'TRANSFER_OUT']);
const COST_ROW_TYPES = new Set(['FEE', 'INTEREST', 'OTHER']);

// IBKR names a stock without its venue suffix (XEON for the journal's XEON.DE).
function sameSymbol(journalSymbol, brokerSymbol) {
    const a = String(journalSymbol || '').toUpperCase();
    const b = String(brokerSymbol || '').toUpperCase();
    return !!a && !!b && (a === b || a.startsWith(`${b}.`));
}

/**
 * Which pending items the journal already has: pure, so it can be tested.
 *
 * @param {object[]} items    pending items { id, kind, date, currency, amount, symbol, actionId }
 * @param {object[]} rows     the user's own ledger rows not linked to any item
 *                            { id, type, date, currency, amount }
 * @param {object[]} dividends the user's own dividends not linked to any item
 *                            { id, symbol, currency, payDate, gross }
 * @returns {{ itemIds: number[], rowIds: number[], dividendId: number|null }[]}
 */
function matchItems(items, rows, dividends = []) {
    const matches = [];
    const usedItems = new Set();
    const usedRows = new Set();
    const usedDividends = new Set();
    const free = list => list.filter(item => !usedItems.has(item.id));
    const freeRows = filter => rows.filter(row => !usedRows.has(row.id) && filter(row));
    const take = (itemList, rowList, dividendId = null) => {
        itemList.forEach(item => usedItems.add(item.id));
        rowList.forEach(row => usedRows.add(row.id));
        if (dividendId) usedDividends.add(dividendId);
        matches.push({ itemIds: itemList.map(i => i.id), rowIds: rowList.map(r => r.id), dividendId });
    };
    const nearest = (candidates, date) => candidates.sort((a, b) => dayGap(a.date, date) - dayGap(b.date, date))[0];

    // Deposits and withdrawals: the user may have entered several broker
    // transfers as one entry (or the other way round), so after one-to-one,
    // a day's items are tried against one entry, and one item against a
    // day's entries.
    const deposits = items.filter(item => item.kind === 'DEPOSIT' || item.kind === 'WITHDRAWAL');
    const depositRow = item => row => DEPOSIT_ROW_TYPES.has(row.type)
        && row.currency === item.currency
        && Math.sign(row.amount) === Math.sign(item.amount)
        && dayGap(row.date, item.date) <= MATCH_DAYS;

    for (const item of deposits) {
        const row = nearest(freeRows(r => depositRow(item)(r) && cents(r.amount) === cents(item.amount)), item.date);
        if (row) take([item], [row]);
    }
    const byDay = new Map();
    for (const item of free(deposits)) {
        const key = `${item.currency}|${item.date}|${Math.sign(item.amount)}`;
        byDay.set(key, [...(byDay.get(key) || []), item]);
    }
    for (const group of byDay.values()) {
        if (group.length < 2) continue;
        const total = group.reduce((sum, item) => sum + cents(item.amount), 0);
        const row = nearest(freeRows(r => depositRow(group[0])(r) && cents(r.amount) === total), group[0].date);
        if (row) take(group, [row]);
    }
    for (const item of free(deposits)) {
        const rowsByDay = new Map();
        for (const row of freeRows(depositRow(item))) {
            const key = toISODate(row.date);
            rowsByDay.set(key, [...(rowsByDay.get(key) || []), row]);
        }
        for (const group of rowsByDay.values()) {
            if (group.length > 1 && group.reduce((sum, row) => sum + cents(row.amount), 0) === cents(item.amount)) {
                take([item], group);
                break;
            }
        }
    }

    // Fees, interest and other: one-to-one only.
    for (const item of free(items).filter(i => ['FEE', 'INTEREST', 'OTHER'].includes(i.kind))) {
        const row = nearest(freeRows(r => COST_ROW_TYPES.has(r.type)
            && r.currency === item.currency
            && cents(r.amount) === cents(item.amount)
            && dayGap(r.date, item.date) <= MATCH_DAYS), item.date);
        if (row) take([item], [row]);
    }

    // Dividends: a dividend the user entered by hand covers the broker's
    // dividend row and the tax rows of the same payment.
    const byAction = new Map();
    for (const item of free(items).filter(i => DIVIDEND_KINDS.has(i.kind))) {
        const key = item.actionId || `${item.symbol}|${item.date}`;
        byAction.set(key, [...(byAction.get(key) || []), item]);
    }
    for (const group of byAction.values()) {
        const paid = group.filter(i => i.kind !== 'WITHHOLDING_TAX');
        if (paid.length === 0) continue;
        const gross = paid.reduce((sum, i) => sum + cents(i.amount), 0);
        const dividend = dividends.find(d => !usedDividends.has(d.id)
            && d.currency === paid[0].currency
            && sameSymbol(d.symbol, paid[0].symbol)
            && cents(d.gross) === gross
            && dayGap(d.payDate, paid[0].date) <= DIVIDEND_MATCH_DAYS);
        if (dividend) take(group, [], dividend.id);
    }

    return matches;
}

// --- Database side ---

// The account's tree: itself and every account below it.
async function treeAccountIds(db, rootId) {
    const { rows } = await db.query(
        `WITH RECURSIVE tree AS (
            SELECT id FROM accounts WHERE id = $1
            UNION SELECT a.id FROM accounts a JOIN tree t ON a.parent_account_id = t.id
        ) SELECT id FROM tree`,
        [rootId]
    );
    return rows.map(r => r.id);
}

// The top-level account an account belongs to (broker sync lives there).
async function rootAccountId(db, accountId) {
    const { rows } = await db.query(
        `WITH RECURSIVE up AS (
            SELECT id, parent_account_id FROM accounts WHERE id = $1
            UNION SELECT a.id, a.parent_account_id FROM accounts a JOIN up u ON a.id = u.parent_account_id
        ) SELECT id FROM up WHERE parent_account_id IS NULL`,
        [accountId]
    );
    return rows[0]?.id || null;
}

// Without a chosen start date: the day after the account's first ledger
// entry (its opening balance), or today for an account without any.
async function defaultSyncFrom(db, rootId) {
    const ids = await treeAccountIds(db, rootId);
    const { rows } = await db.query(
        `SELECT ((MIN(date_time) AT TIME ZONE 'UTC')::date + 1)::text AS from_date FROM cash_transactions WHERE account_id = ANY($1)`,
        [ids]
    );
    const date = rows[0]?.from_date;
    return date ? toISODate(date) : new Date().toISOString().slice(0, 10);
}

// Journal cash and waiting inbox items, as of each stored report's day.
async function balanceCheck(db, rootId) {
    const { rows: reports } = await db.query(
        `SELECT currency, as_of::text AS as_of, ending_cash FROM broker_cash_reports WHERE account_id = $1 ORDER BY currency`,
        [rootId]
    );
    if (reports.length === 0) return [];
    const ids = await treeAccountIds(db, rootId);
    const journal = {};
    const pending = {};
    for (const r of reports) {
        const { rows: [own] } = await db.query(
            `SELECT COALESCE(SUM(amount), 0) AS total FROM cash_transactions
             WHERE account_id = ANY($1) AND currency = $2 AND date_time < ($3::date + 1)::timestamp AT TIME ZONE 'UTC'`,
            [ids, r.currency, r.as_of]
        );
        const { rows: [waiting] } = await db.query(
            `SELECT COALESCE(SUM(amount), 0) AS total FROM broker_cash_items
             WHERE account_id = $1 AND currency = $2 AND status = 'PENDING' AND date_time < ($3::date + 1)::timestamp AT TIME ZONE 'UTC'`,
            [rootId, r.currency, r.as_of]
        );
        journal[r.currency] = Number(own.total);
        pending[r.currency] = Number(waiting.total);
    }
    // What the journal booked after IBKR's statement day (today's trades,
    // say): not in the comparison until IBKR's next statement has it too.
    const { rows: later } = await db.query(
        `SELECT currency, COALESCE(SUM(amount), 0) AS total FROM cash_transactions
         WHERE account_id = ANY($1) AND date_time >= ($2::date + 1)::timestamp AT TIME ZONE 'UTC' GROUP BY currency`,
        [ids, reports[0].as_of]
    );
    const since = Object.fromEntries(later.map(r => [r.currency, Number(r.total)]));
    return compareBalances(
        reports.map(r => ({ currency: r.currency, asOf: r.as_of, endingCash: Number(r.ending_cash) })),
        journal,
        pending
    ).map(b => ({ ...b, sinceStatement: since[b.currency] || 0 }));
}

/**
 * Books what the journal's cash in one currency is off from IBKR's (beyond
 * what's waiting in the inbox) as an ADJUSTMENT on IBKR's statement day,
 * on the top-level account: a visible ledger entry the user can delete.
 * Only ever on request.
 */
async function alignBalance(db, rootId, currency) {
    const row = (await balanceCheck(db, rootId)).find(b => b.currency === currency);
    if (!row) throw new Error(`IBKR reported no ${currency} cash for this account`);
    if (row.inLine) return { amount: 0, row };
    const sign = row.unexplained > 0 ? '+' : '';
    await db.query(
        `INSERT INTO cash_transactions (account_id, date_time, type, amount, currency, note)
         VALUES ($1, $2::date::timestamp AT TIME ZONE 'UTC', 'ADJUSTMENT', $3, $4, $5)`,
        [rootId, row.asOf, row.unexplained, currency,
         `Aligned with IBKR's ${currency} cash of ${row.asOf} (${sign}${row.unexplained.toFixed(2)})`]
    );
    return { amount: row.unexplained, row };
}

async function linkRows(db, itemId, rowIds) {
    for (const rowId of rowIds) {
        await db.query(
            `INSERT INTO broker_item_links (item_id, cash_transaction_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [itemId, rowId]
        );
    }
}

// Tries the account's pending items against the user's own entries.
async function matchPending(db, rootId) {
    const ids = await treeAccountIds(db, rootId);
    const { rows: pending } = await db.query(
        `SELECT id, kind, date_time, currency, amount, symbol, action_id FROM broker_cash_items
         WHERE account_id = $1 AND status = 'PENDING' AND NOT manual_only`,
        [rootId]
    );
    if (pending.length === 0) return 0;
    const { rows: ledger } = await db.query(
        `SELECT ct.id, ct.type, ct.date_time, ct.currency, ct.amount FROM cash_transactions ct
         WHERE ct.account_id = ANY($1) AND ct.linked_trade_id IS NULL AND ct.linked_dividend_id IS NULL
           AND ct.linked_holding_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM broker_item_links l WHERE l.cash_transaction_id = ct.id)`,
        [ids]
    );
    const { rows: ownDividends } = await db.query(
        `SELECT d.id, d.symbol, d.currency, d.pay_date::text AS pay_date, d.gross_amount FROM dividends d
         WHERE d.account_id = ANY($1) AND d.source = 'MANUAL' AND NOT d.dismissed
           AND NOT EXISTS (SELECT 1 FROM broker_cash_items b WHERE b.dividend_id = d.id)`,
        [ids]
    );
    const matches = matchItems(
        pending.map(p => ({ id: p.id, kind: p.kind, date: toISODate(p.date_time), currency: p.currency, amount: Number(p.amount), symbol: p.symbol, actionId: p.action_id })),
        ledger.map(r => ({ id: r.id, type: r.type, date: toISODate(r.date_time), currency: r.currency, amount: Number(r.amount) })),
        ownDividends.map(d => ({ id: d.id, symbol: d.symbol, currency: d.currency, payDate: d.pay_date, gross: Number(d.gross_amount) }))
    );
    let count = 0;
    for (const match of matches) {
        for (const itemId of match.itemIds) {
            await db.query(
                `UPDATE broker_cash_items SET status = 'MATCHED', dividend_id = $2, updated_at = NOW() WHERE id = $1`,
                [itemId, match.dividendId]
            );
            await linkRows(db, itemId, match.rowIds);
            count++;
        }
    }
    return count;
}

// The journal symbol and account a broker dividend belongs to: the stock
// setting that names the same listing, and the account in the tree that
// last traded it (the root when none did).
async function dividendHome(db, rootId, item) {
    const { rows: settings } = await db.query(
        `SELECT symbol, currency FROM futures_settings WHERE type = 'STK' AND (symbol = $1 OR symbol LIKE $1 || '.%')`,
        [item.symbol]
    );
    const setting = settings.find(s => String(s.currency || '').toUpperCase() === item.currency) || settings[0];
    const symbol = setting ? setting.symbol : item.symbol;
    const ids = await treeAccountIds(db, rootId);
    const { rows: holder } = await db.query(
        `SELECT t.account_id FROM trades t JOIN trade_actions a ON a.trade_id = t.id
         WHERE t.account_id = ANY($1) AND t.symbol = $2
         ORDER BY a.date_time DESC LIMIT 1`,
        [ids, symbol]
    );
    return { symbol, accountId: holder[0]?.account_id || rootId };
}

// Books a dividend payment's items (dividend, payment in lieu, tax) as one
// dividend record; its ledger rows follow from it (modules/dividends.js).
async function bookDividendGroup(db, rootId, group, targetAccountId) {
    const paid = group.filter(i => i.kind !== 'WITHHOLDING_TAX');
    const externalId = group[0].action_id || `IBKR-${group[0].external_id}`;
    const { rows: existing } = await db.query(
        `SELECT id, edited FROM dividends WHERE source = 'IBKR' AND external_id = $1`,
        [externalId]
    );
    let dividendId = existing[0]?.id;

    if (!dividendId && paid.length === 0) {
        // Tax on a payment from before tracking (or a later tax correction):
        // there's no dividend to put it on, so it's a ledger row of its own.
        for (const item of group) await bookPlainItem(db, item, targetAccountId);
        return;
    }
    if (!dividendId) {
        const home = await dividendHome(db, rootId, paid[0]);
        const { rows } = await db.query(
            `INSERT INTO dividends (account_id, symbol, kind, currency, ex_date, pay_date, gross_amount, withholding_tax, source, external_id, note)
             VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 'IBKR', $7, $8) RETURNING id`,
            [targetAccountId || home.accountId, home.symbol, paid.some(i => i.kind === 'PAYMENT_IN_LIEU') ? 'PAYMENT_IN_LIEU' : 'DIVIDEND',
             paid[0].currency, paid[0].ex_date_text, toISODate(paid[0].date_time), externalId, paid[0].description]
        );
        dividendId = rows[0].id;
    }
    await db.query(
        `UPDATE broker_cash_items SET status = 'BOOKED', dividend_id = $2, updated_at = NOW() WHERE id = ANY($1)`,
        [group.map(i => i.id), dividendId]
    );
    if (existing[0]?.edited) return; // the user's version stands
    // From every booked item of the payment, so a later correction row
    // (IBKR reverses and re-posts) lands on the same dividend.
    await db.query(
        `UPDATE dividends d SET
            gross_amount = COALESCE((SELECT SUM(amount) FROM broker_cash_items WHERE dividend_id = d.id AND status = 'BOOKED' AND kind <> 'WITHHOLDING_TAX'), 0),
            withholding_tax = COALESCE((SELECT -SUM(amount) FROM broker_cash_items WHERE dividend_id = d.id AND status = 'BOOKED' AND kind = 'WITHHOLDING_TAX'), 0),
            updated_at = NOW()
         WHERE d.id = $1`,
        [dividendId]
    );
    await syncDividendLedger(db, dividendId);
}

async function bookPlainItem(db, item, accountId) {
    const { rows } = await db.query(
        `INSERT INTO cash_transactions (account_id, date_time, type, amount, currency, note)
         VALUES ($1, $2::date::timestamp AT TIME ZONE 'UTC', $3, $4, $5, $6) RETURNING id`,
        [accountId, toISODate(item.date_time), LEDGER_TYPE[item.kind] || 'OTHER', item.amount, item.currency,
         `IBKR: ${item.description || item.broker_type}`]
    );
    await linkRows(db, item.id, [rows[0].id]);
    await db.query(`UPDATE broker_cash_items SET status = 'BOOKED', updated_at = NOW() WHERE id = $1`, [item.id]);
}

/**
 * Books pending items into the journal. A dividend's items always go
 * together (accepting its tax books the dividend too, and the other way
 * round). targetAccountId: an account in the tree; by default the root, or
 * for a dividend the account that holds the stock.
 */
async function bookItems(db, rootId, itemIds, targetAccountId = null) {
    if (targetAccountId) {
        const ids = await treeAccountIds(db, rootId);
        if (!ids.map(String).includes(String(targetAccountId))) throw new Error('That account is not part of this broker account');
    }
    const { rows: chosen } = await db.query(
        `SELECT *, ex_date::text AS ex_date_text FROM broker_cash_items WHERE account_id = $1 AND id = ANY($2) AND status = 'PENDING'`,
        [rootId, itemIds]
    );
    const done = new Set();
    let booked = 0;
    for (const item of chosen) {
        if (done.has(item.id)) continue;
        if (DIVIDEND_KINDS.has(item.kind)) {
            const key = item.action_id;
            const { rows: group } = key
                ? await db.query(`SELECT *, ex_date::text AS ex_date_text FROM broker_cash_items WHERE account_id = $1 AND action_id = $2 AND status = 'PENDING'`, [rootId, key])
                : { rows: [item] };
            await bookDividendGroup(db, rootId, group, targetAccountId);
            group.forEach(i => done.add(i.id));
            booked += group.length;
        } else {
            await bookPlainItem(db, item, targetAccountId || rootId);
            done.add(item.id);
            booked++;
        }
    }
    return booked;
}

/**
 * Stores the cash rows of Flex statements for every journal account that
 * mirrors one of the statements' IBKR accounts and has sync switched on,
 * matches them against the journal, and in Automatic mode books the rest.
 * Paper accounts are skipped (their cash is make-believe).
 *
 * @returns {{ accounts: object[], unmapped: string[] }}
 */
async function syncBrokerCash(pool, statements) {
    const items = parseCashItems(statements);
    const reports = parseCashReport(statements);
    const brokerIds = [...new Set([
        ...(statements || []).map(s => String(s.accountId || '').toUpperCase()),
        ...items.map(i => i.brokerAccountId),
    ].filter(Boolean))];
    const { rows: accounts } = await pool.query(
        `SELECT id, name, broker_account_id, broker_sync_mode, broker_sync_from::text AS broker_sync_from, is_virtual FROM accounts
         WHERE UPPER(broker_account_id) = ANY($1) AND parent_account_id IS NULL`,
        [brokerIds]
    );
    const mapped = new Set(accounts.map(a => a.broker_account_id.toUpperCase()));
    const unmapped = brokerIds.filter(id => !mapped.has(id) && items.some(i => i.brokerAccountId === id));
    const summary = [];

    for (const account of accounts) {
        if (account.is_virtual || account.broker_sync_mode === 'OFF') continue;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const from = account.broker_sync_from ? toISODate(account.broker_sync_from) : await defaultSyncFrom(client, account.id);
            if (!account.broker_sync_from) {
                await client.query(`UPDATE accounts SET broker_sync_from = $2 WHERE id = $1`, [account.id, from]);
            }
            const own = items.filter(i => i.brokerAccountId === account.broker_account_id.toUpperCase() && i.date >= from);
            let added = 0;
            for (const item of own) {
                const { rowCount } = await client.query(
                    `INSERT INTO broker_cash_items (account_id, source, external_id, broker_account_id, broker_type, kind, date_time, currency, amount, symbol, description, action_id, ex_date)
                     VALUES ($1, 'IBKR', $2, $3, $4, $5, $6::date::timestamp AT TIME ZONE 'UTC', $7, $8, $9, $10, $11, $12)
                     ON CONFLICT (source, external_id) DO NOTHING`,
                    [account.id, item.externalId, item.brokerAccountId, item.brokerType, item.kind, item.date, item.currency,
                     item.amount, item.symbol, item.description, item.actionId, item.exDate]
                );
                added += rowCount;
            }
            const matched = await matchPending(client, account.id);
            // IBKR's latest ending cash, for the balance check. Replaced as a
            // whole: a currency IBKR no longer reports is no longer held.
            const ownReports = reports.filter(r => r.brokerAccountId === account.broker_account_id.toUpperCase());
            if (ownReports.length > 0) {
                await client.query(`DELETE FROM broker_cash_reports WHERE account_id = $1`, [account.id]);
                for (const r of ownReports) {
                    await client.query(
                        `INSERT INTO broker_cash_reports (account_id, currency, as_of, ending_cash) VALUES ($1, $2, $3, $4)`,
                        [account.id, r.currency, r.asOf, r.endingCash]
                    );
                }
            }
            let booked = 0;
            if (account.broker_sync_mode === 'AUTO') {
                const { rows: pending } = await client.query(
                    `SELECT id FROM broker_cash_items WHERE account_id = $1 AND status = 'PENDING'`, [account.id]
                );
                booked = await bookItems(client, account.id, pending.map(p => p.id));
            }
            await client.query(`UPDATE accounts SET broker_synced_at = NOW() WHERE id = $1`, [account.id]);
            const { rows: [{ count }] } = await client.query(
                `SELECT COUNT(*)::int AS count FROM broker_cash_items WHERE account_id = $1 AND status = 'PENDING'`, [account.id]
            );
            await client.query('COMMIT');
            summary.push({ accountId: account.id, name: account.name, added, matched, booked, pending: count });
            logger.info(`[BrokerCash] ${account.name}: ${added} new, ${matched} matched, ${booked} booked, ${count} waiting`);
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }
    return { accounts: summary, unmapped };
}

module.exports = {
    classifyCashType,
    parseCashItems,
    parseCashReport,
    compareBalances,
    balanceCheck,
    alignBalance,
    matchItems,
    flexDate,
    sameSymbol,
    syncBrokerCash,
    matchPending,
    bookItems,
    rootAccountId,
    treeAccountIds,
    defaultSyncFrom,
    DIVIDEND_KINDS,
};
