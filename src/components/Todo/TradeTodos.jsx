import React, { useMemo } from 'react';
import { useTodos } from '../../context/TodosContext';
import { useTodoRows } from './TodoRow';
import styles from './Todo.module.css';

// The Todo items linked to a trade, on the trade view under its journal,
// with "+ Todo" to add one for this trade. Every account's items count (the
// trade is what links them), open ones first. With none linked the card
// still shows, for its button: a follow-up can be noted from the trade.
//   cardClass / headerClass  the trade view's own card look

export default function TradeTodos({ trade, cardClass, headerClass }) {
  const { todos } = useTodos();
  const { list, openForm, form } = useTodoRows({ rowOptions: { showTrade: false } });
  const linked = useMemo(() => {
    const closed = s => ['done', 'dismissed', 'expired'].includes(s);
    return todos
      .filter(t => String(t.trade_id) === String(trade.id))
      .sort((a, b) => closed(a.status) - closed(b.status) || Date.parse(a.created_at) - Date.parse(b.created_at));
  }, [todos, trade.id]);

  return (
    <section className={cardClass}>
      <div className={headerClass}>
        <h4>Todo</h4>
        <button
          type="button"
          className={styles.actBtn}
          onClick={() => openForm(null, {
            kind: 'todo',
            trade_id: trade.id,
            trade_symbol: trade.symbol,
            symbol: trade.symbol,
            type: trade.type,
            contract_month: trade.contract_month,
            account_id: trade.account_id,
          })}
        >
          + Todo
        </button>
      </div>
      {linked.length > 0
        ? list(linked)
        : <p className={styles.emptyLine}>Nothing on the Todo list for this trade.</p>}
      {form}
    </section>
  );
}
