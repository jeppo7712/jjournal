import React, { useContext, useState, useEffect, useRef } from 'react';
import { TradeContext, getRealisedPnL, getTickMultiplier } from '../../context/TradeContext';
import { useStatus } from '../../context/StatusContext';
import styles from './Navigation.module.css';

const Navigation = ({ onNewTrade, onNewNote, setCurrentView }) => {
  const { stats, accounts, currentAccountId, setCurrentAccountId, trades } = useContext(TradeContext);
  const { statusLogs } = useStatus();
  const [isDatabaseConnected, setIsDatabaseConnected] = useState(false);
  const [showLogoPopup, setShowLogoPopup] = useState(false);
  const [showActionPopup, setShowActionPopup] = useState(false);
  const [navMode, setNavMode] = useState('wide');
  const [isLowHeight, setIsLowHeight] = useState(false);
  const [showStatusPopup, setShowStatusPopup] = useState(false);

  const logoRef = useRef(null); //
  const actionPopupRef = useRef(null); //
  const logoPopupRef = useRef(null); //
  const statusPopupRef = useRef(null); //
  const statusBoxTriggerRef = useRef(null); // Renamed for clarity, ref for the status trigger area //

  useEffect(() => {
    // WebSocket connection is handled by StatusProvider.
    // This effect remains to update database connection status.
    const fetchDbStatus = async () => {
      try {
        const response = await fetch(`${process.env.REACT_APP_API_URL}/api/config/status`);
        if (!response.ok) {
          throw new Error('Failed to fetch database status');
        }
        const data = await response.json();
        setIsDatabaseConnected(data.isConnected);
      } catch (err) {
        console.error('Error fetching database status:', err);
        setIsDatabaseConnected(false);
      }
    };
    fetchDbStatus();
  }, []); //

  useEffect(() => {
    const handleResize = () => {
      const width = window.innerWidth; //
      const height = window.innerHeight; //
      let currentMode;

      if (width > 1200) {
        currentMode = 'wide'; //
      } else if (width > 600) {
        currentMode = 'medium'; //
      } else {
        currentMode = 'small'; //
      }
      setNavMode(currentMode); //

      const THRESHOLD_HEIGHT_MEDIUM = 380; //
      const newIsLowHeight = (currentMode === 'medium' && height < THRESHOLD_HEIGHT_MEDIUM); //
      setIsLowHeight(newIsLowHeight); //

      if (currentMode === 'wide' && showLogoPopup) {
        setShowLogoPopup(false); //
      }
      // If full status popup's position is not ideal for medium/small,
      // you might want to close it on resize to non-wide modes, or handle its CSS dynamically.
      // For now, it can stay open if triggered.
      // if (currentMode !== 'wide' && showStatusPopup) {
      //   setShowStatusPopup(false);
      // }

      const plusButtonShouldBeVisible = isDatabaseConnected && (currentMode === 'small' || (currentMode === 'medium' && newIsLowHeight)); //
      if (!plusButtonShouldBeVisible && showActionPopup) {
        setShowActionPopup(false); //
      }
    };

    window.addEventListener('resize', handleResize); //
    handleResize(); //
    return () => window.removeEventListener('resize', handleResize); //
  }, [showLogoPopup, showActionPopup, isDatabaseConnected, showStatusPopup]); //

  useEffect(() => {
    const handleClickOutsideLogo = (event) => {
      if (logoRef.current && !logoRef.current.contains(event.target) &&
          logoPopupRef.current && !logoPopupRef.current.contains(event.target)) { //
        setShowLogoPopup(false); //
      }
    };

    if (showLogoPopup) {
      document.addEventListener('pointerdown', handleClickOutsideLogo); //
    }
    return () => {
      document.removeEventListener('pointerdown', handleClickOutsideLogo); //
    };
  }, [showLogoPopup]); //

  useEffect(() => {
    const handleClickOutsideAction = (event) => {
      const plusButton = document.querySelector(`.${styles.plusButton}`); //
      if (plusButton && plusButton.contains(event.target)) {
        return; //
      }
      if (actionPopupRef.current && !actionPopupRef.current.contains(event.target)) { //
        setShowActionPopup(false); //
      }
    };
    if (showActionPopup) {
      document.addEventListener('mousedown', handleClickOutsideAction); //
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutsideAction); //
    };
  }, [showActionPopup]); //

  useEffect(() => {
    const handleClickOutsideStatusPopup = (event) => {
      if (statusPopupRef.current && !statusPopupRef.current.contains(event.target) &&
          statusBoxTriggerRef.current && !statusBoxTriggerRef.current.contains(event.target)) { //
        setShowStatusPopup(false); //
      }
    };
    if (showStatusPopup) {
      document.addEventListener('pointerdown', handleClickOutsideStatusPopup); //
    }
    return () => {
      document.removeEventListener('pointerdown', handleClickOutsideStatusPopup); //
    };
  }, [showStatusPopup]); //


  const handleLogoClick = (e) => {
    e.stopPropagation(); //
    if (navMode !== 'wide') {
      setShowLogoPopup(!showLogoPopup); //
    }
  };

  const handlePlusClick = (e) => {
    e.stopPropagation(); //
    setShowActionPopup(!showActionPopup); //
  };

  const handleStatusTriggerClick = () => {
    setShowStatusPopup(true);
  };

  // Optional inclusion of the current account's cash balance in Total P&L /
  // Market Value — off by default since neither stat historically meant
  // "plus whatever cash is sitting in the account," and folding that in
  // changes what the number represents. Persisted like currentAccountId so
  // the choice sticks across reloads. Only the SAME-currency (USD) balance
  // gets folded directly into the number — other currencies are shown
  // separately rather than summed in, since blending currencies without FX
  // conversion would just be wrong (see docs/CAPITAL_TRACKING_DESIGN.md).
  const [includeCash, setIncludeCash] = useState(localStorage.getItem('navIncludeCash') === 'true');
  useEffect(() => {
    localStorage.setItem('navIncludeCash', includeCash);
  }, [includeCash]);

  const currentAccountCashBalances = (Array.isArray(accounts)
    ? accounts.find(a => String(a.id) === String(currentAccountId))?.cash_balances
    : null) || [];
  const usdCashBalance = currentAccountCashBalances
    .filter(b => (b.currency || 'USD').toUpperCase() === 'USD')
    .reduce((sum, b) => sum + Number(b.balance || 0), 0);
  const otherCurrencyCashBalances = currentAccountCashBalances.filter(b => (b.currency || 'USD').toUpperCase() !== 'USD');

  const totalMarketValue = Array.isArray(trades)
    ? trades
        .filter(trade =>
          trade.status === 'OPEN' &&
          (trade.type === 'STK' || trade.type === 'FUT') &&
          typeof trade.position === 'number' &&
          typeof trade.currentPrice === 'number'
        )
        // FUT contracts aren't worth their raw quoted price per unit (e.g. an ES
        // point isn't a dollar) — scale by the same tick multiplier every PnL
        // formula in this file uses. STK keeps multiplier 1, so unaffected.
        .reduce((sum, trade) => sum + trade.position * trade.currentPrice * getTickMultiplier(trade), 0)
    : 0;

  // Realised (closed trades' return, plus open trades' realised-so-far) *and*
  // unrealised (open trades' live mark-to-market) so this actually is a total,
  // matching Dashboard's R P&L + U P&L combined rather than realised P&L alone.
  const totalPnl = Array.isArray(trades)
    ? trades.reduce((sum, trade) => {
        if (trade.status === 'WIN' || trade.status === 'LOSS' || trade.status === 'WASH') {
          return sum + (trade.return || 0); //
        } else if (trade.status === 'OPEN' && (trade.type === 'STK' || trade.type === 'FUT')) {
          return sum + getRealisedPnL(trade) + (trade.currentReturn || 0); //
        }
        return sum; //
      }, 0) //
    : 0; //

  const safeAccounts = Array.isArray(accounts) ? accounts : []; //
  const safeCurrentAccountId = currentAccountId || ''; //

  const renderAccountInfo = () => (
    <div className={styles.accountInfo}>
      <span className={styles.accountLabel}>Account</span>
      <div className={styles.accountName}>
        {isDatabaseConnected && (
          <select
            value={safeCurrentAccountId}
            onChange={(e) => {
              setCurrentAccountId(e.target.value); //
              if (navMode !== 'wide') {
                setShowLogoPopup(false); //
              }
            }}
            onClick={e => e.stopPropagation()} //
            className={styles.accountSelector}
          >
            {safeAccounts.map(acc => (
              <option key={acc.id} value={acc.id}>
                {acc.name}
              </option>
            ))}
            {safeAccounts.length === 0 && (
              <option value="" disabled>
                No accounts available
              </option>
            )}
          </select>
        )}
      </div>
      <div className={styles.navStat}>
        <span>
          Total P&L
          <label title="Include this account's cash balance in the number below (same-currency only — other currencies shown separately, not summed in)" style={{ marginLeft: '6px', fontWeight: 'normal', fontSize: '0.75em', cursor: 'pointer' }}>
            <input type="checkbox" checked={includeCash} onChange={e => { e.stopPropagation(); setIncludeCash(e.target.checked); }} onClick={e => e.stopPropagation()} style={{ marginRight: '3px' }} />
            +cash
          </label>
        </span>
        <span className={`${styles.accountBalance} ${(totalPnl + (includeCash ? usdCashBalance : 0)) >= 0 ? styles.positive : styles.negative}`}>
          ${(totalPnl + (includeCash ? usdCashBalance : 0)).toFixed(2)}
        </span>
        {includeCash && otherCurrencyCashBalances.length > 0 && (
          <span style={{ fontSize: '0.7em', opacity: 0.7, display: 'block' }}>
            + {otherCurrencyCashBalances.map(b => `${Number(b.balance).toFixed(2)} ${b.currency}`).join(' · ')}
          </span>
        )}
      </div>
      <div className={styles.navStat}>
        <span>Market Value</span>
        <span className={`${styles.accountBalance} ${(totalMarketValue + (includeCash ? usdCashBalance : 0)) >= 0 ? styles.positive : styles.negative}`}>
          ${(totalMarketValue + (includeCash ? usdCashBalance : 0)).toFixed(2)}
        </span>
        {includeCash && otherCurrencyCashBalances.length > 0 && (
          <span style={{ fontSize: '0.7em', opacity: 0.7, display: 'block' }}>
            + {otherCurrencyCashBalances.map(b => `${Number(b.balance).toFixed(2)} ${b.currency}`).join(' · ')}
          </span>
        )}
      </div>

      {/* Integrated Status Display */}
      <div 
        className={styles.integratedStatusSection} 
        onClick={handleStatusTriggerClick} 
        ref={statusBoxTriggerRef} 
        title="Click to see all logs"
      >
        <div className={styles.statusHeader}>
          <span className={styles.statusLabel}>Status</span>
          <div
            className={styles.statusIndicator}
            style={{ backgroundColor: isDatabaseConnected ? '#0d8050' : '#b32424' }} //
          ></div>
        </div>
        {/* Removed the logList div to free up space */}
      </div>
    </div>
  );

  const showPlusButton = isDatabaseConnected && (navMode === 'small' || (navMode === 'medium' && isLowHeight));
  const showRegularActionButtons = isDatabaseConnected && !showPlusButton;

  const recentLogs = statusLogs.slice(-5);
  const allLogs = statusLogs.slice(-50);

  return (
    <nav className={`${styles.navigation} ${navMode === 'medium' && isLowHeight ? styles.mediumLowHeight : ''}`}> {/* */}
      <div className={styles.logo} ref={logoRef} onClick={handleLogoClick}> {/* */}
        <img src="/logo192.png" alt="Logo" className={styles.logoImg} /> {/* */}
        <h1 className={styles.logoText}>Jay's Journal</h1> {/* */}
        {showLogoPopup && navMode !== 'wide' && (
          <div
            className={`${styles.logoPopup} ${showLogoPopup ? styles.show : ''}`} //
            ref={logoPopupRef} //
          >
            {renderAccountInfo()} {/* Account info (now with status) for medium/small modes */}
          </div>
        )}
      </div>

      <div className={styles.navItems}> {/* */}
        {isDatabaseConnected ? (
          <>
            <div className={styles.navItem} onClick={() => setCurrentView('dashboard')} title="Dashboard"> {/* */}
              <svg className={styles.navIcon} viewBox="0 0 20 20" fill="currentColor"><path d="M5 3a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2V5a2 2 0 00-2-2H5zM5 11a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2v-2a2 2 0 00-2-2H5zM11 5a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V5zM11 13a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" /></svg>
              <span className={styles.navLabel}>Dashboard</span>
            </div>
            <div className={styles.navItem} onClick={() => setCurrentView('stats')} title="Stats"> {/* */}
              <svg className={styles.navIcon} viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M5 3a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2V5a2 2 0 00-2-2H5zm9 4a1 1 0 10-2 0v6a1 1 0 102 0V7zm-3 2a1 1 0 10-2 0v4a1 1 0 102 0V9zm-3 3a1 1 0 10-2 0v1a1 1 0 102 0v-1z" clipRule="evenodd" /></svg>
              <span className={styles.navLabel}>Stats</span>
            </div>
            <div className={styles.navItem} onClick={() => setCurrentView('capital')} title="Capital"> {/* */}
              <svg className={styles.navIcon} viewBox="0 0 20 20" fill="currentColor"><path d="M4 4a2 2 0 00-2 2v1h16V6a2 2 0 00-2-2H4z" /><path fillRule="evenodd" d="M18 9H2v5a2 2 0 002 2h12a2 2 0 002-2V9zM4 13a1 1 0 011-1h1a1 1 0 110 2H5a1 1 0 01-1-1zm5-1a1 1 0 100 2h1a1 1 0 100-2H9z" clipRule="evenodd" /></svg>
              <span className={styles.navLabel}>Capital</span>
            </div>
            <div className={styles.navItem} onClick={() => setCurrentView('settings')} title="Settings"> {/* */}
              <svg className={styles.navIcon} viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" /></svg>
              <span className={styles.navLabel}>Settings</span>
            </div>
          </>
        ) : (
          <div className={styles.navItem} onClick={() => setCurrentView('settings')} title="Settings"> {/* */}
            <svg className={styles.navIcon} viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" /></svg>
            <span className={styles.navLabel}>Settings</span>
          </div>
        )}
      </div>

      {showRegularActionButtons && isDatabaseConnected && (
        <div className={styles.actionButtons}> {/* */}
          <button className={styles.newTradeBtn} onClick={onNewTrade}> {/* */}
            <svg className={styles.btnIcon} viewBox="0 0 20 20" fill="currentColor"><path d="M5 3a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2V5a2 2 0 00-2-2H5zM5 11a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2v-2a2 2 0 00-2-2H5zM11 5a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V5zM14 11a1 1 0 011 1v1h1a1 1 0 110 2h-1v1a1 1 0 11-2 0v-1h-1a1 1 0 110-2h1v-1a1 1 0 011-1z" /></svg>
            <span className={styles.btnText}>New Trade</span>
          </button>
           <button className={styles.noteBtn} onClick={onNewNote}> {/* */}
            <svg className={styles.btnIcon} viewBox="0 0 20 20" fill="currentColor"><path d="M5 4a2 2 0 012-2h6a2 2 0 012 2v14l-5-2.5L5 18V4z" /></svg>
            <span className={styles.btnText}>New Note</span>
          </button>
        </div>
      )}

      {showPlusButton && isDatabaseConnected && (
         <div className={`${styles.plusButtonContainer} ${navMode === 'medium' ? styles.plusButtonContainerMedium : ''}`}> {/* */}
          <button
            className={styles.plusButton} //
            onClick={handlePlusClick} //
            title="Actions" //
          >
            <svg className={styles.btnIcon} viewBox="0 0 20 20" fill="currentColor"> {/* */}
              <path fillRule="evenodd" d="M10 5a1 1 0 011 1v3h3a1 1 0 110 2h-3v3a1 1 0 11-2 0v-3H6a1 1 0 110-2h3V6a1 1 0 011-1z" clipRule="evenodd" />
            </svg>
          </button>
          {showActionPopup && (
            <div
              className={`${styles.actionPopup} ${showActionPopup ? styles.show : ''} ${ //
                navMode === 'medium' ? styles.actionPopupMedium : styles.actionPopupSmall //
              }`}
              ref={actionPopupRef} //
            >
              <button className={styles.newTradeBtn} onClick={onNewTrade}> {/* */}
                <svg className={styles.btnIcon} viewBox="0 0 20 20" fill="currentColor"> {/* */}
                  <path d="M5 3a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2V5a2 2 0 00-2-2H5zM5 11a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2v-2a2 2 0 00-2-2H5zM11 5a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V5zM14 11a1 1 0 011 1v1h1a1 1 0 110 2h-1v1a1 1 0 11-2 0v-1h-1a1 1 0 110-2h1v-1a1 1 0 011-1z" />
                </svg>
                <span className={styles.btnText}>New Trade</span>
              </button>
              <button className={styles.noteBtn} onClick={onNewNote}> {/* */}
                <svg className={styles.btnIcon} viewBox="0 0 20 20" fill="currentColor"> {/* */}
                  <path d="M5 4a2 2 0 012-2h6a2 2 0 012 2v14l-5-2.5L5 18V4z" />
                </svg>
                <span className={styles.btnText}>New Note</span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* AccountInfo for wide mode (now includes status display) */}
      {navMode === 'wide' && (
        <div className={styles.wideFooterAccountInfo}> {/* Wrapper for positioning account info in wide mode */}
          {renderAccountInfo()}
        </div>
      )}
      
      {/* Full WebSocket Status Popup - now can be triggered from any mode if accountInfo is visible */}
      {showStatusPopup && (
        <div className={styles.fullStatusPopup} ref={statusPopupRef}> {/* */}
          <div className={styles.fullStatusHeader}> {/* */}
            <h4 className={styles.fullStatusTitle}>WebSocket Connection Logs</h4>
            <button onClick={() => setShowStatusPopup(false)} className={styles.closePopupBtn} title="Close">
              &times;
            </button>
          </div>
          <div className={styles.fullLogList}>
            {allLogs.length > 0 ? 
              [...allLogs].reverse().map((log, index) => (
              <div key={log.id || index} className={`${styles.fullLogItem} ${log.type === 'error' ? styles.logError : log.type === 'warning' ? styles.logWarning : ''}`}>
                <span className={styles.fullLogTimestamp}>
                  {new Date(log.timestamp).toLocaleString()}
                </span>
                <span className={styles.fullLogMessage}>{log.status}</span>
              </div>
            )) : <p className={styles.noLogsMessage}>No WebSocket logs recorded yet.</p>}
          </div>
        </div>
      )}
    </nav>
  );
};

export default Navigation; //