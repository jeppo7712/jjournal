// Checks a saved IBKR Flex query against what the journal reads from it, so
// setting one up isn't guesswork among IBKR's hundreds of checkboxes. Each
// check says what's wrong and what to tick. Pure: takes the parsed
// statements, returns the checks.

const { flexDate } = require('./brokerCash.js');

// What the journal reads, per query type. need: 'required' (the import
// doesn't work without it), 'recommended' (a feature needs it) or
// 'optional'. fields: the attributes read from that section's rows —
// required ones it can't do without, recommended ones that make it more
// precise. cashOnly: sections for cash tracking, which paper accounts
// don't do.
const QUERY_SPECS = {
    activity: {
        type: 'AF',
        label: 'Activity',
        sections: [
            {
                section: 'Trades', row: 'Trade', label: 'Trades', need: 'required',
                purpose: 'importing your trades',
                fields: ['symbol', 'dateTime', 'buySell', 'quantity', 'tradePrice', 'ibCommission', 'ibExecID'],
                recommended: ['accountId', 'assetCategory', 'currency', 'listingExchange', 'expiry', 'underlyingSymbol', 'ibOrderID'],
            },
            {
                section: 'CashTransactions', row: 'CashTransaction', label: 'Cash Transactions', need: 'recommended',
                purpose: 'broker activity on the Capital page: deposits, fees, interest, dividends and tax',
                fields: ['currency', 'type', 'amount', 'dateTime', 'transactionID'],
                recommended: ['accountId', 'actionID', 'symbol', 'description', 'exDate', 'levelOfDetail'],
                cashOnly: true,
            },
            {
                section: 'CashReport', row: 'CashReportCurrency', label: 'Cash Report', need: 'recommended',
                purpose: 'checking the journal\'s cash against IBKR\'s',
                fields: ['accountId', 'currency', 'endingCash', 'toDate'],
                cashOnly: true,
            },
            {
                section: 'OpenDividendAccruals', row: 'OpenDividendAccrual', label: 'Open Dividend Accruals', need: 'optional',
                purpose: 'dividends announced but not paid yet',
                fields: [],
                recommended: ['accountId', 'symbol', 'currency', 'exDate', 'payDate', 'grossAmount', 'netAmount', 'actionID'],
                cashOnly: true,
            },
        ],
    },
    tradeConfirm: {
        type: 'TCF',
        label: 'Trade Confirmation',
        sections: [
            {
                section: 'TradeConfirms', row: 'TradeConfirm', label: 'Trade Confirmations', need: 'required',
                purpose: 'importing today\'s trades',
                fields: ['symbol', 'dateTime', 'buySell', 'quantity', 'price', 'commission', 'execID'],
                recommended: ['accountId', 'assetCategory', 'currency', 'listingExchange', 'expiry'],
            },
        ],
    },
};

const rowsOf = (statement, section, row) => {
    const rows = statement?.[section]?.[row];
    if (!rows) return [];
    return Array.isArray(rows) ? rows : [rows];
};

// IBKR account IDs: U1234567, DU1234567, U1234567F. Anything else is the
// account alias, which the query shows instead when told to.
const ACCOUNT_ID_RE = /^[A-Z]{1,3}\d{3,}[A-Z]?$/;

/**
 * @param {{ statements: object[], type: string|null }} result  one query's pull
 * @param {'activity'|'tradeConfirm'} purpose  which field the query ID is in
 * @param {object} opts
 * @param {'real'|'paper'} opts.kind           which credential set it is
 * @param {object[]} opts.accounts             journal accounts { name, broker_account_id, is_virtual, parent_account_id }
 * @returns {{ status, label, detail, fix? }[]}  status: ok | missing | warn | info
 */
function checkFlexQuery(result, purpose, { kind, accounts = [] }) {
    const spec = QUERY_SPECS[purpose];
    const other = purpose === 'activity' ? QUERY_SPECS.tradeConfirm : QUERY_SPECS.activity;
    const checks = [];
    const statements = result?.statements || [];

    if (result?.type && result.type !== spec.type) {
        checks.push({
            status: 'missing',
            label: 'Query type',
            detail: `This is a ${result.type === other.type ? other.label : result.type} query, but it's in the ${spec.label} field.`,
            fix: `Put its ID in the ${result.type === other.type ? other.label : 'matching'} field, and create an ${spec.label} Flex Query for this one.`,
        });
        return checks;
    }

    // Accounts: real vs paper, alias vs ID, and which journal account each is.
    const ids = [...new Set(statements.map(s => String(s.accountId || '')).filter(Boolean))];
    for (const id of ids) {
        if (!ACCOUNT_ID_RE.test(id)) {
            checks.push({
                status: 'missing', label: `Account "${id}"`,
                detail: 'The query shows the account alias instead of the account ID, so nothing can be matched to a journal account.',
                fix: 'General Configuration: set "Display Account Alias in Place of Account ID" to No.',
            });
            continue;
        }
        const paper = /^D/i.test(id);
        if (paper !== (kind === 'paper')) {
            checks.push({
                status: 'missing', label: `Account ${id}`,
                detail: `A ${paper ? 'paper' : 'real'} account, in the ${kind} settings. Real and paper must never mix: nothing is imported from it.`,
                fix: `Use the ${paper ? 'paper' : 'real'} login's token and queries in the ${paper ? 'Paper' : 'Real'} accounts settings.`,
            });
            continue;
        }
        const journal = accounts.find(a => String(a.broker_account_id || '').toUpperCase() === id.toUpperCase());
        // Trades or cash movements; a Cash Report row is there even for an
        // empty account.
        const active = statements.some(st => String(st.accountId) === id
            && [['Trades', 'Trade'], ['TradeConfirms', 'TradeConfirm'], ['CashTransactions', 'CashTransaction']]
                .some(([section, row]) => rowsOf(st, section, row).length > 0));
        if (!journal && !active) {
            checks.push({ status: 'info', label: `Account ${id}`, detail: 'No activity in this period, so nothing to link it to.' });
            continue;
        }
        checks.push(journal
            ? { status: 'ok', label: `Account ${id}`, detail: `Mirrored by the journal account "${journal.name}".` }
            : {
                status: purpose === 'activity' ? 'warn' : 'info', label: `Account ${id}`,
                detail: 'Not linked to a journal account: its trades import by symbol as before, but its cash activity has nowhere to go.',
                fix: 'Settings → Accounts: enter it as the Broker account ID of the top-level journal account it mirrors.',
            });
    }
    if (ids.length === 0) {
        checks.push({ status: 'info', label: 'Accounts', detail: 'The statement names no account (no activity in its period?).' });
    }

    // Period: the Activity query is the history; a short one misses trades.
    const statement = statements[0];
    const from = flexDate(statement?.fromDate);
    const to = flexDate(statement?.toDate);
    if (purpose === 'activity' && from && to) {
        const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
        checks.push(days >= 300
            ? { status: 'ok', label: 'Period', detail: `${from} to ${to} (${days} days).` }
            : {
                status: 'warn', label: 'Period', detail: `Only ${from} to ${to} (${days} days).`,
                fix: 'Delivery Configuration: set Period to "Last 365 Calendar Days".',
            });
    }

    // Dates: read as year-month-day digits; another order is misread.
    const sampleDate = statements
        .flatMap(s => spec.sections.flatMap(sec => rowsOf(s, sec.section, sec.row)))
        .map(r => r.dateTime || r.tradeDate || r.reportDate)
        .find(Boolean);
    if (sampleDate) {
        const date = flexDate(sampleDate);
        const year = date ? Number(date.slice(0, 4)) : 0;
        checks.push(date && year >= 2000 && year <= 2100
            ? { status: 'ok', label: 'Date format', detail: `Dates read correctly (e.g. ${sampleDate}).` }
            : {
                status: 'missing', label: 'Date format', detail: `"${sampleDate}" isn't year-month-day.`,
                fix: 'General Configuration: Date Format yyyyMMdd, Time Format HHmmss, Date/Time Separator ; (semi-colon).',
            });
    }

    // Sections and their fields.
    for (const sec of spec.sections) {
        if (sec.cashOnly && kind === 'paper') continue; // paper cash is simulated
        const included = statements.some(s => Object.prototype.hasOwnProperty.call(s, sec.section));
        const rows = statements.flatMap(s => rowsOf(s, sec.section, sec.row));
        if (!included) {
            checks.push({
                status: sec.need === 'required' ? 'missing' : sec.need === 'recommended' ? 'warn' : 'info',
                label: sec.label,
                detail: `Not in the query — needed for ${sec.purpose}.`,
                fix: `Sections: tick "${sec.label}" and Select All its fields.`,
            });
            continue;
        }
        if (rows.length === 0) {
            checks.push({
                status: 'info', label: sec.label,
                detail: `Included, but no rows in this period yet, so its fields can't be checked until there are some (${sec.purpose}).`,
            });
            continue;
        }
        const present = new Set(rows.flatMap(r => Object.keys(r)));
        const missing = sec.fields.filter(f => !present.has(f));
        const lacking = (sec.recommended || []).filter(f => !present.has(f));
        if (missing.length > 0) {
            checks.push({
                status: sec.need === 'required' ? 'missing' : 'warn', label: sec.label,
                detail: `Missing field${missing.length > 1 ? 's' : ''} it can't do without: ${missing.join(', ')}${lacking.length ? `; also ${lacking.join(', ')}` : ''}.`,
                fix: `Edit the "${sec.label}" section and Select All its fields.`,
            });
            continue;
        }
        if (lacking.length > 0) {
            checks.push({
                status: 'warn', label: sec.label,
                detail: `Works, but without ${lacking.join(', ')}: these tell apart accounts, asset types, listings and contract months.`,
                fix: `Edit the "${sec.label}" section and Select All its fields.`,
            });
            continue;
        }
        if (sec.section === 'CashTransactions' && rows.some(r => r.levelOfDetail && String(r.levelOfDetail).toUpperCase() !== 'DETAIL')) {
            checks.push({
                status: 'missing', label: sec.label,
                detail: 'Set to Summary: totals carry no transaction IDs, so single payments can\'t be told apart.',
                fix: 'In the "Cash Transactions" section options, choose Detail instead of Summary.',
            });
            continue;
        }
        if (sec.section === 'Trades' && rows.some(r => r.levelOfDetail && String(r.levelOfDetail).toUpperCase() !== 'EXECUTION')) {
            checks.push({
                status: 'warn', label: sec.label,
                detail: 'Contains more than executions; only executions are read.',
                fix: 'In the "Trades" section options, tick Execution only.',
            });
            continue;
        }
        checks.push({ status: 'ok', label: sec.label, detail: `${rows.length} row${rows.length !== 1 ? 's' : ''}, all fields present.` });
    }
    return checks;
}

module.exports = { checkFlexQuery, QUERY_SPECS };
