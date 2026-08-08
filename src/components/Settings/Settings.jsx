import React, { useState, useEffect, useContext, useMemo } from 'react';
import styles from './Settings.module.css';
import { TradeContext, TRADE_LIST_COLUMNS } from '../../context/TradeContext';
import { useStatus } from '../../context/StatusContext';
import { DateTime } from 'luxon';
import { FaPencilAlt, FaTrash } from 'react-icons/fa'; // Example using react-icons
import { findExchangePreset, findFuturesPreset } from '../../data/marketReference';

// Must match VALID_TIMEFRAMES / DEFAULT_TIMEFRAME_SETTINGS in
// modules/historical-data-service.js.
const TIMEFRAME_ORDER = ['1M', '5M', '15M', '1H', '4H', '1D', '1W'];
const DEFAULT_TIMEFRAME_SETTINGS = {
  '1M': { enabled: false },
  '5M': { enabled: true },
  '15M': { enabled: false },
  '1H': { enabled: true },
  '4H': { enabled: false },
  '1D': { enabled: true },
  '1W': { enabled: false },
};

// There's no "how much history to keep" input anymore — every enabled
// timeframe is always fetched as far back as the provider will allow. This
// just describes what's actually going to happen for a given timeframe, from
// the /historical/limits data: Yahoo's fixed known limit, plus any IBKR
// boundary already discovered from a real fetch (absent entirely if IBKR
// hasn't hit its limit yet, which isn't a limit of "none" — just "not learned
// yet").
function describeTimeframeLimits(tfLimits) {
  if (!tfLimits) return null;
  const parts = [];
  if (tfLimits.yahooMaxLookbackDays != null) {
    parts.push(`Yahoo: ~${Math.round(tfLimits.yahooMaxLookbackDays)}d back`);
  }
  (tfLimits.ibkrEarliestAvailable || []).forEach(({ contractMonth, earliestAvailable }) => {
    const label = contractMonth ? `contract ${contractMonth}` : 'IBKR';
    parts.push(`${label}: confirmed back to ${DateTime.fromISO(earliestAvailable).toFormat('yyyy-MM-dd')}`);
  });
  return parts.length > 0 ? parts.join(' · ') : null;
}

function BubbleButton({ children, onClick, color = '#3B82F6', disabled, ...rest }) {
  return (
    <button
      className={styles.saveBtn}
      style={{
        background: color,
        marginRight: 10,
        borderRadius: 18,
        padding: '10px 24px',
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer'
      }}
      onClick={onClick}
      disabled={disabled}
      {...rest}
    >
      {children}
    </button>
  );
}

const ArrowRightIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ margin: '0 8px' }}>
    <path d="M4 12H20M14 6L20 12L14 18" stroke="#A5ADBA" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// Helper to back-adjust continuous futures series (same logic as TradeView)
function getBackAdjustedBars(bars) {
  if (!Array.isArray(bars) || bars.length < 2) {
    return bars || [];
  }

  // Ensure ascending order by time
  const sorted = [...bars].sort((a, b) => {
    const ta = DateTime.fromISO(a.time).toMillis();
    const tb = DateTime.fromISO(b.time).toMillis();
    return ta - tb;
  });

  const adjustedBars = [];
  let currentAdjustment = 0;

  // Iterate from newest to oldest, accumulating adjustment
  for (let i = sorted.length - 1; i >= 0; i--) {
    const currentBar = sorted[i];
    const prevBar = i > 0 ? sorted[i - 1] : null;

    adjustedBars.unshift({
      ...currentBar,
      open: currentBar.open + currentAdjustment,
      high: currentBar.high + currentAdjustment,
      low: currentBar.low + currentAdjustment,
      close: currentBar.close + currentAdjustment,
    });

    if (currentBar.isRollover && prevBar) {
      const gap = currentBar.open - prevBar.close;
      currentAdjustment += gap;
    }
  }

  return adjustedBars;
}

function HistoricalDataSummary({ summary, type, onEditRollover, onExportCsv }) {
  const formatDate = (isoString) => {
    if (!isoString) return 'N/A';
    const dt = DateTime.fromISO(isoString, { zone: 'utc' }).setZone(summary.exchangeTimezone);
    return dt.toFormat('yyyy-MM-dd');
  };
  const hasData = summary && Object.values(summary.timeframes).some(tf => Object.keys(tf).length > 0);

  if (!hasData) {
    return <div className={styles.noSettings}><p>No historical data found for this symbol in the database.</p></div>;
  }

  return (
    <div className={styles.treeContainer}>
      <ul className={styles.tree}>
        {Object.entries(summary.timeframes).map(([timeframe, data]) => {
          if (Object.keys(data).length === 0) return null;
          return (
            <li key={timeframe} className={styles.treeNode}>
              <div className={styles.treeNodeLabel}>{timeframe}</div>
              <ul className={styles.treeNodeChildren}>
                {data.yahoo && (
                  <li className={styles.treeNode}>
                    <div className={styles.sourceBlock}>
                      <h5 className={styles.sourceHeader}>Yahoo Finance</h5>
                      <div className={styles.dataEntry}>
                        <span>Earliest</span>
                        <span>{formatDate(data.yahoo.earliest)}</span>
                      </div>
                      <div className={styles.dataEntry}>
                        <span>Latest</span>
                        <span>{formatDate(data.yahoo.latest)}</span>
                      </div>

                      {onExportCsv && (
                        <div className={styles.exportRow}>
                          <BubbleButton
                            color="#10B981"
                            onClick={() =>
                              onExportCsv({
                                timeframe,
                                source: 'YAHOO',
                                label: 'Yahoo',
                                isContinuous: false,
                                contractMonth: null,
                              })
                            }
                          >
                            Export to CSV
                          </BubbleButton>
                        </div>
                      )}
                    </div>
                  </li>
                )}
                {type === 'STK' && data.ibkr && (
                  <li className={styles.treeNode}>
                    <div className={styles.sourceBlock}>
                      <h5 className={styles.sourceHeader}>IBKR Stock</h5>
                      <div className={styles.dataEntry}>
                        <span>Earliest</span>
                        <span>{formatDate(data.ibkr.earliest)}</span>
                      </div>
                      <div className={styles.dataEntry}>
                        <span>Latest</span>
                        <span>{formatDate(data.ibkr.latest)}</span>
                      </div>

                      {onExportCsv && (
                        <div className={styles.exportRow}>
                          <BubbleButton
                            color="#10B981"
                            onClick={() =>
                              onExportCsv({
                                timeframe,
                                source: 'IBKR',
                                label: 'IBKR_Stock',
                                isContinuous: false,
                                contractMonth: null,
                              })
                            }
                          >
                            Export to CSV
                          </BubbleButton>
                        </div>
                      )}
                    </div>
                  </li>
                )}
                {type === 'FUT' && data.ibkrContracts && Object.keys(data.ibkrContracts).length > 0 && (
                  <li className={styles.treeNode}>
                    <div className={styles.sourceBlock}>
                      <h5 className={styles.sourceHeader}>IBKR (Individual Contracts)</h5>
                      <ul className={styles.treeNodeChildren}>
                        {data.ibkrContinuous && (
                          <li className={styles.treeNode}>
                            <div className={styles.sourceBlock}>
                              <h5 className={styles.sourceHeader}>
                                IBKR (Continuous Series)
                              </h5>
                              <div className={styles.dataEntry}><span>Earliest:</span> <span>{formatDate(data.ibkrContinuous.earliest)}</span></div>
                              <div className={styles.dataEntry}><span>Latest:</span> <span>{formatDate(data.ibkrContinuous.latest)}</span></div>
                              {data.ibkrContinuous.rollovers.length > 0 && (
                                <div className={styles.rolloverSection}>
                                  <h6 className={styles.rolloverTitle}>Rollover History</h6>
                                  <ul className={styles.rolloverList}>
                                    {data.ibkrContinuous.rollovers.map(r => (
                                      <li key={r.date} className={styles.rolloverItem}>
                                        <div className={styles.rolloverContracts}>
                                          <span className={styles.rolloverFrom}>{r.from}</span>
                                          <ArrowRightIcon />
                                          <span className={styles.rolloverTo}>{r.to}</span>
                                        </div>
                                        <span className={styles.rolloverDate}>{formatDate(r.date)}</span>
                                        {r.rollover_type && (
                                          <span className={`${styles.rolloverTypeTag} ${styles[r.rollover_type.toLowerCase()]}`}>
                                            {r.rollover_type.charAt(0).toUpperCase() + r.rollover_type.slice(1).toLowerCase()}
                                          </span>
                                        )}
                                        <div className={styles.rolloverActions}>
                                          <button onClick={() => onEditRollover(r)} className={styles.editRolloverBtn} title="Edit Rollover Date">
                                            <FaPencilAlt />
                                          </button>
                                        </div>
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}

                              {onExportCsv && (
                                <div className={styles.exportRow}>
                                  <BubbleButton
                                    color="#10B981"
                                    onClick={() =>
                                      onExportCsv({
                                        timeframe,
                                        source: 'IBKR',
                                        label: 'IBKR_Continuous',
                                        isContinuous: true,
                                        contractMonth: null,
                                      })
                                    }
                                  >
                                    Export to CSV
                                  </BubbleButton>
                                </div>
                              )}
                            </div>
                          </li>
                        )}
                        {Object.entries(data.ibkrContracts)
                          .sort((a, b) => a[0].localeCompare(b[0]))
                          .map(([month, cData]) => (
                            <li key={month} className={styles.treeNode}>
                              <div className={styles.contractData}>
                                <strong>{month}</strong>
                                <div className={styles.dataEntry}>
                                  <span>Earliest</span>
                                  <span>{formatDate(cData.earliest)}</span>
                                </div>
                                <div className={styles.dataEntry}>
                                  <span>Latest</span>
                                  <span>{formatDate(cData.latest)}</span>
                                </div>

                                {onExportCsv && (
                                  <div className={styles.exportRow}>
                                    <BubbleButton
                                      color="#10B981"
                                      onClick={() =>
                                        onExportCsv({
                                          timeframe,
                                          source: 'IBKR',
                                          label: `IBKR_${month}`,
                                          isContinuous: false,
                                          contractMonth: month,
                                        })
                                      }
                                    >
                                      Export to CSV
                                    </BubbleButton>
                                  </div>
                                )}
                              </div>
                            </li>
                          ))}
                      </ul>
                    </div>
                  </li>
                )}
              </ul>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default function Settings() {
  const { accounts, currentAccountId, setCurrentAccountId, setAccounts, futuresSettings, refreshFuturesSettings, tradesPerPage, setTradesPerPage, hiddenColumns, toggleColumnVisibility } = useContext(TradeContext);
  const { statusLogs } = useStatus();
  const [settings, setSettings] = useState({
    databaseUrl: '',
    port: '3999',
    ibkrAddresses: [
      { host: '', port: '7497' },
      { host: '', port: '7497' }
    ],
    ibkrFlexQueryIdActivity: '',
    ibkrFlexQueryIdTradeConf: ''
  });
  const [activeTab, setActiveTab] = useState('general');
  const [dbStatus, setDbStatus] = useState(null);
  const [apiBaseUrl, setApiBaseUrl] = useState(process.env.REACT_APP_API_URL);
  const [showFuturesModal, setShowFuturesModal] = useState(false);
  const [showExchangeModal, setShowExchangeModal] = useState(false);
  const [editingSetting, setEditingSetting] = useState(null);
  const [editingExchange, setEditingExchange] = useState(null);
  const [form, setForm] = useState({
    symbol: '',
    type: 'FUT',
    tickSize: '',
    tickValue: '',
    fee: '',
    exchange: '',
    rolloverMonths: '',
    initialMargin: '',
    timeframeSettings: DEFAULT_TIMEFRAME_SETTINGS,
  });

  const [exchangeForm, setExchangeForm] = useState({
    name: '',
    timezone: 'America/New_York',
    opening_hours: Array(7).fill().map(() => Array(48).fill(false))
  });
  const [exchanges, setExchanges] = useState([]);
  const [futuresAutoFillNote, setFuturesAutoFillNote] = useState('');
  const [exchangeAutoFillNote, setExchangeAutoFillNote] = useState('');
  const [newIbkrFlexToken, setNewIbkrFlexToken] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState(null);
  const [dragEnd, setDragEnd] = useState(null);

  const [serverLogs, setServerLogs] = useState('');
  const [logsLoading, setLogsLoading] = useState(false);
  const [logLines, setLogLines] = useState(200);

  const [timeframeLimits, setTimeframeLimits] = useState({});
  const [selectedHistoricalSymbol, setSelectedHistoricalSymbol] = useState('');
  const [historicalSummary, setHistoricalSummary] = useState(null);
  const [isLoadingSummary, setIsLoadingSummary] = useState(false);
  const [showRolloverModal, setShowRolloverModal] = useState(false);
  const [editingRollover, setEditingRollover] = useState(null);
  const [rolloverDate, setRolloverDate] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isFetchingSymbolHistoricalData, setIsFetchingSymbolHistoricalData] = useState(false);
  const [isFetchingAllHistoricalData, setIsFetchingAllHistoricalData] = useState(false);
  const [isRebuildingAllContinuous, setIsRebuildingAllContinuous] = useState(false);
  const [currentRebuildRequestId, setCurrentRebuildRequestId] = useState(null);
  const [queueStatus, setQueueStatus] = useState(null);
  const [historicalFetchStatus, setHistoricalFetchStatus] = useState('');

  const currentRebuildLogs = useMemo(() => {
    if (!currentRebuildRequestId) return [];
    return statusLogs.filter(log => log.requestId === currentRebuildRequestId);
  }, [statusLogs, currentRebuildRequestId]);

  // Poll the actual task queue rather than relying on WebSocket log matching —
  // fetch tasks are queued individually with their own ids, disconnected from
  // the batch id the populate-all/populate-symbol endpoints return, so a log
  // filtered by that batch id never shows real per-task progress. Polling
  // reflects live state directly and keeps working even after navigating away
  // from this tab and back.
  useEffect(() => {
    if (activeTab !== 'historical') return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`${apiBaseUrl}/api/historical/queue-status`, {
          headers: { 'X-Account-ID': currentAccountId },
        });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!cancelled) setQueueStatus(data);
      } catch {
        // Transient — next poll will retry.
      }
    };
    poll();
    const interval = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [activeTab, apiBaseUrl, currentAccountId]);

  const timezones = DateTime.now().zoneName ? [DateTime.now().zoneName, ...Intl.supportedValuesOf('timeZone').filter(tz => tz !== DateTime.now().zoneName)].sort() : Intl.supportedValuesOf('timeZone').sort();

  const fetchServerLogs = async (linesOverride) => {
    setLogsLoading(true);
    try {
      const linesToRequest = linesOverride || logLines;
      const res = await fetch(`${apiBaseUrl}/api/config/logs?lines=${linesToRequest}`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      setServerLogs(data.log || '');
    } catch (err) {
      console.error('Error fetching server logs:', err);
      setServerLogs(`Error fetching server logs: ${err.message}`);
    } finally {
      setLogsLoading(false);
    }
  };

  useEffect(() => {
    fetch(`${apiBaseUrl}/api/config/status`)
      .then(res => res.json())
      .then(data => {
        setDbStatus(data);
        setSettings(prev => ({
          ...prev,
          databaseUrl: data.databaseUrl || '',
          port: data.port ? String(data.port) : '3999',
          ibkrAddresses: data.ibkrAddresses || [
            { host: '', port: '7497' },
            { host: '', port: '7497' }
          ],
          ibkrFlexQueryIdActivity: data.ibkrFlexQueryIdActivity || '',
          ibkrFlexQueryIdTradeConf: data.ibkrFlexQueryIdTradeConf || ''
        }));
        if (process.env.NODE_ENV === 'development') {
          setApiBaseUrl(process.env.REACT_APP_API_URL);
        }
        if (!data.isConnected && !data.databaseUrl) {
          alert('Database not configured. Please set a valid database URL.');
        }
      })
      .catch(err => {
        console.error('Error fetching database status:', err);
        setDbStatus({ isConnected: false, status: 'Error fetching status' });
      });

    fetch(`${apiBaseUrl}/api/exchanges`, {
      headers: {
        'X-Account-ID': currentAccountId
      }
    })
      .then(res => {
        if (!res.ok) {
          throw new Error(`HTTP error! status: ${res.status}`);
        }
        return res.json();
      })
      .then(data => {
        setExchanges(Array.isArray(data) ? data : []);
      })
      .catch(err => {
        console.error('Error fetching exchanges:', err);
        setExchanges([]);
      });
  }, [apiBaseUrl, currentAccountId]);

  useEffect(() => {
    if (activeTab === 'logs') {
      fetchServerLogs();
    }
  }, [activeTab, apiBaseUrl, logLines]);

  const handleSettingChange = (e) => {
    const { name, value } = e.target;
    setSettings(prev => ({ ...prev, [name]: value }));
  };

  const handleIbkrAddressChange = (index, field, value) => {
    setSettings(prev => {
      const newIbkrAddresses = [...prev.ibkrAddresses];
      newIbkrAddresses[index] = { ...newIbkrAddresses[index], [field]: value };
      return { ...prev, ibkrAddresses: newIbkrAddresses };
    });
  };

  const handleSave = async () => {
    try {
      const body = {};
      if (settings.databaseUrl) {
        if (!settings.databaseUrl.startsWith('postgresql://')) {
          throw new Error('Invalid PostgreSQL URL format');
        }
        body.databaseUrl = settings.databaseUrl;
      }
      if (settings.port) {
        const portNum = parseInt(settings.port, 10);
        if (isNaN(portNum) || portNum < 1024 || portNum > 65535) {
          throw new Error('Port must be a number between 1024 and 65535');
        }
        body.port = portNum;
      }
      if (newIbkrFlexToken) {
        body.ibkrFlexToken = newIbkrFlexToken;
      }
      if (settings.ibkrFlexQueryIdActivity) {
        body.ibkrFlexQueryIdActivity = settings.ibkrFlexQueryIdActivity;
      }
      if (settings.ibkrFlexQueryIdTradeConf) {
        body.ibkrFlexQueryIdTradeConf = settings.ibkrFlexQueryIdTradeConf;
      }
      if (settings.ibkrAddresses) {
        body.ibkrAddresses = settings.ibkrAddresses.map(addr => ({
          host: addr.host || '',
          port: addr.port ? parseInt(addr.port, 10) : 7497
        }));
      }
      if (Object.keys(body).length === 0) {
        alert('No changes to save.');
        return;
      }
      const res = await fetch(`${apiBaseUrl}/api/config`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Account-ID': currentAccountId
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to update configuration');
      }
      const data = await res.json();
      alert(data.message || 'Configuration updated successfully');
      setNewIbkrFlexToken('');
      const statusRes = await fetch(`${apiBaseUrl}/api/config/status`);
      const statusData = await statusRes.json();
      setDbStatus(statusData);
      if (statusData.isConnected) {
        window.location.reload();
      }
    } catch (err) {
      alert('Error updating configuration: ' + err.message);
    }
  };

  const handleAddAccount = async () => {
    const name = prompt('Enter account name:');
    if (name) {
      try {
        // Step 1: POST to create the new account
        const createRes = await fetch(`${apiBaseUrl}/api/accounts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Account-ID': currentAccountId },
          body: JSON.stringify({ name }),
        });
        if (!createRes.ok) {
          const error = await createRes.json();
          throw new Error(error.error || 'Failed to create account');
        }

        // Step 2: GET the refreshed list of all accounts
        const refreshRes = await fetch(`${apiBaseUrl}/api/accounts`, {
          headers: { 'X-Account-ID': currentAccountId },
        });
        if (!refreshRes.ok) {
          throw new Error('Failed to refresh accounts list after adding.');
        }
        const refreshedAccounts = await refreshRes.json();
        setAccounts(refreshedAccounts);

      } catch (err) {
        alert('Error creating account: ' + err.message);
      }
    }
  };

  const handleEditAccount = async (id) => {
    const account = accounts.find(acc => acc.id === id);
    const newName = prompt('Enter new account name:', account.name);
    if (newName && newName !== account.name) {
      try {
        // Step 1: PUT to update the account
        const updateRes = await fetch(`${apiBaseUrl}/api/accounts/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-Account-ID': currentAccountId },
          body: JSON.stringify({ name: newName }),
        });
        if (!updateRes.ok) {
          const error = await updateRes.json();
          throw new Error(error.error || 'Failed to update account');
        }

        // Step 2: GET the refreshed list
        const refreshRes = await fetch(`${apiBaseUrl}/api/accounts`, {
          headers: { 'X-Account-ID': currentAccountId },
        });
        if (!refreshRes.ok) {
          throw new Error('Failed to refresh accounts list after editing.');
        }
        const refreshedAccounts = await refreshRes.json();
        setAccounts(refreshedAccounts);

      } catch (err) {
        alert('Error updating account: ' + err.message);
      }
    }
  };

  const handleDeleteAccount = async (id) => {
    if (accounts.length <= 1) {
      alert('Cannot delete the last account.');
      return;
    }
    if (window.confirm('Are you sure you want to delete this account? All associated data will be deleted.')) {
      try {
        // Step 1: DELETE the account
        const deleteRes = await fetch(`${apiBaseUrl}/api/accounts/${id}`, {
          method: 'DELETE',
          headers: { 'X-Account-ID': currentAccountId },
        });
        if (!deleteRes.ok) throw new Error('Failed to delete account');

        // Step 2: GET the refreshed list
        const refreshRes = await fetch(`${apiBaseUrl}/api/accounts`, {
          headers: { 'X-Account-ID': currentAccountId },
        });
        if (!refreshRes.ok) {
          throw new Error('Failed to refresh accounts list after deleting.');
        }
        const refreshedAccounts = await refreshRes.json();
        setAccounts(refreshedAccounts);

        // If we deleted the currently active account, switch to the first one in the new list
        if (id === parseInt(currentAccountId)) {
          setCurrentAccountId(refreshedAccounts[0].id);
        }
      } catch (err) {
        alert('Error deleting account: ' + err.message);
      }
    }
  };
  const openModalForEdit = (setting) => {
    setEditingSetting(setting);
    setFuturesAutoFillNote('');
    setForm({
      symbol: setting ? setting.symbol.toUpperCase() : '',
      type: setting && setting.type ? setting.type : 'FUT',
      tickSize: setting && setting.tick_size != null ? setting.tick_size.toString() : '',
      tickValue: setting && setting.tick_value != null ? setting.tick_value.toString() : '',
      fee: setting && setting.fee != null ? setting.fee.toString() : '',
      exchange: setting && setting.exchange != null ? setting.exchange : '',
      rolloverMonths: setting && setting.rollover_months ? setting.rollover_months.join(',') : '',
      initialMargin: setting && setting.initial_margin != null ? setting.initial_margin.toString() : '',
      timeframeSettings: setting && setting.timeframe_settings ? setting.timeframe_settings : DEFAULT_TIMEFRAME_SETTINGS,
    });
    setShowFuturesModal(true);

    // Provider lookback limits only exist for an already-saved symbol (the
    // endpoint looks up futures_settings by symbol/type); a brand new symbol
    // has nothing to show yet.
    setTimeframeLimits({});
    if (setting) {
      fetch(`${apiBaseUrl}/api/historical/limits?symbol=${encodeURIComponent(setting.symbol)}&type=${setting.type || 'FUT'}`)
        .then(res => (res.ok ? res.json() : null))
        .then(data => { if (data) setTimeframeLimits(data.timeframes); })
        .catch(() => {}); // Non-critical — the form just won't show the info line.
    }
  };

  const handleTimeframeToggle = (tf) => {
    setForm(prev => ({
      ...prev,
      timeframeSettings: {
        ...prev.timeframeSettings,
        [tf]: { ...prev.timeframeSettings[tf], enabled: !prev.timeframeSettings[tf].enabled },
      },
    }));
  };

  const openExchangeModal = (exchange = null) => {
    setEditingExchange(exchange);
    setExchangeAutoFillNote('');
    setExchangeForm({
      name: exchange ? exchange.name.toUpperCase() : '',
      timezone: exchange ? exchange.timezone : 'America/New_York',
      opening_hours: exchange ? exchange.opening_hours : Array(7).fill().map(() => Array(48).fill(false))
    });
    setShowExchangeModal(true);
  };

  const handleFuturesFormChange = (e) => {
    const { name, value } = e.target;
    if (name === 'symbol') {
      setForm(prev => ({ ...prev, [name]: value.toUpperCase() }));
    } else if (['tickSize', 'tickValue', 'fee', 'initialMargin'].includes(name)) {
      if (value === '' || /^\d*\.?\d*$/.test(value)) {
        setForm(prev => ({ ...prev, [name]: value }));
      }
    } else if (name === 'rolloverMonths') {
      // Allow empty input, digits, commas, and optional spaces during typing
      if (value === '' || /^[\d,\s]*$/.test(value)) {
        setForm(prev => ({ ...prev, [name]: value }));
      }
    } else {
      setForm(prev => ({ ...prev, [name]: value }));
    }
  };

  const handleExchangeFormChange = (e) => {
    const { name, value } = e.target;
    setExchangeForm(prev => ({
      ...prev,
      [name]: name === 'name' ? value.toUpperCase() : value
    }));
  };

  // Auto-fills timezone + the opening-hours grid for a recognized exchange
  // name (see src/data/marketReference.js) once the user finishes typing it.
  // Only applies when adding a brand new exchange — never overwrites an
  // existing one being edited, since that already holds real, possibly
  // hand-tuned data.
  const handleExchangeNameBlur = () => {
    if (editingExchange) return;
    const preset = findExchangePreset(exchangeForm.name);
    if (!preset) { setExchangeAutoFillNote(''); return; }
    setExchangeForm(prev => ({
      ...prev,
      timezone: preset.timezone,
      opening_hours: preset.opening_hours.map(day => [...day]),
    }));
    setExchangeAutoFillNote(`Auto-filled timezone and opening hours for a known "${exchangeForm.name}" schedule — edit the grid below if yours differs.`);
  };

  // Same idea for the Symbol field in the futures/stock setting form: a
  // recognized futures root symbol auto-fills tick size, tick value, and
  // rollover months (fixed, publicly documented CME Group contract specs).
  // Margin is filled too, but only as an editable starting estimate — it's
  // explicitly not treated as authoritative (see marketReference.js).
  const handleSymbolBlur = () => {
    if (editingSetting) return;
    const preset = findFuturesPreset(form.symbol);
    if (!preset) { setFuturesAutoFillNote(''); return; }
    const exchangeConfigured = exchanges.some(e => e.name.toUpperCase() === preset.exchange);
    setForm(prev => ({
      ...prev,
      type: 'FUT',
      tickSize: String(preset.tickSize),
      tickValue: String(preset.tickValue),
      rolloverMonths: preset.rolloverMonths.join(','),
      exchange: exchangeConfigured ? preset.exchange : prev.exchange,
      initialMargin: prev.initialMargin || String(preset.typicalMargin),
    }));
    setFuturesAutoFillNote(
      `Auto-filled from known ${preset.name} contract specs (tick size/value, rollover months). Margin is a typical estimate — verify with your broker.` +
      (exchangeConfigured ? '' : ` You don't have a "${preset.exchange}" exchange configured yet — add one before saving.`)
    );
  };

  const toggleOpeningHour = (day, slot) => {
    setExchangeForm(prev => {
      const newOpeningHours = prev.opening_hours.map((d, i) =>
        i === day ? d.map((h, j) => (j === slot ? !h : h)) : d
      );
      return { ...prev, opening_hours: newOpeningHours };
    });
  };

  const handleDragStart = (day, slot) => {
    setIsDragging(true);
    setDragStart({ day, slot });
    setDragEnd({ day, slot });
  };

  const handleDragMove = (day, slot) => {
    if (isDragging) {
      setDragEnd({ day, slot });
    }
  };

  const handleDragEnd = () => {
    if (isDragging && dragStart && dragEnd) {
      setExchangeForm(prev => {
        const newOpeningHours = prev.opening_hours.map((daySlots, dayIndex) =>
          daySlots.map((slotValue, slotIndex) => {
            const minDay = Math.min(dragStart.day, dragEnd.day);
            const maxDay = Math.max(dragStart.day, dragEnd.day);
            const minSlot = Math.min(dragStart.slot, dragEnd.slot);
            const maxSlot = Math.max(dragStart.slot, dragEnd.slot);
            if (dayIndex >= minDay && dayIndex <= maxDay && slotIndex >= minSlot && slotIndex <= maxSlot) {
              return !prev.opening_hours[dragStart.day][dragStart.slot];
            }
            return slotValue;
          })
        );
        return { ...prev, opening_hours: newOpeningHours };
      });
    }
    setIsDragging(false);
    setDragStart(null);
    setDragEnd(null);
  };

  const isCellSelected = (day, slot) => {
    if (!isDragging || !dragStart || !dragEnd) return false;
    const minDay = Math.min(dragStart.day, dragEnd.day);
    const maxDay = Math.max(dragStart.day, dragEnd.day);
    const minSlot = Math.min(dragStart.slot, dragEnd.slot);
    const maxSlot = Math.max(dragStart.slot, dragEnd.slot);
    return day >= minDay && day <= maxDay && slot >= minSlot && slot <= maxSlot;
  };

  useEffect(() => {
    const handleGlobalMouseUp = () => {
      setIsDragging(false);
      setDragStart(null);
      setDragEnd(null);
    };
    if (isDragging) {
      window.addEventListener('mouseup', handleGlobalMouseUp);
    }
    return () => {
      window.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, [isDragging]);

  const saveFuturesSetting = async () => {
    const { symbol, type, tickSize, tickValue, fee, exchange, rolloverMonths, initialMargin, timeframeSettings } = form;

    if (!symbol || !type || !fee) {
      alert('Symbol, type, and fee are required.');
      return;
    }

    if (type === 'FUT' && (!tickSize || !tickValue || !rolloverMonths || !initialMargin)) {
      alert('Tick size, tick value, rollover months, and initial margin are required for Futures.');
      return;
    }
    if (type === 'FUT' && parseFloat(initialMargin) <= 0) {
      alert('Initial margin must be a positive number.');
      return;
    }
    const normalizedTimeframeSettings = {};
    for (const tf of TIMEFRAME_ORDER) {
      const entry = timeframeSettings?.[tf] || DEFAULT_TIMEFRAME_SETTINGS[tf];
      normalizedTimeframeSettings[tf] = { enabled: !!entry.enabled };
    }
    if (!Object.values(normalizedTimeframeSettings).some(t => t.enabled)) {
      alert('At least one timeframe must be enabled.');
      return;
    }
    try {
      const method = editingSetting ? 'PUT' : 'POST';
      const url = `${apiBaseUrl}/api/futures-settings`;
      let rolloverMonthsArray = null;
      if (type === 'FUT') {
        // Split by commas, trim spaces, and convert to integers
        rolloverMonthsArray = rolloverMonths
          .split(',')
          .map(m => parseInt(m.trim(), 10))
          .filter(m => !isNaN(m));
        // Validate the array
        if (rolloverMonthsArray.length === 0) {
          throw new Error('Rollover months must contain at least one valid month.');
        }
        if (rolloverMonthsArray.some(m => m < 1 || m > 12)) {
          throw new Error('Rollover months must be integers between 1 and 12.');
        }
        // Remove duplicates and sort
        rolloverMonthsArray = [...new Set(rolloverMonthsArray)].sort((a, b) => a - b);
      }
      const payload = {
        symbol,
        type,
        tick_size: type === 'STK' ? 0.01 : parseFloat(tickSize),
        tick_value: type === 'STK' ? 0.01 : parseFloat(tickValue),
        fee: parseFloat(fee),
        exchange: exchange || null,
        rollover_months: rolloverMonthsArray,
        initial_margin: type === 'FUT' ? parseFloat(initialMargin) : null,
        timeframe_settings: normalizedTimeframeSettings,
        ...(editingSetting && { originalSymbol: editingSetting.symbol }),
        ...(editingSetting && { originalType: editingSetting.type }),
      };
      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Account-ID': currentAccountId
        },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to save symbol setting');
      }
      await refreshFuturesSettings();
      setShowFuturesModal(false);
      setForm({
        symbol: '',
        type: 'FUT',
        tickSize: '',
        tickValue: '',
        fee: '',
        exchange: '',
        rolloverMonths: '',
        initialMargin: '',
        timeframeSettings: DEFAULT_TIMEFRAME_SETTINGS,
      });
    } catch (err) {
      alert('Error saving symbol setting: ' + err.message);
    }
  };

  const saveExchange = async () => {
    const { name, timezone, opening_hours } = exchangeForm;
    if (!name || !timezone || !opening_hours) {
      alert('Name, timezone, and opening hours are required.');
      return;
    }
    if (!currentAccountId) {
      alert('No account selected. Please select an account.');
      return;
    }
    try {
      const method = editingExchange ? 'PUT' : 'POST';
      const url = editingExchange ? `${apiBaseUrl}/api/exchanges/${editingExchange.id}` : `${apiBaseUrl}/api/exchanges`;
      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Account-ID': currentAccountId
        },
        body: JSON.stringify({ name: name.toUpperCase(), timezone, opening_hours })
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to save exchange');
      }
      const data = await fetch(`${apiBaseUrl}/api/exchanges`, {
        headers: { 'X-Account-ID': currentAccountId }
      }).then(res => res.json());
      setExchanges(Array.isArray(data) ? data : []);
      setShowExchangeModal(false);
      setExchangeForm({
        name: '',
        timezone: 'America/New_York',
        opening_hours: Array(7).fill().map(() => Array(48).fill(false))
      });
    } catch (err) {
      alert('Error saving exchange: ' + err.message);
    }
  };

  const handleDeleteSymbol = async (symbol, type) => {
    if (window.confirm(`Are you sure you want to delete the settings for ${symbol}?`)) {
      try {
        const res = await fetch(`${apiBaseUrl}/api/futures-settings?symbol=${symbol}&type=${type}`, {
          method: 'DELETE',
          headers: { 'X-Account-ID': currentAccountId },
        });
        if (!res.ok) {
          const error = await res.json();
          throw new Error(error.error || 'Failed to delete symbol setting');
        }
      } catch (err) {
        alert('Error deleting symbol setting: ' + err.message);
      }
      await refreshFuturesSettings();
    }
  };

  const handleDeleteHistoricalData = async () => {
    if (!selectedHistoricalSymbol) return;
    const [symbol, type] = selectedHistoricalSymbol.split('-');
    if (window.confirm(`Are you sure you want to delete all historical data for ${symbol} (${type})? This action cannot be undone.`)) {
      try {
        const res = await fetch(`${apiBaseUrl}/api/historical-data?symbol=${symbol}&type=${type}`, {
          method: 'DELETE',
          headers: { 'X-Account-ID': currentAccountId },
        });
        if (!res.ok) {
          const error = await res.json();
          throw new Error(error.error || 'Failed to delete historical data');
        }
        alert('Historical data deleted successfully');
        await refreshHistoricalSummary();
      } catch (err) {
        alert('Error deleting historical data: ' + err.message);
      }
    }
  };

  const handleDeleteExchange = async (id) => {
    if (window.confirm(`Are you sure you want to delete the exchange?`)) {
      try {
        const res = await fetch(`${apiBaseUrl}/api/exchanges/${id}`, {
          method: 'DELETE',
          headers: { 'X-Account-ID': currentAccountId },
        });
        if (!res.ok) {
          const error = await res.json();
          throw new Error(error.error || 'Failed to delete exchange');
        }
        const data = await fetch(`${apiBaseUrl}/api/exchanges`, {
          headers: { 'X-Account-ID': currentAccountId }
        }).then(res => res.json());
        setExchanges(Array.isArray(data) ? data : []);
      } catch (err) {
        alert('Error deleting exchange: ' + err.message);
      }
    }
  };

  const slotToTime = (slot) => {
    const hour = Math.floor(slot / 2);
    const minute = slot % 2 === 0 ? '00' : '30';
    return `${hour.toString().padStart(2, '0')}:${minute}`;
  };

  // Define exchange options for the dropdown
  const exchangeOptions = [
    { id: null, name: 'Select Exchange' },
    ...exchanges
  ];

  // Ensure futuresSettings is an array before filtering
  const safeFuturesSettings = Array.isArray(futuresSettings) ? futuresSettings : [];

  const defaultSettings = safeFuturesSettings
    .filter(s => s.symbol === 'DEFAULT')
    .sort((a, b) => a.type.localeCompare(b.type));

  const specificSettingsSorted = safeFuturesSettings
    .filter(s => s.symbol !== 'DEFAULT')
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

  const stkSymbols = specificSettingsSorted.filter(s => s.type === 'STK');
  const futSymbols = specificSettingsSorted.filter(s => s.type === 'FUT');

  const historicalSymbols = useMemo(() => {
    const uniqueSymbols = new Map();
    if (Array.isArray(futuresSettings)) {
      futuresSettings.forEach(s => {
        if (s.symbol === 'DEFAULT') return;
        const key = `${s.symbol}-${s.type}`;
        if (!uniqueSymbols.has(key)) {
          uniqueSymbols.set(key, { symbol: s.symbol, type: s.type });
        }
      });
    }
    return Array.from(uniqueSymbols.values()).sort((a, b) => a.symbol.localeCompare(b.symbol));
  }, [futuresSettings]);

  const handleHistoricalSymbolChange = (e) => {
    const value = e.target.value;
    setSelectedHistoricalSymbol(value);
    setHistoricalFetchStatus('');
    if (!value) {
      setHistoricalSummary(null);
    }
  };

  useEffect(() => {
    if (!selectedHistoricalSymbol || activeTab !== 'historical') return;

    const fetchHistoricalSummary = async () => {
      setIsLoadingSummary(true);
      setHistoricalSummary(null);
      const [symbol, type] = selectedHistoricalSymbol.split('-');
      try {
        const res = await fetch(`${apiBaseUrl}/api/historical/summary?symbol=${symbol}&type=${type}`, {
          headers: { 'X-Account-ID': currentAccountId }
        });
        if (!res.ok) {
          const errorData = await res.json();
          throw new Error(errorData.error || `Failed to fetch summary for ${symbol}`);
        }
        const data = await res.json();
        setHistoricalSummary(data);
      } catch (err) {
        console.error(err);
        alert(`Error: ${err.message}`);
        setHistoricalSummary(null);
      } finally {
        setIsLoadingSummary(false);
      }
    };

    fetchHistoricalSummary();
  }, [selectedHistoricalSymbol, activeTab, apiBaseUrl, currentAccountId]);

  const handleEditRollover = (rollover) => {
    setEditingRollover(rollover);
    setRolloverDate(DateTime.fromISO(rollover.date).toFormat('yyyy-MM-dd'));
    setShowRolloverModal(true);
  };

  const handleCloseRolloverModal = () => {
    setShowRolloverModal(false);
    setEditingRollover(null);
    setRolloverDate('');
  };

  const refreshHistoricalSummary = async () => {
    if (!selectedHistoricalSymbol) return;

    setIsLoadingSummary(true);
    setHistoricalSummary(null);
    const [symbol, type] = selectedHistoricalSymbol.split('-');
    try {
      const res = await fetch(`${apiBaseUrl}/api/historical/summary?symbol=${symbol}&type=${type}`);
      if (!res.ok) throw new Error('Failed to refresh summary');
      const data = await res.json();
      setHistoricalSummary(data);
    } catch (err) {
      console.error(err);
      alert(`Error refreshing summary: ${err.message}`);
    } finally {
      setIsLoadingSummary(false);
    }
  };

  const handleSaveRollover = async () => {
    if (!editingRollover || !rolloverDate) return;
    setIsSaving(true);
    const [symbol, type] = selectedHistoricalSymbol.split('-');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 seconds

    try {
      const res = await fetch(`${apiBaseUrl}/api/historical/rollover-override`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol,
          type,
          from_contract_month: editingRollover.from,
          to_contract_month: editingRollover.to,
          override_date: rolloverDate,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to save override');
      }
      alert('Rollover override saved. The continuous series is rebuilt.');
      handleCloseRolloverModal();
      await refreshHistoricalSummary();
    } catch (err) {
      if (err.name === 'AbortError') {
        alert('Save operation timed out. The rebuild might still be in progress. Please check back later.');
      } else {
        alert(`Error saving rollover: ${err.message}`);
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleFetchSymbolHistoricalData = async () => {
    if (!selectedHistoricalSymbol) return;
    const [symbol, type] = selectedHistoricalSymbol.split('-');

    // Indicate to the user that the action is in progress
    setHistoricalFetchStatus(`Queuing fetch tasks for ${symbol} (${type})...`);
    setIsFetchingSymbolHistoricalData(true);

    try {
      if (!window.confirm(`Are you sure you want to queue data fetching tasks for ${symbol} (${type}) for all timeframes? This may take some time.`)) {
        setHistoricalFetchStatus('');
        return;
      }

      const res = await fetch(`${apiBaseUrl}/api/historical-data/populate-symbol`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Account-ID': currentAccountId
        },
        body: JSON.stringify({ symbol, type })
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to start fetch process for symbol');
      }
      const result = await res.json();
      setHistoricalFetchStatus(result.message || `Successfully queued fetching tasks for ${symbol}. Check the fetch queue below for progress.`);
      alert(result.message || `Successfully queued fetching tasks for ${symbol}. Check the fetch queue below for progress.`);
    } catch (err) {
      setHistoricalFetchStatus(`Error: ${err.message}`);
      alert('Error: ' + err.message);
    } finally {
      setIsFetchingSymbolHistoricalData(false);
    }
  };

  const handleDeleteRolloverOverride = async () => {
    if (!editingRollover || !editingRollover.rollover_type === 'MANUAL') {
      alert('This is not a manual override and cannot be deleted.');
      return;
    }
    if (!window.confirm('Are you sure you want to delete this manual override? The system will revert to volume-based rollover for this date.')) return;

    setIsDeleting(true); // Set deleting state
    const [symbol, type] = selectedHistoricalSymbol.split('-');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 seconds timeout

    try {
      const res = await fetch(`${apiBaseUrl}/api/historical/rollover-override`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol,
          type,
          from_contract_month: editingRollover.from,
          to_contract_month: editingRollover.to,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to delete override');
      }
      alert('Override deleted. The continuous series is rebuilt.');
      handleCloseRolloverModal();
      await refreshHistoricalSummary();
    } catch (err) {
      if (err.name === 'AbortError') {
        alert('Delete operation timed out. The rebuild might still be in progress. Please check back later.');
      } else {
        alert(`Error deleting override: ${err.message}`);
      }
    } finally {
      setIsDeleting(false); // Reset deleting state
    }
  };

  const handleFetchAllHistoricalData = async () => {
    // Indicate to the user that the action is in progress
    setHistoricalFetchStatus('Queuing fetch tasks for all symbols...');
    setIsFetchingAllHistoricalData(true);

    try {
      if (!window.confirm('Are you sure you want to queue data fetching tasks for all configured symbols? This may take a long time and consume API resources.')) {
        setHistoricalFetchStatus('');
        return;
      }

      const res = await fetch(`${apiBaseUrl}/api/historical-data/populate-all`, {
        method: 'POST',
        headers: { 'X-Account-ID': currentAccountId },
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to start fetch process');
      }
      const result = await res.json();
      setHistoricalFetchStatus(result.message || 'Successfully queued all fetching tasks. Check the fetch queue below for progress.');
      alert(result.message || 'Successfully queued all fetching tasks. Check the fetch queue below for progress.');
    } catch (err) {
      setHistoricalFetchStatus(`Error: ${err.message}`);
      alert('Error: ' + err.message);
    } finally {
      setIsFetchingAllHistoricalData(false);
    }
  };

  const handleDeleteAllHistoricalData = async () => {
    if (window.confirm('DANGER: Are you sure you want to delete ALL historical data from the database? This action cannot be undone.')) {
      try {
        const res = await fetch(`${apiBaseUrl}/api/historical-data/all`, {
          method: 'DELETE',
          headers: { 'X-Account-ID': currentAccountId },
        });
        if (!res.ok) {
          const error = await res.json();
          throw new Error(error.error || 'Failed to delete historical data');
        }
        alert('All historical data has been deleted.');
        // Refresh the summary if a symbol is selected, which will now show as empty
        if (selectedHistoricalSymbol) {
          refreshHistoricalSummary();
        }
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }
  };

  const handleRebuildAllContinuousData = async () => {
    if (!window.confirm('Rebuild the continuous series for every futures symbol? This scans each symbol\'s full history and can take a while — progress is reported via the status log.')) {
      return;
    }
    setIsRebuildingAllContinuous(true);
    setCurrentRebuildRequestId(null);
    try {
      const res = await fetch(`${apiBaseUrl}/api/historical/rebuild-continuous-all`, {
        method: 'POST',
        headers: { 'X-Account-ID': currentAccountId },
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to start continuous series rebuild');
      }
      const result = await res.json();
      setCurrentRebuildRequestId(result.requestId || null);
      alert(result.message || 'Continuous series rebuild started for all symbols.');
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      setIsRebuildingAllContinuous(false);
    }
  };

  const handleRecalculateContinuous = async (timeframe) => {
    if (!selectedHistoricalSymbol) return;
    const [symbol, type] = selectedHistoricalSymbol.split('-');
    alert(`Continuous series rebuild initiated for ${symbol} (${type}). The summary will refresh automatically upon completion.`);

    try {
      const res = await fetch(`${apiBaseUrl}/api/historical/rebuild-continuous`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Account-ID': currentAccountId
        },
        body: JSON.stringify({ symbol, type })
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to initiate rebuild');
      }
      await refreshHistoricalSummary();
    } catch (err) {
      alert('Error initiating rebuild: ' + err.message);
    }
  };

  const handleExportCsv = async ({
  timeframe,
  source,
  label,
  isContinuous,
  contractMonth,
}) => {
  if (!selectedHistoricalSymbol) {
    alert('Please select a symbol first.');
    return;
  }

  const [symbol, type] = selectedHistoricalSymbol.split('-');
  if (!symbol || !type) {
    alert('Invalid selected symbol/type.');
    return;
  }

  try {
    const params = new URLSearchParams();
    params.set('symbol', symbol);
    params.set('type', type);
    params.set('timeframe', timeframe);

    // For individual contracts, request the specific contractMonth
    if (contractMonth) {
      params.set('contractMonth', contractMonth);
    }

    const url = `${apiBaseUrl}/api/historical/db?${params.toString()}`;

    const res = await fetch(url, {
      headers: {
        'X-Account-ID': currentAccountId,
      },
    });

    const data = await res.json();

    if (!res.ok) {
      const msg = data?.error || data?.message || `HTTP ${res.status}`;
      throw new Error(msg);
    }

    if (!Array.isArray(data) || data.length === 0) {
      alert('No historical data available for this selection.');
      return;
    }

    // Filter by source (Yahoo vs IBKR), matching DB `source` field
    const filtered = data.filter(
      (bar) =>
        typeof bar.source === 'string' &&
        bar.source.toUpperCase() === source.toUpperCase()
    );

    if (filtered.length === 0) {
      alert(`No ${source} data found for this selection.`);
      return;
    }

    // For continuous futures (IBKR Continuous Series), back-adjust prices
    let barsToExport = filtered;

    if (type.toUpperCase() === 'FUT' && isContinuous) {
      barsToExport = getBackAdjustedBars(filtered);
    } else {
      // Ensure ascending order by time for non-continuous
      barsToExport = [...filtered].sort(
        (a, b) =>
          DateTime.fromISO(a.time).toMillis() -
          DateTime.fromISO(b.time).toMillis()
      );
    }

    // Build CSV
    const header = [
      'time',
      'open',
      'high',
      'low',
      'close',
      'volume',
      'source',
      'contractMonth',
      'isRollover',
    ];

    const lines = [header.join(',')];

    for (const bar of barsToExport) {
      lines.push(
        [
          bar.time,
          bar.open,
          bar.high,
          bar.low,
          bar.close,
          bar.volume != null ? bar.volume : '',
          bar.source || '',
          bar.contractMonth || '',
          bar.isRollover ? '1' : '0',
        ].join(',')
      );
    }

    const csvContent = lines.join('\n');
    const blob = new Blob([csvContent], {
      type: 'text/csv;charset=utf-8;',
    });

    const safeSymbol = symbol.replace(/[^A-Za-z0-9]/g, '');
    const safeTf = timeframe.replace(/[^A-Za-z0-9]/g, '');
    const safeLabel = (label || source || 'data').replace(/[^A-Za-z0-9]/g, '');
    const fileName = `${safeSymbol}_${type}_${safeTf}_${safeLabel}.csv`;

    const urlObject = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = urlObject;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(urlObject);
  } catch (err) {
    console.error('Error exporting CSV:', err);
    alert(`Error exporting CSV: ${err.message}`);
  }
};

  useEffect(() => {
    if (!selectedHistoricalSymbol || activeTab !== 'historical') return;
    refreshHistoricalSummary();
  }, [selectedHistoricalSymbol, activeTab, apiBaseUrl]);

  return (
    <div className={styles.settings}>
      <div
        className={styles.tabsRow}
        style={{
          visibility: showFuturesModal || showExchangeModal ? 'hidden' : 'visible',
        }}
      >
        <button
          className={`${styles.tabButton} ${activeTab === 'general' ? styles.activeTab : ''} ${!dbStatus?.isConnected && activeTab !== 'general' ? styles.disabledTab : ''}`}
          onClick={() => setActiveTab('general')}
        >
          General
        </button>
        <button
          className={`${styles.tabButton} ${activeTab === 'logs' ? styles.activeTab : ''}`}
          onClick={() => setActiveTab('logs')}
        >
          Server Logs
        </button>
        <button
          className={`${styles.tabButton} ${activeTab === 'accounts' ? styles.activeTab : ''} ${!dbStatus?.isConnected ? styles.disabledTab : ''}`}
          onClick={() => setActiveTab('accounts')}
          disabled={!dbStatus?.isConnected}
        >
          Accounts
        </button>
        <button
          className={`${styles.tabButton} ${activeTab === 'tws' ? styles.activeTab : ''} ${!dbStatus?.isConnected ? styles.disabledTab : ''}`}
          onClick={() => setActiveTab('tws')}
          disabled={!dbStatus?.isConnected}
        >
          IBKR API
        </button>
        <button
          className={`${styles.tabButton} ${activeTab === 'exchanges' ? styles.activeTab : ''} ${!dbStatus?.isConnected ? styles.disabledTab : ''}`}
          onClick={() => setActiveTab('exchanges')}
          disabled={!dbStatus?.isConnected}
        >
          Exchanges
        </button>
        <button
          className={`${styles.tabButton} ${activeTab === 'symbols' ? styles.activeTab : ''} ${!dbStatus?.isConnected ? styles.disabledTab : ''}`}
          onClick={() => setActiveTab('symbols')}
          disabled={!dbStatus?.isConnected}
        >
          Symbols
        </button>
        <button
          className={`${styles.tabButton} ${activeTab === 'historical' ? styles.activeTab : ''} ${!dbStatus?.isConnected ? styles.disabledTab : ''}`}
          onClick={() => setActiveTab('historical')}
          disabled={!dbStatus?.isConnected}
        >
          Historical Data
        </button>
      </div>
      <div className={styles.tabContent}>
        {activeTab === 'general' && (
          <div className={styles.formGrid}>
            <div className={styles.formField}>
              <label htmlFor="databaseUrl">Database URL</label>
              <input
                id="databaseUrl"
                name="databaseUrl"
                value={settings.databaseUrl}
                onChange={handleSettingChange}
                className={styles.inputBubble}
                autoComplete="off"
                placeholder="postgresql://user:password@host:port/dbname"
              />
              {dbStatus && (
                <span style={{ color: dbStatus.isConnected ? 'green' : 'red', fontSize: '0.9em' }}>
                  {dbStatus.status}
                </span>
              )}
            </div>
            <div className={styles.formField}>
              <label htmlFor="tradesPerPage">Trades Per Page</label>
              <select
                id="tradesPerPage"
                value={tradesPerPage === null ? 'unlimited' : tradesPerPage}
                onChange={(e) => {
                  const value = e.target.value === 'unlimited' ? null : parseInt(e.target.value);
                  setTradesPerPage(value);
                }}
                className={styles.inputBubble}
              >
                <option value={10}>10 trades</option>
                <option value={25}>25 trades</option>
                <option value={50}>50 trades</option>
                <option value={100}>100 trades</option>
                <option value={200}>200 trades</option>
                <option value={500}>500 trades</option>
                <option value="unlimited">No limit</option>
              </select>
            </div>
            <div className={styles.formField} style={{ gridColumn: '1 / -1' }}>
              <label>Trade List Columns</label>
              <p style={{ margin: '0 0 8px', fontSize: '0.85rem', opacity: 0.8 }}>
                Choose which columns to show in the trade list for this account (e.g. hide Entry/Exit Total for a futures-only account).
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px 20px' }}>
                {TRADE_LIST_COLUMNS.map(col => (
                  <label key={col.key} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 'normal', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={!hiddenColumns.includes(col.key)}
                      onChange={() => toggleColumnVisibility(col.key)}
                    />
                    {col.label}
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}
        {activeTab === 'logs' && (
          <div className={styles.logsTab}>
            <div className={styles.logsControls}>
              <label>
                Lines:
                <input
                  type="number"
                  min={10}
                  max={2000}
                  value={logLines}
                  onChange={(e) => setLogLines(parseInt(e.target.value, 10) || 200)}
                  className={styles.inputBubble}
                  style={{ width: 90, marginLeft: 8 }}
                />
              </label>
              <button
                className={styles.saveBtn}
                onClick={() => fetchServerLogs()}
                disabled={logsLoading}
              >
                {logsLoading ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
            <textarea
              className={styles.logOutput}
              value={serverLogs}
              readOnly
              rows={20}
            />
          </div>
        )}
        {activeTab === 'accounts' && dbStatus?.isConnected && (
          <div className={styles.accountsTab}>
            <div style={{marginBottom: '16px', display: 'flex', justifyContent: 'flex-start'}}>
              <BubbleButton onClick={handleAddAccount}>Add New Account</BubbleButton>
            </div>
            <h3>Accounts</h3>
            <div style={{overflowX: 'auto'}}>
              <table style={{width: '100%', borderCollapse: 'collapse', background: '#232837', border: '1px solid #32384a', borderRadius: '7px', overflow: 'hidden'}}>
                <thead>
                  <tr style={{background: '#353943'}}>
                    <th style={{padding: '12px', textAlign: 'left', color: '#e0e2e6', fontWeight: '600', borderBottom: '1px solid #32384a'}}>Name</th>
                    <th style={{padding: '12px', textAlign: 'left', color: '#e0e2e6', fontWeight: '600', borderBottom: '1px solid #32384a'}}>Status</th>
                    <th style={{padding: '12px', textAlign: 'center', color: '#e0e2e6', fontWeight: '600', borderBottom: '1px solid #32384a'}}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {[...accounts].sort((a, b) => a.name.localeCompare(b.name)).map((acc, index) => (
                    <tr key={acc.id} style={{background: index % 2 === 0 ? '#232837' : '#2a2f3a', borderBottom: '1px solid #32384a'}}>
                      <td style={{padding: '12px', color: '#00ebff', fontWeight: '500'}}>{acc.name}</td>
                      <td style={{padding: '12px', color: '#e0e2e6'}}>{acc.id === parseInt(currentAccountId) ? 'Current' : ''}</td>
                      <td style={{padding: '12px', textAlign: 'center'}}>
                        <button className={styles.actionBtn} onClick={() => handleEditAccount(acc.id)} style={{marginRight: '8px'}}>Edit</button>
                        <button className={styles.actionBtn} onClick={() => handleDeleteAccount(acc.id)}>Delete</button>
                      </td>
                    </tr>
                  ))}
                  {accounts.length === 0 && (
                    <tr>
                      <td colSpan="3" style={{padding: '12px', textAlign: 'center', color: '#e0e2e6'}}>No accounts configured</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {activeTab === 'symbols' && dbStatus?.isConnected && (
          <div className={styles.futuresTab}>
            <div style={{marginBottom: '16px', display: 'flex', justifyContent: 'flex-start'}}>
              <BubbleButton onClick={() => openModalForEdit(null)}>Add Symbol</BubbleButton>
            </div>
            <h3>Default Settings</h3>
            <div style={{overflowX: 'auto'}}>
              <table style={{width: '100%', borderCollapse: 'collapse', background: '#232837', border: '1px solid #32384a', borderRadius: '7px', overflow: 'hidden'}}>
                <thead>
                  <tr style={{background: '#353943'}}>
                    <th style={{padding: '12px', textAlign: 'left', color: '#e0e2e6', fontWeight: '600', borderBottom: '1px solid #32384a'}}>Symbol</th>
                    <th style={{padding: '12px', textAlign: 'left', color: '#e0e2e6', fontWeight: '600', borderBottom: '1px solid #32384a'}}>Type</th>
                    <th style={{padding: '12px', textAlign: 'left', color: '#e0e2e6', fontWeight: '600', borderBottom: '1px solid #32384a'}}>Tick Size</th>
                    <th style={{padding: '12px', textAlign: 'left', color: '#e0e2e6', fontWeight: '600', borderBottom: '1px solid #32384a'}}>Tick Value</th>
                    <th style={{padding: '12px', textAlign: 'left', color: '#e0e2e6', fontWeight: '600', borderBottom: '1px solid #32384a'}}>Rollover Months</th>
                    <th style={{padding: '12px', textAlign: 'left', color: '#e0e2e6', fontWeight: '600', borderBottom: '1px solid #32384a'}}>Initial Margin</th>
                    <th style={{padding: '12px', textAlign: 'left', color: '#e0e2e6', fontWeight: '600', borderBottom: '1px solid #32384a'}}>Fee</th>
                    <th style={{padding: '12px', textAlign: 'left', color: '#e0e2e6', fontWeight: '600', borderBottom: '1px solid #32384a'}}>Exchange</th>
                    <th style={{padding: '12px', textAlign: 'center', color: '#e0e2e6', fontWeight: '600', borderBottom: '1px solid #32384a'}}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {defaultSettings.map((setting, index) => (
                    <tr key={setting.type} style={{background: index % 2 === 0 ? '#232837' : '#2a2f3a', borderBottom: '1px solid #32384a'}}>
                      <td style={{padding: '12px', color: '#00ebff', fontWeight: '500'}}>{setting.symbol}</td>
                      <td style={{padding: '12px', color: '#e0e2e6'}}>{setting.type}</td>
                      <td style={{padding: '12px', color: '#e0e2e6'}}>{setting.type === 'FUT' ? setting.tick_size : '-'}</td>
                      <td style={{padding: '12px', color: '#e0e2e6'}}>{setting.type === 'FUT' ? setting.tick_value : '-'}</td>
                      <td style={{padding: '12px', color: '#e0e2e6'}}>{setting.type === 'FUT' ? setting.rollover_months.join(', ') : '-'}</td>
                      <td style={{padding: '12px', color: '#e0e2e6'}}>{setting.type === 'FUT' ? setting.initial_margin : '-'}</td>
                      <td style={{padding: '12px', color: '#e0e2e6'}}>{setting.fee}</td>
                      <td style={{padding: '12px', color: '#e0e2e6'}}>{setting.exchange || 'N/A'}</td>
                      <td style={{padding: '12px', textAlign: 'center'}}>
                        <button className={styles.actionBtn} onClick={() => openModalForEdit(setting)}>Edit</button>
                      </td>
                    </tr>
                  ))}
                  {defaultSettings.length === 0 && (
                    <tr>
                      <td colSpan="9" style={{padding: '12px', textAlign: 'center', color: '#e0e2e6'}}>
                        No default settings set
                        <div style={{marginTop: '8px'}}>
                          <BubbleButton onClick={() => openModalForEdit({ symbol: 'DEFAULT' })}>Add Default Setting</BubbleButton>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <h3>Stock Symbols</h3>
            <div style={{overflowX: 'auto'}}>
              <table style={{width: '100%', borderCollapse: 'collapse', background: '#232837', border: '1px solid #32384a', borderRadius: '7px', overflow: 'hidden'}}>
                <thead>
                  <tr style={{background: '#353943'}}>
                    <th style={{padding: '12px', textAlign: 'left', color: '#e0e2e6', fontWeight: '600', borderBottom: '1px solid #32384a'}}>Symbol</th>
                    <th style={{padding: '12px', textAlign: 'left', color: '#e0e2e6', fontWeight: '600', borderBottom: '1px solid #32384a'}}>Type</th>
                    <th style={{padding: '12px', textAlign: 'left', color: '#e0e2e6', fontWeight: '600', borderBottom: '1px solid #32384a'}}>Fee</th>
                    <th style={{padding: '12px', textAlign: 'left', color: '#e0e2e6', fontWeight: '600', borderBottom: '1px solid #32384a'}}>Exchange</th>
                    <th style={{padding: '12px', textAlign: 'center', color: '#e0e2e6', fontWeight: '600', borderBottom: '1px solid #32384a'}}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {stkSymbols.map((setting, index) => (
                    <tr key={`${setting.symbol}-${setting.type}`} style={{background: index % 2 === 0 ? '#232837' : '#2a2f3a', borderBottom: '1px solid #32384a'}}>
                      <td style={{padding: '12px', color: '#00ebff', fontWeight: '500'}}>{setting.symbol}</td>
                      <td style={{padding: '12px', color: '#e0e2e6'}}>{setting.type}</td>
                      <td style={{padding: '12px', color: '#e0e2e6'}}>{setting.fee}</td>
                      <td style={{padding: '12px', color: '#e0e2e6'}}>{setting.exchange || 'N/A'}</td>
                      <td style={{padding: '12px', textAlign: 'center'}}>
                        <button className={styles.actionBtn} onClick={() => openModalForEdit(setting)} style={{marginRight: '8px'}}>Edit</button>
                        <button className={styles.actionBtn} onClick={() => handleDeleteSymbol(setting.symbol, setting.type)}>Delete</button>
                      </td>
                    </tr>
                  ))}
                  {stkSymbols.length === 0 && (
                    <tr>
                      <td colSpan="5" style={{padding: '12px', textAlign: 'center', color: '#e0e2e6'}}>No stock symbols configured</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <h3>Futures Symbols</h3>
            <div style={{overflowX: 'auto'}}>
              <table style={{width: '100%', borderCollapse: 'collapse', background: '#232837', border: '1px solid #32384a', borderRadius: '7px', overflow: 'hidden'}}>
                <thead>
                  <tr style={{background: '#353943'}}>
                    <th style={{padding: '12px', textAlign: 'left', color: '#e0e2e6', fontWeight: '600', borderBottom: '1px solid #32384a'}}>Symbol</th>
                    <th style={{padding: '12px', textAlign: 'left', color: '#e0e2e6', fontWeight: '600', borderBottom: '1px solid #32384a'}}>Type</th>
                    <th style={{padding: '12px', textAlign: 'left', color: '#e0e2e6', fontWeight: '600', borderBottom: '1px solid #32384a'}}>Tick Size</th>
                    <th style={{padding: '12px', textAlign: 'left', color: '#e0e2e6', fontWeight: '600', borderBottom: '1px solid #32384a'}}>Tick Value</th>
                    <th style={{padding: '12px', textAlign: 'left', color: '#e0e2e6', fontWeight: '600', borderBottom: '1px solid #32384a'}}>Rollover Months</th>
                    <th style={{padding: '12px', textAlign: 'left', color: '#e0e2e6', fontWeight: '600', borderBottom: '1px solid #32384a'}}>Initial Margin</th>
                    <th style={{padding: '12px', textAlign: 'left', color: '#e0e2e6', fontWeight: '600', borderBottom: '1px solid #32384a'}}>Fee</th>
                    <th style={{padding: '12px', textAlign: 'left', color: '#e0e2e6', fontWeight: '600', borderBottom: '1px solid #32384a'}}>Exchange</th>
                    <th style={{padding: '12px', textAlign: 'center', color: '#e0e2e6', fontWeight: '600', borderBottom: '1px solid #32384a'}}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {futSymbols.map((setting, index) => (
                    <tr key={`${setting.symbol}-${setting.type}`} style={{background: index % 2 === 0 ? '#232837' : '#2a2f3a', borderBottom: '1px solid #32384a'}}>
                      <td style={{padding: '12px', color: '#00ebff', fontWeight: '500'}}>{setting.symbol}</td>
                      <td style={{padding: '12px', color: '#e0e2e6'}}>{setting.type}</td>
                      <td style={{padding: '12px', color: '#e0e2e6'}}>{setting.tick_size}</td>
                      <td style={{padding: '12px', color: '#e0e2e6'}}>{setting.tick_value}</td>
                      <td style={{padding: '12px', color: '#e0e2e6'}}>{setting.rollover_months.join(', ')}</td>
                      <td style={{padding: '12px', color: '#e0e2e6'}}>{setting.initial_margin}</td>
                      <td style={{padding: '12px', color: '#e0e2e6'}}>{setting.fee}</td>
                      <td style={{padding: '12px', color: '#e0e2e6'}}>{setting.exchange || 'N/A'}</td>
                      <td style={{padding: '12px', textAlign: 'center'}}>
                        <button className={styles.actionBtn} onClick={() => openModalForEdit(setting)} style={{marginRight: '8px'}}>Edit</button>
                        <button className={styles.actionBtn} onClick={() => handleDeleteSymbol(setting.symbol, setting.type)}>Delete</button>
                      </td>
                    </tr>
                  ))}
                  {futSymbols.length === 0 && (
                    <tr>
                      <td colSpan="9" style={{padding: '12px', textAlign: 'center', color: '#e0e2e6'}}>No futures symbols configured</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {activeTab === 'tws' && dbStatus?.isConnected && (
          <div className={styles.twsTab}>
            <h3>Interactive Brokers TWS API</h3>
            <div className={styles.formGrid}>
              <div className={styles.formField}>
                <label htmlFor="ibkrHost1">Primary Address</label>
                <input
                  id="ibkrHost1"
                  value={settings.ibkrAddresses[0].host}
                  onChange={(e) => handleIbkrAddressChange(0, 'host', e.target.value)}
                  className={styles.inputBubble}
                  autoComplete="off"
                  placeholder="e.g., 127.0.0.1"
                />
              </div>
              <div className={styles.formField}>
                <label htmlFor="ibkrPort1">Primary Port</label>
                <input
                  id="ibkrPort1"
                  type="number"
                  value={settings.ibkrAddresses[0].port}
                  onChange={(e) => handleIbkrAddressChange(0, 'port', e.target.value)}
                  className={styles.inputBubble}
                  autoComplete="off"
                  placeholder="7497"
                  min="1024"
                  max="65535"
                />
              </div>
              <div className={styles.formField}>
                <label htmlFor="ibkrHost2">Secondary Address (Optional)</label>
                <input
                  id="ibkrHost2"
                  value={settings.ibkrAddresses[1].host}
                  onChange={(e) => handleIbkrAddressChange(1, 'host', e.target.value)}
                  className={styles.inputBubble}
                  autoComplete="off"
                  placeholder="e.g., 192.168.1.10"
                />
              </div>
              <div className={styles.formField}>
                <label htmlFor="ibkrPort2">Secondary Port</label>
                <input
                  id="ibkrPort2"
                  type="number"
                  value={settings.ibkrAddresses[1].port}
                  onChange={(e) => handleIbkrAddressChange(1, 'port', e.target.value)}
                  className={styles.inputBubble}
                  autoComplete="off"
                  placeholder="7497"
                  min="1024"
                  max="65535"
                />
              </div>
            </div>
            <h3 style={{ marginTop: '28px' }}>IBKR Flex Web Service (No TWS Required)</h3>
            <p style={{ color: '#9CA3AF', fontSize: '0.82rem', marginTop: -8, marginBottom: 14 }}>
              One token, two saved Flex Queries on IB's side. The Activity query covers your history (up to 365 days, refreshes end-of-day); the Trade Confirmation query fills in today's trades (ready ~15-30 min after each fill). Together they cover everything — TWS is optional.
            </p>
            <div className={styles.formGrid}>
              <div className={styles.formField}>
                <label htmlFor="ibkrFlexToken">Flex Token</label>
                <input
                  id="ibkrFlexToken"
                  type="password"
                  value={newIbkrFlexToken}
                  onChange={(e) => setNewIbkrFlexToken(e.target.value)}
                  className={styles.inputBubble}
                  autoComplete="off"
                  placeholder={dbStatus?.ibkrFlexTokenSet ? '********' : 'Enter Flex Token'}
                />
                <span>{dbStatus?.ibkrFlexTokenSet ? 'Configured' : 'Not Configured'}</span>
              </div>
              <div className={styles.formField}>
                <label htmlFor="ibkrFlexQueryIdActivity">Activity Query ID (historical)</label>
                <input
                  id="ibkrFlexQueryIdActivity"
                  name="ibkrFlexQueryIdActivity"
                  value={settings.ibkrFlexQueryIdActivity}
                  onChange={handleSettingChange}
                  className={styles.inputBubble}
                  autoComplete="off"
                  placeholder="e.g., 1234567"
                />
              </div>
              <div className={styles.formField}>
                <label htmlFor="ibkrFlexQueryIdTradeConf">Trade Confirmation Query ID (today)</label>
                <input
                  id="ibkrFlexQueryIdTradeConf"
                  name="ibkrFlexQueryIdTradeConf"
                  value={settings.ibkrFlexQueryIdTradeConf}
                  onChange={handleSettingChange}
                  className={styles.inputBubble}
                  autoComplete="off"
                  placeholder="e.g., 1234568"
                />
              </div>
            </div>
          </div>
        )}
        {activeTab === 'exchanges' && dbStatus?.isConnected && (
          <div className={styles.exchangesTab}>
            <div style={{marginBottom: '16px', display: 'flex', justifyContent: 'flex-start'}}>
              <BubbleButton onClick={() => openExchangeModal()}>Add Exchange</BubbleButton>
            </div>
            <h3>Exchanges</h3>
            <div style={{overflowX: 'auto'}}>
              <table style={{width: '100%', borderCollapse: 'collapse', background: '#232837', border: '1px solid #32384a', borderRadius: '7px', overflow: 'hidden'}}>
                <thead>
                  <tr style={{background: '#353943'}}>
                    <th style={{padding: '12px', textAlign: 'left', color: '#e0e2e6', fontWeight: '600', borderBottom: '1px solid #32384a'}}>Name</th>
                    <th style={{padding: '12px', textAlign: 'left', color: '#e0e2e6', fontWeight: '600', borderBottom: '1px solid #32384a'}}>Timezone</th>
                    <th style={{padding: '12px', textAlign: 'left', color: '#e0e2e6', fontWeight: '600', borderBottom: '1px solid #32384a'}}>Open Slots</th>
                    <th style={{padding: '12px', textAlign: 'center', color: '#e0e2e6', fontWeight: '600', borderBottom: '1px solid #32384a'}}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {[...exchanges]
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((exchange, index) => (
                      <tr key={exchange.id} style={{background: index % 2 === 0 ? '#232837' : '#2a2f3a', borderBottom: '1px solid #32384a'}}>
                        <td style={{padding: '12px', color: '#00ebff', fontWeight: '500'}}>{exchange.name}</td>
                        <td style={{padding: '12px', color: '#e0e2e6'}}>{exchange.timezone}</td>
                        <td style={{padding: '12px', color: '#e0e2e6'}}>{exchange.opening_hours.flat().filter(h => h).length}</td>
                        <td style={{padding: '12px', textAlign: 'center'}}>
                          <button className={styles.actionBtn} onClick={() => openExchangeModal(exchange)} style={{marginRight: '8px'}}>Edit</button>
                          <button className={styles.actionBtn} onClick={() => handleDeleteExchange(exchange.id)}>Delete</button>
                        </td>
                      </tr>
                    ))}
                  {(!Array.isArray(exchanges) || exchanges.length === 0) && (
                    <tr>
                      <td colSpan="4" style={{padding: '12px', textAlign: 'center', color: '#e0e2e6'}}>No exchanges configured</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {activeTab === 'historical' && dbStatus?.isConnected && (
          <div className={styles.historicalTab}>
            <h3>Historical Data Summary</h3>
            <div className={styles.formField}>
              <label>Select a Symbol to inspect:</label>
              <select
                value={selectedHistoricalSymbol}
                onChange={handleHistoricalSymbolChange}
                className={styles.inputBubble}
              >
                <option value="">-- Select Symbol --</option>
                {historicalSymbols.map(({ symbol, type }) => (
                  <option key={`${symbol}-${type}`} value={`${symbol}-${type}`}>
                    {symbol} ({type})
                  </option>
                ))}
              </select>
            </div>
            {isLoadingSummary && <p>Loading summary...</p>}
            {historicalSummary && (
              <>
                <HistoricalDataSummary
                  summary={historicalSummary}
                  type={selectedHistoricalSymbol.split('-')[1]}
                  onEditRollover={handleEditRollover}
                  onExportCsv={handleExportCsv}
                />
                <hr style={{ margin: '2rem 0' }} />
                <div className={styles.globalActions}>
                  <h3>{selectedHistoricalSymbol.split('-')[0]} Data Actions</h3>
                  <div className={styles.buttonContainer} style={{ marginTop: '1rem' }}>
                    {selectedHistoricalSymbol.split('-')[1] === 'FUT' && (
                      <BubbleButton onClick={handleRecalculateContinuous} color="#2563EB" disabled={isFetchingSymbolHistoricalData || isFetchingAllHistoricalData}>
                        Recalculate Continuous Series
                      </BubbleButton>
                    )}
                    <BubbleButton onClick={handleDeleteHistoricalData} color="#DC2626" disabled={isFetchingSymbolHistoricalData || isFetchingAllHistoricalData}>
                      Delete Historical Data
                    </BubbleButton>
                    <BubbleButton onClick={handleFetchSymbolHistoricalData} color="#10B981" disabled={isFetchingSymbolHistoricalData || isFetchingAllHistoricalData}>
                      {isFetchingSymbolHistoricalData ? 'Fetching…' : 'Fetch Historical Data'}
                    </BubbleButton>
                  </div>

                </div>
              </>
            )}
            <hr style={{ margin: '2rem 0' }} />
            <div className={styles.globalActions}>
              <h3>Global Data Actions</h3>
              <p>These actions affect all symbols in the historical database.</p>
              <div className={styles.buttonContainer} style={{ marginTop: '1rem' }}>
                <BubbleButton onClick={handleFetchAllHistoricalData} color="#2563EB" disabled={isFetchingSymbolHistoricalData || isFetchingAllHistoricalData}>
                  {isFetchingAllHistoricalData ? 'Fetching all…' : 'Fetch All Historical Data'}
                </BubbleButton>
                <BubbleButton onClick={handleDeleteAllHistoricalData} color="#DC2626" disabled={isFetchingSymbolHistoricalData || isFetchingAllHistoricalData}>
                  Delete All Historical Data
                </BubbleButton>
                <BubbleButton onClick={handleRebuildAllContinuousData} color="#2563EB" disabled={isRebuildingAllContinuous}>
                  {isRebuildingAllContinuous ? 'Starting rebuild…' : 'Rebuild All Continuous Series'}
                </BubbleButton>
              </div>

              {(queueStatus?.currentTask || queueStatus?.pendingCount > 0) && (
                <div className={styles.actionStatus}>
                  <span className={styles.inlineSpinner} />
                  <div style={{ flex: 1 }}>
                    <strong>Fetch queue:</strong>{' '}
                    {queueStatus.currentTask ? (
                      <span>
                        Processing {queueStatus.currentTask.symbol} {queueStatus.currentTask.timeframe}
                        {queueStatus.currentTask.contractMonth ? ` (${queueStatus.currentTask.contractMonth})` : ''} — {queueStatus.currentTask.phase}
                      </span>
                    ) : (
                      <span>Waiting for next task…</span>
                    )}
                    {queueStatus.activeChunks?.length > 0 && (
                      <ul style={{ paddingLeft: 16, margin: '4px 0 0', fontSize: '0.85rem' }}>
                        {queueStatus.activeChunks.map((c, i) => (
                          <li key={i} style={{ marginBottom: 2 }}>
                            IBKR: {c.symbol} {c.timeframe}{c.contractMonth ? ` (${c.contractMonth})` : ''} — fetching{' '}
                            {DateTime.fromISO(c.chunkStart).toFormat('yyyy-MM-dd')} → {DateTime.fromISO(c.chunkEnd).toFormat('yyyy-MM-dd')}
                          </li>
                        ))}
                      </ul>
                    )}
                    <div style={{ fontSize: '0.85rem', marginTop: '4px' }}>
                      {queueStatus.pendingCount} task{queueStatus.pendingCount === 1 ? '' : 's'} remaining in queue
                      {queueStatus.pendingPreview?.length > 0 && (
                        <ul style={{ paddingLeft: 16, margin: '4px 0 0', maxHeight: 140, overflowY: 'auto' }}>
                          {queueStatus.pendingPreview.map((t, i) => (
                            <li key={i} style={{ marginBottom: 2 }}>
                              {t.symbol} {t.timeframe}{t.contractMonth ? ` (${t.contractMonth})` : ''} — {t.phase}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                </div>
              )}
              {queueStatus?.recentOutcomes?.length > 0 && (
                <div className={styles.actionStatus} style={{ display: 'block' }}>
                  <strong>Recent fetch activity:</strong>
                  <span style={{ marginLeft: 8, fontSize: '0.8rem', opacity: 0.7 }}>
                    {queueStatus.recentOutcomes.filter(o => o.status === 'failed').length} failed of last {queueStatus.recentOutcomes.length}
                  </span>
                  <ul style={{ paddingLeft: 0, margin: '8px 0 0', listStyle: 'none', maxHeight: 220, overflowY: 'auto' }}>
                    {queueStatus.recentOutcomes.map((o, i) => {
                      const color = o.status === 'failed' ? '#EF4444' : o.status === 'cancelled' ? '#A5ADBA' : '#22C55E';
                      const icon = o.status === 'failed' ? '✗' : o.status === 'cancelled' ? '⊘' : '✓';
                      return (
                        <li key={i} style={{ marginBottom: 4, fontSize: '0.85rem', display: 'flex', gap: 8, alignItems: 'baseline' }}>
                          <span style={{ color, minWidth: 14 }}>{icon}</span>
                          <span>
                            {o.symbol} {o.timeframe}{o.contractMonth ? ` (${o.contractMonth})` : ''} — {o.phase}
                            <span style={{ opacity: 0.6 }}> · {DateTime.fromISO(o.finishedAt).toFormat('HH:mm:ss')}</span>
                            {o.error && <div style={{ color: '#EF4444', opacity: 0.9 }}>{o.error}</div>}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
              {historicalFetchStatus && (
                <div className={styles.actionStatus}>
                  <div style={{ flex: 1 }}>{historicalFetchStatus}</div>
                  <button
                    style={{ background: 'transparent', border: 'none', color: '#A5ADBA', cursor: 'pointer', padding: 0, marginLeft: '12px' }}
                    onClick={() => setHistoricalFetchStatus('')}
                    title="Clear status"
                  >
                    ✕
                  </button>
                </div>
              )}
              {currentRebuildRequestId && (
                <div className={styles.actionStatus}>
                  {isRebuildingAllContinuous && <span className={styles.inlineSpinner} />}
                  <div style={{ flex: 1 }}>
                    <strong>Continuous series rebuild progress:</strong>
                    <div style={{ fontSize: '0.85rem', marginTop: '4px' }}>
                      {currentRebuildLogs.length === 0 ? (
                        <span>No status updates received yet.</span>
                      ) : (
                        <ul style={{ paddingLeft: 16, margin: 0, maxHeight: 180, overflowY: 'auto' }}>
                          {currentRebuildLogs.slice(-15).map((log) => (
                            <li key={log.id} style={{ marginBottom: 2 }}>
                              <span style={{ opacity: 0.7 }}>[{new Date(log.timestamp).toLocaleTimeString()}]</span>{' '}
                              <span>{log.status}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                  <button
                    style={{ background: 'transparent', border: 'none', color: '#A5ADBA', cursor: 'pointer', padding: 0, marginLeft: '12px' }}
                    onClick={() => setCurrentRebuildRequestId(null)}
                    title="Clear status"
                  >
                    ✕
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      {(activeTab === 'general' || activeTab === 'tws') && (
        <div className={styles.footerRow}>
          <BubbleButton onClick={handleSave} color="#3B82F6">
            Save
          </BubbleButton>
        </div>
      )}
      {showFuturesModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            zIndex: 2000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <div className={styles.modal}>
            <div className={styles.header}>
              <span className={styles.title}>{editingSetting ? 'Edit Symbol Setting' : 'Add Symbol Setting'}</span>
              <button className={styles.closeBtn} onClick={() => setShowFuturesModal(false)}>×</button>
            </div>
            {!editingSetting && (
              <p style={{ margin: '0 0 12px', fontSize: '0.85rem', opacity: 0.8 }}>
                Type a known futures root symbol (e.g. MNQ, ES, GC, CL) and tab out of the field to auto-fill its contract specs.
              </p>
            )}
            {futuresAutoFillNote && (
              <p style={{ margin: '0 0 12px', fontSize: '0.85rem', color: '#3B82F6' }}>{futuresAutoFillNote}</p>
            )}
            <div className={styles.formGrid}>
              <div className={styles.formField}>
                <label htmlFor="symbol">Symbol</label>
                <input
                  id="symbol"
                  name="symbol"
                  value={form.symbol}
                  onChange={handleFuturesFormChange}
                  onBlur={handleSymbolBlur}
                  className={styles.inputBubble}
                  disabled={editingSetting && editingSetting.symbol === 'DEFAULT'}
                  autoComplete="off"
                />
              </div>
              <div className={styles.formField}>
                <label htmlFor="type">Type</label>
                <select
                  id="type"
                  name="type"
                  value={form.type}
                  onChange={handleFuturesFormChange}
                  className={styles.inputBubble}
                >
                  <option value="STK">Stock</option>
                  <option value="FUT">Futures</option>
                </select>
              </div>
              {form.type === 'FUT' && (
                <>
                  <div className={styles.formField}>
                    <label htmlFor="tickSize">Tick Size</label>
                    <input
                      id="tickSize"
                      name="tickSize"
                      value={form.tickSize}
                      onChange={handleFuturesFormChange}
                      className={styles.inputBubble}
                      inputMode="decimal"
                      autoComplete="off"
                      type="number"
                      step="0.01"
                    />
                  </div>
                  <div className={styles.formField}>
                    <label htmlFor="tickValue">Tick Value</label>
                    <input
                      id="tickValue"
                      name="tickValue"
                      value={form.tickValue}
                      onChange={handleFuturesFormChange}
                      className={styles.inputBubble}
                      inputMode="decimal"
                      autoComplete="off"
                      type="number"
                      step="0.01"
                    />
                  </div>
                  <div className={styles.formField}>
                    <label htmlFor="rolloverMonths">Rollover Months (e.g., 3,6,9,12)</label>
                    <input
                      id="rolloverMonths"
                      name="rolloverMonths"
                      value={form.rolloverMonths}
                      onChange={handleFuturesFormChange}
                      className={styles.inputBubble}
                      autoComplete="off"
                      placeholder="Enter months (1-12) separated by commas"
                    />
                  </div>
                  <div className={styles.formField}>
                    <label htmlFor="initialMargin">Initial Margin ($)</label>
                    <input
                      id="initialMargin"
                      name="initialMargin"
                      value={form.initialMargin}
                      onChange={handleFuturesFormChange}
                      className={styles.inputBubble}
                      inputMode="decimal"
                      autoComplete="off"
                      type="number"
                      step="0.01"
                      placeholder="e.g., 5000"
                      required
                    />
                  </div>
                </>
              )}
              <div className={styles.formField}>
                <label htmlFor="fee">Fee</label>
                <input
                  id="fee"
                  name="fee"
                  value={form.fee}
                  onChange={handleFuturesFormChange}
                  className={styles.inputBubble}
                  inputMode="decimal"
                  autoComplete="off"
                  type="number"
                  step="0.01"
                />
              </div>
              <div className={styles.formField}>
                <label htmlFor="exchange">Exchange</label>
                <select
                  id="exchange"
                  name="exchange"
                  value={form.exchange}
                  onChange={handleFuturesFormChange}
                  className={styles.inputBubble}
                >
                  {exchangeOptions.map(option => (
                    <option key={option.id || 'null'} value={option.name}>
                      {option.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <hr style={{ margin: '1.5rem 0 1rem' }} />
            <div>
              <h3 style={{ margin: '0 0 4px' }}>Timeframes to Fetch</h3>
              <p style={{ margin: '0 0 12px', fontSize: '0.85rem', opacity: 0.8 }}>
                Choose which timeframes to fetch and keep updated for this symbol. Each enabled timeframe is always
                fetched as far back as the data provider allows — no need to specify how much history to keep.
              </p>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', fontSize: '0.8rem', opacity: 0.7 }}>
                    <th style={{ padding: '4px 8px' }}>Fetch</th>
                    <th style={{ padding: '4px 8px' }}>Timeframe</th>
                    <th style={{ padding: '4px 8px' }}>Known limits</th>
                  </tr>
                </thead>
                <tbody>
                  {TIMEFRAME_ORDER.map(tf => {
                    const entry = form.timeframeSettings?.[tf] || DEFAULT_TIMEFRAME_SETTINGS[tf];
                    const limitsInfo = describeTimeframeLimits(timeframeLimits?.[tf]);
                    return (
                      <tr key={tf}>
                        <td style={{ padding: '4px 8px' }}>
                          <input
                            type="checkbox"
                            checked={!!entry.enabled}
                            onChange={() => handleTimeframeToggle(tf)}
                          />
                        </td>
                        <td style={{ padding: '4px 8px' }}>{tf}</td>
                        <td style={{ padding: '4px 8px', fontSize: '0.8rem', opacity: 0.8 }}>
                          {entry.enabled ? (limitsInfo || 'No limit discovered yet') : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className={styles.footerRow}>
              <BubbleButton onClick={saveFuturesSetting} color="#3B82F6">Save</BubbleButton>
            </div>
          </div>
        </div>
      )}
      {showExchangeModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            zIndex: 2000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <div className={styles.modal}>
            <div className={styles.header}>
              <span className={styles.title}>{editingExchange ? 'Edit Exchange' : 'Add Exchange'}</span>
              <button className={styles.closeBtn} onClick={() => setShowExchangeModal(false)}>×</button>
            </div>
            {!editingExchange && (
              <p style={{ margin: '0 0 12px', fontSize: '0.85rem', opacity: 0.8 }}>
                Type a known exchange name (e.g. CME, NYMEX, COMEX, NYSE, NASDAQ) and tab out of the field to auto-fill its timezone and hours.
              </p>
            )}
            {exchangeAutoFillNote && (
              <p style={{ margin: '0 0 12px', fontSize: '0.85rem', color: '#3B82F6' }}>{exchangeAutoFillNote}</p>
            )}
            <div className={styles.formGrid}>
              <div className={styles.formField}>
                <label htmlFor="name">Exchange Name</label>
                <input
                  id="name"
                  name="name"
                  value={exchangeForm.name}
                  onChange={handleExchangeFormChange}
                  onBlur={handleExchangeNameBlur}
                  className={styles.inputBubble}
                  autoComplete="off"
                  placeholder="e.g., NYMEX, NASDAQ"
                />
              </div>
              <div className={styles.formField}>
                <label htmlFor="timezone">Timezone</label>
                <select
                  id="timezone"
                  name="timezone"
                  value={exchangeForm.timezone}
                  onChange={handleExchangeFormChange}
                  className={styles.inputBubble}
                >
                  {timezones.map(tz => (
                    <option key={tz} value={tz}>{tz}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className={styles.formField}>
              <label>Opening Hours (Click to toggle or drag to select multiple)</label>
              <div
                className={styles.openingHoursMatrix}
                onMouseLeave={handleDragEnd}
                style={{ userSelect: 'none' }}
              >
                <div style={{ display: 'flex', marginBottom: 4 }}>
                  <div style={{ width: 44 }}></div>
                  {Array(48).fill().map((_, slotIdx) =>
                    slotIdx % 4 === 0 ? (
                      <div
                        key={slotIdx}
                        className={styles.matrixHeader}
                        style={{ width: 20, textAlign: 'center' }}
                      >
                        {slotToTime(slotIdx)}
                      </div>
                    ) : (
                      <div key={slotIdx} style={{ width: 20 }} />
                    )
                  )}
                </div>
                {exchangeForm.opening_hours.map((slots, dayIdx) => (
                  <div key={dayIdx} style={{ display: 'flex' }}>
                    <div
                      className={styles.matrixHeader}
                      style={{ width: 44, textAlign: 'right', marginRight: 2 }}
                    >
                      {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][dayIdx]}
                    </div>
                    {slots.map((slotValue, slotIdx) => (
                      <div
                        key={slotIdx}
                        className={[
                          styles.matrixCell,
                          slotValue ? styles.active : '',
                          isCellSelected(dayIdx, slotIdx) ? styles.selected : ''
                        ].join(' ')}
                        title={`${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][dayIdx]} ${slotToTime(slotIdx)}`}
                        onMouseDown={e => {
                          e.preventDefault();
                          setDragStart({ day: dayIdx, slot: slotIdx });
                          setDragEnd({ day: dayIdx, slot: slotIdx });
                          setIsDragging(true);
                        }}
                        onMouseEnter={() => {
                          if (isDragging) setDragEnd({ day: dayIdx, slot: slotIdx });
                        }}
                        onMouseUp={e => {
                          if (
                            dragStart &&
                            dragStart.day === dayIdx &&
                            dragStart.slot === slotIdx &&
                            (!dragEnd ||
                              (dragEnd.day === dayIdx && dragEnd.slot === slotIdx))
                          ) {
                            toggleOpeningHour(dayIdx, slotIdx);
                            setIsDragging(false);
                            setDragStart(null);
                            setDragEnd(null);
                          } else {
                            handleDragEnd();
                          }
                        }}
                        aria-label={`Toggle ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][dayIdx]} ${slotToTime(slotIdx)}`}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </div>
            <div className={styles.footerRow}>
              <BubbleButton onClick={saveExchange} color="#3B82F6">Save</BubbleButton>
            </div>
          </div>
        </div>
      )}
      {showRolloverModal && editingRollover && (
        <div className={styles.overlay}>
          <div className={styles.modal}>
            <div className={styles.header}>
              <span className={styles.title}>Edit Rollover Date</span>
              <button className={styles.closeBtn} onClick={handleCloseRolloverModal}>×</button>
            </div>
            <div className={styles.formGrid}>
              <div className={styles.formField}>
                <label>From Contract</label>
                <input value={editingRollover.from} className={styles.inputBubble} disabled />
              </div>
              <div className={styles.formField}>
                <label>To Contract</label>
                <input value={editingRollover.to} className={styles.inputBubble} disabled />
              </div>
              <div className={styles.formField}>
                <label htmlFor="rolloverDate">Manual Rollover Date</label>
                <input
                  id="rolloverDate"
                  type="date"
                  value={rolloverDate}
                  onChange={(e) => setRolloverDate(e.target.value)}
                  className={styles.inputBubble}
                />
              </div>
            </div>
            <div className={styles.footerRow} style={{ justifyContent: 'space-between' }}>
              <div>
                {editingRollover.rollover_type === 'MANUAL' && (
                  <BubbleButton onClick={handleDeleteRolloverOverride} color="#EF4444" disabled={isDeleting}>
                    {isDeleting ? 'Deleting...' : 'Delete Override'}
                  </BubbleButton>
                )}
              </div>
              <BubbleButton onClick={handleSaveRollover} color="#3B82F6" disabled={isSaving}>
                {isSaving ? 'Rebuilding...' : 'Save'}
              </BubbleButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}