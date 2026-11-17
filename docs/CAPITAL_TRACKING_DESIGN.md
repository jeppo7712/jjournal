# Capital & Cash Tracking

How the journal tracks money besides trades: accounts and sub-accounts, a
cash ledger, trade settlement, T-bill/bond holdings, dividends, the IBKR
cash sync, and what the menu, Stats and the external API make of it.

Code: `routes/capital.js` (ledger, holdings, dividends), `routes/accounts.js`
(account tree), `modules/tradeSettlement.js` + `settlementEntries` in
`modules/tradeCalculations.js` (trade cash), `modules/holdingsAccrual.js`,
`modules/dividends.js`, `modules/brokerCash.js` + `routes/brokerActivity.js`
(IBKR cash sync), `modules/brokerFills.js` (IBKR fills and fees), and the
Capital page in `src/components/Capital/`.

## Principles

- **Derived, never maintained.** A balance is the sum of ledger rows up to
  a date; there is no stored balance to drift. The same goes for a bond's
  next coupon (found from the last one posted) and a trade's cash (rebuilt
  from its fills).
- **Per currency, never blended.** Every amount carries its currency and
  totals are shown per currency; nothing is converted without a rate.
- **Paper and real never mix.** Paper vs. real is a property of the whole
  account, as at the broker, where they are different accounts.
- **Forward-looking.** Tracking starts from an opening balance; past trades
  aren't replayed into cash and old broker data is never backfilled.

## Accounts

`accounts` columns that matter here:

- `parent_account_id`: an account can be a sub-account of another. The
  intended use is one real broker account split into several journal
  accounts (e.g. stocks and futures), all sharing one cash pool.
- `is_virtual`: paper or real, for the whole account, permanently. An
  account that moves from paper to live trading becomes a new account; the
  paper account's history stays as it was. Ledger rows carry no flag of
  their own.
- `custodian` (free text, e.g. `IBKR LLC`) and `custodian_is_us`
  (`true`/`false`/`null` = not classified yet; never inferred, `null` is
  not `false`): who holds the account's cash.
- `broker_account_id`: which broker account (e.g. an IBKR account number) a
  top-level account mirrors, so imported fills and cash land on the right
  journal account. Sub-accounts never carry one; they resolve through their
  parent.
- `archived`, `hidden_capital_sections`: display only.

**A family agrees on account-level facts.** A sub-account is part of the
same real account as its parent, so `is_virtual`, `custodian` and
`custodian_is_us` are enforced server-side (`routes/accounts.js`):
`resolveInheritedFields` replaces whatever a POST/PUT sends for them with
the parent's values when a parent is set, and `cascadeToDescendants`
pushes an account's values down to every existing descendant. Any
account's own row can therefore be read and trusted directly. Settings
shows these fields read-only, with the parent's values, once a parent is
chosen.

**What rolls up to a parent:**
- Cash and holdings: always. `cash_balances` in `GET /api/accounts`, and
  `GET /api/cash-transactions` / `GET /api/holdings`, include every
  descendant (`WITH RECURSIVE` over `parent_account_id`); each row carries
  `account_name`. Writes stay on the exact account selected; the Capital
  page disables delete/redeem on a descendant's rows.
- Trades: the Dashboard's **Sub-accounts** toggle decides, and Stats and
  the menu's Total P&L / Market Value follow it. **Total Portfolio** always
  includes the descendants' positions: what the account is worth is the
  combined number, as the broker shows it.

## The cash ledger: `cash_transactions`

One row per money movement, `amount` signed (+ in, − out), with
`currency`, `date_time`, `note`, and links: `linked_trade_id`,
`linked_holding_id`, `linked_dividend_id`, and `transfer_pair_id`, which
ties the two rows of a transfer or currency exchange (possibly in two
accounts) to each other.

Types:

| Type | Written by |
|---|---|
| `DEPOSIT`, `WITHDRAWAL` | the user, or the IBKR sync |
| `TRANSFER_OUT` / `TRANSFER_IN` | a transfer between two journal accounts (a pair) |
| `EXCHANGE_OUT` / `EXCHANGE_IN` | a currency conversion (a pair, one per currency) |
| `TRADE_SETTLEMENT` | a trade's fills, rebuilt on every save |
| `DIVIDEND`, `WITHHOLDING_TAX` | a dividend record, rebuilt on every change |
| `INTEREST` | the user, the IBKR sync, or a bond's coupon |
| `FEE` | the user, or the IBKR sync |
| `ADJUSTMENT` | Align on the Capital page (see the balance check) |
| `OTHER` | anything else |

Rows written for a trade or a dividend can't be deleted on their own; they
change with the trade or dividend.

**Opening balance.** Tracking starts with a deposit for the cash held on
some day. `accounts.opening_covers_before` (Capital page, top-level
account) says whether that balance already includes earlier fills: with a
date set, fills before it book no cash (buying a stock years ago and selling
it now books only the sale); unset, every fill books its cash, for an
opening balance entered as if the earlier trades hadn't happened yet.
Changing it rebuilds the cash of every trade in the account's tree and
reports what moved.

## Trade settlement

`settlementEntries` (`modules/tradeCalculations.js`) turns a trade's fills
into ledger rows, one per fill, on that fill's own date, as the broker
books it:

- **Stocks:** a BUY books −(price × quantity + fee), a SELL
  +(price × quantity − fee).
- **Futures:** every fill books −fee; a closing fill also books its
  realized P&L (FIFO, price difference × quantity × tick value / tick
  size). Never the contract value: margin isn't a cash movement here.
  Lots are matched with their own side (`src/utils/lots.js` on the client),
  so a fill beyond the open position opens one the other way; the IBKR
  import splits such a fill into two trades instead (the opening part's
  execution ID gets a `.flip` suffix).

`modules/tradeSettlement.js` rebuilds a trade's rows on every save, after
a fee correction from IBKR, when `opening_covers_before` changes, and when
the trade moves.

**Moving a trade** (`POST /api/trades/:id/move`, body `{ to_account_id }`,
the source account in `X-Account-ID`) moves, in one transaction, the trade,
its attachments (`trade_attachments` carries its own `account_id`) and its
cash, which is rebuilt in the new account. TradeView's **Move** button
calls it.

## Holdings: T-bills, bonds, other

`holdings` is separate from `trades`: fixed income matures instead of being
sold and pays on a schedule instead of moving with a quote. Fields:
`type` (`TBILL` | `BOND` | `OTHER`), `name`, `currency`, `face_value`,
`purchase_price`, `purchase_date`, optional `maturity_date`, optional
`coupon_rate` + `coupon_frequency`, `status` (`ACTIVE` | `MATURED` |
`SOLD`), `notes`.

Buying books a debit linked by `linked_holding_id`; `POST
/holdings/:id/redeem` covers early sales and anything off schedule.
`modules/holdingsAccrual.js` (every 6 hours, or `POST
/holdings/process-accrual`) posts what the schedule says, on the date it
says, for `ACTIVE` holdings only:

- a bond's coupons (`face_value × coupon_rate / 100 ÷ payments per year`)
  as `INTEREST` rows, resuming after the last coupon posted and catching up
  on missed periods;
- every holding's redemption at face value once `maturity_date` has passed,
  setting it `MATURED`. That is all a T-bill (zero coupon) ever does.

A holding's value is its `purchase_price` until something is posted; no
accrued-value estimate is shown in between.

## Dividends

A dividend is a record in `dividends`; its cash is derived from it: a
`DIVIDEND` row for the gross amount and, when tax was withheld, a
`WITHHOLDING_TAX` row, both on the pay date. `syncDividendLedger`
(`modules/dividends.js`) rebuilds both on every change.

- **Tax is recorded, not computed**: withholding depends on the company's
  country, treaties and the broker, so manual entries take the amount
  typed and imports what the broker reports.
- **Signed like the ledger**: a payment in lieu of a dividend owed on a
  short position is a negative gross amount.
- **Imports never fight manual changes**: `source` says where a row came
  from; editing an imported row sets `edited` and imports leave it alone;
  deleting one only sets `dismissed` (restorable), so the next import
  doesn't bring it back. `(source, external_id)` is unique.
- Paper accounts don't track dividends.

## Totals in the menu

The account card shows Total P&L, Market Value, Cash and Total Portfolio,
unfiltered (the Dashboard's figures follow its filters). Total Portfolio =
stock market value + futures unrealized P&L + cash + active holdings at
`purchase_price`, per currency. Futures count with their P&L, not their
notional value.

## Return in Stats

Stats' "Return over time" is a time-weighted return of the capital on the
Capital page (`computeReturnPercentageSeries` in
`src/components/Stats/statsUtils.jsx`): each day's marked-to-market P&L
divided by the capital at the start of that day, chained, so deposits and
withdrawals move the capital without counting as gain or loss.

- Capital flows: `DEPOSIT`, `WITHDRAWAL`, `TRANSFER_*`, `EXCHANGE_*`. A
  transfer between a parent and a sub-account that are both included
  cancels out.
- Optional income ("Include dividends, interest and fees"): `DIVIDEND`,
  `WITHHOLDING_TAX`, `INTEREST`, `FEE`.
- `ADJUSTMENT` and `OTHER` are neither.
- When the trades start before the opening balance, the capital before it
  is reconstructed from the opening cash and the positions held, never
  below the positions' value.

## Paper vs. real IBKR Flex credentials

Paper and live are different IBKR accounts, so each has its own Flex Web
Service token and query IDs: `ibkrFlexToken{Real,Paper}`,
`ibkrFlexQueryIdActivity{Real,Paper}`, `ibkrFlexQueryIdTradeConf{Real,Paper}`
in `config.json`, side by side under Settings → IBKR API. Flex requests for
an account (e.g. `GET /api/ibkr/trade-groups-flex`, needs `X-Account-ID`)
use the set matching its `is_virtual`, and the Flex cache is keyed by query
ID, so paper and real never share an entry.

## Broker cash sync (IBKR Flex)

`modules/brokerCash.js`, `routes/brokerActivity.js`, the "From IBKR"
section of the Capital page. Reads the Cash Transactions section of the
real accounts' Activity Flex query: deposits and withdrawals, fees,
interest, dividends, payments in lieu and withholding tax.

- **Off unless switched on, per account.** `accounts.broker_sync_mode`:
  `OFF` (default — the journal is its own ledger), `SUGGEST` (an inbox to
  add or dismiss from) or `AUTO`. Set on the top-level account mapped to
  the broker account (`broker_account_id`). Paper accounts are never
  synced.
- **Nothing before tracking started.** `broker_sync_from` (default: the
  day after the account's first ledger entry, its opening balance) is the
  first day read; the opening balance already holds everything earlier.
- **Every broker row is kept** in `broker_cash_items`, unique on IBKR's
  transaction ID, so a sync never imports the same row twice, and with
  what became of it: `MATCHED` (an entry the user made covers it),
  `BOOKED` (added by the sync), `PENDING` or `DISMISSED`.
  `broker_item_links` ties an item to the ledger rows it booked or matched.
- **The user's own entries are never changed.** Matching only links:
  same currency and sign, within 3 days (5 for dividends), one-to-one
  first, then a day's broker rows against one entry (two transfers
  entered as one deposit) and one broker row against a day's entries.
  "Not the same" undoes a match and leaves that row to the user
  (`manual_only`).
- **Dividends go through `dividends`**: a payment's dividend and tax rows
  share IBKR's action ID and are booked together as one IBKR dividend
  (accepting either books both), on the account in the tree that last
  traded the stock. A later correction row updates the same dividend
  unless the user edited it. Tax without a dividend in the sync (paid
  before tracking) books as its own `WITHHOLDING_TAX` row.
- **Deleting what a sync added** marks its item dismissed, so it doesn't
  come back; deleting an entry a broker row was matched to puts that row
  back in the inbox.
- Runs on demand (Sync now) and every 6 hours for accounts with sync on.
  One Flex pull serves the trade import, the sync and the query check
  (`getFlexStatements` in `routes/ibkrFlex.js`, cached 5 minutes): IBKR
  refuses concurrent requests under one token. A query IBKR answers with
  "not ready" or "locked" is paused, doubling the pause each time, instead
  of being retried quickly.

### Setting up the Flex queries

Settings → IBKR API has a step-by-step guide to the sections, options and
general settings to tick in IBKR's Flex Query editor, and a check
(`modules/flexCheck.js`, `GET /api/ibkr-flex/check`) that runs the saved
queries and says, per check, what's missing and what to change: query
type, real vs paper account, alias instead of account ID, accounts not
linked to a journal account, period, date format, and each section's
fields (the ones the journal can't do without vs. ones that make it more
precise).

### Cash vs IBKR (balance check)

Each sync also stores IBKR's ending cash per currency from the Cash
Report section (`broker_cash_reports`, replaced on every sync). An account
holding only its base currency gets just the `BASE_SUMMARY` row; it counts
as the base currency, read from any statement row whose `fxRateToBase` is
1 (nothing is guessed otherwise). The Capital page compares it with the
journal's cash of the same tree, as of IBKR's statement day (later journal
entries don't count), and says how much of a difference is broker items
still waiting in the inbox. Under 0.05 is rounding. **Align** books only
the rest, on request, as an `ADJUSTMENT` ledger row on the top-level
account, dated on the statement day — visible, labelled, deletable.

A difference can come from the Flex query itself: its Cash Transactions
list only the types ticked in the query, while the Cash Report counts
every type. Each sync compares the Cash Report's categories (deposits and
withdrawals, broker and bond interest, dividends, withholding tax, other
fees, and transfers between IBKR accounts) with the Detail rows listed
for them over the statement's period, per currency, and stores the types
that fall short (`broker_cash_reports.unlisted`). The balance row names
them, so the fix is ticking the type and syncing again rather than an
Align that hides what the money was; the Settings query check warns about
them too, and transaction taxes are named as not imported. A currency that
isn't in line also counts toward the badge next to Capital in the menu,
along with the items waiting in the inbox.

Transfers between IBKR accounts aren't Cash Transactions: they're the
query's own Transfers section. Its rows that move cash (`cashTransfer`;
a position transfer moves none) come into the inbox as deposits and
withdrawals, keyed `TRANSFER-<transactionID>-IN|OUT` (between two IBKR
accounts both sides carry the same transaction ID; IBKR marks the rows
`levelOfDetail="TRANSFER"`). They match the user's own deposit or
transfer rows like any deposit, so a transfer between two journal
accounts entered as a transfer pair is matched on both sides.

Currency conversions aren't Cash Transactions either: IBKR lists them as
trades of asset category `CASH` in the Trades section (`EUR.USD`: the
quantity in the first currency, the proceeds in the second, the fee in
`ibCommissionCurrency`). Each execution comes into the inbox as an
`EXCHANGE` item per currency, signed (bought +, sold −), and a `FEE` item
when IBKR charged one, keyed `FX-<execID>-<currency>` / `FX-<execID>-FEE`
and sharing `action_id` `FX-<execID>`. Booking any of them books all of
them: the legs as `EXCHANGE_OUT`/`EXCHANGE_IN` linked by
`transfer_pair_id`, like an exchange entered on the Capital page, and the
fee as `FEE`. A leg matches the user's own exchange entry in its currency
(`EXCHANGE_IN` for the one bought, `EXCHANGE_OUT` for the one sold, same
amount, within three days). The query's Forex P/L Details and Forex
Balances sections aren't read.

### Fees from IBKR

A TWS import takes a fill's fee from the commission report TWS sends
after the execution; when it hasn't arrived yet the fill is saved without
a fee. The fills scan (`modules/brokerFills.js`, every 15 minutes) has
IBKR's commission for every fill of a linked account from
`broker_fills_from` on, so it sets a journal fill's fee to it by execution
ID when they differ, and rebuilds the trade's cash. The fee the journal had
is kept on the broker fill (`journal_fee_was`, `fee_corrected_at`). A
commission IBKR charged in another currency than the fill's is left alone.
The same scan lists IBKR fills that aren't in the journal yet (the badge
next to Dashboard).

## API

Internal (`X-Account-ID` scoped, like `/trades`): `GET/POST
/api/cash-transactions`, `DELETE /api/cash-transactions/:id`, `POST
/api/cash-transactions/transfer` and `/exchange` (explicit
`to_account_id`), `GET/POST/PUT /api/holdings`, `POST
/api/holdings/:id/redeem`, `DELETE /api/holdings/:id`, `/api/dividends`,
`/api/opening-balance`, `/api/broker-activity`. `GET /api/accounts`
includes the account fields above and the rolled-up `cash_balances` (an
array of `{currency, balance}`).

External (see [EXTERNAL_API.md](../EXTERNAL_API.md)): `GET
/api/external/v1/accounts` (with `cash_balances`, `is_virtual`, custodian
fields), `GET /api/external/v1/accounts/:id/cash-transactions` (the
ledger, rolled up, paginated) and `GET /api/external/v1/holdings` (with
`total_interest_earned` and, for a T-bill, `implied_annual_yield_percent`),
so a consumer gets the whole picture — cash vs. trades vs. fixed income,
per account and currency, real vs. paper — without redoing the math.
