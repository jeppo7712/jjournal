import React, { useState, useEffect, useContext, useMemo } from 'react';
import styles from './Settings.module.css';
import { TradeContext } from '../../context/TradeContext';
import ChecklistSettings from './ChecklistSettings';
import IconButton, { ACTION_COLORS } from '../common/IconButton';
import { useStatus } from '../../context/StatusContext';
import { DateTime } from 'luxon';
import { findExchangePreset, findFuturesPreset } from '../../data/marketReference';
import { NUMBER_FORMATS, getNumberFormat, setNumberFormat } from '../../utils/numberFormat';
import HistoricalDataSummary from './HistoricalDataSummary';
import { FaSlidersH, FaTerminal, FaWallet, FaTasks, FaPlug, FaGlobeAmericas, FaChartLine, FaDatabase, FaPlus, FaSyncAlt, FaEye, FaEyeSlash } from 'react-icons/fa';
import { notify, confirmDialog } from '../common/Dialogs';

// The sections of the Settings page, in menu order. Without a database only
// General and Server Logs can be opened.
const SECTIONS = [
  { id: 'general', label: 'General', icon: FaSlidersH, description: 'Database connection and how the journal displays things.' },
  { id: 'logs', label: 'Server Logs', icon: FaTerminal, description: 'The latest lines of the server log.' },
  { id: 'accounts', label: 'Accounts', icon: FaWallet, description: 'Trading accounts, where their cash is held and how they nest.' },
  { id: 'checklists', label: 'Checklists', icon: FaTasks, description: 'Checks to tick off when entering and leaving a trade, per account.' },
  { id: 'tws', label: 'IBKR API', icon: FaPlug, description: 'TWS and IB Gateway connections, and Flex Web Service imports.' },
  { id: 'exchanges', label: 'Exchanges', icon: FaGlobeAmericas, description: 'Trading venues with their timezone and opening hours.' },
  { id: 'symbols', label: 'Symbols', icon: FaChartLine, description: 'Contract specs, fees and which timeframes to fetch.' },
  { id: 'historical', label: 'Historical Data', icon: FaDatabase, description: "What's stored for each symbol, per timeframe and source." },
];

// postgresql://user:secret@host/db -> postgresql://user:••••••@host/db, so
// the password isn't on screen (or in a screenshot) unless asked for.
function maskDbUrl(url) {
  if (!url) return '';
  return url.replace(/^([a-z]+:\/\/[^:/@]+:)([^@]*)(@)/i, (m, a, pass, c) => `${a}${'•'.repeat(6)}${c}`);
}

// The server log is one JSON object per line ({ level, message, timestamp });
// anything else is shown as it is.
function parseLogLines(text) {
  return String(text || '').split('\n').filter(line => line.trim()).map((line, i) => {
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === 'object' && entry.message !== undefined) {
        return { id: i, level: String(entry.level || 'info').toLowerCase(), message: String(entry.message), timestamp: entry.timestamp || null };
      }
    } catch { /* not JSON */ }
    return { id: i, level: /error/i.test(line) ? 'error' : 'info', message: line, timestamp: null };
  });
}

function StatusPill({ ok, okText, badText, neutral }) {
  const tone = neutral ? styles.pillNeutral : ok ? styles.pillOk : styles.pillBad;
  return <span className={`${styles.statusPill} ${tone}`}><span className={styles.pillDot} />{ok ? okText : badText}</span>;
}

// Must match VALID_TIMEFRAMES / DEFAULT_TIMEFRAME_SETTINGS in
// modules/historical-data-service.js.
const TIMEFRAME_ORDER = ['1M', '5M', '15M', '1H', '4H', '1D', '1W'];

// The historical-data picker's value is `${symbol}-${type}`. Symbols can
// contain dashes themselves (BTC-EUR), so split on the last one: the type
// (STK/FUT) never does.
function splitSymbolKey(key) {
  const i = key.lastIndexOf('-');
  return i < 0 ? [key, undefined] : [key.slice(0, i), key.slice(i + 1)];
}
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

function BubbleButton({ children, onClick, color = '#3B82F6', disabled, className = '', ...rest }) {
  return (
    <button
      type="button"
      className={`${styles.button} ${className}`}
      style={{ '--button-color': color }}
      onClick={onClick}
      disabled={disabled}
      {...rest}
    >
      {children}
    </button>
  );
}

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

export default function Settings() {
  const { accounts, currentAccountId, setCurrentAccountId, setAccounts, futuresSettings, refreshFuturesSettings, tradesPerPage, setTradesPerPage } = useContext(TradeContext);
  const { statusLogs } = useStatus();
  const [settings, setSettings] = useState({
    databaseUrl: '',
    port: '3999',
    ibkrAddresses: [
      { host: '', port: '7497' },
      { host: '', port: '7497' }
    ],
    ibkrDataAddress: { host: '', port: '4004' },
    ibkrGatewayCommandAddress: { host: '', port: '7462' },
    // Separate Flex credentials per paper-vs-real — see
    // docs/CAPITAL_TRACKING_DESIGN.md and routes/ibkr.js. Which set a given
    // Flex fetch uses is decided by the account's own is_virtual, not a
    // global choice here.
    ibkrFlexQueryIdActivityReal: '',
    ibkrFlexQueryIdTradeConfReal: '',
    ibkrFlexQueryIdActivityPaper: '',
    ibkrFlexQueryIdTradeConfPaper: '',
  });
  const [activeTab, setActiveTab] = useState('general');
  const [dbStatus, setDbStatus] = useState(null);
  const [apiBaseUrl, setApiBaseUrl] = useState(process.env.REACT_APP_API_URL);
  const [showFuturesModal, setShowFuturesModal] = useState(false);
  const [showExchangeModal, setShowExchangeModal] = useState(false);
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [editingSetting, setEditingSetting] = useState(null);
  const [editingExchange, setEditingExchange] = useState(null);
  const [editingAccountId, setEditingAccountId] = useState(null);
  // custodian_is_us is genuinely tri-state (US / non-US / not set) — '' is
  // the form's "not set" sentinel (a native <select> value must be a
  // string), converted to true/false/null right before the request goes
  // out. See saveAccountForm.
  const [accountForm, setAccountForm] = useState({ name: '', parent_account_id: '', is_virtual: false, custodian: '', custodian_is_us: '', broker_account_id: '' });
  const [form, setForm] = useState({
    symbol: '',
    type: 'FUT',
    tickSize: '',
    tickValue: '',
    fee: '',
    exchange: '',
    currency: 'USD',
    rolloverMonths: '',
    initialMargin: '',
    timeframeSettings: DEFAULT_TIMEFRAME_SETTINGS,
    ibkrSymbol: '',
    ibkrExchange: '',
  });

  const [exchangeForm, setExchangeForm] = useState({
    name: '',
    timezone: 'America/New_York',
    opening_hours: Array(7).fill().map(() => Array(48).fill(false))
  });
  const [exchanges, setExchanges] = useState([]);
  const [futuresAutoFillNote, setFuturesAutoFillNote] = useState('');
  const [exchangeAutoFillNote, setExchangeAutoFillNote] = useState('');
  const [newIbkrFlexTokenReal, setNewIbkrFlexTokenReal] = useState('');
  const [newIbkrFlexTokenPaper, setNewIbkrFlexTokenPaper] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState(null);
  const [dragEnd, setDragEnd] = useState(null);

  const [serverLogs, setServerLogs] = useState('');
  const [logsLoading, setLogsLoading] = useState(false);
  const [logLines, setLogLines] = useState(200);
  const [logLevelFilter, setLogLevelFilter] = useState('all');
  const [showDbUrl, setShowDbUrl] = useState(false);

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
          ibkrDataAddress: {
            host: data.ibkrDataAddresses?.[0]?.host || '',
            port: String(data.ibkrDataAddresses?.[0]?.port || '4004'),
          },
          ibkrGatewayCommandAddress: {
            host: data.ibkrGatewayCommandAddress?.host || '',
            port: String(data.ibkrGatewayCommandAddress?.port || '7462'),
          },
          ibkrFlexQueryIdActivityReal: data.ibkrFlexQueryIdActivityReal || '',
          ibkrFlexQueryIdTradeConfReal: data.ibkrFlexQueryIdTradeConfReal || '',
          ibkrFlexQueryIdActivityPaper: data.ibkrFlexQueryIdActivityPaper || '',
          ibkrFlexQueryIdTradeConfPaper: data.ibkrFlexQueryIdTradeConfPaper || ''
        }));
        if (process.env.NODE_ENV === 'development') {
          setApiBaseUrl(process.env.REACT_APP_API_URL);
        }
        if (!data.isConnected && !data.databaseUrl) {
          notify('Database not configured. Please set a valid database URL.');
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
      if (newIbkrFlexTokenReal) {
        body.ibkrFlexTokenReal = newIbkrFlexTokenReal;
      }
      if (settings.ibkrFlexQueryIdActivityReal) {
        body.ibkrFlexQueryIdActivityReal = settings.ibkrFlexQueryIdActivityReal;
      }
      if (settings.ibkrFlexQueryIdTradeConfReal) {
        body.ibkrFlexQueryIdTradeConfReal = settings.ibkrFlexQueryIdTradeConfReal;
      }
      if (newIbkrFlexTokenPaper) {
        body.ibkrFlexTokenPaper = newIbkrFlexTokenPaper;
      }
      if (settings.ibkrFlexQueryIdActivityPaper) {
        body.ibkrFlexQueryIdActivityPaper = settings.ibkrFlexQueryIdActivityPaper;
      }
      if (settings.ibkrFlexQueryIdTradeConfPaper) {
        body.ibkrFlexQueryIdTradeConfPaper = settings.ibkrFlexQueryIdTradeConfPaper;
      }
      if (settings.ibkrAddresses) {
        body.ibkrAddresses = settings.ibkrAddresses.map(addr => ({
          host: addr.host || '',
          port: addr.port ? parseInt(addr.port, 10) : 7497
        }));
      }
      if (settings.ibkrDataAddress) {
        body.ibkrDataAddresses = [{
          host: (settings.ibkrDataAddress.host || '').trim(),
          port: settings.ibkrDataAddress.port ? parseInt(settings.ibkrDataAddress.port, 10) : 4004,
        }];
      }
      if (settings.ibkrGatewayCommandAddress) {
        // An empty address switches the auto-reconnect off.
        const host = (settings.ibkrGatewayCommandAddress.host || '').trim();
        body.ibkrGatewayCommandAddress = host
          ? { host, port: settings.ibkrGatewayCommandAddress.port ? parseInt(settings.ibkrGatewayCommandAddress.port, 10) : 7462 }
          : null;
      }
      if (Object.keys(body).length === 0) {
        notify('No changes to save.');
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
      setNewIbkrFlexTokenReal('');
      setNewIbkrFlexTokenPaper('');
      // A new database URL or port restarts the server: wait until it
      // answers again, then reload so everything reconnects. Any other
      // change applies straight away and the page stays as it is.
      if (data.needsRestart) {
        notify('Saved. The server is restarting; the page reloads when it is back.', 'success');
        const started = Date.now();
        await new Promise(resolve => setTimeout(resolve, 3000));
        while (Date.now() - started < 60000) {
          try {
            const ping = await fetch(`${apiBaseUrl}/api/config/status`);
            if (ping.ok) break;
          } catch { /* still restarting */ }
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        window.location.reload();
        return;
      }
      notify(data.message || 'Settings saved.', 'success');
      const statusRes = await fetch(`${apiBaseUrl}/api/config/status`);
      const statusData = await statusRes.json();
      setDbStatus(statusData);
    } catch (err) {
      notify('Error updating configuration: ' + err.message);
    }
  };

  const refreshAccountsList = async () => {
    const refreshRes = await fetch(`${apiBaseUrl}/api/accounts`, {
      headers: { 'X-Account-ID': currentAccountId },
    });
    if (!refreshRes.ok) throw new Error('Failed to refresh accounts list.');
    setAccounts(await refreshRes.json());
  };

  // parent_account_id lets an account's capital be represented as allocated
  // from a larger pool (e.g. a "Main Capital" account with several trading
  // accounts as children) instead of every account being an isolated
  // island — see docs/CAPITAL_TRACKING_DESIGN.md. is_virtual is paper vs
  // real for the WHOLE account, permanently — not a per-transaction
  // choice. A real paper-trading account is a genuinely different account
  // at the broker (different account number entirely), so "graduating" to
  // live trading means switching to a separate real account, not flipping
  // this flag on an existing one. custodian/custodian_is_us describe where
  // this account's cash actually sits — same "permanent fact about the whole account" shape as
  // is_virtual, and same reasoning for why a child can't disagree with its
  // parent: they're the same real account at the same real custodian. The
  // form still carries these three fields for an account WITH a parent
  // (disabled, showing the parent's live values below) purely for display —
  // the backend ignores whatever's submitted for them in that case and uses
  // the parent's own current values instead (see routes/accounts.js).
  // An account can't be moved under itself or one of its own sub-accounts
  // (that would make the family a loop), so those aren't offered as parents.
  const unavailableParentIds = (() => {
    const ids = new Set();
    if (!editingAccountId) return ids;
    const pending = [editingAccountId];
    while (pending.length > 0) {
      const id = pending.pop();
      if (ids.has(id)) continue;
      ids.add(id);
      accounts.forEach(a => { if (a.parent_account_id === id) pending.push(a.id); });
    }
    return ids;
  })();

  // Saved in the server config straight away (it applies on every device),
  // then applied here; the app redraws its numbers in the new format.
  const [numberFormat, setNumberFormatChoice] = useState(getNumberFormat);
  const saveNumberFormat = async (value) => {
    const previous = numberFormat;
    setNumberFormatChoice(value);
    try {
      const res = await fetch(`${apiBaseUrl}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ numberFormat: value }),
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.error || 'Failed to save the number format');
      }
      setNumberFormat(value);
    } catch (err) {
      setNumberFormatChoice(previous);
      notify(err.message);
    }
  };

  const openAccountModal = (account = null) => {
    setEditingAccountId(account ? account.id : null);
    setAccountForm({
      name: account ? account.name : '',
      parent_account_id: account && account.parent_account_id ? String(account.parent_account_id) : '',
      is_virtual: account ? !!account.is_virtual : false,
      custodian: account ? (account.custodian || '') : '',
      custodian_is_us: account && account.custodian_is_us !== null && account.custodian_is_us !== undefined
        ? String(account.custodian_is_us)
        : '',
      broker_account_id: account ? (account.broker_account_id || '') : '',
    });
    setShowAccountModal(true);
  };

  const saveAccountForm = async () => {
    if (!accountForm.name.trim()) {
      notify('Account name is required.');
      return;
    }
    try {
      const method = editingAccountId ? 'PUT' : 'POST';
      const url = editingAccountId ? `${apiBaseUrl}/api/accounts/${editingAccountId}` : `${apiBaseUrl}/api/accounts`;
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Account-ID': currentAccountId },
        body: JSON.stringify({
          name: accountForm.name.trim(),
          parent_account_id: accountForm.parent_account_id || null,
          is_virtual: accountForm.is_virtual,
          custodian: accountForm.custodian.trim() || null,
          // '' (not set) -> null; the backend ignores all three of these
          // anyway when parent_account_id is set, inheriting the parent's
          // values instead — see routes/accounts.js.
          custodian_is_us: accountForm.custodian_is_us === 'true' ? true : accountForm.custodian_is_us === 'false' ? false : null,
          broker_account_id: accountForm.broker_account_id.trim() || null,
        }),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to save account');
      }
      await refreshAccountsList();
      setShowAccountModal(false);
    } catch (err) {
      notify('Error saving account: ' + err.message);
    }
  };

  const handleDeleteAccount = async (id) => {
    if (accounts.length <= 1) {
      notify('Cannot delete the last account.');
      return;
    }
    if (await confirmDialog('Are you sure you want to delete this account? All associated data will be deleted.')) {
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
        notify('Error deleting account: ' + err.message);
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
      currency: setting && setting.currency ? setting.currency : 'USD',
      rolloverMonths: setting && setting.rollover_months ? setting.rollover_months.join(',') : '',
      initialMargin: setting && setting.initial_margin != null ? setting.initial_margin.toString() : '',
      timeframeSettings: setting && setting.timeframe_settings ? setting.timeframe_settings : DEFAULT_TIMEFRAME_SETTINGS,
      ibkrSymbol: setting && setting.ibkr_symbol ? setting.ibkr_symbol : '',
      ibkrExchange: setting && setting.ibkr_exchange ? setting.ibkr_exchange : '',
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
    if (['symbol', 'currency', 'ibkrSymbol', 'ibkrExchange'].includes(name)) {
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
    const { symbol, type, tickSize, tickValue, fee, exchange, currency, rolloverMonths, initialMargin, timeframeSettings, ibkrSymbol, ibkrExchange } = form;

    if (!symbol || !type || !fee) {
      notify('Symbol, type, and fee are required.');
      return;
    }

    if (type === 'FUT' && (!tickSize || !tickValue || !rolloverMonths || !initialMargin)) {
      notify('Tick size, tick value, rollover months, and initial margin are required for Futures.');
      return;
    }
    if (type === 'FUT' && parseFloat(initialMargin) <= 0) {
      notify('Initial margin must be a positive number.');
      return;
    }
    const normalizedTimeframeSettings = {};
    for (const tf of TIMEFRAME_ORDER) {
      const entry = timeframeSettings?.[tf] || DEFAULT_TIMEFRAME_SETTINGS[tf];
      normalizedTimeframeSettings[tf] = { enabled: !!entry.enabled };
    }
    if (!Object.values(normalizedTimeframeSettings).some(t => t.enabled)) {
      notify('At least one timeframe must be enabled.');
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
        currency: currency || 'USD',
        rollover_months: rolloverMonthsArray,
        initial_margin: type === 'FUT' ? parseFloat(initialMargin) : null,
        timeframe_settings: normalizedTimeframeSettings,
        ibkr_symbol: type === 'STK' ? (ibkrSymbol.trim() || null) : null,
        ibkr_exchange: type === 'STK' ? (ibkrExchange.trim() || null) : null,
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
        currency: 'USD',
        rolloverMonths: '',
        initialMargin: '',
        timeframeSettings: DEFAULT_TIMEFRAME_SETTINGS,
        ibkrSymbol: '',
        ibkrExchange: '',
      });
    } catch (err) {
      notify('Error saving symbol setting: ' + err.message);
    }
  };

  const saveExchange = async () => {
    const { name, timezone, opening_hours } = exchangeForm;
    if (!name || !timezone || !opening_hours) {
      notify('Name, timezone, and opening hours are required.');
      return;
    }
    if (!currentAccountId) {
      notify('No account selected. Please select an account.');
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
      notify('Error saving exchange: ' + err.message);
    }
  };

  const handleDeleteSymbol = async (symbol, type) => {
    if (await confirmDialog(`Are you sure you want to delete the settings for ${symbol}?`)) {
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
        notify('Error deleting symbol setting: ' + err.message);
      }
      await refreshFuturesSettings();
    }
  };

  const handleDeleteHistoricalData = async () => {
    if (!selectedHistoricalSymbol) return;
    const [symbol, type] = splitSymbolKey(selectedHistoricalSymbol);
    if (await confirmDialog(`Are you sure you want to delete all historical data for ${symbol} (${type})? This action cannot be undone.`)) {
      try {
        const res = await fetch(`${apiBaseUrl}/api/historical-data?symbol=${symbol}&type=${type}`, {
          method: 'DELETE',
          headers: { 'X-Account-ID': currentAccountId },
        });
        if (!res.ok) {
          const error = await res.json();
          throw new Error(error.error || 'Failed to delete historical data');
        }
        notify('Historical data deleted successfully');
        await refreshHistoricalSummary();
      } catch (err) {
        notify('Error deleting historical data: ' + err.message);
      }
    }
  };

  const handleDeleteExchange = async (id) => {
    if (await confirmDialog(`Are you sure you want to delete the exchange?`)) {
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
        notify('Error deleting exchange: ' + err.message);
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
      const [symbol, type] = splitSymbolKey(selectedHistoricalSymbol);
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
        notify(`Error: ${err.message}`);
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
    const [symbol, type] = splitSymbolKey(selectedHistoricalSymbol);
    try {
      const res = await fetch(`${apiBaseUrl}/api/historical/summary?symbol=${symbol}&type=${type}`);
      if (!res.ok) throw new Error('Failed to refresh summary');
      const data = await res.json();
      setHistoricalSummary(data);
    } catch (err) {
      console.error(err);
      notify(`Error refreshing summary: ${err.message}`);
    } finally {
      setIsLoadingSummary(false);
    }
  };

  const handleSaveRollover = async () => {
    if (!editingRollover || !rolloverDate) return;
    setIsSaving(true);
    const [symbol, type] = splitSymbolKey(selectedHistoricalSymbol);
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
      notify('Rollover override saved. The continuous series is rebuilt.');
      handleCloseRolloverModal();
      await refreshHistoricalSummary();
    } catch (err) {
      if (err.name === 'AbortError') {
        notify('Save operation timed out. The rebuild might still be in progress. Please check back later.');
      } else {
        notify(`Error saving rollover: ${err.message}`);
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleFetchSymbolHistoricalData = async () => {
    if (!selectedHistoricalSymbol) return;
    const [symbol, type] = splitSymbolKey(selectedHistoricalSymbol);

    // Indicate to the user that the action is in progress
    setHistoricalFetchStatus(`Queuing fetch tasks for ${symbol} (${type})...`);
    setIsFetchingSymbolHistoricalData(true);

    try {
      if (!await confirmDialog(`Are you sure you want to queue data fetching tasks for ${symbol} (${type}) for all timeframes? This may take some time.`)) {
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
      notify(result.message || `Successfully queued fetching tasks for ${symbol}. Check the fetch queue below for progress.`);
    } catch (err) {
      setHistoricalFetchStatus(`Error: ${err.message}`);
      notify('Error: ' + err.message);
    } finally {
      setIsFetchingSymbolHistoricalData(false);
    }
  };

  const handleDeleteRolloverOverride = async () => {
    if (!editingRollover || !editingRollover.rollover_type === 'MANUAL') {
      notify('This is not a manual override and cannot be deleted.');
      return;
    }
    if (!await confirmDialog('Are you sure you want to delete this manual override? The system will revert to volume-based rollover for this date.')) return;

    setIsDeleting(true); // Set deleting state
    const [symbol, type] = splitSymbolKey(selectedHistoricalSymbol);
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
      notify('Override deleted. The continuous series is rebuilt.');
      handleCloseRolloverModal();
      await refreshHistoricalSummary();
    } catch (err) {
      if (err.name === 'AbortError') {
        notify('Delete operation timed out. The rebuild might still be in progress. Please check back later.');
      } else {
        notify(`Error deleting override: ${err.message}`);
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
      if (!await confirmDialog('Are you sure you want to queue data fetching tasks for all configured symbols? This may take a long time and consume API resources.')) {
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
      notify(result.message || 'Successfully queued all fetching tasks. Check the fetch queue below for progress.');
    } catch (err) {
      setHistoricalFetchStatus(`Error: ${err.message}`);
      notify('Error: ' + err.message);
    } finally {
      setIsFetchingAllHistoricalData(false);
    }
  };

  const handleDeleteAllHistoricalData = async () => {
    if (await confirmDialog('DANGER: Are you sure you want to delete ALL historical data from the database? This action cannot be undone.')) {
      try {
        const res = await fetch(`${apiBaseUrl}/api/historical-data/all`, {
          method: 'DELETE',
          headers: { 'X-Account-ID': currentAccountId },
        });
        if (!res.ok) {
          const error = await res.json();
          throw new Error(error.error || 'Failed to delete historical data');
        }
        notify('All historical data has been deleted.');
        // Refresh the summary if a symbol is selected, which will now show as empty
        if (selectedHistoricalSymbol) {
          refreshHistoricalSummary();
        }
      } catch (err) {
        notify('Error: ' + err.message);
      }
    }
  };

  const handleRebuildAllContinuousData = async () => {
    if (!await confirmDialog('Rebuild the continuous series for every futures symbol? This scans each symbol\'s full history and can take a while — progress is reported via the status log.')) {
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
      notify(result.message || 'Continuous series rebuild started for all symbols.');
    } catch (err) {
      notify('Error: ' + err.message);
    } finally {
      setIsRebuildingAllContinuous(false);
    }
  };

  const handleRecalculateContinuous = async (timeframe) => {
    if (!selectedHistoricalSymbol) return;
    const [symbol, type] = splitSymbolKey(selectedHistoricalSymbol);
    notify(`Continuous series rebuild initiated for ${symbol} (${type}). The summary will refresh automatically upon completion.`);

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
      notify('Error initiating rebuild: ' + err.message);
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
    notify('Please select a symbol first.');
    return;
  }

  const [symbol, type] = splitSymbolKey(selectedHistoricalSymbol);
  if (!symbol || !type) {
    notify('Invalid selected symbol/type.');
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
      notify('No historical data available for this selection.');
      return;
    }

    // Filter by source (Yahoo vs IBKR), matching DB `source` field
    const filtered = data.filter(
      (bar) =>
        typeof bar.source === 'string' &&
        bar.source.toUpperCase() === source.toUpperCase()
    );

    if (filtered.length === 0) {
      notify(`No ${source} data found for this selection.`);
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
    notify(`Error exporting CSV: ${err.message}`);
  }
};

  useEffect(() => {
    if (!selectedHistoricalSymbol || activeTab !== 'historical') return;
    refreshHistoricalSummary();
  }, [selectedHistoricalSymbol, activeTab, apiBaseUrl]);

  return (
    <div className={styles.settings}>
      <div className={styles.settingsLayout}>
      <nav
        className={styles.sideNav}
        aria-label="Settings sections"
        style={{ visibility: showFuturesModal || showExchangeModal ? 'hidden' : 'visible' }}
      >
        {/* Phones pick the section here: one line instead of a menu (see .tabSelect). */}
        <select
          className={styles.tabSelect}
          value={activeTab}
          onChange={e => setActiveTab(e.target.value)}
          aria-label="Settings section"
        >
          {SECTIONS.map(({ id, label }) => (
            <option key={id} value={id} disabled={!dbStatus?.isConnected && id !== 'general' && id !== 'logs'}>{label}</option>
          ))}
        </select>
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={`${styles.navButton} ${activeTab === id ? styles.navActive : ''}`}
            onClick={() => setActiveTab(id)}
            disabled={!dbStatus?.isConnected && id !== 'general' && id !== 'logs'}
            aria-current={activeTab === id ? 'page' : undefined}
          >
            <Icon className={styles.navIcon} aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <div className={styles.contentColumn}>
      {(() => {
        const section = SECTIONS.find(x => x.id === activeTab) || SECTIONS[0];
        return (
          <header className={styles.sectionHeader}>
            <div className={styles.sectionHeading}>
              <h2>{section.label}</h2>
              <p>{section.description}</p>
            </div>
            <div className={styles.sectionAction}>
              {activeTab === 'accounts' && dbStatus?.isConnected && (
                <BubbleButton onClick={() => openAccountModal(null)}><FaPlus aria-hidden="true" /> Add account</BubbleButton>
              )}
              {activeTab === 'symbols' && dbStatus?.isConnected && (
                <BubbleButton onClick={() => openModalForEdit(null)}><FaPlus aria-hidden="true" /> Add symbol</BubbleButton>
              )}
              {activeTab === 'exchanges' && dbStatus?.isConnected && (
                <BubbleButton onClick={() => openExchangeModal()}><FaPlus aria-hidden="true" /> Add exchange</BubbleButton>
              )}
              {activeTab === 'historical' && dbStatus?.isConnected && (
                <select
                  value={selectedHistoricalSymbol}
                  onChange={handleHistoricalSymbolChange}
                  className={`${styles.inputBubble} ${styles.histSymbolSelect}`}
                  aria-label="Symbol"
                >
                  <option value="">Choose a symbol…</option>
                  {historicalSymbols.map(({ symbol, type }) => (
                    <option key={`${symbol}-${type}`} value={`${symbol}-${type}`}>
                      {symbol} ({type})
                    </option>
                  ))}
                </select>
              )}
            </div>
          </header>
        );
      })()}
      <div className={styles.tabContent}>
        {activeTab === 'general' && (
          <div className={styles.stack}>
            <section className={styles.card}>
              <div className={styles.cardHeader}>
                <div>
                  <h3>Database</h3>
                  <p>The PostgreSQL database the journal keeps everything in. Changing it restarts the server.</p>
                </div>
                {dbStatus && <StatusPill ok={dbStatus.isConnected} okText="Connected" badText={dbStatus.status || 'Not connected'} />}
              </div>
              <div className={styles.formField}>
                <label htmlFor="databaseUrl">Connection URL</label>
                <div className={styles.inputWithButton}>
                  {showDbUrl ? (
                    <input
                      id="databaseUrl"
                      name="databaseUrl"
                      value={settings.databaseUrl}
                      onChange={handleSettingChange}
                      className={styles.inputBubble}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="postgresql://user:password@host:port/dbname"
                    />
                  ) : (
                    <input
                      id="databaseUrl"
                      value={maskDbUrl(settings.databaseUrl)}
                      readOnly
                      onFocus={() => setShowDbUrl(true)}
                      className={styles.inputBubble}
                      placeholder="postgresql://user:password@host:port/dbname"
                    />
                  )}
                  <button
                    type="button"
                    className={styles.ghostIconButton}
                    onClick={() => setShowDbUrl(v => !v)}
                    title={showDbUrl ? 'Hide the password' : 'Show and edit'}
                    aria-label={showDbUrl ? 'Hide the password' : 'Show and edit the connection URL'}
                  >
                    {showDbUrl ? <FaEyeSlash /> : <FaEye />}
                  </button>
                </div>
              </div>
            </section>

            <section className={styles.card}>
              <div className={styles.cardHeader}>
                <div>
                  <h3>Display</h3>
                  <p>Applied straight away.</p>
                </div>
              </div>
              <div className={styles.formGrid}>
                <div className={styles.formField}>
                  <label htmlFor="numberFormat">Number format</label>
                  <select
                    id="numberFormat"
                    value={numberFormat}
                    onChange={(e) => saveNumberFormat(e.target.value)}
                    className={styles.inputBubble}
                  >
                    {NUMBER_FORMATS.map(f => (
                      <option key={f.value} value={f.value}>{f.label}</option>
                    ))}
                  </select>
                  <span className={styles.fieldHint}>On every device.</span>
                </div>
                <div className={styles.formField}>
                  <label htmlFor="tradesPerPage">Trades per page</label>
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
                  <span className={styles.fieldHint}>For this account.</span>
                </div>
              </div>
            </section>

          </div>
        )}
        {activeTab === 'logs' && (() => {
          const entries = parseLogLines(serverLogs);
          const counts = entries.reduce((acc, e) => ({ ...acc, [e.level]: (acc[e.level] || 0) + 1 }), {});
          const shown = logLevelFilter === 'all' ? entries : entries.filter(e => e.level === logLevelFilter);
          return (
            <section className={styles.card}>
              <div className={styles.logsToolbar}>
                <div className={styles.segmented} role="group" aria-label="Show levels">
                  {['all', 'error', 'warn', 'info', 'debug'].filter(l => l === 'all' || counts[l]).map(level => (
                    <button
                      key={level}
                      type="button"
                      className={`${styles.segment} ${logLevelFilter === level ? styles.segmentOn : ''}`}
                      onClick={() => setLogLevelFilter(level)}
                    >
                      {level === 'all' ? 'All' : level.charAt(0).toUpperCase() + level.slice(1)}
                      <span className={styles.segmentCount}>{level === 'all' ? entries.length : counts[level]}</span>
                    </button>
                  ))}
                </div>
                <div className={styles.logsControls}>
                  <label htmlFor="logLines">Lines</label>
                  <select
                    id="logLines"
                    value={logLines}
                    onChange={(e) => { const n = parseInt(e.target.value, 10); setLogLines(n); fetchServerLogs(n); }}
                    className={`${styles.inputBubble} ${styles.compactSelect}`}
                  >
                    {[100, 200, 500, 1000, 2000].map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                  <button
                    type="button"
                    className={styles.ghostIconButton}
                    onClick={() => fetchServerLogs()}
                    disabled={logsLoading}
                    title="Refresh"
                    aria-label="Refresh the log"
                  >
                    <FaSyncAlt className={logsLoading ? styles.spinning : ''} />
                  </button>
                </div>
              </div>
              <div className={styles.logView} role="log">
                {shown.length === 0 && <div className={styles.logEmpty}>{logsLoading ? 'Loading…' : 'Nothing to show.'}</div>}
                {shown.map(entry => (
                  <div key={entry.id} className={styles.logLine}>
                    <span className={`${styles.logLevel} ${styles[`level_${entry.level}`] || ''}`}>{entry.level}</span>
                    <span className={styles.logTime}>{entry.timestamp ? DateTime.fromISO(entry.timestamp).toFormat('dd LLL HH:mm:ss') : ''}</span>
                    <span className={styles.logMessage}>{entry.message}</span>
                  </div>
                ))}
              </div>
            </section>
          );
        })()}
        {activeTab === 'checklists' && dbStatus?.isConnected && (
          <section className={styles.card}>
            <ChecklistSettings styles={styles} apiBaseUrl={apiBaseUrl} />
          </section>
        )}
        {activeTab === 'accounts' && dbStatus?.isConnected && (
          <div className={styles.accountsTab}>
            <div className={styles.tableCard}>
              <table className={`responsive-table ${styles.table}`}>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Parent</th>
                    <th>Mode</th>
                    <th title="Where this account's cash is actually held">Custodian</th>
                    <th>Status</th>
                    <th className={styles.actionsCell} aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {[...accounts].sort((a, b) => a.name.localeCompare(b.name)).map((acc, index) => (
                    <tr key={acc.id}>
                      <td className={styles.primaryCell}>{acc.name}</td>
                      <td>
                        {acc.parent_account_id ? (accounts.find(a => a.id === acc.parent_account_id)?.name || '—') : '—'}
                      </td>
                      <td>
                        <span className={`${styles.badge} ${acc.is_virtual ? styles.badgeAmber : styles.badgeGreen}`}>{acc.is_virtual ? 'Paper' : 'Real'}</span>
                      </td>
                      <td>
                        {acc.custodian || <span style={{ opacity: 0.5 }}>—</span>}
                        {acc.custodian_is_us === true && <span className={`${styles.badge} ${styles.badgeSubtle}`}>US</span>}
                        {acc.custodian_is_us === false && <span className={`${styles.badge} ${styles.badgeSubtle}`}>non-US</span>}
                        {(acc.custodian_is_us === null || acc.custodian_is_us === undefined) && <span className={styles.muted}> unclassified</span>}
                      </td>
                      <td>{acc.id === parseInt(currentAccountId) && <span className={`${styles.badge} ${styles.badgeBlue}`}>Current</span>}</td>
                      <td className={styles.actionsCell}>
                        <span className={styles.rowActions}>
                          <IconButton size="small" icon="pencil" label={`Edit ${acc.name}`} onClick={() => openAccountModal(acc)} />
                          <IconButton size="small" icon="trash" label={`Delete ${acc.name}`} onClick={() => handleDeleteAccount(acc.id)} />
                        </span>
                      </td>
                    </tr>
                  ))}
                  {accounts.length === 0 && (
                    <tr>
                      <td colSpan="6" className={styles.emptyCell}>No accounts configured</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {showAccountModal && (
          <div className={styles.overlay}>
            <div className={styles.modal}>
              <div className={styles.header}>
                <span className={styles.title}>{editingAccountId ? 'Edit Account' : 'Add Account'}</span>
                <button className={styles.closeBtn} onClick={() => setShowAccountModal(false)}>×</button>
              </div>
              <div className={styles.formGrid}>
                <div className={styles.formField}>
                  <label htmlFor="accountName">Name</label>
                  <input
                    id="accountName"
                    value={accountForm.name}
                    onChange={e => setAccountForm(prev => ({ ...prev, name: e.target.value }))}
                    className={styles.inputBubble}
                    autoComplete="off"
                  />
                </div>
                <div className={styles.formField}>
                  <label htmlFor="accountParent">Parent account</label>
                  <select
                    id="accountParent"
                    value={accountForm.parent_account_id}
                    onChange={e => setAccountForm(prev => ({ ...prev, parent_account_id: e.target.value }))}
                    className={styles.inputBubble}
                  >
                    <option value="">None (top-level)</option>
                    {accounts.filter(a => !unavailableParentIds.has(a.id)).map(a => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </div>
                {(() => {
                  // A parent/child group is the same real account at the same
                  // real custodian — is_virtual/custodian/custodian_is_us
                  // can't differ from the parent's, so once a parent is
                  // chosen these three become read-only, showing the
                  // parent's own live values (what will actually be saved —
                  // the backend ignores whatever this form holds for them in
                  // that case). See routes/accounts.js.
                  const parentAccount = accountForm.parent_account_id
                    ? accounts.find(a => String(a.id) === String(accountForm.parent_account_id))
                    : null;
                  const inherited = !!parentAccount;
                  const displayIsVirtual = inherited ? !!parentAccount.is_virtual : accountForm.is_virtual;
                  const displayCustodian = inherited ? (parentAccount.custodian || '') : accountForm.custodian;
                  const displayCustodianIsUs = inherited
                    ? (parentAccount.custodian_is_us === null || parentAccount.custodian_is_us === undefined ? '' : String(parentAccount.custodian_is_us))
                    : accountForm.custodian_is_us;
                  return (
                    <>
                      <div className={styles.formField}>
                        <label htmlFor="accountVirtual" title="Every trade and cash transaction in this account is treated as paper/simulated — not a per-transaction choice. If this account graduates to real trading, use a separate real account instead of flipping this later.">
                          <input
                            id="accountVirtual"
                            type="checkbox"
                            checked={displayIsVirtual}
                            disabled={inherited}
                            onChange={e => setAccountForm(prev => ({ ...prev, is_virtual: e.target.checked }))}
                            style={{ marginRight: '8px' }}
                          />
                          Paper / virtual account (all trades and cash here are simulated)
                          {inherited && <span style={{ opacity: 0.6 }}> — inherited from {parentAccount.name}</span>}
                        </label>
                      </div>
                      <div className={styles.formField}>
                        <label htmlFor="accountCustodian" title="Where this account's cash is actually held — a different fact from is_virtual or which securities are traded. Free text.">
                          Custodian{inherited && <span style={{ opacity: 0.6 }}> — inherited from {parentAccount.name}</span>}
                        </label>
                        <input
                          id="accountCustodian"
                          value={displayCustodian}
                          disabled={inherited}
                          placeholder="e.g. IBKR LLC, IBKR Ireland, Kraken"
                          onChange={e => setAccountForm(prev => ({ ...prev, custodian: e.target.value }))}
                          className={styles.inputBubble}
                          autoComplete="off"
                        />
                      </div>
                      <div className={styles.formField}>
                        <label htmlFor="accountCustodianIsUs" title="Whether the custodian above is a US entity — left as 'Not set' means unclassified, not confirmed non-US.">
                          Custodian is a US entity?{inherited && <span style={{ opacity: 0.6 }}> — inherited from {parentAccount.name}</span>}
                        </label>
                        <select
                          id="accountCustodianIsUs"
                          value={displayCustodianIsUs}
                          disabled={inherited}
                          onChange={e => setAccountForm(prev => ({ ...prev, custodian_is_us: e.target.value }))}
                          className={styles.inputBubble}
                        >
                          <option value="">Not set</option>
                          <option value="true">US entity</option>
                          <option value="false">Non-US entity</option>
                        </select>
                      </div>
                      <div className={styles.formField}>
                        <label htmlFor="accountBrokerId" title="The broker's own account number this journal account mirrors (for IBKR, the one shown in Client Portal). Imported cash activity such as dividends is booked on the journal account mapped to it.">
                          Broker account ID{inherited && <span style={{ opacity: 0.6 }}> — uses {parentAccount.name}'s</span>}
                        </label>
                        <input
                          id="accountBrokerId"
                          value={inherited ? (parentAccount.broker_account_id || '') : accountForm.broker_account_id}
                          disabled={inherited}
                          placeholder="optional, e.g. U1234567"
                          onChange={e => setAccountForm(prev => ({ ...prev, broker_account_id: e.target.value.toUpperCase() }))}
                          className={styles.inputBubble}
                          autoComplete="off"
                        />
                      </div>
                    </>
                  );
                })()}
              </div>
              <div className={styles.footerRow}>
                <IconButton icon="check" caption="Save" label="Save the account" onClick={saveAccountForm} />
              </div>
            </div>
          </div>
        )}
        {activeTab === 'symbols' && dbStatus?.isConnected && (
          <div className={styles.futuresTab}>
            <h3 className={styles.groupTitle}>Defaults <span>for symbols without their own settings</span></h3>
            <div className={styles.tableCard}>
              <table className={`responsive-table ${styles.table}`}>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Type</th>
                    <th>Tick Size</th>
                    <th>Tick Value</th>
                    <th>Rollover Months</th>
                    <th>Initial Margin</th>
                    <th>Fee</th>
                    <th>Exchange</th>
                    <th className={styles.actionsCell} aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {defaultSettings.map((setting, index) => (
                    <tr key={setting.type}>
                      <td className={styles.primaryCell}>{setting.symbol}</td>
                      <td><span className={`${styles.badge} ${setting.type === 'FUT' ? styles.badgeViolet : styles.badgeTeal}`}>{setting.type}</span></td>
                      <td>{setting.type === 'FUT' ? setting.tick_size : '-'}</td>
                      <td>{setting.type === 'FUT' ? setting.tick_value : '-'}</td>
                      <td>{setting.type === 'FUT' ? setting.rollover_months.join(', ') : '-'}</td>
                      <td>{setting.type === 'FUT' ? setting.initial_margin : '-'}</td>
                      <td>{setting.fee}</td>
                      <td>{setting.exchange || 'N/A'}</td>
                      <td className={styles.actionsCell}>
                        <span className={styles.rowActions}>
                          <IconButton size="small" icon="pencil" label="Edit the default settings" onClick={() => openModalForEdit(setting)} />
                        </span>
                      </td>
                    </tr>
                  ))}
                  {defaultSettings.length === 0 && (
                    <tr>
                      <td colSpan="9" className={styles.emptyCell}>
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
            <h3 className={styles.groupTitle}>Stocks <span>{stkSymbols.length}</span></h3>
            <div className={styles.tableCard}>
              <table className={`responsive-table ${styles.table}`}>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Type</th>
                    <th>Fee</th>
                    <th>Exchange</th>
                    <th className={styles.actionsCell} aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {stkSymbols.map((setting, index) => (
                    <tr key={`${setting.symbol}-${setting.type}`}>
                      <td className={styles.primaryCell}>{setting.symbol}</td>
                      <td><span className={`${styles.badge} ${setting.type === 'FUT' ? styles.badgeViolet : styles.badgeTeal}`}>{setting.type}</span></td>
                      <td>{setting.fee}</td>
                      <td>{setting.exchange || 'N/A'}</td>
                      <td className={styles.actionsCell}>
                        <span className={styles.rowActions}>
                          <IconButton size="small" icon="pencil" label={`Edit ${setting.symbol}`} onClick={() => openModalForEdit(setting)} />
                          <IconButton size="small" icon="trash" label={`Delete ${setting.symbol}`} onClick={() => handleDeleteSymbol(setting.symbol, setting.type)} />
                        </span>
                      </td>
                    </tr>
                  ))}
                  {stkSymbols.length === 0 && (
                    <tr>
                      <td colSpan="5" className={styles.emptyCell}>No stock symbols configured</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <h3 className={styles.groupTitle}>Futures <span>{futSymbols.length}</span></h3>
            <div className={styles.tableCard}>
              <table className={`responsive-table ${styles.table}`}>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Type</th>
                    <th>Tick Size</th>
                    <th>Tick Value</th>
                    <th>Rollover Months</th>
                    <th>Initial Margin</th>
                    <th>Fee</th>
                    <th>Exchange</th>
                    <th className={styles.actionsCell} aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {futSymbols.map((setting, index) => (
                    <tr key={`${setting.symbol}-${setting.type}`}>
                      <td className={styles.primaryCell}>{setting.symbol}</td>
                      <td><span className={`${styles.badge} ${setting.type === 'FUT' ? styles.badgeViolet : styles.badgeTeal}`}>{setting.type}</span></td>
                      <td>{setting.tick_size}</td>
                      <td>{setting.tick_value}</td>
                      <td>{setting.rollover_months.join(', ')}</td>
                      <td>{setting.initial_margin}</td>
                      <td>{setting.fee}</td>
                      <td>{setting.exchange || 'N/A'}</td>
                      <td className={styles.actionsCell}>
                        <span className={styles.rowActions}>
                          <IconButton size="small" icon="pencil" label={`Edit ${setting.symbol}`} onClick={() => openModalForEdit(setting)} />
                          <IconButton size="small" icon="trash" label={`Delete ${setting.symbol}`} onClick={() => handleDeleteSymbol(setting.symbol, setting.type)} />
                        </span>
                      </td>
                    </tr>
                  ))}
                  {futSymbols.length === 0 && (
                    <tr>
                      <td colSpan="9" className={styles.emptyCell}>No futures symbols configured</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {activeTab === 'tws' && dbStatus?.isConnected && (
          <div className={`${styles.twsTab} ${styles.stack}`}>
            <section className={styles.card}>
            <div className={styles.cardHeader}>
              <div>
                <h3>TWS</h3>
                <p>Your own TWS or IB Gateway, logged into the account whose trades get imported. The secondary address is tried when the first doesn't answer.</p>
              </div>
              <StatusPill ok={!!dbStatus?.ibkrConnected} okText="Connected" badText="Idle" neutral={!dbStatus?.ibkrConnected} />
            </div>
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
            </section>
            <section className={styles.card}>
            <div className={styles.cardHeader}>
              <div>
                <h3>Historical data connection <span className={styles.optional}>optional</span></h3>
                <p>
                  Where historical bars and contract lookups come from, e.g. a headless IB Gateway that
                  is always running, so charts don't need TWS open. Any login with market data works,
                  including a paper login. Leave the address empty to use the TWS addresses above.
                  Trade imports from TWS always use the addresses above.
                </p>
              </div>
              <StatusPill ok={!!dbStatus?.ibkrDataConnected} okText="Connected" badText="Idle" neutral={!dbStatus?.ibkrDataConnected} />
            </div>
            <div className={styles.formGrid}>
              <div className={styles.formField}>
                <label htmlFor="ibkrDataHost">Address</label>
                <input
                  id="ibkrDataHost"
                  value={settings.ibkrDataAddress.host}
                  onChange={(e) => setSettings(prev => ({ ...prev, ibkrDataAddress: { ...prev.ibkrDataAddress, host: e.target.value } }))}
                  className={styles.inputBubble}
                  autoComplete="off"
                  placeholder="e.g., ib-gateway"
                />
              </div>
              <div className={styles.formField}>
                <label htmlFor="ibkrDataPort">Port</label>
                <input
                  id="ibkrDataPort"
                  type="number"
                  value={settings.ibkrDataAddress.port}
                  onChange={(e) => setSettings(prev => ({ ...prev, ibkrDataAddress: { ...prev.ibkrDataAddress, port: e.target.value } }))}
                  className={styles.inputBubble}
                  autoComplete="off"
                  placeholder="4004"
                  min="1024"
                  max="65535"
                />
              </div>
            </div>
            <h4 className={styles.subheading}>Gateway auto-reconnect <span className={styles.optional}>optional</span></h4>
            <p className={styles.subtext}>
              IB Gateway can stay connected while no longer answering historical-data requests
              (the HIS light turns red). If it runs with IBC's command server enabled, the journal
              then asks it to reconnect (RECONNECTDATA), at most every 15 minutes. Enter IBC's
              command server here; leave empty to switch this off. See docs/SETUP.md for the IBC side.
            </p>
            <div className={styles.formGrid}>
              <div className={styles.formField}>
                <label htmlFor="ibkrGatewayCommandHost">Command server address</label>
                <input
                  id="ibkrGatewayCommandHost"
                  value={settings.ibkrGatewayCommandAddress.host}
                  onChange={(e) => setSettings(prev => ({ ...prev, ibkrGatewayCommandAddress: { ...prev.ibkrGatewayCommandAddress, host: e.target.value } }))}
                  className={styles.inputBubble}
                  autoComplete="off"
                  placeholder="e.g., ib-gateway"
                />
              </div>
              <div className={styles.formField}>
                <label htmlFor="ibkrGatewayCommandPort">Port</label>
                <input
                  id="ibkrGatewayCommandPort"
                  type="number"
                  value={settings.ibkrGatewayCommandAddress.port}
                  onChange={(e) => setSettings(prev => ({ ...prev, ibkrGatewayCommandAddress: { ...prev.ibkrGatewayCommandAddress, port: e.target.value } }))}
                  className={styles.inputBubble}
                  autoComplete="off"
                  placeholder="7462"
                  min="1024"
                  max="65535"
                />
              </div>
            </div>
            </section>
            <section className={styles.card}>
            <div className={styles.cardHeader}>
              <div>
                <h3>Flex Web Service <span className={styles.optional}>no TWS needed</span></h3>
                <p>
                  Paper and real IBKR accounts are separate accounts on IB's side, so each needs its own
                  Flex Web Service token and Query IDs. Which set a journal account uses follows its own
                  Paper/Real setting (Accounts). Per set: one token and two saved Flex Queries on IB's
                  side. The Activity query covers your history (up to 365 days, refreshed end of day); the
                  Trade Confirmation query fills in today's trades (ready ~15-30 min after each fill).
                </p>
              </div>
            </div>
            <div className={styles.flexSets}>
            <div className={styles.innerCard}>
            <div className={styles.innerHeader}>
              <h4>Real accounts</h4>
              <StatusPill ok={!!dbStatus?.ibkrFlexTokenRealSet} okText="Token set" badText="No token" neutral={!dbStatus?.ibkrFlexTokenRealSet} />
            </div>
            <div className={styles.formGrid}>
              <div className={styles.formField}>
                <label htmlFor="ibkrFlexTokenReal">Flex Token</label>
                <input
                  id="ibkrFlexTokenReal"
                  type="password"
                  value={newIbkrFlexTokenReal}
                  onChange={(e) => setNewIbkrFlexTokenReal(e.target.value)}
                  className={styles.inputBubble}
                  autoComplete="off"
                  placeholder={dbStatus?.ibkrFlexTokenRealSet ? '********' : 'Enter Flex Token'}
                />
              </div>
              <div className={styles.formField}>
                <label htmlFor="ibkrFlexQueryIdActivityReal">Activity Query ID (historical)</label>
                <input
                  id="ibkrFlexQueryIdActivityReal"
                  name="ibkrFlexQueryIdActivityReal"
                  value={settings.ibkrFlexQueryIdActivityReal}
                  onChange={handleSettingChange}
                  className={styles.inputBubble}
                  autoComplete="off"
                  placeholder="e.g., 1234567"
                />
              </div>
              <div className={styles.formField}>
                <label htmlFor="ibkrFlexQueryIdTradeConfReal">Trade Confirmation Query ID (today)</label>
                <input
                  id="ibkrFlexQueryIdTradeConfReal"
                  name="ibkrFlexQueryIdTradeConfReal"
                  value={settings.ibkrFlexQueryIdTradeConfReal}
                  onChange={handleSettingChange}
                  className={styles.inputBubble}
                  autoComplete="off"
                  placeholder="e.g., 1234568"
                />
              </div>
            </div>
            </div>
            <div className={styles.innerCard}>
            <div className={styles.innerHeader}>
              <h4>Paper accounts</h4>
              <StatusPill ok={!!dbStatus?.ibkrFlexTokenPaperSet} okText="Token set" badText="No token" neutral={!dbStatus?.ibkrFlexTokenPaperSet} />
            </div>
            <div className={styles.formGrid}>
              <div className={styles.formField}>
                <label htmlFor="ibkrFlexTokenPaper">Flex Token</label>
                <input
                  id="ibkrFlexTokenPaper"
                  type="password"
                  value={newIbkrFlexTokenPaper}
                  onChange={(e) => setNewIbkrFlexTokenPaper(e.target.value)}
                  className={styles.inputBubble}
                  autoComplete="off"
                  placeholder={dbStatus?.ibkrFlexTokenPaperSet ? '********' : 'Enter Flex Token'}
                />
              </div>
              <div className={styles.formField}>
                <label htmlFor="ibkrFlexQueryIdActivityPaper">Activity Query ID (historical)</label>
                <input
                  id="ibkrFlexQueryIdActivityPaper"
                  name="ibkrFlexQueryIdActivityPaper"
                  value={settings.ibkrFlexQueryIdActivityPaper}
                  onChange={handleSettingChange}
                  className={styles.inputBubble}
                  autoComplete="off"
                  placeholder="e.g., 1234567"
                />
              </div>
              <div className={styles.formField}>
                <label htmlFor="ibkrFlexQueryIdTradeConfPaper">Trade Confirmation Query ID (today)</label>
                <input
                  id="ibkrFlexQueryIdTradeConfPaper"
                  name="ibkrFlexQueryIdTradeConfPaper"
                  value={settings.ibkrFlexQueryIdTradeConfPaper}
                  onChange={handleSettingChange}
                  className={styles.inputBubble}
                  autoComplete="off"
                  placeholder="e.g., 1234568"
                />
              </div>
            </div>
            </div>
            </div>
            </section>
          </div>
        )}
        {activeTab === 'exchanges' && dbStatus?.isConnected && (
          <div className={styles.exchangesTab}>
            <div className={styles.tableCard}>
              <table className={`responsive-table ${styles.table}`}>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Timezone</th>
                    <th>Open Slots</th>
                    <th className={styles.actionsCell} aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {[...exchanges]
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((exchange, index) => (
                      <tr key={exchange.id}>
                        <td className={styles.primaryCell}>{exchange.name}</td>
                        <td>{exchange.timezone}</td>
                        <td>{exchange.opening_hours.flat().filter(h => h).length}</td>
                        <td className={styles.actionsCell}>
                          <span className={styles.rowActions}>
                            <IconButton size="small" icon="pencil" label={`Edit ${exchange.name}`} onClick={() => openExchangeModal(exchange)} />
                            <IconButton size="small" icon="trash" label={`Delete ${exchange.name}`} onClick={() => handleDeleteExchange(exchange.id)} />
                          </span>
                        </td>
                      </tr>
                    ))}
                  {(!Array.isArray(exchanges) || exchanges.length === 0) && (
                    <tr>
                      <td colSpan="4" className={styles.emptyCell}>No exchanges configured</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {activeTab === 'historical' && dbStatus?.isConnected && (
          <div className={styles.historicalTab}>
            {!selectedHistoricalSymbol && !isLoadingSummary && (
              <div className={styles.histPlaceholder}>Choose a symbol to see its coverage, contracts and rollovers.</div>
            )}
            {isLoadingSummary && (
              <div className={styles.histPlaceholder}>
                <span className={styles.inlineSpinner} />
                Loading {splitSymbolKey(selectedHistoricalSymbol)[0]}… a symbol with years of 1-minute bars takes a few seconds.
              </div>
            )}
            {historicalSummary && !isLoadingSummary && (
              <>
                <HistoricalDataSummary
                  key={selectedHistoricalSymbol}
                  summary={historicalSummary}
                  type={splitSymbolKey(selectedHistoricalSymbol)[1]}
                  onEditRollover={handleEditRollover}
                  onExportCsv={handleExportCsv}
                />
                <section className={styles.histCard}>
                  <h4 className={styles.histCardTitle}>{splitSymbolKey(selectedHistoricalSymbol)[0]} actions</h4>
                  <div className={styles.histActions}>
                    <BubbleButton onClick={handleFetchSymbolHistoricalData} color={ACTION_COLORS.import} disabled={isFetchingSymbolHistoricalData || isFetchingAllHistoricalData}>
                      {isFetchingSymbolHistoricalData ? 'Fetching…' : 'Fetch Historical Data'}
                    </BubbleButton>
                    {splitSymbolKey(selectedHistoricalSymbol)[1] === 'FUT' && (
                      <BubbleButton onClick={handleRecalculateContinuous} color={ACTION_COLORS.primary} disabled={isFetchingSymbolHistoricalData || isFetchingAllHistoricalData}>
                        Recalculate Continuous Series
                      </BubbleButton>
                    )}
                    <BubbleButton onClick={handleDeleteHistoricalData} color={ACTION_COLORS.danger} disabled={isFetchingSymbolHistoricalData || isFetchingAllHistoricalData}>
                      Delete Historical Data
                    </BubbleButton>
                  </div>
                </section>
              </>
            )}
            <section className={styles.histCard}>
              <h4 className={styles.histCardTitle}>All symbols</h4>
              <p className={styles.histCardHint}>These actions affect every symbol in the historical database.</p>
              <div className={styles.histActions}>
                <BubbleButton onClick={handleFetchAllHistoricalData} color={ACTION_COLORS.import} disabled={isFetchingSymbolHistoricalData || isFetchingAllHistoricalData}>
                  {isFetchingAllHistoricalData ? 'Fetching all…' : 'Fetch All Historical Data'}
                </BubbleButton>
                <BubbleButton onClick={handleRebuildAllContinuousData} color={ACTION_COLORS.primary} disabled={isRebuildingAllContinuous}>
                  {isRebuildingAllContinuous ? 'Starting rebuild…' : 'Rebuild All Continuous Series'}
                </BubbleButton>
                <BubbleButton onClick={handleDeleteAllHistoricalData} color={ACTION_COLORS.danger} disabled={isFetchingSymbolHistoricalData || isFetchingAllHistoricalData}>
                  Delete All Historical Data
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
            </section>
          </div>
        )}
      </div>
      {(activeTab === 'general' || activeTab === 'tws') && (
        <div className={styles.saveBar}>
          <span>Connection changes take effect when saved.</span>
          <IconButton icon="check" caption="Save" label="Save settings" onClick={handleSave} />
        </div>
      )}
      </div>
      </div>
      {showFuturesModal && (
        <div className={styles.overlay}>
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
              <div className={styles.formField}>
                <label htmlFor="currency">Currency</label>
                <input
                  id="currency"
                  name="currency"
                  value={form.currency}
                  onChange={handleFuturesFormChange}
                  className={styles.inputBubble}
                  autoComplete="off"
                  maxLength={3}
                  placeholder="USD"
                  title="ISO currency code this symbol is priced/traded in (e.g. USD, EUR, AED) — used for cash settlement and IBKR contract lookups, not just display."
                />
              </div>
              {form.type === 'STK' && (
                <>
                  <div className={styles.formField}>
                    <label htmlFor="ibkrSymbol" title="Only if IBKR names this differently than worked out automatically. A Yahoo-style symbol like XEON.DE is already looked up at IBKR as XEON on Xetra.">IBKR symbol (optional)</label>
                    <input
                      id="ibkrSymbol"
                      name="ibkrSymbol"
                      value={form.ibkrSymbol}
                      onChange={handleFuturesFormChange}
                      className={styles.inputBubble}
                      autoComplete="off"
                      placeholder="automatic"
                    />
                  </div>
                  <div className={styles.formField}>
                    <label htmlFor="ibkrExchange" title="IBKR's code for the listing exchange (e.g. IBIS, AEB, LSEETF), only if the automatic one is wrong.">IBKR exchange (optional)</label>
                    <input
                      id="ibkrExchange"
                      name="ibkrExchange"
                      value={form.ibkrExchange}
                      onChange={handleFuturesFormChange}
                      className={styles.inputBubble}
                      autoComplete="off"
                      placeholder="automatic"
                    />
                  </div>
                </>
              )}
            </div>
            <div className={styles.divider} />
            <div>
              <h3 style={{ margin: '0 0 4px' }}>Timeframes to Fetch</h3>
              <p style={{ margin: '0 0 12px', fontSize: '0.85rem', opacity: 0.8 }}>
                Choose which timeframes to fetch and keep updated for this symbol. Each enabled timeframe is always
                fetched as far back as the data provider allows — no need to specify how much history to keep.
              </p>
              <table className={styles.miniTable}>
                <thead>
                  <tr>
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
              <IconButton icon="check" caption="Save" label="Save the symbol" onClick={saveFuturesSetting} />
            </div>
          </div>
        </div>
      )}
      {showExchangeModal && (
        <div className={styles.overlay}>
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
              <IconButton icon="check" caption="Save" label="Save the exchange" onClick={saveExchange} />
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
            <div className={styles.footerRow} style={{ justifyContent: 'flex-end', gap: 12 }}>
              <div>
                {editingRollover.rollover_type === 'MANUAL' && (
                  <IconButton icon="trash" caption="Delete" label="Delete this rollover override" onClick={handleDeleteRolloverOverride} busy={isDeleting} />
                )}
              </div>
              <IconButton icon="check" caption={isSaving ? 'Rebuilding…' : 'Save'} label="Save the rollover and rebuild the continuous series" onClick={handleSaveRollover} busy={isSaving} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}