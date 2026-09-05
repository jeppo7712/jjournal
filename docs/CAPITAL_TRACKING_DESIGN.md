# Capital & Cash Tracking — Design

Status: **phases 1-3 implemented** (cash ledger, hierarchical accounts,
real/virtual tracking, trade auto-settlement, holdings). Phase 4 (external
API exposure) is not yet done. Written 2026-09-05 after a planning
discussion; captures the decisions made so a future session can pick up
Phase 4 directly instead of re-deriving the rest. Revised after initial
use surfaced two corrections (see Implementation notes): `is_virtual`
moved from the ledger to the account, and trade settlement now includes
futures realized P&L, not just fees.

## Implementation notes (added once built, revised after initial use)

- **`is_virtual` lives on the account, not the ledger — revised from the
  original design.** The original design (see the now-superseded section
  below) put `is_virtual` on each `cash_transactions` row with the account
  merely supplying a default for new rows. In practice this let paper and
  real money get mixed within one account whenever the account's default
  didn't match what a given row actually needed (this happened for real,
  silently, before being caught): an account's manually-entered cash was
  stamped correctly while its auto-settled trade cash used the account's
  stale default and came out wrong. At the broker level, paper and live
  are genuinely different accounts (different account numbers) — never
  the same account with a mixed history — so the schema now matches that:
  `accounts.is_virtual` is a single, permanent flag with no per-transaction
  override and no per-transaction storage at all (the column was dropped
  from `cash_transactions` entirely). An account that "graduates" from
  paper to live becomes a new account, not a flag flip on the old one.
- **FUT auto-settlement now includes realized P&L, not just fees.**
  Every trade action still incurs its flat fee, but closing actions on a
  futures trade also settle their FIFO-matched realized P&L (price
  difference only — fees are handled separately by the flat per-action
  charge), computed server-side via `computeFuturesRealizedPnLPerAction`
  in `modules/tradeCalculations.js`, a port of the same FIFO matching
  TradeContext.js already did client-side for realized/unrealized PnL.
- **Settlement is one row per trade, not one per fill.** A multi-fill
  futures trade used to create a `cash_transactions` row per action,
  which cluttered the ledger fast. `settleTradeActionsToCash` now sums
  all of a trade's actions into a single row, dated at the trade's last
  action (matching the Dashboard's existing "when did this trade's PnL
  count" convention).
- New endpoints: `GET/POST /api/cash-transactions`, `POST
  /api/cash-transactions/transfer`, `POST /api/cash-transactions/exchange`,
  `DELETE /api/cash-transactions/:id`,
  `GET/POST/PUT /api/holdings`, `POST /api/holdings/:id/redeem`, `DELETE
  /api/holdings/:id` — all scoped to the `X-Account-ID` header like
  `/trades`, except transfer/exchange which take an explicit
  `to_account_id`. `GET /api/accounts` now also returns
  `parent_account_id`, `is_virtual`, and `cash_balances` (an array of
  `{currency, balance}` — deliberately not collapsed into one number, per
  the FX section below; no `is_virtual` per balance since it's now
  uniform for the whole account).
- Frontend: new Capital view (`src/components/Capital/`) reachable from
  the nav bar; account hierarchy/virtual-mode editable via a proper modal
  in Settings (replacing the old `prompt()`-based rename flow); symbols
  gained a `currency` field in Settings that also fixed the previously
  hardcoded `currency: 'USD'` in IBKR contract lookups
  (`modules/utils.js`/`modules/historical-data-service.js`).

## Motivation

The journal currently tracks only trades (buy/sell fills on stocks/futures,
with computed PnL). It has no concept of cash, capital allocation, or
non-trade holdings (T-bills, bonds) — no way to journal capital that
isn't tied up in an open trade, or to represent an account's capital as
partly allocated from a larger pool. It also has no way to distinguish
real money from paper/simulated trading, which matters for an account
that starts as paper and later transitions to live trading. The primary
motivation beyond personal record-keeping: exposing a complete capital
picture (cash, allocation, real vs. virtual, non-trade holdings) via the
external API to an AI financial advisor, not just trade PnL.

## Core concepts

Trades, cash, and fixed-income holdings are different shapes of thing and
are modeled as three separate, connected concepts — not forced into one
universal "asset" abstraction, which would be more confusing, not less.

### 1. Accounts become hierarchical

Add one nullable column: `accounts.parent_account_id`. This alone gives
"main cash capital, subdivided into accounts" — create an account (e.g.
"Main Capital") the same way any account is created today, and set other
accounts' parent to it. No special-cased root concept, no new UI paradigm.
Every existing account defaults to `parent_account_id = NULL` (top-level),
so this is a zero-risk additive change to the existing `accounts` table
(currently just `id, name, created_at, updated_at`).

Alongside it, `accounts.is_virtual BOOLEAN NOT NULL DEFAULT FALSE` marks
the whole account as paper or real, permanently — see section 3.

### 2. `cash_transactions` — the ledger

Append-only, one row per money movement:

```sql
CREATE TABLE cash_transactions (
    id SERIAL PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    date_time TIMESTAMP WITH TIME ZONE NOT NULL,
    type VARCHAR NOT NULL, -- DEPOSIT | WITHDRAWAL | TRANSFER_IN | TRANSFER_OUT
                            -- | EXCHANGE_IN | EXCHANGE_OUT
                            -- | TRADE_SETTLEMENT | INTEREST | OTHER
    amount NUMERIC NOT NULL, -- signed: positive = cash in, negative = cash out
    currency VARCHAR NOT NULL DEFAULT 'USD',
    -- No is_virtual here — see section 3. Paper vs. real is a property of
    -- the account (accounts.is_virtual), not of an individual row; storing
    -- it per-row let it silently drift out of sync with the account it
    -- belongs to.
    linked_trade_id INTEGER REFERENCES trades(id),
    linked_holding_id INTEGER REFERENCES holdings(id),
    transfer_pair_id INTEGER REFERENCES cash_transactions(id), -- links a
        -- TRANSFER_OUT/EXCHANGE_OUT row to its matching TRANSFER_IN/
        -- EXCHANGE_IN row (possibly in another account), so a transfer or
        -- exchange is always a traceable, balanced pair. ON DELETE SET
        -- NULL, since the two rows mutually reference each other.
    note TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

An account's cash balance at any point in time is just the sum of its
`cash_transactions.amount` up to that date — no separately-maintained
mutable balance field to keep in sync or drift out of correctness. This
also means "what was my balance on date X" comes for free, which the
API/advisor use case will want.

### 3. `is_virtual` lives on the account, not the ledger

Superseded from the original design (which put `is_virtual` on each
ledger row, the account only supplying a default — see Implementation
notes above for why that was changed). `accounts.is_virtual` is a single,
permanent, boolean column; every `cash_transactions` row for that account
is implicitly paper or real by virtue of which account it's in. This
matches how paper and live actually exist at the broker: different
account numbers, not one account with a mixed history. An account that
transitions from paper to live trading is represented as a *new* real
account, not a flag flipped on the old paper one — the paper account's
full history stays intact and correctly labeled forever.

### 4. `holdings` — T-bills, bonds, other non-trade assets

Deliberately separate from `trades`: no live quote, no buy/sell-fill PnL
math, because fixed income isn't shaped like a stock trade (it matures
instead of being sold, accrues interest on a schedule instead of moving
tick-by-tick).

```sql
CREATE TABLE holdings (
    id SERIAL PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    type VARCHAR NOT NULL, -- TBILL | BOND | OTHER
    name VARCHAR NOT NULL,
    currency VARCHAR NOT NULL DEFAULT 'USD',
    face_value NUMERIC NOT NULL,
    purchase_price NUMERIC NOT NULL,
    purchase_date DATE NOT NULL,
    maturity_date DATE,
    -- Optional detail, filled in only when it matters (per user preference:
    -- simple by default, detailed when they want it) — NULL means "don't
    -- model accrual, just track principal in/out at purchase/maturity."
    coupon_rate NUMERIC,
    coupon_frequency VARCHAR, -- e.g. 'SEMI_ANNUAL', 'ANNUAL'; NULL if no coupon_rate
    status VARCHAR NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | MATURED | SOLD
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

Buying a holding creates a `cash_transactions` debit linked via
`linked_holding_id`. Maturity/redemption creates a credit (face value,
plus any final coupon if `coupon_rate` is set) — either the user marks it
matured manually, or (later refinement) a scheduled check auto-detects
`maturity_date <= today` and prompts/auto-creates the redemption entry.
When `coupon_rate`/`coupon_frequency` are set, current accrued value can
be computed on the fly (purchase_price + accrued interest since last
coupon) for display; when they're NULL, displayed value is just
purchase_price until maturity — no accrual modeling attempted.

### 5. Trade actions auto-settle to cash (confirmed: automatic, not manual)

Every BUY debits cash (`price × quantity + fee`), every SELL credits it
(`price × quantity − fee`), automatically, going forward — a
`cash_transactions` row with `type = TRADE_SETTLEMENT` and
`linked_trade_id` set, created at the same time the trade action itself
is saved. This is what keeps the ledger accurate without the user
double-entering the same activity in two places.

### 6. No historical backfill (confirmed)

Cash tracking starts clean from an opening balance the user sets per
account as of the day this ships — no attempt to reconstruct what every
past trade "would have done" to cash. This is forward-looking capital
management, not historical reconciliation; backfilling years of trades
would also surface old fee/data quirks as confusing ledger noise.

## API exposure (the stated primary motivation)

- `GET /api/external/v1/accounts` gains `parent_account_id`,
  `cash_balance`, `is_virtual` (the account's own column, not derived —
  see section 3) per account.
- New `GET /api/external/v1/accounts/:id/cash-transactions` — the ledger,
  paginated like `/trades`.
- New `GET /api/external/v1/holdings` — T-bills/bonds, filterable by
  account/status like `/trades`.

This gives an API consumer (an AI advisor) the full picture: total
capital, how it's split across accounts, how much is cash vs. deployed in
trades vs. parked in fixed income, and which of that is real vs.
simulated — not just trade PnL.

## Rollout, phased

1. **`cash_transactions` + manual deposit/withdrawal/transfer UI +
   `parent_account_id` + `is_virtual`.** Unblocks journaling real
   capital immediately. No dependency on anything else below.
2. **Auto-settlement**: trade actions create their own
   `TRADE_SETTLEMENT` cash_transactions rows going forward.
3. **`holdings`** for T-bills/bonds, simple fields required + optional
   coupon detail.
4. **External API exposure** of all of the above — still not yet done.

Each phase should ship and be usable on its own before the next starts —
this is meant to avoid becoming one giant redesign before any of it is
useful.

## "Total Portfolio" (net liquidation value), implemented ahead of Phase 4

Cash and Total Portfolio shipped in the Navigation sidebar (below the
existing Total P&L / Market Value stats), not the Dashboard — Dashboard's
numbers move with the user's active time/status filters, while these are
unfiltered account snapshots, the same nature as Total P&L/Market Value.
Formula: `STK market value + FUT unrealized P&L + cash + active holdings
(purchase_price as a conservative "current value")`. Futures are
deliberately *not* included via `position × price × tickMultiplier` —
that's notional exposure, not money possessed (margin isn't tracked as a
cash event in this app at all), matching the existing precedent that
Ent Tot/Ext Tot columns are hidden for futures accounts for the same
reason. Same-currency (USD) amounts sum directly; other currencies are
shown as a separate note rather than blended in, since summing without
FX conversion would be meaningless.
