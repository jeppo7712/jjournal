const { Pool } = require('pg');
const { logger } = require('./logger.js');

let pool = null;

let isConnected = false;

/**
 * Connects to the database, creates the schema, and sets up the connection pool.
 * @param {string} databaseUrl - The PostgreSQL connection string.
 * @param {function} broadcastStatus - Function to send status updates via WebSocket.
 * @param {function} uuidv4 - Function to generate a UUID for request IDs.
 */
async function connectDatabase(databaseUrl, broadcastStatus, uuidv4) {
  try {
    logger.info('[Database] Connecting to database...');
    pool = new Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 5000,
      // Default (10) was tight: every chart open triggers a fresh Yahoo/IBKR
      // foreground population check on the same table a read is about to
      // query — confirmed via timing logs that a read taking ~150ms in
      // isolation (EXPLAIN ANALYZE) took ~3.7s when a same-request-triggered
      // background write was running concurrently. More headroom reduces
      // that contention; Postgres's own default max_connections is
      // typically 100+, so this still leaves room for other clients (this DB
      // is shared with an unrelated service on this host).
      max: 20,
    });

    const client = await pool.connect();
    logger.info('✅ Connected to PostgreSQL database');

    // Check current user
    const { rows: userRows } = await client.query('SELECT current_user');
    logger.info(`Current database user: ${userRows[0].current_user}`);

    // Create symbol_type enum. Postgres has no `CREATE TYPE IF NOT EXISTS`,
    // so on every startup after the very first one this used to just try the
    // CREATE and catch the resulting 42710 (duplicate_object) error — handled
    // fine application-side, but Postgres still logs the raw ERROR itself
    // before the app ever gets a chance to catch it, showing up in the DB's
    // own log on every single restart. Checking pg_type first avoids ever
    // issuing the doomed CREATE, so nothing gets logged as an error at all.
    logger.debug('Creating symbol_type...');
    const { rows: symbolTypeExists } = await client.query(
      `SELECT 1 FROM pg_type WHERE typname = 'symbol_type'`
    );
    if (symbolTypeExists.length === 0) {
      await client.query(`CREATE TYPE symbol_type AS ENUM ('STK', 'FUT');`);
      logger.debug('Symbol_type created successfully');
    } else {
      logger.debug('Symbol_type already exists, proceeding...');
    }

    // Create accounts table
    logger.debug('Creating accounts table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id SERIAL PRIMARY KEY,
        name VARCHAR NOT NULL UNIQUE,
        parent_account_id INTEGER REFERENCES accounts(id),
        is_virtual BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
    logger.debug('Accounts table created successfully');

    // parent_account_id: lets an account's capital be represented as
    // allocated from a larger pool (e.g. a "Main Capital" account with
    // several trading accounts as children) without inventing a separate
    // hierarchy concept — it's still just accounts, one optional link.
    // is_virtual: paper vs real, for the WHOLE account, permanently — not a
    // per-transaction choice. A real IBKR paper-trading account is a
    // genuinely different account from a live one (different account
    // number entirely), so a paper journal account graduating to live
    // trading means switching to a different (already-separate) account,
    // not flipping a flag mid-stream on one account. Originally designed
    // as a per-transaction override with an account-level "default" — that
    // flexibility was never wanted and was actively causing mislabeled
    // data (an account's own default not being set correctly meant
    // auto-settled trades silently landed on the wrong side), so it's
    // simplified to one account-level source of truth. See
    // docs/CAPITAL_TRACKING_DESIGN.md.
    await client.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS parent_account_id INTEGER REFERENCES accounts(id)`);
    await client.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS default_is_virtual BOOLEAN NOT NULL DEFAULT FALSE`);
    // Rename from the original per-transaction-default design to the
    // simplified account-level meaning. IF NOT EXISTS-style guard: only
    // rename if the old name is still there (idempotent across restarts).
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='accounts' AND column_name='default_is_virtual')
           AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='accounts' AND column_name='is_virtual')
        THEN
          ALTER TABLE accounts RENAME COLUMN default_is_virtual TO is_virtual;
        END IF;
      END $$;
    `);
    logger.debug('accounts hierarchy/virtual columns ready');

    logger.debug('Creating account_filters table...');
    await client.query(`
  CREATE TABLE IF NOT EXISTS account_filters (
    account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    status_filters JSONB,
    time_filter VARCHAR,
    custom_start_date DATE,
    custom_end_date DATE,
    symbol_filter VARCHAR,
    show_trades BOOLEAN,
    show_day_notes BOOLEAN,
    restrict_to_actions_in_range BOOLEAN,
    trades_per_page INTEGER DEFAULT 100
      );
`);
    logger.debug('Account_filters table created successfully');

    // Per-account trade list column visibility (e.g. hiding "Ent Tot"/"Ext Tot"
    // for a futures-only account where they don't make sense). Empty array
    // default means every column stays visible unless the user hides one.
    await client.query(`ALTER TABLE account_filters ADD COLUMN IF NOT EXISTS hidden_columns JSONB NOT NULL DEFAULT '[]'::jsonb`);
    logger.debug('account_filters.hidden_columns ready');

    // Create trades table with symbol_type
    logger.debug('Creating trades table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS trades (
        id SERIAL PRIMARY KEY,
        account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
        type symbol_type NOT NULL,
        symbol VARCHAR NOT NULL,
        target NUMERIC,
        stop_loss NUMERIC,
        tick_size NUMERIC,
        tick_value NUMERIC,
        contract_month VARCHAR,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
    logger.debug('Trades table created successfully');

    // Create trade_actions table
    logger.debug('Creating trade_actions table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS trade_actions (
        id SERIAL PRIMARY KEY,
        trade_id INTEGER REFERENCES trades(id) ON DELETE CASCADE,
        type VARCHAR NOT NULL,
        date_time TIMESTAMP WITH TIME ZONE NOT NULL,
        quantity NUMERIC NOT NULL,
        price NUMERIC NOT NULL,
        fee NUMERIC,
        exec_id TEXT
      );
    `);
    logger.debug('Trade_actions table created successfully');

    // Add exec_id to trade_actions for databases created before this column existed
    // (no-op on fresh installs, where CREATE TABLE above already includes it)
    logger.debug('Ensuring trade_actions.exec_id exists...');
    await client.query(`
      ALTER TABLE trade_actions ADD COLUMN IF NOT EXISTS exec_id TEXT;
    `);
    logger.debug('trade_actions.exec_id present');

    // Create trade_journals table
    logger.debug('Creating trade_journals table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS trade_journals (
        id SERIAL PRIMARY KEY,
        trade_id INTEGER REFERENCES trades(id) ON DELETE CASCADE,
        tags VARCHAR,
        notes_html TEXT,
        confidence INTEGER,
        execution_rating INTEGER
      );
    `);
    logger.debug('Trade_journals table created successfully');

    // AI-generated analysis, written by external tools via the external API
    // (routes/external.js). Kept separate from notes_html (the user's own
    // journal writing) so an external tool can never overwrite what the user
    // wrote by hand.
    await client.query(`ALTER TABLE trade_journals ADD COLUMN IF NOT EXISTS ai_analysis TEXT`);
    await client.query(`ALTER TABLE trade_journals ADD COLUMN IF NOT EXISTS ai_analysis_source VARCHAR`);
    await client.query(`ALTER TABLE trade_journals ADD COLUMN IF NOT EXISTS ai_analysis_updated_at TIMESTAMP WITH TIME ZONE`);
    logger.debug('trade_journals.ai_analysis columns ready');

    // The external API upserts a trade's AI analysis by trade_id (ON CONFLICT),
    // which needs a uniqueness guarantee. The app has always kept at most one
    // trade_journals row per trade via delete-then-insert on every save, but
    // that was never enforced at the DB level — defensively collapse any
    // pre-existing duplicates before adding the index.
    await client.query(`DELETE FROM trade_journals a USING trade_journals b WHERE a.id < b.id AND a.trade_id = b.trade_id`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS trade_journals_trade_id_unique_idx ON trade_journals (trade_id)`);
    logger.debug('trade_journals.trade_id uniqueness ready');

    // Create day_notes table
    logger.debug('Creating day_notes table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS day_notes (
        id SERIAL PRIMARY KEY,
        account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        mood INTEGER,
        market_condition INTEGER,
        market_volume INTEGER,
        summary TEXT,
        notes_html TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE (account_id, date)
      );
    `);
    logger.debug('Day_notes table created successfully');

    logger.debug('Creating trade_attachments table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS trade_attachments (
        id SERIAL PRIMARY KEY,
        account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
    trade_id INTEGER REFERENCES trades(id),
    day_note_id INTEGER REFERENCES day_notes(id),
        image_data BYTEA,
        file_url VARCHAR,
        mime_type TEXT,
        filename TEXT,
        uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        CONSTRAINT check_link CHECK (
          (trade_id IS NOT NULL AND day_note_id IS NULL) OR
          (trade_id IS NULL AND day_note_id IS NULL) OR
          (trade_id IS NULL AND day_note_id IS NOT NULL)
        )
      );
    `);
    logger.debug('Trade_attachments table created successfully');

    // --- Capital tracking: holdings (T-bills/bonds/other non-trade assets)
    // and cash_transactions (the ledger). See docs/CAPITAL_TRACKING_DESIGN.md
    // for the full design and rationale. holdings is created first since
    // cash_transactions references it.
    logger.debug('Creating holdings table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS holdings (
        id SERIAL PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        type VARCHAR NOT NULL, -- TBILL | BOND | OTHER
        name VARCHAR NOT NULL,
        currency VARCHAR NOT NULL DEFAULT 'USD',
        face_value NUMERIC NOT NULL,
        purchase_price NUMERIC NOT NULL,
        purchase_date DATE NOT NULL,
        maturity_date DATE,
        -- Optional detail: NULL means "just track principal in/out at
        -- purchase/maturity," no accrual modeling. Set both to compute
        -- accrued value between coupon dates for display.
        coupon_rate NUMERIC,
        coupon_frequency VARCHAR, -- e.g. 'ANNUAL', 'SEMI_ANNUAL', 'QUARTERLY'
        status VARCHAR NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | MATURED | SOLD
        notes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        CONSTRAINT check_holding_type CHECK (type IN ('TBILL', 'BOND', 'OTHER')),
        CONSTRAINT check_holding_status CHECK (status IN ('ACTIVE', 'MATURED', 'SOLD'))
      );
    `);
    logger.debug('Holdings table created successfully');

    logger.debug('Creating cash_transactions table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS cash_transactions (
        id SERIAL PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        date_time TIMESTAMP WITH TIME ZONE NOT NULL,
        type VARCHAR NOT NULL, -- DEPOSIT | WITHDRAWAL | TRANSFER_IN | TRANSFER_OUT
                                -- | TRADE_SETTLEMENT | INTEREST | OTHER
                                -- | EXCHANGE_IN | EXCHANGE_OUT
        amount NUMERIC NOT NULL, -- signed: positive = cash in, negative = cash out
        currency VARCHAR NOT NULL DEFAULT 'USD',
        -- No is_virtual here — paper-vs-real is an ACCOUNT-level property
        -- (accounts.is_virtual), not per-transaction. Originally this table
        -- had its own is_virtual with the account's as just a "default,"
        -- which meant an account's own setting not being configured
        -- correctly silently mislabeled every transaction created under
        -- it. Simplified: every transaction is whatever its account is,
        -- always, derived via JOIN rather than duplicated per row.
        linked_trade_id INTEGER REFERENCES trades(id) ON DELETE CASCADE,
        linked_holding_id INTEGER REFERENCES holdings(id) ON DELETE CASCADE,
        -- Links a TRANSFER_OUT row to its matching TRANSFER_IN row in the
        -- other account (and vice versa), so a transfer is always a
        -- traceable, balanced pair rather than two independent entries.
        -- Also reused for a currency EXCHANGE_OUT/EXCHANGE_IN pair, which is
        -- the same idea within a single account (currency differs between
        -- the two legs instead of account_id). ON DELETE SET NULL: both
        -- sides mutually reference each other, so deleting either one first
        -- would otherwise violate the other's FK — this lets the app delete
        -- one side, have the other's reference auto-null, then delete that
        -- one too, instead of failing on a circular reference.
        transfer_pair_id INTEGER REFERENCES cash_transactions(id) ON DELETE SET NULL,
        note TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        CONSTRAINT check_cash_transaction_type CHECK (type IN (
          'DEPOSIT', 'WITHDRAWAL', 'TRANSFER_IN', 'TRANSFER_OUT',
          'TRADE_SETTLEMENT', 'INTEREST', 'OTHER', 'EXCHANGE_IN', 'EXCHANGE_OUT'
        ))
      );
    `);
    logger.debug('Cash_transactions table created successfully');

    // Existing installs from before is_virtual was simplified to
    // account-level still have this column — drop it, now that it's been
    // verified redundant with (and previously drifted from) the account's
    // own flag.
    await client.query(`ALTER TABLE cash_transactions DROP COLUMN IF EXISTS is_virtual`);
    logger.debug('cash_transactions.is_virtual removed (account-level now)');

    // Existing installs from before EXCHANGE_IN/EXCHANGE_OUT existed have the
    // narrower constraint from the original CREATE TABLE (which IF NOT
    // EXISTS won't retroactively update) — replace it so the check reflects
    // the current allowed type list either way.
    await client.query(`ALTER TABLE cash_transactions DROP CONSTRAINT IF EXISTS check_cash_transaction_type`);
    await client.query(`
      ALTER TABLE cash_transactions ADD CONSTRAINT check_cash_transaction_type CHECK (type IN (
        'DEPOSIT', 'WITHDRAWAL', 'TRANSFER_IN', 'TRANSFER_OUT',
        'TRADE_SETTLEMENT', 'INTEREST', 'OTHER', 'EXCHANGE_IN', 'EXCHANGE_OUT'
      ))
    `);
    logger.debug('cash_transactions type constraint up to date');

    // Same "IF NOT EXISTS won't retroactively update" reasoning as above —
    // an existing install's transfer_pair_id FK has no ON DELETE behavior,
    // which fails deleting either side of a transfer/exchange pair (they
    // mutually reference each other).
    await client.query(`ALTER TABLE cash_transactions DROP CONSTRAINT IF EXISTS cash_transactions_transfer_pair_id_fkey`);
    await client.query(`
      ALTER TABLE cash_transactions ADD CONSTRAINT cash_transactions_transfer_pair_id_fkey
        FOREIGN KEY (transfer_pair_id) REFERENCES cash_transactions(id) ON DELETE SET NULL
    `);
    logger.debug('cash_transactions transfer_pair_id ON DELETE behavior up to date');

    await client.query(`CREATE INDEX IF NOT EXISTS idx_cash_transactions_account ON cash_transactions (account_id, date_time)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_cash_transactions_trade ON cash_transactions (linked_trade_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_holdings_account ON holdings (account_id)`);
    logger.debug('Capital tracking indexes ready');

    logger.debug('Creating futures_settings table...');
    await client.query(`
CREATE TABLE IF NOT EXISTS futures_settings (
id SERIAL PRIMARY KEY,
symbol VARCHAR NOT NULL,
type symbol_type NOT NULL,
tick_size NUMERIC NOT NULL,
tick_value NUMERIC NOT NULL,
fee NUMERIC NOT NULL,
exchange VARCHAR,
rollover_months integer[],
        initial_margin NUMERIC,
        maintenance_margin NUMERIC,
        currency VARCHAR NOT NULL DEFAULT 'USD',
UNIQUE (symbol, type)
);
`);
    logger.debug('Futures_settings table created successfully');

    // Every price/PnL calculation in this app implicitly assumed USD (IBKR
    // contract lookups even hardcoded currency:'USD'). Defaulting existing
    // and new rows to USD preserves that behavior for symbols nobody
    // touches; a non-USD symbol (e.g. a EUR- or AED-denominated listing)
    // just needs this set explicitly once, in Settings.
    await client.query(`ALTER TABLE futures_settings ADD COLUMN IF NOT EXISTS currency VARCHAR NOT NULL DEFAULT 'USD'`);
    logger.debug('futures_settings.currency ready');

    // Set default rollover_months for existing FUT rows
    await client.query(`
  UPDATE futures_settings 
  SET rollover_months = ARRAY[3,6,9,12] 
  WHERE type = 'FUT' AND rollover_months IS NULL
`);
    logger.debug('Set default rollover_months for existing FUT settings');

    // Add check_rollover_months constraint (simplified)
    const { rows: monthConstraintExists } = await client.query(`
  SELECT constraint_name 
  FROM information_schema.table_constraints 
  WHERE table_name = 'futures_settings' AND constraint_name = 'check_rollover_months'
`);
    if (monthConstraintExists.length === 0) {
      await client.query(`
    ALTER TABLE futures_settings 
    ADD CONSTRAINT check_rollover_months CHECK (
      rollover_months IS NULL OR array_length(rollover_months, 1) > 0
        );
  `);
      logger.debug('Added check_rollover_months constraint');
    }

    // Add check_rollover_months_type constraint
    const { rows: typeConstraintExists } = await client.query(`
  SELECT constraint_name 
  FROM information_schema.table_constraints 
  WHERE table_name = 'futures_settings' AND constraint_name = 'check_rollover_months_type'
`);
    if (typeConstraintExists.length === 0) {
      await client.query(`
    ALTER TABLE futures_settings 
    ADD CONSTRAINT check_rollover_months_type CHECK (
      (type = 'STK' AND rollover_months IS NULL) OR
      (type = 'FUT' AND rollover_months IS NOT NULL AND array_length(rollover_months, 1) > 0)
        );
  `);
      logger.debug('Added check_rollover_months_type constraint');
    }

    // Per-symbol configurable timeframe fetching: which timeframes to fetch at
    // all (see resolveTimeframeConfig / DEFAULT_TIMEFRAME_SETTINGS in
    // modules/historical-data-service.js, which must be kept in sync with the
    // JSON literals below). There's no per-timeframe "amount"/"unit" anymore —
    // every enabled timeframe is fetched as far back as the provider allows;
    // rows written by an older version of this migration may still carry
    // leftover amount/unit keys, which are simply ignored.
    logger.debug('Adding timeframe_settings to futures_settings...');
    await client.query(`ALTER TABLE futures_settings ADD COLUMN IF NOT EXISTS timeframe_settings JSONB`);

    // Existing rows (from before this feature existed) default to every
    // timeframe enabled, preserving their prior fetch-everything behavior.
    await client.query(`
      UPDATE futures_settings SET timeframe_settings = '{
        "1M": {"enabled": true},
        "5M": {"enabled": true},
        "15M": {"enabled": true},
        "1H": {"enabled": true},
        "4H": {"enabled": true},
        "1D": {"enabled": true},
        "1W": {"enabled": true}
      }'::jsonb
      WHERE timeframe_settings IS NULL
    `);

    // New rows going forward default to a smaller, more deliberate set
    // (matches DEFAULT_TIMEFRAME_SETTINGS in historical-data-service.js).
    await client.query(`
      ALTER TABLE futures_settings ALTER COLUMN timeframe_settings SET DEFAULT '{
        "1M": {"enabled": false},
        "5M": {"enabled": true},
        "15M": {"enabled": false},
        "1H": {"enabled": true},
        "4H": {"enabled": false},
        "1D": {"enabled": true},
        "1W": {"enabled": false}
      }'::jsonb
    `);
    await client.query(`ALTER TABLE futures_settings ALTER COLUMN timeframe_settings SET NOT NULL`);
    logger.debug('timeframe_settings ready on futures_settings');

    logger.debug('Creating historical_data table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS historical_data (
        id SERIAL PRIMARY KEY,
        futures_setting_id INTEGER NOT NULL,
        contract_month VARCHAR,
        time TIMESTAMP WITH TIME ZONE NOT NULL,
        open NUMERIC NOT NULL,
        high NUMERIC NOT NULL,
        low NUMERIC NOT NULL,
        close NUMERIC NOT NULL,
        volume BIGINT NOT NULL,
        timeframe TEXT NOT NULL,
        source VARCHAR NOT NULL DEFAULT 'IBKR',
        is_continuous BOOLEAN DEFAULT FALSE,
        is_rollover BOOLEAN DEFAULT FALSE,
        rollover_type VARCHAR(10),
        CONSTRAINT check_rollover_type CHECK (rollover_type IN ('VOLUME', 'MANUAL', 'FALLBACK')),
        CONSTRAINT fk_futures_setting
          FOREIGN KEY (futures_setting_id)
          REFERENCES futures_settings (id)
      );
    `);
    logger.debug('Historical_data table created successfully');

    // volume used to be INTEGER (max ~2.147 billion). Some Yahoo-reported
    // volume figures for certain futures exceed that, which made the whole
    // batch INSERT ... unnest() for that fetch fail on the single oversized
    // row (Postgres rejects the out-of-range parameter before any row is
    // written), silently dropping every other bar in the same batch too.
    // Widen to BIGINT (max ~9.2 quintillion) so any real-world volume value
    // Yahoo/IBKR returns fits. Existing installs get this via ALTER; fresh
    // ones already get BIGINT from the CREATE TABLE above.
    await client.query(`ALTER TABLE historical_data ALTER COLUMN volume TYPE BIGINT`);


    logger.debug('Creating historical_data_unique_idx...');
    await client.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS historical_data_unique_idx 
  ON historical_data (
    futures_setting_id,
    COALESCE(contract_month, ''),
    time,
    timeframe,
    is_continuous
      );
`);
    logger.debug('Historical_data_unique_idx created successfully');

    logger.debug('Creating historical_data_source_idx...');
    await client.query(`
  CREATE INDEX IF NOT EXISTS historical_data_source_idx
  ON historical_data (futures_setting_id, timeframe, source, time);
`);
    logger.debug('historical_data_source_idx created successfully');

    logger.debug('Creating idx_historical_data_recency...');
    await client.query(`
CREATE INDEX IF NOT EXISTS idx_historical_data_recency
ON historical_data (futures_setting_id, timeframe, source, time DESC);
`);
    logger.debug('idx_historical_data_recency created successfully');

    // Every chart request for a futures symbol without an explicit
    // contract_month (i.e. every normal TradeView/TradeFormChart request)
    // reads the continuous series via WHERE futures_setting_id = ? AND
    // timeframe = ? AND is_continuous = ? ORDER BY time — none of the
    // indexes above are ordered to serve that (historical_data_unique_idx
    // has contract_month between futures_setting_id and is_continuous,
    // breaking it; the other two require filtering by source, which this
    // query doesn't have). Without a matching index, a heavily-backfilled
    // 1-minute symbol (a real case: ~885k rows) forces a full scan + sort on
    // every single chart open — confirmed via curl that the backend was
    // taking ~20s to even start responding, independent of network transfer
    // or response compression, before this index existed.
    logger.debug('Creating idx_historical_data_continuous_lookup...');
    await client.query(`
CREATE INDEX IF NOT EXISTS idx_historical_data_continuous_lookup
ON historical_data (futures_setting_id, timeframe, is_continuous, time);
`);
    logger.debug('idx_historical_data_continuous_lookup created successfully');

    logger.debug('Creating idx_trades_symbol_type_month...');
    await client.query(`
CREATE INDEX IF NOT EXISTS idx_trades_symbol_type_month 
ON trades (symbol, type, contract_month);
`);
    logger.debug('idx_trades_symbol_type_month created successfully');

    logger.debug('Creating futures_rollover_overrides table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS futures_rollover_overrides (
        id SERIAL PRIMARY KEY,
        futures_setting_id INTEGER NOT NULL REFERENCES futures_settings(id) ON DELETE CASCADE,
        from_contract_month VARCHAR(6) NOT NULL,
        to_contract_month VARCHAR(6) NOT NULL,
        override_date DATE NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE (futures_setting_id, from_contract_month, to_contract_month)
      );
    `);
    logger.debug('Futures_rollover_overrides table created successfully.');

    logger.debug('Creating idx_rollover_overrides_lookup ON futures_rollover_overrides...');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_rollover_overrides_lookup
      ON futures_rollover_overrides (futures_setting_id, override_date);
    `);
    logger.debug('idx_rollover_overrides_lookup created successfully.');

    // Tracks, per symbol/contract/timeframe, the earliest date IBKR has
    // actually confirmed it can provide data for — discovered empirically
    // when a *backfill* chunk request (extending existing data further back,
    // never a from-scratch fetch — see the comment at its call site) comes
    // back with zero bars, which is IBKR's own signal that there's nothing
    // further back, not a guessed/hardcoded limit. See getIbkrDataBound /
    // recordIbkrDataBound in modules/historical-data-service.js.
    logger.debug('Creating historical_data_bounds table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS historical_data_bounds (
        id SERIAL PRIMARY KEY,
        futures_setting_id INTEGER NOT NULL REFERENCES futures_settings(id) ON DELETE CASCADE,
        contract_month VARCHAR,
        timeframe VARCHAR NOT NULL,
        earliest_available TIMESTAMP WITH TIME ZONE NOT NULL,
        checked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
    logger.debug('historical_data_bounds table created successfully.');

    logger.debug('Creating historical_data_bounds_unique_idx...');
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS historical_data_bounds_unique_idx
      ON historical_data_bounds (futures_setting_id, COALESCE(contract_month, ''), timeframe);
    `);
    logger.debug('historical_data_bounds_unique_idx created successfully.');

    // Create exchanges table
    logger.debug('Creating exchanges table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS exchanges (
        id SERIAL PRIMARY KEY,
        name VARCHAR NOT NULL UNIQUE,
        timezone VARCHAR NOT NULL,
        opening_hours JSONB NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
    logger.debug('Exchanges table created successfully');

    // --- New General Indexes for Performance ---
    logger.debug('Creating additional indexes for performance...');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_trades_account_id_created_at ON trades (account_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_trade_actions_trade_id_date_time ON trade_actions (trade_id, date_time ASC);
      CREATE INDEX IF NOT EXISTS idx_trade_attachments_account_id ON trade_attachments (account_id);
      CREATE INDEX IF NOT EXISTS idx_trade_actions_exec_id ON trade_actions (exec_id) WHERE exec_id IS NOT NULL;
    `);
    logger.debug('Additional indexes created successfully');
    // --- End New General Indexes ---

    const { rows: accounts } = await client.query('SELECT * FROM accounts');
    if (accounts.length === 0) {
      await client.query('INSERT INTO accounts (name) VALUES ($1)', ['Default']);
      broadcastStatus(uuidv4(), 'Created default account', 'success');
      logger.info('✅ Created default account');
    }

    broadcastStatus(uuidv4(), 'Database tables checked/created', 'success');
    isConnected = true;
    client.release();

  } catch (err) {
    isConnected = false;
    let errorMessage = 'Failed to connect to database';
    if (err.code === '28P01') {
      errorMessage = 'Invalid authentication credentials';
    } else if (err.code === '3D000') {
      errorMessage = 'Database does not exist';
    } else if (err.code === '08001') {
      errorMessage = 'Unable to connect to database host';
    } else {
      errorMessage += ': ' + err.message;
    }

    broadcastStatus(uuidv4(), errorMessage, 'error');
    logger.error('❌ Failed to connect to database', { message: err.message, stack: err.stack });

    if (pool) {
      try {
        await pool.end();
        logger.warn('[connectDatabase] Ended pool due to connection failure.');
      } catch (endError) {
        logger.error('[connectDatabase] Error while ending pool after connection failure', { message: endError.message, stack: endError.stack });
      }
      pool = null;
    }
    throw new Error(errorMessage);
  }
}

/**
 * Returns the active database connection pool.
 * @returns {Pool} The pg Pool object.
 */
function getPool() {
  if (!pool) {
    throw new Error("Database pool has not been initialized. Call connectDatabase first.");
  }
  return pool;
}

/**
 * Returns the current connection status.
 * @returns {boolean} True if the database is connected.
 */
function getIsConnected() {
  return isConnected;
}

module.exports = {
  connectDatabase,
  getPool,
  getIsConnected,
};
