import React, { useContext, useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { TradeContext, formatDate, parseActionDate, TRADE_LIST_COLUMNS } from '../../context/TradeContext';
import { DateTime } from 'luxon';
import { sanitizeNotesHtml } from '../../utils/sanitizeHtml';
import styles from './TradeList.module.css';

// SVG Icons for Mood, Market Condition, and Market Volume (existing)
const moodSvgs = [
  // Sad
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM7 9a1 1 0 100-2 1 1 0 000 2zm7-1a1 1 0 11-2 0 1 1 0 012 0zm-7.536 5.879a1 1 0 001.415 0 3 3 0 014.242 0 1 1 0 001.415-1.415 5 5 0 00-7.072 0 1 1 0 000 1.415z" clipRule="evenodd"/></svg>,
  // Neutral
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M 10 18 a 8 8 0 1 0 0 -16 a 8 8 0 0 0 0 16 z M 7 9 a 1 1 0 1 0 0 -2 a 1 1 0 0 0 0 2 z m 7 -1 a 1 1 0 1 1 -2 0 a 1 1 0 0 1 2 0 z m -0.464 5.535 q 0.464 -1.535 -1.415 -1.414 l -4.242 0 q -1.879 -0.121 -1.415 1.414 q 3.536 0.465 7.072 0 z" clipRule="evenodd"/></svg>,
  // Happy
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM7 9a1 1 0 100-2 1 1 0 000 2zm7-1a1 1 0 11-2 0 1 1 0 012 0zm-.464 5.535a1 1 0 10-1.415-1.414 3 3 0 01-4.242 0 1 1 0 00-1.415 1.414 5 5 0 007.072 0z" clipRule="evenodd"/></svg>,
];

const mktConditionSvgs = [
  // Trending down
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M12 13a1 1 0 100 2h5a1 1 0 001-1V9a1 1 0 10-2 0v2.586l-4.293-4.293a1 1 0 00-1.414 0L8 9.586 3.707 5.293a1 1 0 00-1.414 1.414l5 5a1 1 0 001.414 0L11 9.414 14.586 13H12z" clipRule="evenodd"/></svg>,
  // Sideways
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M8 5a1 1 0 100 2h5.586l-1.293 1.293a1 1 0 001.414 1.414l3-3a1 1 0 000-1.414l-3-3a1 1 0 10-1.414 1.414L13.586 5H8zM12 15a1 1 0 100-2H6.414l1.293-1.293a1 1 0 10-1.414-1.414l-3 3a1 1 0 000 1.414l3 3a1 1 0 001.414-1.414L6.414 15H12z" clipRule="evenodd"/></svg>,
  // Trending up
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M12 7a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0V8.414l-4.293 4.293a1 1 0 01-1.414 0L8 10.414l-4.293 4.293a1 1 0 01-1.414-1.414l5-5a1 1 0 011.414 0L11 10.586 14.586 7H12z" clipRule="evenodd"/></svg>,
];

const mktVolSvgs = [
  // Low
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M 8 11 a 1 1 0 0 1 1 -1 h 2 a 1 1 0 0 1 1 1 v 5 a 1 1 0 0 1 -1 1 H 9 a 1 1 0 0 1 -1 -1 v -5 z" clipRule="evenodd"/></svg>,
  // Medium
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M 5 11 a 1 1 0 0 1 1 -1 h 2 a 1 1 0 0 1 1 1 v 5 a 1 1 0 0 1 -1 1 H 6 a 1 1 0 0 1 -1 -1 v -5 z M 11 7 a 1 1 0 0 1 1 -1 h 2 a 1 1 0 0 1 1 1 v 9 a 1 1 0 0 1 -1 1 H 12 a 1 1 0 0 1 -1 -1 V 7 z" clipRule="evenodd"/></svg>,
  // High
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zM8 7a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zM14 4a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z" clipRule="evenodd"/></svg>,
];

// Define the new SVG icons for trade side
const LongArrowSvg = (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" style={{ width: '16px', height: '16px' }}>
    <path fillRule="evenodd" d="M12.577 4.878a.75.75 0 01.919-.53l4.78 1.281a.75.75 0 01.531.919l-1.281 4.78a.75.75 0 01-1.449-.387l.81-3.022a19.407 19.407 0 00-5.594 5.203.75.75 0 01-1.139.093L7 10.06l-4.72 4.72a.75.75 0 01-1.06-1.061l5.25-5.25a.75.75 0 011.06 0l3.074 3.073a20.923 20.923 0 015.545-4.931l-3.042-.815a.75.75 0 01-.53-.919z" clipRule="evenodd"></path>
  </svg>
);

const ShortArrowSvg = (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" style={{ width: '16px', height: '16px' }}>
    <path fillRule="evenodd" d="M1.22 5.222a.75.75 0 011.06 0L7 9.942l3.768-3.769a.75.75 0 011.113.058 20.908 20.908 0 013.813 7.254l1.574-2.727a.75.75 0 011.3.75l-2.475 4.286a.75.75 0 01-1.025.275l-4.287-2.475a.75.75 0 01.75-1.3l2.71 1.565a19.422 19.422 0 00-3.013-6.024L7.53 11.533a.75.75 0 01-1.06 0l-5.25-5.25a.75.75 0 010-1.06z" clipRule="evenodd"></path>
  </svg>
);

const TradeList = ({ onViewTrade, onEditTrade, onViewDayNote }) => {
  const {
    filteredItems,
    setSort,
    sortField,
    sortDirection,
    timeFilter,
    getTimeRange,
    customStartDate,
    customEndDate,
    trades,
    tradesPerPage,
    currentPage,
    setCurrentPage,
    hiddenColumns,
  } = useContext(TradeContext);

  const isColumnVisible = (key) => !hiddenColumns.includes(key);
  const safeFilteredItems = Array.isArray(filteredItems) ? filteredItems : [];
  const [isMidBreakpoint, setIsMidBreakpoint] = useState(false);
  const [hoveredTrade, setHoveredTrade] = useState(null);
  const [popupPosition, setPopupPosition] = useState({ x: 0, y: 0 });
  const hoverTimerRef = useRef(null); // Ref for the hover timer

  // Cleanup timer on component unmount
  useEffect(() => {
    return () => {
      clearTimeout(hoverTimerRef.current);
    };
  }, []);

  const handleMouseEnterTrade = (event, trade) => {
    clearTimeout(hoverTimerRef.current); // Clear any existing timer
    if (trade.type !== 'FUT' && trade.type !== 'STK') return; // Only for trades

    const { pageX, pageY } = event; // Capture mouse position

    // Start a new timer to show the popup after a 1-second delay
    hoverTimerRef.current = setTimeout(() => {
      setHoveredTrade(trade);
      setPopupPosition({ x: pageX, y: pageY });
    }, 1000); // 1000ms delay
  };

  const handleMouseLeaveTrade = () => {
    clearTimeout(hoverTimerRef.current); // Cancel the timer if mouse leaves
    setHoveredTrade(null); // Hide the popup immediately
  };

  const handleMouseMove = (event) => {
    if (hoveredTrade) {
      // Update position only if the popup is already visible
      setPopupPosition({ x: event.pageX, y: event.pageY });
    }
  };

  const handleTradeClick = (item) => {
    clearTimeout(hoverTimerRef.current); // Clear the hover timer
    setHoveredTrade(null); // Hide the popup
    if (onViewTrade) {
      onViewTrade(item); // Call the original onViewTrade handler
    }
  };

  useEffect(() => {
    const checkBreakpoint = () => {
      const midBreakpoint = window.matchMedia('(min-width: 600px) and (max-width: 992px)');
      setIsMidBreakpoint(midBreakpoint.matches);
    };
    checkBreakpoint();
    window.addEventListener('resize', checkBreakpoint);
    return () => window.removeEventListener('resize', checkBreakpoint);
  }, []);

  const handleSort = (field) => {
    setSort(field);
  };

  const filterRange = timeFilter ? getTimeRange(timeFilter, customStartDate, customEndDate) : null;

  const getDailyStats = (noteDate) => {
    if (!(noteDate instanceof DateTime) || !noteDate.isValid) return { dailyPnL: 0, wins: 0, losses: 0 };

    const sameDayTrades = trades.filter((trade) => {
      if ((trade.type !== 'STK' && trade.type !== 'FUT') || trade.status === 'OPEN') return false;
      const lastActionDate = parseActionDate(trade.lastActionDate);
      if (!lastActionDate.isValid) return false;
      return (
        lastActionDate.hasSame(noteDate, 'year') &&
        lastActionDate.hasSame(noteDate, 'month') &&
        lastActionDate.hasSame(noteDate, 'day')
      );
    });

    let dailyPnL = 0;
    let wins = 0;
    let losses = 0;

    sameDayTrades.forEach((trade) => {
      if (trade.return !== undefined && trade.return !== null) {
        dailyPnL += trade.return;
      }
      if (trade.status === 'WIN') {
        wins++;
      } else if (trade.status === 'LOSS') {
        losses++;
      }
    });

    return { dailyPnL, wins, losses };
  };

  const getStatusText = (status) => {
    if (isMidBreakpoint) {
      switch (status) {
        case 'WIN':
          return 'W';
        case 'OPEN':
          return 'O';
        case 'LOSS':
          return 'L';
        default:
          return status;
      }
    }
    return status;
  };

  // Reset to page 1 when filtered items change
  useEffect(() => {
    setCurrentPage(1);
  }, [safeFilteredItems.length, setCurrentPage]);

  // Calculate pagination
  const totalTrades = safeFilteredItems.length;
  const totalPages = tradesPerPage === null ? 1 : Math.ceil(totalTrades / tradesPerPage);
  const startIndex = tradesPerPage === null ? 0 : (currentPage - 1) * tradesPerPage;
  const endIndex = tradesPerPage === null ? totalTrades : Math.min(startIndex + tradesPerPage, totalTrades);
  const paginatedItems = tradesPerPage === null ? safeFilteredItems : safeFilteredItems.slice(startIndex, endIndex);


  return (
    <div className={styles.tradeList} onMouseMove={handleMouseMove}>
      <div className={styles.header}>
        {isColumnVisible('openDate') && (
          <div
            className={`${styles.headerCell} ${styles.sortable} ${sortField === 'openDate' ? styles.sorted : ''}`}
            onClick={() => handleSort('openDate')}
          >
            Open Date
            {sortField === 'openDate' && (
              <span className={styles.sortIcon}>
                {sortDirection === 'asc' ? '↑' : '↓'}
              </span>
            )}
          </div>
        )}
        {isColumnVisible('symbol') && (
          <div
            className={`${styles.headerCell} ${styles.sortable} ${sortField === 'symbol' ? styles.sorted : ''}`}
            onClick={() => handleSort('symbol')}
          >
            Symbol
            {sortField === 'symbol' && (
              <span className={styles.sortIcon}>
                {sortDirection === 'asc' ? '↑' : '↓'}
              </span>
            )}
          </div>
        )}
        {isColumnVisible('status') && (
          <div
            className={`${styles.headerCell} ${styles.sortable} ${sortField === 'status' ? styles.sorted : ''}`}
            onClick={() => handleSort('status')}
          >
            Status
            {sortField === 'status' && (
              <span className={styles.sortIcon}>
                {sortDirection === 'asc' ? '↑' : '↓'}
              </span>
            )}
          </div>
        )}
        {isColumnVisible('side') && (
          <div
            className={`${styles.headerCell} ${styles.sortable} ${sortField === 'side' ? styles.sorted : ''}`}
            onClick={() => handleSort('side')}
          >
            Side
            {sortField === 'side' && (
              <span className={styles.sortIcon}>
                {sortDirection === 'asc' ? '↑' : '↓'}
              </span>
            )}
          </div>
        )}
        {isColumnVisible('quantity') && <div className={styles.headerCell}>Qty</div>}
        {isColumnVisible('entry') && <div className={styles.headerCell}>Entry</div>}
        {isColumnVisible('exit') && <div className={styles.headerCell}>Exit</div>}
        {isColumnVisible('entryTotal') && <div className={`${styles.headerCell} ${styles.colEntryTotal}`}>Ent Tot</div>}
        {isColumnVisible('exitTotal') && <div className={`${styles.headerCell} ${styles.colExitTotal}`}>Ext Tot</div>}
        {isColumnVisible('position') && <div className={`${styles.headerCell} ${styles.colPosition}`}>Pos</div>}
        {isColumnVisible('holdTime') && <div className={styles.headerCell}>Hold</div>}
        {isColumnVisible('return') && (
          <div
            className={`${styles.headerCell} ${styles.sortable} ${sortField === 'return' ? styles.sorted : ''}`}
            onClick={() => handleSort('return')}
          >
            Return
            {sortField === 'return' && (
              <span className={styles.sortIcon}>
                {sortDirection === 'asc' ? '↑' : '↓'}
              </span>
            )}
          </div>
        )}
        {isColumnVisible('returnPercentage') && (
          <div
            className={`${styles.headerCell} ${styles.sortable} ${sortField === 'returnPercentage' ? styles.sorted : ''}`}
            onClick={() => handleSort('returnPercentage')}
          >
            Return %
            {sortField === 'returnPercentage' && (
              <span className={styles.sortIcon}>
                {sortDirection === 'asc' ? '↑' : '↓'}
              </span>
            )}
          </div>
        )}
      </div>
      <div className={styles.tradeRows}>
        {paginatedItems.map(item => {
          if (item.type === 'FUT' || item.type === 'STK') {
            const lastActionDate = item.lastActionDate;
            const isNotClosed = filterRange && (
              (item.status === 'OPEN') ||
              (lastActionDate && !isNaN(lastActionDate) && lastActionDate > filterRange.end)
            );

            return (
              <div
                key={`trade-${item.id}`}
                className={`${styles.tradeRow} ${isNotClosed ? styles.tradeRowNotClosed : ''}`}
                onClick={() => handleTradeClick(item)} // Updated to use new handler
                onMouseEnter={(e) => handleMouseEnterTrade(e, item)}
                onMouseLeave={handleMouseLeaveTrade}
                tabIndex={0}
                role="button"
              >
                <div className={styles.cellContainer}>
                  <div className={styles.cellColumn}>
                    <div className={styles.cellTop}>
                      <span className={styles.symbol}>{item.symbol}</span>
                      <span className={`${styles.direction} ${item.side === 'LONG' ? styles.long : item.side === 'SHORT' ? styles.short : ''}`}>
                        {item.side === 'LONG' ? LongArrowSvg : item.side === 'SHORT' ? ShortArrowSvg : '-'}
                      </span>
                    </div>
                    <div className={styles.cellBottom}>
                      {item.status === 'OPEN' ? (
                        item.position !== undefined && item.position !== null ? `${item.position} PCS` : '- PCS'
                      ) : (
                        item.quantity !== undefined && item.quantity !== null ? `${item.quantity} PCS` : '- PCS'
                      )}
                    </div>
                  </div>
                  <div className={styles.cellColumn}>
                    <div className={styles.cellTop}>
                      {item.openDate}
                    </div>
                    <div className={styles.cellBottom}>
                      {item.entry !== undefined && item.entry !== null
                        ? `$${item.entry.toFixed(item.pricePrecision || 2)}`
                        : '-'} - {item.exit !== undefined && item.exit !== null
                          ? `$${item.exit.toFixed(item.pricePrecision || 2)}`
                          : '-'}
                    </div>
                  </div>
                  <div className={styles.cellColumn}>
                    <div className={styles.cellTop}>
                      {item.status === 'OPEN' ? (
                        item.currentReturn !== undefined && item.currentReturn !== null ? (
                          <span className={item.currentReturn >= 0 ? styles.positiveItalic : styles.negativeItalic}>
                            ({item.currentReturn >= 0 ? '$' : '$'}{Math.abs(item.currentReturn).toFixed(2)})
                          </span>
                        ) : (
                          <span className={styles.loading}>Loading...</span>
                        )
                      ) : (
                        item.return !== undefined && item.return !== null ? (
                          <span className={item.return >= 0 ? styles.positive : styles.negative}>
                            {item.return >= 0 ? '$' : '$'}{Math.abs(item.return).toFixed(2)}
                          </span>
                        ) : (
                          '-'
                        )
                      )}
                    </div>
                    <div className={styles.cellBottom}>
                      {item.status === 'OPEN' ? (
                        item.currentReturnPercentage !== undefined && item.currentReturnPercentage !== null ? (
                          <span className={item.currentReturnPercentage >= 0 ? styles.positiveItalic : styles.negativeItalic}>
                            ({item.currentReturnPercentage >= 0 ? '' : ''}{Math.abs(item.currentReturnPercentage).toFixed(2)}%)
                          </span>
                        ) : (
                          <span className={styles.loading}>Loading...</span>
                        )
                      ) : (
                        item.returnPercentage !== undefined && item.returnPercentage !== null ? (
                          <span className={item.returnPercentage >= 0 ? styles.positive : styles.negative}>
                            {item.returnPercentage >= 0 ? '' : ''}{Math.abs(item.returnPercentage).toFixed(2)}%
                          </span>
                        ) : (
                          '-'
                        )
                      )}
                    </div>
                  </div>
                </div>
                <div className={styles.desktopCells}>
                  {isColumnVisible('openDate') && <div className={styles.cell}>{item.openDate}</div>}
                  {isColumnVisible('symbol') && <div className={`${styles.cell} ${styles.symbol}`}>{item.symbol}</div>}
                  {isColumnVisible('status') && (
                    <div className={styles.cell}>
                      <span className={
                        `${styles.status} ` +
                        (item.status === 'WIN'
                          ? styles.statusWin
                          : item.status === 'LOSS'
                          ? styles.statusLoss
                          : styles.statusOpen)
                      }>
                        {getStatusText(item.status)}
                      </span>
                    </div>
                  )}
                  {isColumnVisible('side') && (
                    <div className={styles.cell}>
                      <span className={`${styles.direction} ${item.side === 'LONG' ? styles.long : item.side === 'SHORT' ? styles.short : ''}`}>
                        {item.side === 'LONG' ? LongArrowSvg : item.side === 'SHORT' ? ShortArrowSvg : '-'}
                      </span>
                    </div>
                  )}
                  {isColumnVisible('quantity') && (
                    <div className={styles.cell}>
                      {item.quantity !== undefined && item.quantity !== null ? item.quantity : '-'}
                    </div>
                  )}
                  {isColumnVisible('entry') && (
                    <div className={styles.cell}>
                      {item.entry !== undefined && item.entry !== null ? `$${item.entry.toFixed(item.pricePrecision || 2)}` : '-'}
                    </div>
                  )}
                  {isColumnVisible('exit') && (
                    <div className={styles.cell}>
                      {item.exit !== undefined && item.exit !== null ? `$${item.exit.toFixed(item.pricePrecision || 2)}` : '-'}
                    </div>
                  )}
                  {isColumnVisible('entryTotal') && (
                    <div className={`${styles.cell} ${styles.colEntryTotal}`}>
                      {item.entryTotal !== undefined && item.entryTotal !== null ? `$${item.entryTotal.toFixed(2)}` : '-'}
                    </div>
                  )}
                  {isColumnVisible('exitTotal') && (
                    <div className={`${styles.cell} ${styles.colExitTotal}`}>
                      {item.exitTotal !== undefined && item.exitTotal !== null ? `$${item.exitTotal.toFixed(2)}` : '-'}
                    </div>
                  )}
                  {isColumnVisible('position') && (
                    <div className={`${styles.cell} ${styles.colPosition}`}>
                      {item.position !== undefined && item.position !== null ? item.position : '-'}
                    </div>
                  )}
                  {isColumnVisible('holdTime') && (
                    <div className={styles.cell}>
                      <span className={styles.hold}>{item.holdTime || '-'}</span>
                    </div>
                  )}
                  {isColumnVisible('return') && (
                    <div className={styles.cell}>
                      {item.status === 'OPEN' ? (
                        item.currentReturn !== undefined && item.currentReturn !== null ? (
                          <span className={item.currentReturn >= 0 ? styles.positiveItalic : styles.negativeItalic}>
                            ({item.currentReturn >= 0 ? '$' : '$'}{Math.abs(item.currentReturn).toFixed(2)})
                          </span>
                        ) : (
                          <span className={styles.loading}>Loading...</span>
                        )
                      ) : (
                        item.return !== undefined && item.return !== null ? (
                          <span className={item.return >= 0 ? styles.positive : styles.negative}>
                            {item.return >= 0 ? '$' : '$'}{Math.abs(item.return).toFixed(2)}
                          </span>
                        ) : (
                          '-'
                        )
                      )}
                    </div>
                  )}
                  {isColumnVisible('returnPercentage') && (
                    <div className={styles.cell}>
                      {item.status === 'OPEN' ? (
                        item.currentReturnPercentage !== undefined && item.currentReturnPercentage !== null ? (
                          <span className={item.currentReturnPercentage >= 0 ? styles.positiveItalic : styles.negativeItalic}>
                            ({item.currentReturnPercentage >= 0 ? '' : ''}{Math.abs(item.currentReturnPercentage).toFixed(2)}%)
                          </span>
                        ) : (
                          <span className={styles.loading}>Loading...</span>
                        )
                      ) : (
                        item.returnPercentage !== undefined && item.returnPercentage !== null ? (
                          <span className={item.returnPercentage >= 0 ? styles.positive : styles.negative}>
                            {item.returnPercentage >= 0 ? '' : ''}{Math.abs(item.returnPercentage).toFixed(2)}%
                          </span>
                        ) : (
                          '-'
                        )
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          } else if (item.type === 'dayNote') {
            const { dailyPnL, wins, losses } = getDailyStats(item.date);
            const hasTrades = wins > 0 || losses > 0;

            return (
              <div
                key={`daynote-${item.id}`}
                className={styles.noteRow}
                onClick={() => onViewDayNote && onViewDayNote(item)}
                tabIndex={0}
                role="button"
              >
                <div className={styles.noteContainer}>
                  <div className={styles.noteTop}>
                    <div className={styles.noteIconDate}>
                      <span className={styles.noteIcon}>
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          viewBox="0 0 20 20"
                          fill="currentColor"
                          className={styles.noteBadge}
                        >
                          <path d="M5 4a2 2 0 012-2h6a2 2 0 012 2v14l-5-2.5L5 18V4z"></path>
                        </svg>
                      </span>
                      <span className={styles.noteDate}>
                        {formatDate(item.date)}
                      </span>
                    </div>
                    <div className={styles.noteIcons}>
                      <span className={styles.noteIcon}>
                        {moodSvgs[item.mood]}
                      </span>
                      <span className={styles.noteIcon}>
                        {mktConditionSvgs[item.market_condition]}
                      </span>
                      <span className={styles.noteIcon}>
                        {mktVolSvgs[item.market_volume]}
                      </span>
                    </div>
                    <div className={styles.noteStats}>
                      {hasTrades ? (
                        <>
                          <span className={`${styles.dailyPnL} ${dailyPnL >= 0 ? styles.statusWin : styles.statusLoss}`}>
                            {dailyPnL >= 0 ? '$' : '$'}{Math.abs(dailyPnL).toFixed(2)}
                          </span>
                          <span className={styles.tradeCounts}>
                            <span className={styles.wins}>{wins}</span>/
                            <span className={styles.losses}>{losses}</span>
                          </span>
                        </>
                      ) : (
                        <span className={styles.noTrades}>-</span>
                      )}
                    </div>
                  </div>
                  <div className={styles.noteBottom}>
                    <div className={styles.noteContent}>
                      {item.summary || '-'}
                    </div>
                  </div>
                </div>
                <div className={styles.desktopNote}>
                  <div className={styles.noteIcon}>
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      className={styles.noteBadge}
                    >
                      <path d="M5 4a2 2 0 012-2h6a2 2 0 012 2v14l-5-2.5L5 18V4z"></path>
                    </svg>
                  </div>
                  <div className={styles.noteDate}>
                    {formatDate(item.date)}
                  </div>
                  <div className={styles.noteIcons}>
                    <span className={styles.noteIcon}>
                      {moodSvgs[item.mood]}
                    </span>
                    <span className={styles.noteIcon}>
                      {mktConditionSvgs[item.market_condition]}
                    </span>
                    <span className={styles.noteIcon}>
                      {mktVolSvgs[item.market_volume]}
                    </span>
                  </div>
                  <div className={styles.noteContent}>
                    {item.summary || '-'}
                  </div>
                  <div className={styles.noteStats}>
                    {hasTrades ? (
                      <>
                        <span className={`${styles.dailyPnL} ${dailyPnL >= 0 ? styles.statusWin : styles.statusLoss}`}>
                          {dailyPnL >= 0 ? '$' : '$'}{Math.abs(dailyPnL).toFixed(2)}
                        </span>
                        <span className={styles.tradeCounts}>
                          <span className={styles.wins}>{wins}</span>/
                          <span className={styles.losses}>{losses}</span>
                        </span>
                      </>
                    ) : (
                      <span className={styles.noTrades}>-</span>
                    )}
                  </div>
                </div>
              </div>
            );
          }
          return null;
        })}
      </div>
      {/* Pagination Controls */}
      {tradesPerPage !== null && totalPages > 1 && (
        <div className={styles.paginationContainer}>
          <button
            className={styles.paginationBtn}
            onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
            disabled={currentPage === 1}
          >
            ← Previous
          </button>
          <span className={styles.paginationInfo}>
            Page {currentPage} of {totalPages} ({totalTrades} trades)
          </span>
          <button
            className={styles.paginationBtn}
            onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
            disabled={currentPage === totalPages}
          >
            Next →
          </button>
        </div>
      )}

      {/* 👇 Use createPortal to render the popup */}
      {hoveredTrade && createPortal(
        <div
          className={styles.notesPopup}
          style={{
            position: 'absolute',
            top: `${popupPosition.y + 15}px`,
            left: `${popupPosition.x + 15}px`,
            zIndex: 9999,
          }}
        >
          {hoveredTrade.journal && hoveredTrade.journal.notes_html ? (
            <div dangerouslySetInnerHTML={{ __html: sanitizeNotesHtml(hoveredTrade.journal.notes_html) }} />
          ) : (
            "No notes"
          )}
        </div>,
        document.body // Target the document body
      )}
    </div>
  );
};

export default TradeList;