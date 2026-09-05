# Capital & Cash Tracking — Design

Status: **approved design, not yet implemented.** Written 2026-09-05 after a
planning discussion; captures the decisions made so a future session can
pick this up directly instead of re-deriving it.

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

### 2. `cash_transactions` — the ledger

Append-only, one row per money movement:

```sql
CREATE TABLE cash_transactions (
    id SERIAL PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    date_time TIMESTAMP WITH TIME ZONE NOT NULL,
    type VARCHAR NOT NULL, -- DEPOSIT | WITHDRAWAL | TRANSFER_IN | TRANSFER_OUT
                            -- | TRADE_SETTLEMENT | INTEREST | OTHER
    amount NUMERIC NOT NULL, -- signed: positive = cash in, negative = cash out
    currency VARCHAR NOT NULL DEFAULT 'USD',
    is_virtual BOOLEAN NOT NULL DEFAULT FALSE,
    linked_trade_id INTEGER REFERENCES trades(id),
    linked_holding_id INTEGER REFERENCES holdings(id),
    transfer_pair_id INTEGER REFERENCES cash_transactions(id), -- links a
        -- TRANSFER_OUT row to its matching TRANSFER_IN row in the other
        -- account, so a transfer is always a traceable, balanced pair
    note TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

An account's cash balance at any point in time is just the sum of its
`cash_transactions.amount` up to that date — no separately-maintained
mutable balance field to keep in sync or drift out of correctness. This
also means "what was my balance on date X" comes for free, which the
API/advisor use case will want.

### 3. `is_virtual` lives on the ledger, not the account

An account is not permanently "paper" or permanently "real" — it's
whatever its transactions say at any point in time. This is what lets a
paper-trading account cleanly transition to live trading later: the
paper period's ledger entries stay marked `is_virtual = true` forever
(the simulated track record is preserved, not erased), and the day real
money starts flowing in, new entries are `is_virtual = false`. Any query
can filter to real-only or virtual-only without the two ever being summed
together by accident.

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
  `cash_balance`, `is_virtual` (derived: true if the account's most
  recent/all relevant transactions are virtual) per account.
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
4. **External API exposure** of all of the above, plus any Dashboard
   additions (e.g. a "Net Liquidation Value" = cash + open positions'
   market value + holdings value, per account) — deliberately last, once
   the underlying data actually exists to expose.

Each phase should ship and be usable on its own before the next starts —
this is meant to avoid becoming one giant redesign before any of it is
useful.
