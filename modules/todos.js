// The Todo list: things to do, price alerts and pending orders, written by
// the user in the app and by an external agent through the external API.
// The journal stores, shows and serves them. It never evaluates prices and
// never sends notifications: the agent watches and pings, and reports back
// by marking items fired (alerts) or reminded (a due_at it pinged for).
//
// This module holds the rules both sets of routes share (routes/todos.js):
// validation, the bookkeeping of status times, and the list's filters and
// order. They're plain functions over plain objects so they can be tested
// without a database; createTodoStore() is the Postgres side.
//
// API shape (EXTERNAL_API.md, "Todos") vs storage (modules/database.js,
// createTodoTables): `then` is `then_text`, `trigger` is `trigger_spec`,
// `order` is `order_spec` (THEN and ORDER are SQL keywords).

const KINDS = ['todo', 'trigger', 'order'];
const STATUSES = ['open', 'fired', 'done', 'dismissed', 'expired'];
const CLOSED_STATUSES = ['done', 'dismissed', 'expired'];
// Closed by the user's own decision: an agent's upsert leaves these alone.
const USER_CLOSED_STATUSES = ['done', 'dismissed'];
const CREATORS = ['user', 'agent'];
const INSTRUMENT_TYPES = ['STK', 'FUT'];
const CONDITIONS = ['touch', 'close_1m', 'close_1d', 'close_1w'];
const DIRECTIONS = ['above', 'below'];
const SIDES = ['BUY', 'SELL'];
const ORDER_TYPES = ['LMT', 'STP', 'STP LMT', 'MOC', 'LOC'];
const TIFS = ['DAY', 'GTC', 'GTD'];
// Which prices an order type needs; any other price must be left out.
const ORDER_PRICES = {
    LMT: ['limit_price'],
    STP: ['stop_price'],
    'STP LMT': ['stop_price', 'limit_price'],
    MOC: [],
    LOC: ['limit_price'],
};

const TITLE_MAX = 300;
const THEN_MAX = 300;
const NOTE_MAX = 300;
const NOTES_MAX = 10000;
const SOURCE_MAX = 60;
const KEY_MAX = 200;
const SYMBOL_MAX = 30;
// Goes into a URL path (PUT /todos/key/:key), so nothing that needs escaping.
const KEY_RE = /^[A-Za-z0-9._:~-]+$/;
const CONTRACT_MONTH_RE = /^\d{6}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// A time must say which zone it's in: "2026-03-20T16:00:00Z" or "...+01:00".
const ZONED_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

// Fields a request may write. Anything else in the body (id, created_at,
// account_name, ... from an item sent back as it was read) is ignored.
const WRITABLE = ['key', 'kind', 'title', 'then', 'notes', 'status', 'source', 'account_id', 'trade_id',
    'due_at', 'alert', 'reminded_at', 'expires_at', 'fired_at', 'fired_note', 'closed_note', 'trigger', 'order'];

class TodoError extends Error {
    constructor(status, message, extra) {
        super(message);
        this.status = status;
        this.extra = extra;
    }
}

const bad = (message) => new TodoError(400, message);

function text(value, field, max, { required = false } = {}) {
    if (value === null || value === undefined) {
        if (required) throw bad(`${field} is required`);
        return null;
    }
    if (typeof value !== 'string') throw bad(`${field} must be text`);
    const trimmed = value.trim();
    if (!trimmed) {
        if (required) throw bad(`${field} is required`);
        return null;
    }
    if (trimmed.length > max) throw bad(`${field} is longer than ${max} characters`);
    return trimmed;
}

function oneOf(value, field, allowed, { upper = false, required = true } = {}) {
    if (value === null || value === undefined || value === '') {
        if (required) throw bad(`${field} is required (one of: ${allowed.join(', ')})`);
        return null;
    }
    const v = typeof value === 'string' ? (upper ? value.trim().toUpperCase() : value.trim()) : value;
    if (!allowed.includes(v)) throw bad(`${field} must be one of: ${allowed.join(', ')}`);
    return v;
}

function positive(value, field, { required = false } = {}) {
    if (value === null || value === undefined || value === '') {
        if (required) throw bad(`${field} is required`);
        return null;
    }
    const n = typeof value === 'string' ? Number(value.trim()) : value;
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) throw bad(`${field} must be a positive number`);
    return n;
}

function id(value, field) {
    if (value === null || value === undefined || value === '') return null;
    const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (!Number.isInteger(n) || n <= 0) throw bad(`${field} must be a whole number`);
    return n;
}

// '2026-02-30' is not a day (Date.parse would roll it on to 2 March).
const realDay = (day) => new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;

// Stored and answered as an ISO string in UTC.
function time(value, field) {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date) return value.toISOString();
    if (typeof value !== 'string' || !ZONED_TIME_RE.test(value.trim()) || Number.isNaN(Date.parse(value))
        || !realDay(value.trim().slice(0, 10))) {
        throw bad(`${field} must be a time with its zone, e.g. 2026-03-20T16:00:00Z`);
    }
    return new Date(value.trim()).toISOString();
}

function date(value, field) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string' || !DATE_RE.test(value.trim())
        || Number.isNaN(Date.parse(`${value.trim()}T00:00:00Z`))
        || new Date(`${value.trim()}T00:00:00Z`).toISOString().slice(0, 10) !== value.trim()) {
        throw bad(`${field} must be a date, e.g. 2026-03-20`);
    }
    return value.trim();
}

function symbol(value, field) {
    const s = text(value, field, SYMBOL_MAX, { required: true }).toUpperCase();
    if (/\s/.test(s)) throw bad(`${field} must not contain spaces`);
    return s;
}

function plainObject(value, field) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object' || Array.isArray(value)) throw bad(`${field} must be an object`);
    return value;
}

function parseTrigger(value) {
    const t = plainObject(value, 'trigger');
    if (!t) return null;
    const type = oneOf(t.type, 'trigger.type', INSTRUMENT_TYPES, { upper: true });
    const condition = oneOf(t.condition, 'trigger.condition', CONDITIONS);
    if (condition === 'close_1m' && type !== 'FUT') throw bad('trigger.condition close_1m is for futures only (trigger.type FUT)');
    const contractMonth = t.contract_month === null || t.contract_month === undefined || t.contract_month === ''
        ? null : String(t.contract_month).trim();
    if (contractMonth !== null) {
        if (type !== 'FUT') throw bad('trigger.contract_month is for futures only (trigger.type FUT)');
        if (!CONTRACT_MONTH_RE.test(contractMonth)) throw bad('trigger.contract_month must look like 202606');
    }
    return {
        symbol: symbol(t.symbol, 'trigger.symbol'),
        type,
        contract_month: contractMonth,
        condition,
        direction: oneOf(t.direction, 'trigger.direction', DIRECTIONS),
        level: positive(t.level, 'trigger.level', { required: true }),
        void_above: positive(t.void_above, 'trigger.void_above'),
        void_below: positive(t.void_below, 'trigger.void_below'),
    };
}

function parseOrder(value) {
    const o = plainObject(value, 'order');
    if (!o) return null;
    const type = oneOf(o.type ?? 'STK', 'order.type', INSTRUMENT_TYPES, { upper: true });
    const contractMonth = o.contract_month === null || o.contract_month === undefined || o.contract_month === ''
        ? null : String(o.contract_month).trim();
    if (contractMonth !== null) {
        if (type !== 'FUT') throw bad('order.contract_month is for futures only (order.type FUT)');
        if (!CONTRACT_MONTH_RE.test(contractMonth)) throw bad('order.contract_month must look like 202606');
    }
    const side = oneOf(o.side, 'order.side', SIDES, { upper: true });
    const orderType = oneOf(o.order_type, 'order.order_type', ORDER_TYPES, { upper: true });
    const prices = {};
    for (const field of ['limit_price', 'stop_price']) {
        const needed = ORDER_PRICES[orderType].includes(field);
        const v = positive(o[field], `order.${field}`, { required: needed });
        if (!needed && v !== null) throw bad(`order.${field} doesn't go with order_type ${orderType}`);
        prices[field] = v;
    }
    const tif = oneOf(o.tif, 'order.tif', TIFS, { upper: true });
    const goodTill = date(o.good_till, 'order.good_till');
    if (tif === 'GTD' && !goodTill) throw bad('order.good_till is required for tif GTD');
    if (tif !== 'GTD' && goodTill) throw bad('order.good_till only goes with tif GTD');
    let currency = null;
    if (o.currency !== null && o.currency !== undefined && o.currency !== '') {
        currency = String(o.currency).trim().toUpperCase();
        if (!/^[A-Z]{3}$/.test(currency)) throw bad('order.currency must be a 3-letter code, e.g. USD');
    }
    // A bracket: the protective stop and the target that go with the entry.
    const stopLoss = positive(o.stop_loss, 'order.stop_loss');
    const profitTarget = positive(o.profit_target, 'order.profit_target');
    const entry = prices.limit_price ?? prices.stop_price;
    if (entry !== null && entry !== undefined) {
        const buy = side === 'BUY';
        if (stopLoss !== null && (buy ? stopLoss >= entry : stopLoss <= entry)) {
            throw bad(`order.stop_loss must be ${buy ? 'below' : 'above'} the entry price for a ${side}`);
        }
        if (profitTarget !== null && (buy ? profitTarget <= entry : profitTarget >= entry)) {
            throw bad(`order.profit_target must be ${buy ? 'above' : 'below'} the entry price for a ${side}`);
        }
    }
    return {
        symbol: symbol(o.symbol, 'order.symbol'),
        type,
        contract_month: contractMonth,
        side,
        quantity: positive(o.quantity, 'order.quantity', { required: true }),
        order_type: orderType,
        limit_price: prices.limit_price,
        stop_price: prices.stop_price,
        tif,
        good_till: goodTill,
        currency,
        stop_loss: stopLoss,
        profit_target: profitTarget,
    };
}

// The fields a request sends, each checked on its own and normalised. Only
// the fields present in the body appear in the result: absent means "leave
// as it is", null means "clear it".
function parseInput(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('The body must be a JSON object');
    const has = (field) => Object.prototype.hasOwnProperty.call(body, field);
    const patch = {};
    if (has('key')) {
        const key = text(body.key, 'key', KEY_MAX);
        if (key !== null && !KEY_RE.test(key)) throw bad('key may only contain letters, digits and . _ : ~ -');
        patch.key = key;
    }
    if (has('kind')) patch.kind = oneOf(body.kind, 'kind', KINDS);
    if (has('title')) patch.title = text(body.title, 'title', TITLE_MAX, { required: true });
    if (has('then')) patch.then = text(body.then, 'then', THEN_MAX);
    if (has('notes')) patch.notes = text(body.notes, 'notes', NOTES_MAX);
    if (has('status')) patch.status = oneOf(body.status, 'status', STATUSES);
    if (has('source')) patch.source = text(body.source, 'source', SOURCE_MAX);
    if (has('account_id')) patch.account_id = id(body.account_id, 'account_id');
    if (has('trade_id')) patch.trade_id = id(body.trade_id, 'trade_id');
    if (has('due_at')) patch.due_at = time(body.due_at, 'due_at');
    if (has('alert')) {
        if (typeof body.alert !== 'boolean') throw bad('alert must be true or false');
        patch.alert = body.alert;
    }
    if (has('reminded_at')) patch.reminded_at = time(body.reminded_at, 'reminded_at');
    if (has('expires_at')) patch.expires_at = time(body.expires_at, 'expires_at');
    if (has('fired_at')) patch.fired_at = time(body.fired_at, 'fired_at');
    if (has('fired_note')) patch.fired_note = text(body.fired_note, 'fired_note', NOTE_MAX);
    if (has('closed_note')) patch.closed_note = text(body.closed_note, 'closed_note', NOTE_MAX);
    if (has('trigger')) patch.trigger = parseTrigger(body.trigger);
    if (has('order')) patch.order = parseOrder(body.order);
    return patch;
}

// What the alert watches: a change to any of these starts it afresh.
const triggerDefinition = (t) => (t
    ? [t.symbol, t.type, t.contract_month ?? null, t.condition, t.direction, Number(t.level)].join('|')
    : null);

const sameTime = (a, b) => (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null);

const EMPTY = {
    key: null, kind: null, title: null, then: null, notes: null, status: 'open', created_by: null, source: null,
    account_id: null, trade_id: null, due_at: null, alert: false, reminded_at: null, expires_at: null,
    armed_at: null, fired_at: null, fired_note: null, closed_at: null, closed_note: null, seen_at: null,
    trigger: null, order: null,
};

// The item as it is after a write: `existing` (null for a new item) with the
// request's parsed fields applied, checked as a whole, and the bookkeeping
// times set. origin: 'app' (the user, through the app) or 'agent' (the
// external API). Throws a TodoError(400) for an item that doesn't hold
// together. Doesn't check that account_id / trade_id exist (the store does).
function applyWrite(existing, patch, { origin, now = new Date() }) {
    const nowIso = now.toISOString();
    const before = existing ? { ...EMPTY, ...existing } : null;
    const item = { ...(before || EMPTY) };
    for (const field of WRITABLE) {
        if (Object.prototype.hasOwnProperty.call(patch, field)) item[field] = patch[field];
    }

    if (!item.kind) throw bad(`kind is required (one of: ${KINDS.join(', ')})`);
    if (!item.title) throw bad('title is required');
    // A kind changed without sending the old kind's details along: they go.
    if (before && before.kind !== item.kind) {
        if (item.kind !== 'trigger' && !Object.prototype.hasOwnProperty.call(patch, 'trigger')) item.trigger = null;
        if (item.kind !== 'order' && !Object.prototype.hasOwnProperty.call(patch, 'order')) item.order = null;
    }
    if (item.kind === 'trigger' && !item.trigger) throw bad('trigger is required for kind trigger');
    if (item.kind !== 'trigger' && item.trigger) throw bad(`trigger only goes with kind trigger, not ${item.kind}`);
    if (item.kind === 'order' && !item.order) throw bad('order is required for kind order');
    if (item.kind !== 'order' && item.order) throw bad(`order only goes with kind order, not ${item.kind}`);
    // An order needs an account when it's made one or its account is set;
    // one whose account was deleted since (account_id went null) can still
    // be closed and edited.
    if (item.kind === 'order' && !item.account_id
        && (!before || before.kind !== 'order' || Object.prototype.hasOwnProperty.call(patch, 'account_id'))) {
        throw bad('account_id is required for kind order');
    }

    item.created_by = before ? before.created_by : (origin === 'app' ? 'user' : 'agent');
    if (!before && !item.source && origin === 'app') item.source = 'app';

    // Ping at due_at: on by default once a due_at is set, off without one.
    const dueChanged = before ? !sameTime(before.due_at, item.due_at) : !!item.due_at;
    if (!item.due_at) item.alert = false;
    else if (!Object.prototype.hasOwnProperty.call(patch, 'alert') && (!before || !before.due_at)) item.alert = true;

    // A price alert is redefined by its level and the like, not by its
    // reminder: snoozing a fired alert's reminder keeps it fired (and when
    // and why it fired). A todo or order is redefined by a new due_at.
    const redefined = before
        ? triggerDefinition(before.trigger) !== triggerDefinition(item.trigger) || (item.kind !== 'trigger' && dueChanged)
        : true;
    // An alert or reminder that fired or lapsed and is then moved (a new
    // level, a new time) watches again, unless the request says otherwise.
    // Done and dismissed stay: they're the user's decision.
    // An expired item whose expiry is moved later than now (or taken away)
    // matters again too.
    const extended = before && before.status === 'expired' && !sameTime(before.expires_at, item.expires_at)
        && (!item.expires_at || new Date(item.expires_at).getTime() > now.getTime());
    if (before && !Object.prototype.hasOwnProperty.call(patch, 'status')
        && ((redefined && (before.status === 'fired' || before.status === 'expired')) || extended)) {
        item.status = 'open';
    }

    // What each status carries: open has no fired or closed details, fired
    // has a fired_at and no closed details, a closed item has a closed_at
    // (from when it was closed; kept while it stays closed).
    const statusChanged = !before || before.status !== item.status;
    if (item.status === 'open') {
        item.fired_at = null;
        item.fired_note = null;
        item.closed_at = null;
        item.closed_note = null;
        if (statusChanged) item.reminded_at = null;
    } else if (item.status === 'fired') {
        if (statusChanged && !Object.prototype.hasOwnProperty.call(patch, 'fired_at')) item.fired_at = nowIso;
        if (!item.fired_at) item.fired_at = nowIso;
        // Fired again (a new fired_at on a fired item): new to the user again.
        if (statusChanged || !sameTime(before.fired_at, item.fired_at)) item.seen_at = null;
        item.closed_at = null;
        item.closed_note = null;
    } else {
        item.closed_at = statusChanged ? nowIso : (before.closed_at || nowIso);
    }

    const reopened = before && statusChanged && item.status === 'open';
    if (!before || redefined || reopened) item.armed_at = nowIso;
    // A reminder is for one due_at: moved (snoozed) or reopened, it's due again.
    if (before && (dueChanged || reopened) && !Object.prototype.hasOwnProperty.call(patch, 'reminded_at')) {
        item.reminded_at = null;
    }
    return item;
}

// --- Listing ---

const csv = (value) => String(value).split(',').map(s => s.trim()).filter(Boolean);

// The list's query string, checked. Throws a TodoError(400).
function parseListQuery(query = {}) {
    const q = {};
    if (query.status) {
        q.status = csv(query.status);
        for (const s of q.status) oneOf(s, 'status', STATUSES);
    }
    if (query.kind) {
        q.kind = csv(query.kind);
        for (const k of q.kind) oneOf(k, 'kind', KINDS);
    }
    if (query.created_by) q.created_by = oneOf(query.created_by, 'created_by', CREATORS);
    if (query.account_id) q.account_id = id(query.account_id, 'account_id');
    if (query.trade_id) q.trade_id = id(query.trade_id, 'trade_id');
    const bound = (value, field, endOfDay) => {
        if (!value) return null;
        if (DATE_RE.test(value)) return new Date(`${date(value, field)}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`).getTime();
        return new Date(time(value, field)).getTime();
    };
    // Dates are UTC days; give a time with a zone for any other day boundary.
    q.from = bound(query.from, 'from', false);
    q.to = bound(query.to, 'to', true);
    q.updated_since = bound(query.updated_since, 'updated_since', false);
    q.closed_since = bound(query.closed_since, 'closed_since', false);
    q.closed_before = bound(query.closed_before, 'closed_before', false);
    q.limit = Math.min(Math.max(parseInt(query.limit, 10) || 200, 1), 1000);
    q.offset = Math.max(parseInt(query.offset, 10) || 0, 0);
    return q;
}

const ms = (value) => (value ? new Date(value).getTime() : null);

// Fired first (they need someone), then by due_at (undated last), then by
// when they were written.
function compareItems(a, b) {
    const fired = (b.status === 'fired') - (a.status === 'fired');
    if (fired) return fired;
    const da = ms(a.due_at);
    const dbt = ms(b.due_at);
    if (da !== dbt) {
        if (da === null) return 1;
        if (dbt === null) return -1;
        return da - dbt;
    }
    return (ms(a.created_at) - ms(b.created_at)) || (a.id - b.id);
}

// Filters and orders the items (API shape) as the list query asks:
// { total, limit, offset, items } with items cut to limit/offset.
function filterItems(items, q) {
    const matched = items.filter(item => {
        if (q.status && !q.status.includes(item.status)) return false;
        if (q.kind && !q.kind.includes(item.kind)) return false;
        if (q.created_by && item.created_by !== q.created_by) return false;
        if (q.account_id && item.account_id !== q.account_id) return false;
        if (q.trade_id && item.trade_id !== q.trade_id) return false;
        if (q.from !== null && q.from !== undefined && !(item.due_at && ms(item.due_at) >= q.from)) return false;
        if (q.to !== null && q.to !== undefined && !(item.due_at && ms(item.due_at) <= q.to)) return false;
        if (q.updated_since !== null && q.updated_since !== undefined && !(ms(item.updated_at) >= q.updated_since)) return false;
        // Closed items only from this time on; open and fired ones always.
        if (q.closed_since !== null && q.closed_since !== undefined && CLOSED_STATUSES.includes(item.status)
            && !(ms(item.closed_at) >= q.closed_since)) return false;
        // Only items closed before this time (the older history), newest first.
        if (q.closed_before !== null && q.closed_before !== undefined
            && !(CLOSED_STATUSES.includes(item.status) && ms(item.closed_at) < q.closed_before)) return false;
        return true;
    }).sort(q.closed_before !== null && q.closed_before !== undefined
        ? (a, b) => (ms(b.closed_at) - ms(a.closed_at)) || (b.id - a.id)
        : compareItems);
    const offset = q.offset || 0;
    const limit = q.limit || 200;
    return { total: matched.length, limit, offset, items: matched.slice(offset, offset + limit) };
}

// --- Storage (Postgres) ---

const iso = (value) => (value instanceof Date ? value.toISOString() : value ?? null);

// A database row (with account_name / trade_symbol joined) in the API shape.
function rowToItem(row) {
    return {
        id: row.id,
        key: row.key,
        kind: row.kind,
        title: row.title,
        then: row.then_text,
        notes: row.notes,
        status: row.status,
        created_by: row.created_by,
        source: row.source,
        account_id: row.account_id,
        account_name: row.account_name ?? null,
        trade_id: row.trade_id,
        trade_symbol: row.trade_symbol ?? null,
        due_at: iso(row.due_at),
        alert: row.alert,
        reminded_at: iso(row.reminded_at),
        expires_at: iso(row.expires_at),
        armed_at: iso(row.armed_at),
        fired_at: iso(row.fired_at),
        fired_note: row.fired_note,
        closed_at: iso(row.closed_at),
        closed_note: row.closed_note,
        seen_at: iso(row.seen_at),
        created_at: iso(row.created_at),
        updated_at: iso(row.updated_at),
        trigger: row.trigger_spec,
        order: row.order_spec,
    };
}

// Columns written from an item (API shape), in this order.
const COLUMNS = [
    ['key', i => i.key], ['kind', i => i.kind], ['title', i => i.title], ['then_text', i => i.then],
    ['notes', i => i.notes], ['status', i => i.status], ['created_by', i => i.created_by], ['source', i => i.source],
    ['account_id', i => i.account_id], ['trade_id', i => i.trade_id], ['due_at', i => i.due_at],
    ['alert', i => i.alert], ['reminded_at', i => i.reminded_at], ['expires_at', i => i.expires_at],
    ['armed_at', i => i.armed_at], ['fired_at', i => i.fired_at], ['fired_note', i => i.fired_note],
    ['closed_at', i => i.closed_at], ['closed_note', i => i.closed_note], ['seen_at', i => i.seen_at],
    ['trigger_spec', i => (i.trigger ? JSON.stringify(i.trigger) : null)],
    ['order_spec', i => (i.order ? JSON.stringify(i.order) : null)],
];

const SELECT = `
    SELECT t.*, a.name AS account_name, tr.symbol AS trade_symbol
    FROM todos t
    LEFT JOIN accounts a ON a.id = t.account_id
    LEFT JOIN trades tr ON tr.id = t.trade_id`;

// getPool: () => pg Pool (called per use: the pool may not exist yet when
// the routes are built).
function createTodoStore(getPool) {
    const one = async (runner, where, params) => {
        const { rows } = await runner.query(`${SELECT} WHERE ${where}`, params);
        return rows[0] ? rowToItem(rows[0]) : null;
    };
    const queries = (runner) => ({
        get: (todoId) => one(runner, 't.id = $1', [todoId]),
        getByKey: (key) => one(runner, 't.key = $1', [key]),
        // Locked until the transaction ends: two writes to one item queue up.
        lock: async (todoId) => {
            await runner.query('SELECT id FROM todos WHERE id = $1 FOR UPDATE', [todoId]);
            return one(runner, 't.id = $1', [todoId]);
        },
        lockByKey: async (key) => {
            await runner.query('SELECT id FROM todos WHERE key = $1 FOR UPDATE', [key]);
            return one(runner, 't.key = $1', [key]);
        },
        insert: async (item) => {
            const { rows: [row] } = await runner.query(
                `INSERT INTO todos (${COLUMNS.map(c => c[0]).join(', ')})
                 VALUES (${COLUMNS.map((c, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
                COLUMNS.map(c => c[1](item))
            );
            return one(runner, 't.id = $1', [row.id]);
        },
        update: async (todoId, item) => {
            await runner.query(
                `UPDATE todos SET ${COLUMNS.map((c, i) => `${c[0]} = $${i + 2}`).join(', ')}, updated_at = NOW()
                 WHERE id = $1`,
                [todoId, ...COLUMNS.map(c => c[1](item))]
            );
            return one(runner, 't.id = $1', [todoId]);
        },
        remove: async (todoId) => {
            const { rows: [row] } = await runner.query('DELETE FROM todos WHERE id = $1 RETURNING id, key', [todoId]);
            return row || null;
        },
        // ids: only these (the ones on screen); null: every fired item.
        markSeen: async (ids = null) => {
            const { rowCount } = await runner.query(
                `UPDATE todos SET seen_at = NOW() WHERE status = 'fired' AND seen_at IS NULL AND ($1::int[] IS NULL OR id = ANY($1))`,
                [ids]
            );
            return rowCount;
        },
        account: async (accountId) => {
            const { rows: [row] } = await runner.query('SELECT id, name, is_virtual, archived FROM accounts WHERE id = $1', [accountId]);
            return row || null;
        },
        trade: async (tradeId) => {
            const { rows: [row] } = await runner.query('SELECT id, symbol FROM trades WHERE id = $1', [tradeId]);
            return row || null;
        },
        all: async () => {
            const { rows } = await runner.query(SELECT);
            return rows.map(rowToItem);
        },
    });

    return {
        ...queries({ query: (...args) => getPool().query(...args) }),
        // fn(store) runs in one transaction on one connection.
        async transaction(fn) {
            const client = await getPool().connect();
            try {
                await client.query('BEGIN');
                const result = await fn(queries(client));
                await client.query('COMMIT');
                return result;
            } catch (err) {
                await client.query('ROLLBACK').catch(() => {});
                throw err;
            } finally {
                client.release();
            }
        },
    };
}

// --- The operations both sets of routes offer ---

// store: createTodoStore() or a stand-in with the same methods.
// onChange({ id, key, change, origin }): after every write that changed
// something, change 'created' | 'updated' | 'deleted'.
function createTodoService(store, { onChange = () => {}, now = () => new Date() } = {}) {
    // The links an item points at: they must exist, and an account must not
    // be archived (paper ones are fine: orders on a paper account are
    // pending orders too). Only checked for a value the request changes, so
    // an item whose account was archived later can still be edited and
    // closed (the app's form sends the account it has along every time).
    async function checkLinks(tx, patch, before) {
        const changes = (field) => patch[field] && (!before || Number(before[field]) !== Number(patch[field]));
        if (changes('account_id')) {
            const account = await tx.account(patch.account_id);
            if (!account) throw bad(`account_id ${patch.account_id} doesn't exist`);
            if (account.archived) throw bad(`account_id ${patch.account_id} is archived`);
        }
        if (changes('trade_id')) {
            const trade = await tx.trade(patch.trade_id);
            if (!trade) throw bad(`trade_id ${patch.trade_id} doesn't exist`);
        }
    }

    const keyTaken = (err) => err && err.code === '23505';

    async function create(body, origin) {
        const patch = parseInput(body);
        const item = applyWrite(null, patch, { origin, now: now() });
        try {
            const saved = await store.transaction(async (tx) => {
                await checkLinks(tx, patch, null);
                return tx.insert(item);
            });
            onChange({ id: saved.id, key: saved.key, change: 'created', origin });
            return saved;
        } catch (err) {
            if (keyTaken(err)) throw new TodoError(409, `key ${item.key} is already in use; PUT /todos/key/${item.key} updates that item`);
            throw err;
        }
    }

    // PUT by key: creates the item, or updates the one with that key. An
    // item the user closed (done, dismissed) stays as it is unless the body
    // says "reopen": true.
    async function upsertByKey(key, body, origin) {
        if (!KEY_RE.test(key) || key.length > KEY_MAX) throw bad('key may only contain letters, digits and . _ : ~ -');
        const patch = parseInput(body);
        patch.key = key;
        const reopen = body.reopen === true;
        const attempt = () => store.transaction(async (tx) => {
            const existing = await tx.lockByKey(key);
            if (!existing) {
                const item = applyWrite(null, patch, { origin, now: now() });
                await checkLinks(tx, patch, null);
                return { saved: await tx.insert(item), created: true };
            }
            if (USER_CLOSED_STATUSES.includes(existing.status)) {
                if (!reopen) throw new TodoError(409, 'closed by the user', { todo: existing });
                if (!Object.prototype.hasOwnProperty.call(patch, 'status')) patch.status = 'open';
            }
            const item = applyWrite(existing, patch, { origin, now: now() });
            await checkLinks(tx, patch, existing);
            return { saved: await tx.update(existing.id, item), created: false };
        });
        let result;
        try {
            result = await attempt();
        } catch (err) {
            // Created by a second request at the same moment: update that one.
            if (!keyTaken(err)) throw err;
            result = await attempt();
        }
        onChange({ id: result.saved.id, key: result.saved.key, change: result.created ? 'created' : 'updated', origin });
        return result;
    }

    async function update(todoId, body, origin) {
        const patch = parseInput(body);
        try {
            const saved = await store.transaction(async (tx) => {
                const existing = await tx.lock(todoId);
                if (!existing) throw new TodoError(404, 'Todo not found');
                const item = applyWrite(existing, patch, { origin, now: now() });
                await checkLinks(tx, patch, existing);
                return tx.update(todoId, item);
            });
            onChange({ id: saved.id, key: saved.key, change: 'updated', origin });
            return saved;
        } catch (err) {
            if (keyTaken(err)) throw new TodoError(409, `key ${patch.key} is already in use by another item`);
            throw err;
        }
    }

    async function remove(todoId, origin) {
        const removed = await store.remove(todoId);
        if (!removed) throw new TodoError(404, 'Todo not found');
        onChange({ id: removed.id, key: removed.key, change: 'deleted', origin });
        return removed;
    }

    async function list(query) {
        const q = parseListQuery(query);
        return filterItems(await store.all(), q);
    }

    async function get(todoId) {
        const item = await store.get(todoId);
        if (!item) throw new TodoError(404, 'Todo not found');
        return item;
    }

    async function getByKey(key) {
        const item = await store.getByKey(key);
        if (!item) throw new TodoError(404, 'Todo not found');
        return item;
    }

    // The user has seen the fired items (the Todo page was opened): the
    // ones with these ids, or every one without ids.
    async function markSeen(origin = 'app', ids = null) {
        if (ids !== null && (!Array.isArray(ids) || !ids.every(i => Number.isInteger(i) && i > 0))) {
            throw bad('ids must be a list of whole numbers');
        }
        const count = await store.markSeen(ids);
        if (count > 0) onChange({ id: null, key: null, change: 'seen', origin });
        return count;
    }

    return { create, upsertByKey, update, remove, list, get, getByKey, markSeen };
}

module.exports = {
    KINDS, STATUSES, CLOSED_STATUSES, USER_CLOSED_STATUSES, CONDITIONS, ORDER_TYPES, ORDER_PRICES, TIFS,
    TodoError,
    parseInput,
    applyWrite,
    parseListQuery,
    compareItems,
    filterItems,
    rowToItem,
    createTodoStore,
    createTodoService,
};
