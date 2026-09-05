# Capital & Cash Tracking — Design

Status: **all 4 phases implemented** (cash ledger, hierarchical accounts,
real/virtual tracking, trade auto-settlement, holdings, external API
exposure). Written 2026-09-05 after a planning discussion. Revised twice
after initial use: `is_virtual` moved from the ledger to the account
(trade settlement also gained futures realized P&L, not just fees), and
`parent_account_id` gained actual cash/holdings roll-up behavior instead
of being a no-op label — see Implementation notes for both.

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
`linked_holding_id`. Coupon payments and maturity are both automatic now
(implemented — see below), on top of the manual purchase/redeem flow
(`POST /holdings`, `POST /holdings/:id/redeem`) which still exists for
early sales or anything the schedule doesn't cover.

**Automatic coupon/maturity processing** (`modules/holdingsAccrual.js`,
run by a cron job every 6 hours in `server.js`, or on demand via `POST
/holdings/process-accrual`):
- **BOND** holdings with `coupon_rate`/`coupon_frequency` set: each coupon
  period (`face_value × coupon_rate/100 ÷ payments-per-year`) is posted as
  a `cash_transactions` row (`type = INTEREST`, `linked_holding_id` set)
  the moment its due date passes. Resumes from whichever coupon was last
  posted (found via `MAX(date_time) WHERE linked_holding_id = ... AND type
  = 'INTEREST'`, or `purchase_date` if none yet) rather than a separately
  maintained "next due" column — same "derive it from the ledger, don't
  track a parallel mutable value" philosophy as account cash balances.
  Catches up on multiple missed periods in one pass if the server was down
  a while.
- **Any** holding type — auto-redeems at face value and flips to
  `MATURED` once `maturity_date <= today`. This is the whole story for a
  **TBILL**: a zero-coupon discount instrument (bought below face value,
  no periodic coupon, single payoff at maturity) has no `coupon_rate` set
  at all, so it just silently sits until this one event fires. For a BOND
  this runs alongside its last coupon payment, as two separate ledger
  rows (final coupon, then principal).
- Deliberately narrow: only ever posts the exact scheduled amount on the
  exact scheduled date, for a holding still `ACTIVE`. An early sale, a
  partial redemption, or any custom amount/date is still the manual `POST
  /holdings/:id/redeem` flow, untouched by this.
- Confirmed with the user: no separate "display-only accrued value"
  estimate between now and the next due date — a holding's displayed
  value stays flat `purchase_price` right up until an actual posting
  happens, matching "real cash shows up automatically" rather than a
  running projection.

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

## API exposure (the stated primary motivation) — implemented

- `GET /api/external/v1/accounts` gains `parent_account_id`, `is_virtual`
  (the account's own column, not derived — see section 3), and
  `cash_balances` (rolled up across descendants, per currency — see the
  parent_account_id note in Implementation notes).
- New `GET /api/external/v1/accounts/:id/cash-transactions` — the ledger,
  paginated like `/trades`, rolled up the same way.
- New `GET /api/external/v1/holdings` — T-bills/bonds, filterable by
  account/status like `/trades`, rolled up the same way. Also enriches
  each row with `total_interest_earned` (realized coupon income to date)
  and `implied_annual_yield_percent` (a `TBILL`'s annualized discount
  yield if held to maturity) — added specifically so "how much is this
  actually earning" doesn't require an advisor to cross-reference
  cash-transactions and do the yield math itself.

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
4. **External API exposure** of all of the above — done: `GET
   /api/external/v1/accounts` (now includes `parent_account_id`,
   `is_virtual`, rolled-up `cash_balances`), `GET
   /api/external/v1/accounts/:id/cash-transactions`, `GET
   /api/external/v1/holdings`. See EXTERNAL_API.md.

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

## Paper vs. real IBKR Flex Web Service credentials

Follows directly from `accounts.is_virtual` being account-level (see
section 3): paper and live are different IBKR accounts, so each needs its
own Flex Web Service token and Query IDs — one global set couldn't
correctly cover both without risking the same kind of paper/real mixing
`is_virtual` itself was fixed to avoid. `modules/config.js` now stores
`ibkrFlexToken{Real,Paper}` / `ibkrFlexQueryIdActivity{Real,Paper}` /
`ibkrFlexQueryIdTradeConf{Real,Paper}`, migrated automatically on first
load from the old single-set fields (folded into `...Real`, the more
common existing case) — see `migrateFlexConfig` in that file. Settings →
TWS shows both sets side by side. `GET /api/ibkr/trade-groups-flex` (the
endpoint behind TradeModal's "Show Chart"/import flow) now requires an
`X-Account-ID` header — previously entirely account-agnostic — looks up
that account's `is_virtual`, and picks the matching credential set;
Flex's own response cache is keyed by query IDs, so paper/real never
share a cache entry.

## `parent_account_id` gets real behavior: cash/holdings roll up to the parent

Until now `parent_account_id` was stored and shown in Settings but did
nothing — no query anywhere summed a child's capital into its parent, so
setting one was silently a no-op (confirmed and clarified with the user
after "IB FUT Live 2026" — parent-linked to "IB Stocks" but with zero
trades/cash of its own — correctly showed $0 everywhere, which looked
like a bug but wasn't). The concrete use case: one real IBKR account,
split into several journal accounts by instrument type (stocks vs.
futures) for clarity, all sharing the same actual cash pool.

- `GET /api/accounts`: `cash_balances` is now a roll-up — an account's
  balance is its own `cash_transactions` PLUS every descendant's,
  recursively (`WITH RECURSIVE` over `parent_account_id`). Identical to
  before for any account with no children (verified against live data).
- `GET /api/cash-transactions` and `GET /api/holdings` (routes/capital.js):
  same roll-up, plus each row now carries `account_name` so the UI can
  show which physical account it actually belongs to when viewing a
  parent's combined view.
- Deliberately NOT rolled up: **trades**, in the sense of Dashboard/
  TradeList/Stats — those stay scoped to exactly the selected account,
  confirmed with the user: you don't want your stocks book's P&L polluted
  by futures trades or vice versa, and that per-instrument-type separation
  is the whole reason to split one broker account into several journal
  accounts to begin with.
- All writes (deposit/withdrawal/transfer/exchange, holding purchase/
  redeem/delete) stay strictly scoped to the exact selected account — a
  row's `account_id` is real and singular, roll-up is a read-time view,
  not a data model change. Capital.jsx disables the delete/redeem controls
  on a row that belongs to a descendant rather than the account currently
  selected, with a tooltip pointing at which account to switch to instead.

**Total Portfolio does roll up trades, unlike Total P&L/Market Value —
confirmed as the intended split**: "what is this account's trading P&L"
should stay per-account (that's the point of splitting by instrument
type), but "what is this account actually worth" (Total Portfolio) should
reflect the real combined number, matching what IBKR itself would show.
Implemented via `TradeContext.processRawTradesArray` — the trade→computed-
shape pipeline (`computeTradeMeta` → FIFO lot matching → entry/exit/
position) that `refreshTrades` already ran inline, factored out into its
own function so it's not duplicated — plus a new context method
`fetchProcessedTradesForAccount(accountId)` that runs that same pipeline
*and* the live-price step (`updateTradePriceData`) for an arbitrary other
account's trades, returning them rather than writing into the `trades`
state (which stays exactly the selected account's own, for
Dashboard/TradeList/Stats/Total P&L/Market Value). Navigation calls this
for every descendant account (full recursive closure, not just direct
children) and merges the results into Total Portfolio's STK market value
/ FUT unrealized P&L calculation only.
