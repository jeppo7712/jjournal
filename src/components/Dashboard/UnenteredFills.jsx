import React, { useContext, useMemo } from 'react';
import { TradeContext } from '../../context/TradeContext';
import { useBrokerAlerts } from '../../context/BrokerAlertsContext';
import styles from './UnenteredFills.module.css';

// IBKR fills of this account (or its top-level account) that aren't in the
// journal yet (modules/brokerFills.js), on one line, per instrument: add them
// to the open trade they belong to or as a new trade (the trade window
// opens with the Flex import running), or dismiss them.

// IBKR names a stock without its venue suffix (ETFE for ETFE.AS): the
// journal symbol set up for it, when there's exactly one.
function journalSymbol(fill, futuresSettings) {
  if (fill.type !== 'STK') return fill.symbol;
  const stocks = (futuresSettings || []).filter(s => s.type === 'STK').map(s => String(s.symbol));
  const exact = stocks.find(s => s.toUpperCase() === fill.symbol);
  if (exact) return exact;
  const listed = stocks.filter(s => s.toUpperCase().startsWith(`${fill.symbol}.`));
  return listed.length === 1 ? listed[0] : fill.symbol;
}

export default function UnenteredFills({ onAddFills }) {
  const { currentAccountId, trades, scopedTrades, futuresSettings } = useContext(TradeContext);
  const { fills, rootOf, dismissFills } = useBrokerAlerts();
  const root = rootOf(currentAccountId);

  const groups = useMemo(() => {
    const byKey = new Map();
    for (const fill of fills) {
      if (String(fill.account_id) !== root) continue;
      const symbol = journalSymbol(fill, futuresSettings);
      const key = `${fill.type}|${symbol}|${fill.contract_month || ''}`;
      if (!byKey.has(key)) {
        byKey.set(key, { key, type: fill.type, symbol, contractMonth: fill.contract_month, label: fill.type === 'FUT' ? fill.raw_symbol || symbol : symbol, fills: [] });
      }
      byKey.get(key).fills.push(fill);
    }
    const open = [...(scopedTrades || []), ...(trades || [])].filter(t => t.status === 'OPEN');
    return [...byKey.values()].map(g => ({
      ...g,
      openTrade: open.find(t => t.type === g.type && String(t.symbol).toUpperCase() === g.symbol.toUpperCase()
        && (g.type !== 'FUT' || !t.contract_month || !g.contractMonth || String(t.contract_month) === String(g.contractMonth))) || null,
    }));
  }, [fills, root, futuresSettings, trades, scopedTrades]);

  if (groups.length === 0) return null;

  return (
    <section className={styles.panel} aria-label="IBKR fills not in the journal">
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.head}>IBKR fills not in the journal yet:</span>
      {groups.map(g => (
        <span key={g.key} className={styles.group}>
          <span className={styles.symbol}>{g.label}</span>
          <span className={styles.count}>{g.fills.length} fill{g.fills.length > 1 ? 's' : ''}</span>
          <button
            type="button"
            className={styles.add}
            onClick={() => onAddFills({ symbol: g.symbol, type: g.type, execIds: g.fills.map(f => f.exec_id) }, g.openTrade)}
            title={g.openTrade ? `Opens the open ${g.symbol} trade with the IBKR import` : `Opens a new ${g.symbol} trade with the IBKR import`}
          >
            {g.openTrade ? 'Add to open trade' : 'Add trade'}
          </button>
          <button
            type="button"
            className={styles.dismiss}
            onClick={() => dismissFills(g.fills.map(f => f.id))}
            title="Dismiss: these fills don't belong in the journal"
            aria-label={`Dismiss the ${g.label} fills`}
          >
            ×
          </button>
        </span>
      ))}
    </section>
  );
}
