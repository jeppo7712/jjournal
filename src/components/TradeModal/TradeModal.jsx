import React, { useContext, useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import ReactQuill from 'react-quill';
import { useDropzone } from 'react-dropzone';
import 'react-quill/dist/quill.snow.css';
import { TradeContext, calculateRisk, getEnabledTimeframesForSetting } from '../../context/TradeContext';
import styles from './TradeModal.module.css';
import { DateTime } from 'luxon';
import { loadStoredDisplayTimezone, storeDisplayTimezone, resolveDisplayZone, TimezonePicker } from '../../utils/timezonePreference';
import TradeFormChart from './TradeFormChart';

const onlyNumber = val => /^-?\d*[,.\d]*$/.test(val);
const validTimeFormat = val => /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(val);
const validExpression = val => /^[0-9+\-*/().\s]*$/.test(val);

function formatCacheAge(fetchedAtMs) {
  const seconds = Math.max(0, Math.round((Date.now() - fetchedAtMs) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  return `${minutes} min${minutes !== 1 ? 's' : ''} ago`;
}

function getFuturesSettings(symbol, type, futuresSettings) {
  if (!symbol || !type) {
    const defaultSetting = futuresSettings.find(s => s.symbol === 'DEFAULT' && s.type === type) ||
                          futuresSettings.find(s => s.symbol === 'DEFAULT');
    if (!defaultSetting) {
      console.warn(`No default settings found for type ${type}`);
    }
    return defaultSetting || null;
  }
  const upperSymbol = symbol.toUpperCase();
  const specificSettings = futuresSettings
    .filter(s => s.symbol !== 'DEFAULT' && s.type === type)
    .sort((a, b) => b.symbol.length - a.symbol.length);
  const matchingSetting = specificSettings.find(s => upperSymbol.startsWith(s.symbol));
  if (matchingSetting) {
    return matchingSetting;
  }
  const defaultSetting = futuresSettings.find(s => s.symbol === 'DEFAULT' && s.type === type) || futuresSettings.find(s => s.symbol === 'DEFAULT');
  if (!defaultSetting) {
      console.warn(`No settings found for symbol ${symbol} and type ${type}`);
  }
  return defaultSetting || null;
}

function isFormDirty(form, actions, tags, notes, confidence, executionRating, attachments, initial, isEditMode) {
  if (isEditMode) {
    if (!initial) return false;
    if (
      form.symbol !== initial.form.symbol ||
      form.target !== initial.form.target ||
      form.stopLoss !== initial.form.stopLoss ||
      form.tickSize !== initial.form.tickSize ||
      form.tickValue !== initial.form.tickValue ||
      form.type !== initial.form.type ||
      tags !== initial.tags ||
      notes !== initial.notes ||
      confidence !== initial.confidence ||
      executionRating !== initial.executionRating ||
      attachments.length !== initial.attachments.length
    ) return true;
    if (actions.length !== initial.actions.length) return true;
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i], b = initial.actions[i];
      if (!b || a.type !== b.type || a.quantity !== b.quantity || a.price !== b.price || a.fee !== b.fee || a.dateTime.toISO() !== b.dateTime.toISO()) return true;
    }
    return false;
  } else {
    if (
      form.symbol ||
      form.target ||
      form.stopLoss ||
      form.type !== 'FUT' ||
      tags ||
      notes ||
      confidence !== 0 ||
      executionRating !== 0 ||
      attachments.length > 0
    ) return true;
    if (actions.length > 1) return true;
    const a = actions[0];
    const now = DateTime.now();
    const timeDiff = Math.abs(a.dateTime.toMillis() - now.toMillis());
    if (
      a.type !== 'BUY' ||
      a.quantity !== 1 ||
      a.price !== '' ||
      timeDiff > 60000
    ) return true;
    return false;
  }
}

// `small` shrinks padding/font/radius for mobile, where these were full
// desktop size regardless of viewport — fine for one row of buttons, but
// this modal's footer can have up to 5 of them stacked, and full-size made
// each one take a disproportionate share of a phone screen's height.
function BubbleButton({ children, onClick, color = '#3B82F6', disabled, small, ...rest }) {
  return (
    <button
      className={styles.saveBtn}
      style={small ? {
        background: color,
        borderRadius: 12,
        padding: '7px 14px',
        fontSize: '0.9rem',
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer'
      } : {
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

function StarRating({ value, onChange, max = 5 }) {
  return (
    <div className={styles.starRating}>
      {[...Array(max)].map((_, i) => (
        <span
          key={i}
          className={`${styles.star} ${i < value ? styles.filled : ''}`}
          onClick={() => onChange(i + 1)}
        >
          ★
        </span>
      ))}
    </div>
  );
}

export default function TradeModal({ trade, onClose }) {
  const { refreshTrades, currentAccountId, futuresSettings, trades } = useContext(TradeContext);
  const isEditMode = !!trade;

  const defaultSettings = futuresSettings.find(s => s.symbol === 'DEFAULT') || {};
  const initialTickSize = defaultSettings.tick_size?.toString() || '0.1';
  const initialTickValue = defaultSettings.tick_value?.toString() || '5';
  const initialFee = defaultSettings.fee || 2.47;

  const stockDefaults = {
    type: 'STK',
    tickSize: '0.01',
    tickValue: '1',
    fee: 0.005,
  };

  const [displayTimezone, setDisplayTimezoneState] = useState(loadStoredDisplayTimezone);
  const setDisplayTimezone = useCallback((value) => {
    setDisplayTimezoneState(value);
    storeDisplayTimezone(value);
  }, []);
  const [showFormChart, setShowFormChart] = useState(false);
  // Matches TradeModal.module.css's own `@media (max-width: 600px)`
  // breakpoint — tracked in JS too because the modal's width/layout below is
  // driven by inline styles (to animate smoothly when the chart opens/
  // closes), and inline styles always win over a CSS class's media query on
  // the same element. Without this, the modal silently stayed desktop-sized
  // on mobile no matter what the stylesheet said.
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 600px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 600px)');
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  const [form, setForm] = useState({
    type: isEditMode ? trade.type : 'FUT',
    symbol: isEditMode ? trade.symbol : '',
    target: isEditMode ? trade.target : '',
    stopLoss: isEditMode ? (trade.stopLoss || trade.stop_loss || '') : '',
    tickSize: isEditMode ? (trade.tickSize || trade.tick_size || '') : initialTickSize,
    tickValue: isEditMode ? (trade.tickValue || trade.tick_value || '') : initialTickValue,
    contract_month: isEditMode ? trade.contract_month : '',
  });

  const exchangeTimezone = useMemo(() => {
    const symbol = isEditMode ? trade.symbol : form.symbol;
    const type = isEditMode ? trade.type : form.type;
    const setting = getFuturesSettings(symbol, type, futuresSettings);
    return setting?.timezone || 'America/New_York';
  }, [isEditMode, trade, form.symbol, form.type, futuresSettings]);

  // Only offer timeframes the symbol is actually set up to fetch on the
  // reference chart — a deselected timeframe never gets populated, so its
  // button used to lead to a chart stuck empty with no way to know why.
  const enabledTimeframes = useMemo(() => {
    const symbol = isEditMode ? trade.symbol : form.symbol;
    const type = isEditMode ? trade.type : form.type;
    const setting = getFuturesSettings(symbol, type, futuresSettings);
    return getEnabledTimeframesForSetting(setting?.timeframe_settings);
  }, [isEditMode, trade, form.symbol, form.type, futuresSettings]);

  // Just for formatting marker labels on the reference chart — derived from
  // tick size's own decimal places rather than a dedicated setting.
  const formPricePrecision = useMemo(() => {
    const tickSizeStr = String(form.tickSize || '');
    const dotIndex = tickSizeStr.indexOf('.');
    return dotIndex === -1 ? 0 : tickSizeStr.length - dotIndex - 1;
  }, [form.tickSize]);

  const initialActions = useMemo(() => [
    { 
      type: 'BUY', 
      dateTime: DateTime.now().setZone(exchangeTimezone), 
      quantity: 1, 
      price: '', 
      fee: initialFee.toString() 
    },
  ], [exchangeTimezone, initialFee]);

  const [actions, setActions] = useState(() => {
    if (!isEditMode) return initialActions;
    return trade.actions.map(a => {
      let dateTime;
      if (typeof a.dateTime === 'string') {
        dateTime = DateTime.fromISO(a.dateTime, { zone: 'utc' });
      } else if (a.dateTime instanceof Date) {
        dateTime = DateTime.fromJSDate(a.dateTime, { zone: 'utc' });
      } else {
        console.warn(`Invalid dateTime type for action: ${typeof a.dateTime}`, a);
        dateTime = DateTime.now().setZone(exchangeTimezone);
      }
      if (!dateTime.isValid) {
        console.warn(`Invalid dateTime value: ${a.dateTime}, falling back to current time in ${exchangeTimezone}`);
        dateTime = DateTime.now().setZone(exchangeTimezone);
      }
      return {
        ...a,
        dateTime: dateTime.setZone(exchangeTimezone, { keepLocalTime: false }),
        fee: String(a.fee)
      };
    });
  });

  const [activeTab, setActiveTab] = useState('general');
  const [touched, setTouched] = useState(isEditMode ? actions.map(() => ({})) : [{}]);
  const [tags, setTags] = useState(isEditMode ? (trade.journal?.tags || '') : '');
  const [notes, setNotes] = useState(isEditMode ? (trade.journal?.notes_html || '') : '');
  const [confidence, setConfidence] = useState(isEditMode ? (trade.journal?.confidence || 0) : 0);
  const [executionRating, setExecutionRating] = useState(isEditMode ? (trade.journal?.execution_rating || 0) : 0);
  const [attachments, setAttachments] = useState(
    isEditMode
      ? (trade.attachments || []).map(att => ({
          ...att,
          preview: att.image_base64 && att.mime_type
            ? `data:${att.mime_type};base64,${att.image_base64}`
            : undefined,
          attachment_id: att.id
        }))
      : []
  );
  const [showUnsavedPopup, setShowUnsavedPopup] = useState(false);
  const [showDeletePopup, setShowDeletePopup] = useState(false);
  const [selectedAttachment, setSelectedAttachment] = useState(null);
  const [tempTimeInputs, setTempTimeInputs] = useState([]);
  const [showIBKRModal, setShowIBKRModal] = useState(false);
  const [ibkrGroups, setIbkrGroups] = useState([]);      // bracket groups returned by /trade-groups
  const [ibkrOrphans, setIbkrOrphans] = useState([]);    // executions with no order info
  const [ibkrLoading, setIbkrLoading] = useState(false);
  const [ibkrError, setIbkrError] = useState(null);
  const [ibkrSource, setIbkrSource] = useState('tws'); // 'tws' (today's session) or 'flex' (historical)
  const [ibkrFetchedAt, setIbkrFetchedAt] = useState(null); // ms timestamp of when Flex data was actually pulled from IBKR
  const [ibkrFromCache, setIbkrFromCache] = useState(false);
  const [ibkrWarning, setIbkrWarning] = useState(null); // set when one of two Flex queries failed but the other still returned data
  const [startDate, setStartDate] = useState(DateTime.now().minus({ days: 7 }).toISODate());
  const [addedIbkrItemIds, setAddedIbkrItemIds] = useState(new Set());
  const [expandedGroups, setExpandedGroups] = useState(new Set());
  const [showAlreadyImported, setShowAlreadyImported] = useState(false);
  const timeInputRefs = useRef([]);

  const initialState = useRef(isEditMode ? {
    form: { ...form },
    actions: actions.map(a => ({ ...a, dateTime: a.dateTime })),
    tags, notes, confidence, executionRating, attachments: [...attachments]
  } : null);

  useEffect(() => {
    if (!isEditMode && form.symbol) {
      const savedTrade = trades?.reduce((latest, t) => {
        if (t.symbol.toUpperCase() === form.symbol.toUpperCase()) {
          const tDate = t.actions?.[0]?.dateTime ? DateTime.fromISO(t.actions[0].dateTime) : DateTime.fromMillis(0);
          const latestDate = latest ? (latest.actions?.[0]?.dateTime ? DateTime.fromISO(latest.actions[0].dateTime) : DateTime.fromMillis(0)) : DateTime.fromMillis(0);
          return !latest || tDate > latestDate ? t : latest;
        }
        return latest;
      }, null);

      if (savedTrade) {
        console.debug(`Found saved trade for ${form.symbol}:`, savedTrade);
        setForm(prev => ({
          ...prev,
          type: savedTrade.type || 'FUT',
          tickSize: savedTrade.tickSize || savedTrade.tick_size || (savedTrade.type === 'STK' ? stockDefaults.tickSize : initialTickSize),
          tickValue: savedTrade.tickValue || savedTrade.tick_value || (savedTrade.type === 'STK' ? stockDefaults.tickValue : initialTickValue),
        }));
        setActions(prevActions => prevActions.map(action => ({
          ...action,
          fee: String(savedTrade.fee || (savedTrade.type === 'STK' ? stockDefaults.fee : initialFee)),
          dateTime: action.dateTime.setZone(exchangeTimezone, { keepLocalTime: false })
        })));
      } else {
        const futSettings = getFuturesSettings(form.symbol, 'FUT', futuresSettings);
        const stkSettings = getFuturesSettings(form.symbol, 'STK', futuresSettings);
        
        let selectedSettings = futSettings;
        let selectedType = 'FUT';
        
        if (stkSettings && stkSettings.symbol !== 'DEFAULT') {
          selectedSettings = stkSettings;
          selectedType = 'STK';
        } else if (futSettings && futSettings.symbol !== 'DEFAULT') {
          selectedSettings = futSettings;
          selectedType = 'FUT';
        }

        if (selectedSettings) {
          console.debug(`Using settings for ${form.symbol} (type: ${selectedType}):`, selectedSettings);
          setForm(prev => ({
            ...prev,
            type: selectedType,
            tickSize: selectedSettings.tick_size?.toString() || (selectedType === 'STK' ? stockDefaults.tickSize : initialTickSize),
            tickValue: selectedSettings.tick_value?.toString() || (selectedType === 'STK' ? stockDefaults.tickValue : initialTickValue),
          }));
          setActions(prevActions => prevActions.map(action => ({
            ...action,
            fee: String(selectedSettings.fee || (selectedType === 'STK' ? stockDefaults.fee : initialFee)),
            dateTime: action.dateTime.setZone(exchangeTimezone, { keepLocalTime: false })
          })));
        } else {
          console.debug(`No settings or saved trades found for ${form.symbol}, defaulting to FUT`);
          setForm(prev => ({
            ...prev,
            type: 'FUT',
            tickSize: initialTickSize,
            tickValue: initialTickValue,
          }));
          setActions(prevActions => prevActions.map(action => ({
            ...action,
            fee: String(initialFee),
            dateTime: action.dateTime.setZone(exchangeTimezone, { keepLocalTime: false })
          })));
        }
      }
    }
  }, [form.symbol, futuresSettings, trades, isEditMode, initialTickSize, initialTickValue, initialFee, exchangeTimezone]);

  useEffect(() => {
    const newTempTimeInputs = actions.map((action, idx) => {
      if (!action.dateTime.isValid) {
        console.warn(`Invalid dateTime at index ${idx}:`, action.dateTime);
        return '00:00';
      }
      const dt = action.dateTime.setZone(resolveDisplayZone(displayTimezone, exchangeTimezone), { keepLocalTime: false });
      return dt.toFormat('HH:mm');
    });
    setTempTimeInputs(newTempTimeInputs);
    timeInputRefs.current = actions.map((_, idx) => timeInputRefs.current[idx] || React.createRef());
  }, [actions, displayTimezone, exchangeTimezone]);

  const risk = useMemo(() => {
    const tradeDataForRiskCalculation = {
      actions: actions,
      type: form.type,
      stop_loss: form.stopLoss,
      tick_size: form.tickSize,
      tick_value: form.tickValue,
    };
    return calculateRisk(tradeDataForRiskCalculation);
  }, [actions, form.type, form.stopLoss, form.tickSize, form.tickValue]);

  const actionErrors = actions.map((action, idx) => ({
    quantity: action.quantity === '' || !onlyNumber(action.quantity),
    price: action.price === '' || !onlyNumber(String(action.price).replace(',', '.')),
    fee: action.fee === '' || !onlyNumber(String(action.fee).replace(',', '.')),
    dateTime: tempTimeInputs[idx] !== '' && !validTimeFormat(tempTimeInputs[idx]) && touched[idx]?.dateTime,
  }));

  const formErrors = {
    symbol: !form.symbol,
    target: form.target === '' || !onlyNumber(form.target),
    stopLoss: form.stopLoss === '' || !onlyNumber(form.stopLoss),
    tickSize: form.tickSize === '' || !onlyNumber(form.tickSize),
    tickValue: form.tickValue === '' || !onlyNumber(form.tickValue),
  };

  const allActionsValid = actionErrors.every(err => !err.quantity && !err.price && !err.fee && !err.dateTime);
  const allFormValid = Object.values(formErrors).every(v => !v);
  const canSave = allActionsValid && allFormValid;

  const handleActionChange = (idx, field, value) => {
    const normalizedValue = ['price', 'quantity', 'fee'].includes(field) ? value.replace(',', '.') : value;
    setActions(actions =>
      actions.map((a, i) => i === idx ? { ...a, [field]: normalizedValue } : a)
    );
    setTouched(touched => touched.map((t, i) => i === idx ? { ...t, [field]: true } : t));
  };

  const handleFeeBlur = (idx) => {
    const feeValue = String(actions[idx].fee).replace(',', '.');
    if (validExpression(feeValue) && !onlyNumber(feeValue)) {
      try {
        const result = eval(feeValue);
        if (typeof result === 'number' && !isNaN(result) && result >= 0) {
          const roundedResult = result.toFixed(2);
          setActions(actions => actions.map((a, i) => i === idx ? { ...a, fee: String(roundedResult) } : a));
        } else {
          const settings = getFuturesSettings(form.symbol, form.type, futuresSettings);
          const defaultFee = settings ? settings.fee : (form.type === 'STK' ? stockDefaults.fee : initialFee);
          setActions(actions => actions.map((a, i) => i === idx ? { ...a, fee: String(defaultFee) } : a));
        }
      } catch (e) {
        const settings = getFuturesSettings(form.symbol, form.type, futuresSettings);
        const defaultFee = settings ? settings.fee : (form.type === 'STK' ? stockDefaults.fee : initialFee);
        setActions(actions => actions.map((a, i) => i === idx ? { ...a, fee: String(defaultFee) } : a));
      }
    } else if (feeValue === '' || !onlyNumber(feeValue)) {
      const settings = getFuturesSettings(form.symbol, form.type, futuresSettings);
      const defaultFee = settings ? settings.fee : (form.type === 'STK' ? stockDefaults.fee : initialFee);
      setActions(actions => actions.map((a, i) => i === idx ? { ...a, fee: String(defaultFee) } : a));
    }
  };

  const handleActionType = (idx, type) => {
    setActions(actions => actions.map((a, i) => (i === idx ? { ...a, type } : a)));
  };

  const handleRemoveAction = idx => {
    if (actions.length > 1) {
      setActions(actions => actions.filter((_, i) => i !== idx));
      setTouched(touched => touched.filter((_, i) => i !== idx));
      setTempTimeInputs(inputs => inputs.filter((_, i) => i !== idx));
      timeInputRefs.current = timeInputRefs.current.filter((_, i) => i !== idx);
    }
  };

  const handleAddAction = () => {
    setTouched(actions.map(() => ({ quantity: true, price: true, fee: true, dateTime: true })));
    if (allActionsValid) {
      const settings = getFuturesSettings(form.symbol, form.type, futuresSettings);
      const defaultFee = settings ? settings.fee : (form.type === 'STK' ? stockDefaults.fee : initialFee);
      const newDateTime = DateTime.now().setZone(exchangeTimezone);
      setActions(actions => [
        ...actions,
        { type: 'BUY', dateTime: newDateTime, quantity: 1, price: '', fee: String(defaultFee) },
      ]);
      setTouched(touched => [
        ...touched,
        { quantity: false, price: false, fee: false, dateTime: false },
      ]);
      setTempTimeInputs(inputs => [
        ...inputs,
        newDateTime.setZone(resolveDisplayZone(displayTimezone, exchangeTimezone)).toFormat('HH:mm'),
      ]);
      timeInputRefs.current.push(React.createRef());
    }
  };

  const handleFormChange = e => {
    const { name, value } = e.target;
    if (name === 'symbol') {
      setForm({ ...form, symbol: value.toUpperCase() });
    } else if (['target', 'stopLoss', 'tickSize', 'tickValue'].includes(name)) {
      const normalizedValue = value.replace(',', '.');
      if (normalizedValue === '' || onlyNumber(normalizedValue)) {
        setForm({ ...form, [name]: normalizedValue });
      }
    } else {
      setForm({ ...form, [name]: value });
    }
  };

  const handleDateChange = (idx, value) => {
    setTouched(touched => touched.map((t, i) => i === idx ? { ...t, dateTime: true } : t));
    setActions(actions => actions.map((a, i) => {
      if (i !== idx) return a;
      let newDate = DateTime.fromFormat(value, 'yyyy-MM-dd', { zone: resolveDisplayZone(displayTimezone, exchangeTimezone) });
      if (!newDate.isValid) {
        console.warn(`Invalid date input for action ${idx}: ${value}`);
        return a;
      }
      const currentTime = a.dateTime.setZone(resolveDisplayZone(displayTimezone, exchangeTimezone));
      newDate = newDate.set({ hour: currentTime.hour, minute: currentTime.minute });
      if (displayTimezone !== 'exchange') {
        newDate = newDate.setZone(exchangeTimezone);
      }
      return { ...a, dateTime: newDate };
    }));
  };

  const handleTimeKeyDown = (idx, e) => {
    const input = timeInputRefs.current[idx].current;
    const value = input.value || '00:00';
    const start = input.selectionStart;
    const key = e.key;

    if (['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(key)) return;
    e.preventDefault();
    if (!/[0-9]/.test(key)) return;

    let newValue = value.padEnd(5, '0');
    let newCursorPos = start + 1;

    if (start === 2) {
      newValue = newValue.slice(0, 3) + key + newValue.slice(4);
      newCursorPos = 4;
    } else if (start < 5) {
      if (start < 2) newValue = newValue.slice(0, start) + key + newValue.slice(start + 1);
      else if (start >= 3) newValue = newValue.slice(0, start) + key + newValue.slice(start + 1);
    } else return;

    input.value = newValue;
    setTempTimeInputs(prev => prev.map((v, i) => (i === idx ? newValue : v)));
    setTouched(touched => touched.map((t, i) => i === idx ? { ...t, dateTime: true } : t));
    input.setSelectionRange(newCursorPos, newCursorPos);

    if (validTimeFormat(newValue)) {
      setActions(actions => actions.map((a, i) => {
        if (i !== idx) return a;
        let newTime = DateTime.fromFormat(newValue, 'HH:mm', { zone: resolveDisplayZone(displayTimezone, exchangeTimezone) });
        if (!newTime.isValid) {
          console.warn(`Invalid time input for action ${idx}: ${newValue}`);
          return a;
        }
        const currentDate = a.dateTime.setZone(resolveDisplayZone(displayTimezone, exchangeTimezone));
        newTime = currentDate.set({ hour: newTime.hour, minute: newTime.minute });
        if (displayTimezone !== 'exchange') newTime = newTime.setZone(exchangeTimezone);
        return { ...a, dateTime: newTime };
      }));
    }
  };

  const handleTimeBlur = (idx) => {
    const input = timeInputRefs.current[idx].current;
    const value = input.value;
    if (validTimeFormat(value)) {
      let newTime = DateTime.fromFormat(value, 'HH:mm', { zone: resolveDisplayZone(displayTimezone, exchangeTimezone) });
      if (newTime.isValid) {
        const currentDate = actions[idx].dateTime.setZone(resolveDisplayZone(displayTimezone, exchangeTimezone));
        newTime = currentDate.set({ hour: newTime.hour, minute: newTime.minute });
        if (displayTimezone !== 'exchange') newTime = newTime.setZone(exchangeTimezone);
        setActions(actions => actions.map((a, i) => i === idx ? { ...a, dateTime: newTime } : a));
        setTempTimeInputs(prev => prev.map((v, i) => i === idx ? value : v));
      } else {
        console.warn(`Invalid time on blur for action ${idx}: ${value}`);
        const displayTime = actions[idx].dateTime.isValid
          ? actions[idx].dateTime.setZone(resolveDisplayZone(displayTimezone, exchangeTimezone)).toFormat('HH:mm')
          : '00:00';
        setTempTimeInputs(prev => prev.map((v, i) => i === idx ? displayTime : v));
        input.value = displayTime;
      }
    } else {
      const displayTime = actions[idx].dateTime.isValid
        ? actions[idx].dateTime.setZone(resolveDisplayZone(displayTimezone, exchangeTimezone)).toFormat('HH:mm')
        : '00:00';
      setTempTimeInputs(prev => prev.map((v, i) => i === idx ? displayTime : v));
      input.value = displayTime;
    }
  };

  const onDrop = useCallback((acceptedFiles) => {
    setAttachments(prev => [
      ...prev,
      ...acceptedFiles.map(file => ({
        name: file.name,
        preview: URL.createObjectURL(file),
        file
      }))
    ]);
  }, []);
  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop, accept: {'image/*': []} });
  const handleRemoveAttachment = (idx) => {
    setAttachments(prev => prev.filter((_, i) => i !== idx));
  };

  const modalRef = useRef(null);
  const contentWrapperRef = useRef(null);
  const [modalHeight, setModalHeight] = useState(undefined);

  useLayoutEffect(() => {
    if (contentWrapperRef.current && modalRef.current) {
      requestAnimationFrame(() => {
        const h = contentWrapperRef.current.offsetHeight;
        setModalHeight(h > 50 ? h : undefined);
      });
    }
  }, [activeTab, actions.length, notes, tags, confidence, attachments.length, form]);

  const parseIBKRTime = (timeStr, zone) => {
    const [datePart, timePart] = timeStr.split(' ');
    const dateTimeStr = `${datePart} ${timePart}`;
    return DateTime.fromFormat(dateTimeStr, 'yyyyMMdd HH:mm:ss', { zone });
  };

  // IBKR Flex Web Service reports execution times in the timezone configured
  // for the Flex Query itself (an account-level setting in IBKR Account
  // Management), independent of the traded instrument's own exchange
  // timezone. TWS's live reqExecutions, by contrast, really does report in
  // the instrument's own exchange timezone. Empirically confirmed against a
  // known-correct fill time: this account's Flex Query reports in
  // America/New_York regardless of symbol/exchange.
  const FLEX_REPORTED_TIMEZONE = 'America/New_York';

  // Helper: convert a raw execution from /trade-groups (TWS, isFlexSource
  // false) or /trade-groups-flex (Flex, isFlexSource true) into a usable
  // object. Which one it came from matters — see FLEX_REPORTED_TIMEZONE above.
  const processRawExec = (exec, isFlexSource) => {
    const parseZone = isFlexSource ? FLEX_REPORTED_TIMEZONE : exchangeTimezone;
    const dt = parseIBKRTime(exec.time, parseZone);
    return {
      execId: exec.execId,
      orderId: exec.orderId,
      dateTime: dt.isValid ? dt : DateTime.now().setZone(exchangeTimezone),
      action: exec.side === 'BOT' ? 'BUY' : 'SELL',
      quantity: exec.quantity,
      price: exec.price.toString(),
      fee: exec.commission.toString(),
    };
  };

  const fetchIBKRData = async (historical = false, forceRefresh = false) => {
    if (!form.symbol) return;
    setIbkrLoading(true);
    setIbkrError(null);
    setIbkrWarning(null);
    setShowIBKRModal(true);
    setIbkrSource(historical ? 'flex' : 'tws');
    setShowAlreadyImported(false);
    try {
      const endpoint = historical ? 'trade-groups-flex' : 'trade-groups';
      const refreshParam = historical && forceRefresh ? '&refresh=true' : '';
      const res = await fetch(
        `${process.env.REACT_APP_API_URL}/api/ibkr/${endpoint}?symbol=${form.symbol}&type=${form.type}${refreshParam}`
      );
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      setIbkrFetchedAt(data.fetchedAt || null);
      setIbkrFromCache(!!data.fromCache);
      setIbkrWarning(data.warning || null);

      // Build the set of execIds already in this journal to avoid duplicate entries
      const existingExecIds = new Set(
        trades.flatMap(t => (t.actions || []).map(a => a.execId).filter(Boolean))
      );

      // Process each bracket group — attach processed executions
      const groups = (data.bracketGroups || []).map(group => ({
        ...group,
        entryExecutions: group.entryExecutions.map(e => processRawExec(e, historical)),
        tpExecutions:    group.tpExecutions.map(e => processRawExec(e, historical)),
        slExecutions:    group.slExecutions.map(e => processRawExec(e, historical)),
        otherChildren:   (group.otherChildren || []).map(c => ({
          ...c,
          executions: c.executions.map(e => processRawExec(e, historical)),
        })),
        // flag: all entry execs are already in the journal
        alreadyLogged: group.entryExecutions.length > 0 &&
          group.entryExecutions.every(e => existingExecIds.has(e.execId)),
      }));

      // Orphan executions (no bracket order data available)
      const orphans = (data.orphanExecutions || [])
        .filter(e => !existingExecIds.has(e.execId))
        .map(e => processRawExec(e, historical));

      setIbkrGroups(groups);
      setIbkrOrphans(orphans);
    } catch (err) {
      console.error('Error fetching IBKR trade groups:', err);
      setIbkrError(err.message);
      setIbkrGroups([]);
      setIbkrOrphans([]);
    } finally {
      setIbkrLoading(false);
    }
  };

  const handleAddAsAction = (item) => {
    const newAction = {
      type: item.action,
      dateTime: item.dateTime,
      quantity: item.quantity,
      price: item.price,
      fee: item.fee,
      execId: item.execId, // persisted so future fetches can recognize this exec as already imported
    };
    setActions(prev => [...prev, newAction]);
    setTouched(prev => [...prev, { quantity: true, price: true, fee: true, dateTime: true }]);
    setTempTimeInputs(prev => [
      ...prev,
      item.dateTime.toFormat('HH:mm'),
    ]);
    // Add the item's ID to the set of confirmed items for UI feedback
    setAddedIbkrItemIds(prev => new Set(prev).add(item.execId || item.orderId));
    timeInputRefs.current.push(React.createRef());
  };

  const handleSetAsTarget = (item) => {
    setForm(prev => ({ ...prev, target: item.price, targetConfirmed: true }));
  };

  const handleSetAsStopLoss = (item) => {
    setForm(prev => ({ ...prev, stopLoss: item.price, stopLossConfirmed: true }));
  };

  // Apply an entire bracket group to the trade form in one click
  const handleApplyTrade = (group) => {
    const allExecs = [
      ...group.entryExecutions,
      ...group.tpExecutions,
      ...group.slExecutions,
    ];

    if (allExecs.length === 0) return;

    // Build action rows from executions
    const newActions = allExecs.map(exec => ({
      type: exec.action,
      dateTime: exec.dateTime,
      quantity: exec.quantity,
      price: exec.price,
      fee: exec.fee,
      execId: exec.execId, // persisted so future fetches can recognize this exec as already imported
    }));

    setActions(newActions);
    setTouched(newActions.map(() => ({ quantity: true, price: true, fee: true, dateTime: true })));
    setTempTimeInputs(newActions.map(a => a.dateTime.toFormat('HH:mm')));
    // Ensure refs array is correct length
    timeInputRefs.current = newActions.map((_, i) => timeInputRefs.current[i] || React.createRef());

    // Set TP and SL from the order prices (the unexecuted order still holds the price)
    if (group.tpOrder && group.tpOrder.limitPrice != null) {
      setForm(prev => ({ ...prev, target: group.tpOrder.limitPrice.toString(), targetConfirmed: true }));
    }
    if (group.slOrder) {
      const slPrice = group.slOrder.stopPrice ?? group.slOrder.limitPrice;
      if (slPrice != null) {
        setForm(prev => ({ ...prev, stopLoss: slPrice.toString(), stopLossConfirmed: true }));
      }
    }

    // Mark all execIds as added for UI feedback
    setAddedIbkrItemIds(prev => {
      const next = new Set(prev);
      allExecs.forEach(e => next.add(e.execId));
      return next;
    });
  };

  // Toggle expand/collapse a bracket group card in the IBKR modal
  const toggleGroupExpand = (parentOrderId) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(parentOrderId)) next.delete(parentOrderId);
      else next.add(parentOrderId);
      return next;
    });
  };

  async function saveTrade() {
    for (let i = 0; i < attachments.length; i++) {
      if (!attachments[i].attachment_id && attachments[i].file) {
        const formData = new FormData();
        formData.append('file', attachments[i].file);
        const resp = await fetch(`${process.env.REACT_APP_API_URL}/api/attachments`, {
          method: 'POST',
          headers: { 'X-Account-ID': currentAccountId },
          body: formData
        });
        const data = await resp.json();
        attachments[i].attachment_id = data.attachment_id;
      }
    }
    const payload = {
      ...(isEditMode && { id: trade.id }),
      symbol: form.symbol,
      target: form.target,
      stopLoss: form.stopLoss,
      tickSize: form.tickSize,
      tickValue: form.tickValue,
      type: form.type,
      contract_month: form.contract_month,
      actions: actions.map(a => ({
        ...a,
        dateTime: a.dateTime.isValid ? a.dateTime.toISO() : DateTime.now().setZone(exchangeTimezone).toISO(),
      })),
      journal: { tags, notes_html: notes, confidence, execution_rating: executionRating },
      attachments: attachments.map(a => ({ attachment_id: a.attachment_id }))
    };
    const url = isEditMode
      ? `${process.env.REACT_APP_API_URL}/api/trades/${trade.id}`
      : `${process.env.REACT_APP_API_URL}/api/trades`;
    const method = isEditMode ? 'PUT' : 'POST';
    const resp = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Account-ID': currentAccountId,
      },
      body: JSON.stringify(payload)
    });
    if (resp.ok) {
      refreshTrades();
      onClose();
    } else {
      alert('Error saving trade');
    }
  }

  async function deleteTrade() {
    if (!isEditMode) return;
    const resp = await fetch(`${process.env.REACT_APP_API_URL}/api/trades/${trade.id}`, {
      method: 'DELETE',
      headers: { 'X-Account-ID': currentAccountId },
    });
    if (resp.ok) {
      refreshTrades();
      onClose();
    } else {
      alert('Error deleting trade');
    }
  }

  const handleRequestClose = () => {
    if (isFormDirty(form, actions, tags, notes, confidence, executionRating, attachments, initialState.current, isEditMode)) {
      setShowUnsavedPopup(true);
    } else {
      onClose();
    }
  };

  const quillModules = {
    toolbar: [
      ['bold', 'italic'],
      [{ 'header': [1, 2, false] }],
      [{ 'list': 'ordered'}, { 'list': 'bullet' }],
      ['link', 'image'],
      ['clean']
    ]
  };

  useEffect(() => {
    const styleId = 'quill-dark-toolbar-trade';
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style');
      style.id = styleId;
      style.innerHTML = `
        .${styles.modal} .${styles.richText} .ql-toolbar {
          background: #232733 !important;
          border-radius: 12px 12px 0 0 !important;
          border: none !important;
          color: #e0e2e6 !important;
        }
        .${styles.modal} .${styles.richText} .ql-toolbar button, 
        .${styles.modal} .${styles.richText} .ql-toolbar .ql-picker-label, 
        .${styles.modal} .${styles.richText} .ql-toolbar .ql-picker-item {
          color: #e0e2e6 !important;
          filter: brightness(1.5);
        }
        .${styles.modal} .${styles.richText} .ql-toolbar button.ql-active, 
        .${styles.modal} .${styles.richText} .ql-toolbar .ql-picker-label.ql-active,
        .${styles.modal} .${styles.richText} .ql-toolbar .ql-picker-item:hover {
          background: #3B82F6 !important;
          color: #fff !important;
        }
        .${styles.modal} .${styles.richText} .ql-toolbar .ql-picker-options {
          background: #232733 !important;
          border: none !important;
          borderRadius: 8px !important;
          color: #e0e2e6 !important;
        }
        .${styles.modal} .${styles.richText} .ql-container {
          background: #353943 !important;
          border-radius: 0 0 12px 12px !important;
          border: none !important;
          color: #e0e2e6 !important;
          min-height: 100px !important;
          max-height: 220px !important;
          overflow-y: auto !important;
        }
        .${styles.modal} .${styles.richText} .ql-editor {
          min-height: 120px !important;
          color: #e0e2e6 !important;
          border: none !important;
          padding: 12px 15px !important;
          background: transparent !important;
        }
        .${styles.modal} .${styles.richText} .ql-editor:focus {
          outline: none !important;
          border: none !important;
        }
        .${styles.modal} .${styles.richText} .ql-editor textarea {
          min-height: 220px !important;
          border: none !important;
          background: #353943 !important;
          color: #e0e2e6 !important;
          border-radius: 0 0 12px 12px !important;
        }
      `;
      document.head.appendChild(style);
    }
    return () => {
      const style = document.getElementById(styleId);
      if (style) document.head.removeChild(style);
    };
  }, []);

  return (
    <div className={styles.overlay}>
      <div
        className={styles.modal}
        ref={modalRef}
        style={isMobile ? {
          display: 'flex',
          flexDirection: 'column',
          width: '100vw',
          // Not 100vh: mobile browsers' collapsible address bar means 100vh
          // reports a taller height than what's actually visible whenever
          // the bar is showing — enough to push the footer's Save/Delete
          // buttons below the fold, outside the modal's own overflow:hidden
          // clip, genuinely unreachable rather than just requiring a scroll.
          // --vh (set in public/index.html from window.innerHeight, updated
          // on resize) is this app's existing fix for that; .app/html/body
          // already use it the same way in styles.css.
          height: 'calc(var(--vh, 1vh) * 100)',
          maxHeight: 'none',
          maxWidth: 'none',
          overflow: 'hidden',
          borderRadius: 0,
        } : {
          display: 'flex',
          flexDirection: 'column',
          maxHeight: '90vh',
          overflow: 'hidden',
          width: showFormChart ? 'min(1500px, 98vw)' : '700px',
          maxWidth: '98vw',
          transition: 'width 0.15s ease',
        }}
      >
        <div className={styles.headerRow}>
          <span className={styles.title}>{isEditMode ? 'Edit Trade' : 'New Trade'}</span>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}>
            <span style={{ color: '#A5ADBA', fontSize: '0.85em', fontWeight: 500 }}>
              Timezone
            </span>
            <TimezonePicker value={displayTimezone} onChange={setDisplayTimezone} />
          </div>
          <button className={styles.closeBtn} onClick={handleRequestClose}>×</button>
        </div>
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden', position: 'relative' }}>
        <div style={{ flex: (!isMobile && showFormChart) ? '0 0 700px' : '1 1 auto', display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        <div className={styles.tabsBar}>
          <button className={`${styles.tabBtn} ${activeTab === 'general' ? styles.activeTab : ''}`} onClick={() => setActiveTab('general')}>
            General
          </button>
          <button className={`${styles.tabBtn} ${activeTab === 'journal' ? styles.activeTab : ''}`} onClick={() => setActiveTab('journal')}>
            Journal
          </button>
        </div>
        <div className={styles.tabContent} ref={contentWrapperRef}>
          {activeTab === 'general' ? (
            <>
              <div className={styles.formGrid}>
                <div className={styles.formField}>
                  <label htmlFor="symbol">Symbol</label>
                  <input
                    id="symbol"
                    name="symbol"
                    value={form.symbol}
                    onChange={handleFormChange}
                    className={`${styles.inputBubble} ${formErrors.symbol ? styles.invalid : ''}`}
                    autoComplete="off"
                  />
                </div>
                <div className={styles.formField}>
                  <label htmlFor="type">Type</label>
                  <select
                    id="type"
                    name="type"
                    value={form.type}
                    onChange={handleFormChange}
                    className={styles.inputBubble}
                  >
                    <option value="FUT">Futures</option>
                    <option value="STK">Stock</option>
                  </select>
                </div>
                {1 === 0 && form.type === 'FUT' && (
                  <div className={styles.formField}>
                    <label htmlFor="contract_month">Contract Month</label>
                    <input
                      id="contract_month"
                      name="contract_month"
                      value={form.contract_month}
                      onChange={handleFormChange}
                      className={styles.inputBubble}
                      placeholder="YYYYMM"
                    />
                  </div>
                )}
                <div className={styles.formField}>
                  <label htmlFor="target">Target</label>
                  <input
                    id="target"
                    name="target"
                    value={form.target}
                    onChange={handleFormChange}
                    className={`${styles.inputBubble} ${formErrors.target ? styles.invalid : ''}`}
                    inputMode="decimal"
                  />
                </div>
                <div className={styles.formField}>
                  <label htmlFor="stopLoss">
                    Stop-Loss {risk !== null && <span style={{ fontWeight: 'normal' }}>(${risk.toFixed(2)})</span>}
                  </label>
                  <input
                    id="stopLoss"
                    name="stopLoss"
                    value={form.stopLoss}
                    onChange={handleFormChange}
                    className={`${styles.inputBubble} ${formErrors.stopLoss ? styles.invalid : ''}`}
                    inputMode="decimal"
                  />
                </div>
                {form.type === 'FUT' && (
                  <div className={styles.formField}>
                    <label htmlFor="tickSize">Tick Size</label>
                    <input
                      id="tickSize"
                      name="tickSize"
                      value={form.tickSize}
                      onChange={handleFormChange}
                      className={`${styles.inputBubble} ${formErrors.tickSize ? styles.invalid : ''}`}
                      inputMode="decimal"
                    />
                  </div>
                )}
                {form.type === 'FUT' && (
                  <div className={styles.formField}>
                    <label htmlFor="tickValue">Tick Value</label>
                    <input
                      id="tickValue"
                      name="tickValue"
                      value={form.tickValue}
                      onChange={handleFormChange}
                      className={`${styles.inputBubble} ${formErrors.tickValue ? styles.invalid : ''}`}
                      inputMode="decimal"
                    />
                  </div>
                )}
              </div>
              <div className={styles.actionsTable} style={{ maxHeight: actions.length > 4 ? 350 : 'none', overflowY: actions.length > 4 ? 'auto' : 'visible' }}>
                {actions.map((action, idx) => {
                  const displayDateTime = action.dateTime.isValid
                    ? action.dateTime.setZone(resolveDisplayZone(displayTimezone, exchangeTimezone))
                    : DateTime.now().setZone(resolveDisplayZone(displayTimezone, exchangeTimezone));
                  return (
                    <div className={styles.actionRow} key={action.execId || action.id || idx}>
                      <button
                        className={styles.actionRemove}
                        onClick={() => handleRemoveAction(idx)}
                        aria-label="Remove action"
                        disabled={actions.length === 1}
                      >
                        ×
                      </button>
                      <div className={styles.actionField}>
                        <label className={styles.actionLabel}>Action</label>
                        <button
                          className={`${styles.actionTypeBtn} ${action.type === 'BUY' ? styles.buy : styles.sell}`}
                          type="button"
                          style={{ width: 70 }}
                          onClick={() => handleActionType(idx, action.type === 'BUY' ? 'SELL' : 'BUY')}
                        >
                          {action.type}
                        </button>
                      </div>
                      <div className={styles.actionField}>
                        <label className={styles.actionLabel}>Date</label>
                        <input
                          type="date"
                          className={`${styles.actionInputBubble} ${touched[idx]?.dateTime && actionErrors[idx].dateTime ? styles.invalid : ''}`}
                          value={displayDateTime.toFormat('yyyy-MM-dd')}
                          onChange={e => handleDateChange(idx, e.target.value)}
                        />
                      </div>
                      <div className={styles.actionField}>
                        <label className={styles.actionLabel}>Time</label>
                        <input
                          className={`${styles.actionInputBubble} ${touched[idx]?.dateTime && actionErrors[idx].dateTime ? styles.invalid : ''}`}
                          type="text"
                          inputMode="numeric"
                          value={tempTimeInputs[idx] || ''}
                          ref={timeInputRefs.current[idx]}
                          onKeyDown={e => handleTimeKeyDown(idx, e)}
                          onBlur={() => handleTimeBlur(idx)}
                          onChange={e => {
                            const value = e.target.value;
                            setTempTimeInputs(prev => prev.map((v, i) => (i === idx ? value : v)));
                            setTouched(touched => touched.map((t, i) => i === idx ? { ...t, dateTime: true } : t));
                            if (validTimeFormat(value)) {
                              setActions(actions => actions.map((a, i) => {
                                if (i !== idx) return a;
                                let newTime = DateTime.fromFormat(value, 'HH:mm', { zone: resolveDisplayZone(displayTimezone, exchangeTimezone) });
                                if (!newTime.isValid) {
                                  console.warn(`Invalid time input for action ${idx}: ${value}`);
                                  return a;
                                }
                                const currentDate = a.dateTime.setZone(resolveDisplayZone(displayTimezone, exchangeTimezone));
                                newTime = currentDate.set({ hour: newTime.hour, minute: newTime.minute });
                                if (displayTimezone !== 'exchange') newTime = newTime.setZone(exchangeTimezone);
                                return { ...a, dateTime: newTime };
                              }));
                            }
                          }}
                          placeholder="HH:mm"
                          maxLength="5"
                        />
                      </div>
                      <div className={styles.actionField}>
                        <label className={styles.actionLabel}>Quantity</label>
                        <input
                          className={`${styles.actionInputBubble} ${touched[idx]?.quantity && actionErrors[idx].quantity ? styles.invalid : ''}`}
                          type="text"
                          value={action.quantity}
                          inputMode="decimal"
                          onChange={e => onlyNumber(e.target.value) && handleActionChange(idx, 'quantity', e.target.value)}
                        />
                      </div>
                      <div className={styles.actionField}>
                        <label className={styles.actionLabel}>Price</label>
                        <input
                          className={`${styles.actionInputBubble} ${touched[idx]?.price && actionErrors[idx].price ? styles.invalid : ''}`}
                          type="text"
                          value={action.price}
                          inputMode="decimal"
                          onChange={e => onlyNumber(e.target.value) && handleActionChange(idx, 'price', e.target.value)}
                        />
                      </div>
                      <div className={styles.actionField}>
                        <label className={styles.actionLabel}>Fee</label>
                        <input
                          className={`${styles.actionInputBubble} ${touched[idx]?.fee && actionErrors[idx].fee ? styles.invalid : ''}`}
                          type="text"
                          value={action.fee}
                          inputMode="text"
                          onChange={e => handleActionChange(idx, 'fee', e.target.value)}
                          onBlur={() => handleFeeBlur(idx)}
                        />
                      </div>
                    </div>
                  );
                })}
                <div className={styles.addActionRow}>
                  <button className={styles.addActionBtn} onClick={handleAddAction} disabled={!allActionsValid}>+</button>
                </div>
              </div>
            </>
          ) : (
            <div className={styles.journalTab}>
              <div className={styles.formFieldFull}>
                <label htmlFor="tags">Tags</label>
                <input
                  id="tags"
                  className={styles.inputBubble}
                  placeholder="Comma separated tags"
                  value={tags}
                  onChange={e => setTags(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <div className={styles.formFieldFull}>
                <label htmlFor="notes">Notes</label>
                <div className={styles.notesEditor}>
                  <ReactQuill
                    theme="snow"
                    value={notes}
                    onChange={setNotes}
                    className={styles.richText}
                    placeholder="Write your notes here..."
                    modules={quillModules}
                  />
                </div>
              </div>
              <div className={styles.ratingsRow}>
                <div className={styles.ratingItem}>
                  <label>Confidence</label>
                  <StarRating value={confidence} onChange={setConfidence} />
                </div>
                <div className={styles.ratingItem}>
                  <label>Execution</label>
                  <StarRating value={executionRating} onChange={setExecutionRating} />
                </div>
              </div>
              <div className={styles.uploadRow}>
                <div {...getRootProps({ className: styles.uploadBtn })}>
                  <input {...getInputProps()} />
                  <div className={styles.iconContainer}>
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" className={styles.uploadIcon}>
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                  </div>
                  {isDragActive ? "Drop images here..." : "Upload screenshots"}
                </div>
                <div className={styles.attachmentsPreview}>
                  {attachments.map((att, i) => {
                    const src = att.image_base64 && att.mime_type ? `data:${att.mime_type};base64,${att.image_base64}` : att.preview;
                    if (!src) return null;
                    return (
                      <div key={att.id || i} className={styles.attachmentThumb}>
                        <img
                          src={src}
                          alt={att.filename || att.name || 'attachment'}
                          style={{ width: 54, height: 54, borderRadius: 8, cursor: 'pointer' }}
                          onClick={() => setSelectedAttachment(src)}
                        />
                        <span className={styles.tooltip}>{att.filename || att.name || 'Unnamed file'}</span>
                        <button className={styles.attachmentRemove} onClick={() => handleRemoveAttachment(i)} type="button" aria-label="Remove attachment">×</button>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
        <div className={styles.footerRow}>
          <div style={{ marginRight: 'auto', display: 'flex', flexWrap: isMobile ? 'wrap' : 'nowrap', gap: 10 }}>
            <BubbleButton
              onClick={() => fetchIBKRData(true)}
              disabled={!form.symbol || ibkrLoading}
              color="#6366F1"
              small={isMobile}
            >
              {ibkrLoading && ibkrSource === 'flex' ? 'Loading...' : 'Fetch IBKR (Flex)'}
            </BubbleButton>
            <BubbleButton
              onClick={() => fetchIBKRData(false)}
              disabled={!form.symbol || ibkrLoading}
              color="#10B981"
              small={isMobile}
            >
              {ibkrLoading && ibkrSource === 'tws' ? 'Loading...' : 'Fetch TWS (fallback)'}
            </BubbleButton>
            <BubbleButton
              onClick={() => setShowFormChart(prev => !prev)}
              disabled={!form.symbol}
              color="#F59E0B"
              title="See the price action around your fills to help pick Stop-Loss / Target"
              small={isMobile}
            >
              {showFormChart ? 'Hide Chart' : 'Show Chart'}
            </BubbleButton>
          </div>
          <div>
            {isEditMode && (
              <BubbleButton onClick={() => setShowDeletePopup(true)} color="#EF4444" small={isMobile}>
                Delete
              </BubbleButton>
            )}
          </div>

          <BubbleButton onClick={saveTrade} disabled={!canSave} color="#3B82F6" small={isMobile}>
            Save
          </BubbleButton>
        </div>
        </div>
        {showFormChart && !isMobile && (
          <TradeFormChart
            symbol={form.symbol}
            type={form.type}
            actions={actions}
            exchangeTimezone={exchangeTimezone}
            displayTimezone={displayTimezone}
            pricePrecision={formPricePrecision}
            enabledTimeframes={enabledTimeframes}
            onClose={() => setShowFormChart(false)}
          />
        )}
        {showFormChart && isMobile && createPortal(
          <>
            {/* Backdrop: tapping outside the sheet closes it, same as the × inside.
                Rendered via a portal straight into <body> — nested inside .modal
                (which has overflow:hidden, as does an intermediate wrapper), a
                position:fixed backdrop here visually painted on top just fine but
                did NOT receive clicks over the header (elementFromPoint kept
                resolving to the header's contents instead of the backdrop) —
                a real Chromium hit-testing quirk with overflow:hidden ancestors
                and fixed descendants, not just theoretical. Escaping to <body>
                sidesteps it entirely instead of chasing z-index further. */}
            <div
              onClick={() => setShowFormChart(false)}
              style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1500 }}
            />
            {/* Bottom sheet: there's no room to show the chart beside the form on a
                phone screen, so on mobile it slides up over the form instead of
                sitting next to it — closer to how a native app would surface a
                secondary panel. */}
            <div
              style={{
                position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 1501,
                height: 'calc(var(--vh, 1vh) * 82)', maxHeight: 'calc(var(--vh, 1vh) * 82)',
                background: '#2a2d34', borderRadius: '18px 18px 0 0',
                boxShadow: '0 -4px 32px 0 rgba(0,0,0,0.35)',
                display: 'flex', flexDirection: 'column', overflow: 'hidden',
                animation: 'tradeFormChartSheetUp 0.2s ease-out',
              }}
            >
              <div style={{ width: 40, height: 4, borderRadius: 2, background: '#555b68', margin: '10px auto 0' }} />
              <TradeFormChart
                symbol={form.symbol}
                type={form.type}
                actions={actions}
                exchangeTimezone={exchangeTimezone}
                displayTimezone={displayTimezone}
                pricePrecision={formPricePrecision}
                enabledTimeframes={enabledTimeframes}
                onClose={() => setShowFormChart(false)}
                isMobile
              />
            </div>
          </>,
          document.body
        )}
        </div>
        {showUnsavedPopup && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {/* minWidth:320 + padding used to add up to more than a phone's own
                width before the buttons even laid out, and with 3 buttons
                (Cancel/Save/Don't Save) possible in one unwrapped row, this was
                the same "overflows off the edge, unreachable" failure as the
                footer buttons above — just easier to miss since it only shows
                up with a valid, unsaved trade (Save only renders when canSave). */}
            <div style={{ background: '#232733', borderRadius: 18, padding: isMobile ? '24px 20px 20px' : '36px 36px 28px 36px', minWidth: isMobile ? 0 : 320, maxWidth: '90vw', boxShadow: '0 4px 32px 0 rgba(0,0,0,0.18)', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div style={{ color: '#fff', fontSize: '1.12rem', marginBottom: 24, textAlign: 'center' }}>
                You have unsaved changes. What do you want to do?
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 12 }}>
                <BubbleButton color="#353943" onClick={() => setShowUnsavedPopup(false)} small={isMobile}>Cancel</BubbleButton>
                {canSave && <BubbleButton color="#3B82F6" onClick={() => { setShowUnsavedPopup(false); saveTrade(); }} small={isMobile}>Save</BubbleButton>}
                <BubbleButton color="#EF4444" onClick={() => { setShowUnsavedPopup(false); onClose(); }} small={isMobile}>Don't Save</BubbleButton>
              </div>
            </div>
          </div>
        )}
        {showDeletePopup && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ background: '#232733', borderRadius: 18, padding: isMobile ? '24px 20px 20px' : '36px 36px 28px 36px', minWidth: isMobile ? 0 : 320, maxWidth: '90vw', boxShadow: '0 4px 32px 0 rgba(0,0,0,0.18)', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div style={{ color: '#fff', fontSize: '1.12rem', marginBottom: 24, textAlign: 'center' }}>
                Are you sure you want to delete this trade? This cannot be undone.
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 18 }}>
                <BubbleButton color="#353943" onClick={() => setShowDeletePopup(false)} small={isMobile}>Cancel</BubbleButton>
                <BubbleButton color="#EF4444" onClick={deleteTrade} small={isMobile}>Delete</BubbleButton>
              </div>
            </div>
          </div>
        )}
        {selectedAttachment && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ background: '#232733', borderRadius: 18, padding: 16, maxWidth: '90vw', maxHeight: '90vh', position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <img src={selectedAttachment} alt="Full-size attachment" style={{ maxWidth: '100%', maxHeight: '80vh', borderRadius: 8, objectFit: 'contain' }} />
              <button
                onClick={() => setSelectedAttachment(null)}
                style={{
                  position: 'absolute',
                  top: -12,
                  right: -12,
                  background: '#ef4444',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '50%',
                  width: 32,
                  height: 32,
                  fontSize: '1.2em',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  zIndex: 2,
                  boxShadow: '0 2px 8px 0 rgba(0,0,0,0.22)',
                  lineHeight: 1,
                  padding: 0
                }}
              >
                ×
              </button>
            </div>
          </div>
        )}
        {showIBKRModal && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 2000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 40 }}>
            <div style={{ background: '#1a1d27', borderRadius: 16, padding: '24px', width: '100%', maxWidth: 700, maxHeight: '85vh', overflowY: 'auto', boxShadow: '0 8px 40px rgba(0,0,0,0.6)' }}>

              {/* Header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                <div>
                  <span style={{ color: '#fff', fontSize: '1.15rem', fontWeight: 600 }}>
                    IBKR — {form.symbol} Trade Groups
                    {ibkrSource === 'flex' && (
                      <span style={{ color: '#818CF8', fontSize: '0.75rem', marginLeft: 8, fontWeight: 500 }}>
                        (via Flex)
                      </span>
                    )}
                  </span>
                  {!ibkrLoading && (
                    <span style={{ color: '#6B7280', fontSize: '0.8rem', marginLeft: 10 }}>
                      {ibkrGroups.filter(g => !g.alreadyLogged).length} new group{ibkrGroups.filter(g => !g.alreadyLogged).length !== 1 ? 's' : ''}
                      {ibkrGroups.some(g => g.alreadyLogged) ? ` (+${ibkrGroups.filter(g => g.alreadyLogged).length} already imported)` : ''}
                      {ibkrOrphans.length > 0 ? ` + ${ibkrOrphans.length} ungrouped exec${ibkrOrphans.length !== 1 ? 's' : ''}` : ''}
                    </span>
                  )}
                  {!ibkrLoading && ibkrSource === 'flex' && ibkrFetchedAt && (
                    <div style={{ marginTop: 4 }}>
                      <span style={{ color: '#6B7280', fontSize: '0.72rem' }}>
                        {ibkrFromCache
                          ? `Cached · fetched ${formatCacheAge(ibkrFetchedAt)}`
                          : 'Freshly fetched from IBKR'}
                      </span>
                      <button
                        onClick={() => fetchIBKRData(true, true)}
                        style={{ marginLeft: 8, background: 'none', border: 'none', color: '#6366F1', cursor: 'pointer', fontSize: '0.72rem', padding: 0 }}
                      >
                        ↻ Refresh
                      </button>
                    </div>
                  )}
                  {!ibkrLoading && ibkrSource === 'flex' && ibkrWarning && (
                    <div style={{ marginTop: 6, padding: '6px 10px', background: 'rgba(245, 158, 11, 0.12)', border: '1px solid rgba(245, 158, 11, 0.35)', borderRadius: 6, color: '#F59E0B', fontSize: '0.75rem' }}>
                      ⚠ {ibkrWarning}
                    </div>
                  )}
                </div>
                <button onClick={() => setShowIBKRModal(false)} className={styles.closeBtn} style={{ fontSize: '1.4rem', lineHeight: 1, background: 'none', border: 'none', color: '#9CA3AF', cursor: 'pointer' }}>×</button>
              </div>

              {/* States */}
              {ibkrLoading && (
                <div style={{ textAlign: 'center', color: '#A5ADBA', padding: '40px 0' }}>
                  <div style={{ fontSize: '0.95rem' }}>
                    {ibkrSource === 'flex' ? 'Fetching trades via Flex…' : 'Fetching from IBKR TWS…'}
                  </div>
                  <div style={{ fontSize: '0.78rem', color: '#6B7280', marginTop: 6 }}>
                    {ibkrSource === 'flex' ? 'This can take up to 90 seconds' : 'This may take up to 30 seconds'}
                  </div>
                </div>
              )}

              {!ibkrLoading && ibkrError && (
                <div style={{ color: '#F87171', background: '#2D1B1B', borderRadius: 8, padding: '12px 16px', fontSize: '0.88rem' }}>
                  ⚠️ {ibkrError}
                </div>
              )}

              {!ibkrLoading && !ibkrError && ibkrGroups.length === 0 && ibkrOrphans.length === 0 && (
                <div style={{ textAlign: 'center', color: '#6B7280', padding: '40px 0', fontSize: '0.9rem' }}>
                  {ibkrSource === 'flex' ? (
                    <>
                      No trades found for {form.symbol} via Flex.
                      <div style={{ marginTop: 14 }}>
                        <button
                          onClick={() => fetchIBKRData(false)}
                          style={{ padding: '8px 16px', background: '#10B981', color: '#fff', border: 'none', borderRadius: 7, cursor: 'pointer', fontSize: '0.85rem' }}
                        >
                          Try TWS instead
                        </button>
                      </div>
                    </>
                  ) : (
                    `No trades found for ${form.symbol} in the current TWS session.`
                  )}
                </div>
              )}

              {/* Already-imported toggle */}
              {!ibkrLoading && ibkrGroups.some(g => g.alreadyLogged) && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
                  <button
                    onClick={() => setShowAlreadyImported(prev => !prev)}
                    style={{ background: 'none', border: 'none', color: '#6366F1', cursor: 'pointer', fontSize: '0.8rem', padding: 0 }}
                  >
                    {showAlreadyImported
                      ? 'Hide already-imported trades'
                      : `Show ${ibkrGroups.filter(g => g.alreadyLogged).length} already-imported trade${ibkrGroups.filter(g => g.alreadyLogged).length !== 1 ? 's' : ''}`}
                  </button>
                </div>
              )}

              {/* Bracket Groups */}
              {!ibkrLoading && ibkrGroups.filter(g => showAlreadyImported || !g.alreadyLogged).map((group) => {
                const isExpanded = expandedGroups.has(group.parentOrderId);
                const allGroupExecs = [...group.entryExecutions, ...group.tpExecutions, ...group.slExecutions];
                const alreadyApplied = allGroupExecs.length > 0 && allGroupExecs.every(e => addedIbkrItemIds.has(e.execId));

                const resultColor = {
                  TP_HIT:        '#10B981',
                  SL_HIT:        '#EF4444',
                  OPEN:          '#F59E0B',
                  PENDING:       '#6B7280',
                  CLOSED:        '#A78BFA',
                }[group.result] || '#6B7280';

                const resultLabel = {
                  TP_HIT:        '✅ TP Hit',
                  SL_HIT:        '🛑 SL Hit',
                  OPEN:          '🔓 Open',
                  PENDING:       '⏳ Pending',
                  CLOSED:        '📊 Closed',
                }[group.result] || group.result;

                const dirColor = group.direction === 'LONG' ? '#60A5FA' : '#F97316';

                // Summary numbers for collapsed view
                const entryPrice = group.entryExecutions[0]?.price ?? '—';
                const exitExecs = group.tpExecutions.length > 0 ? group.tpExecutions : group.slExecutions;
                const exitPrice = exitExecs[0]?.price ?? (group.result === 'TP_HIT' ? group.tpOrder?.limitPrice : group.slOrder?.stopPrice) ?? '—';
                const tpPrice = group.tpOrder?.limitPrice ?? '—';
                const slPrice = group.slOrder?.stopPrice ?? group.slOrder?.limitPrice ?? '—';
                const totalFee = allGroupExecs.reduce((s, e) => s + parseFloat(e.fee || 0), 0).toFixed(2);
                const totalQty = group.entryExecutions.reduce((s, e) => s + parseFloat(e.quantity || 0), 0);

                return (
                  <div key={group.parentOrderId} style={{
                    background: '#232733',
                    borderRadius: 12,
                    marginBottom: 12,
                    border: `1px solid ${alreadyApplied ? '#374151' : '#2D3748'}`,
                    opacity: alreadyApplied ? 0.65 : 1,
                    overflow: 'hidden',
                  }}>
                    {/* Card Header Row */}
                    <div style={{ display: 'flex', alignItems: 'center', padding: '12px 14px', gap: 8, flexWrap: 'wrap', cursor: 'pointer' }}
                      onClick={() => toggleGroupExpand(group.parentOrderId)}>

                      {/* Direction badge */}
                      <span style={{ background: dirColor + '22', color: dirColor, borderRadius: 6, padding: '2px 8px', fontSize: '0.75rem', fontWeight: 700, letterSpacing: '0.05em' }}>
                        {group.direction}
                      </span>

                      {/* Result badge */}
                      <span style={{ background: resultColor + '22', color: resultColor, borderRadius: 6, padding: '2px 8px', fontSize: '0.75rem', fontWeight: 600 }}>
                        {resultLabel}
                      </span>

                      {/* Bracket type */}
                      {group.type === 'bracket' && (
                        <span style={{ color: '#6B7280', fontSize: '0.72rem', background: '#1a1d27', borderRadius: 4, padding: '2px 6px' }}>BRACKET</span>
                      )}

                      {/* Date/time of entry */}
                      {group.entryExecutions[0] && (
                        <span style={{ color: '#9CA3AF', fontSize: '0.78rem', marginLeft: 2 }}>
                          {group.entryExecutions[0].dateTime.toFormat('LLL d, HH:mm')}
                        </span>
                      )}

                      {/* Summary: qty @ entry → exit */}
                      <span style={{ color: '#D1D5DB', fontSize: '0.82rem', flex: 1, textAlign: 'right' }}>
                        {totalQty > 0 ? `${totalQty} @ ` : ''}{entryPrice}
                        {exitPrice !== '—' ? ` → ${exitPrice}` : ''}
                        {totalFee > 0 ? <span style={{ color: '#6B7280' }}> (fee: ${totalFee})</span> : null}
                      </span>

                      {/* Expand chevron */}
                      <span style={{ color: '#6B7280', fontSize: '0.85rem', marginLeft: 4 }}>
                        {isExpanded ? '▲' : '▼'}
                      </span>
                    </div>

                    {/* Expanded Detail */}
                    {isExpanded && (
                      <div style={{ borderTop: '1px solid #2D3748', padding: '12px 14px', fontSize: '0.82rem' }}>

                        {/* Entry executions */}
                        {group.entryExecutions.length > 0 && (
                          <div style={{ marginBottom: 8 }}>
                            <div style={{ color: '#9CA3AF', marginBottom: 4, fontWeight: 600, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Entry execution{group.entryExecutions.length > 1 ? 's' : ''}</div>
                            {group.entryExecutions.map(e => (
                              <div key={e.execId} style={{ display: 'flex', justifyContent: 'space-between', color: '#E5E7EB', padding: '3px 0' }}>
                                <span>{e.action} {e.quantity} @ <b>{e.price}</b> — {e.dateTime.toFormat('LLL d, HH:mm:ss')}</span>
                                <span style={{ color: '#9CA3AF' }}>fee: ${e.fee}</span>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Position-based group notice */}
                        {group.type === 'position-based' && (
                          <div style={{ color: '#9CA3AF', fontSize: '0.78rem', background: '#1a1d27', borderRadius: 6, padding: '6px 10px', marginBottom: 8, fontStyle: 'italic' }}>
                            ℹ️ Grouped by position tracking — no bracket order data available. TP/SL prices not shown.
                          </div>
                        )}
                        
                        {/* TP order row */}
                        {group.tpOrder && (
                          <div style={{ marginBottom: 8 }}>
                            <div style={{ color: '#9CA3AF', marginBottom: 4, fontWeight: 600, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Take Profit order</div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', color: group.tpExecutions.length > 0 ? '#10B981' : '#6B7280', padding: '3px 0' }}>
                              <span>LMT {group.tpOrder.action} {group.tpOrder.quantity} @ <b>{group.tpOrder.limitPrice ?? '—'}</b></span>
                              <span style={{ fontSize: '0.75rem' }}>
                                {group.tpExecutions.length > 0
                                  ? `✅ FILLED @ ${group.tpExecutions[0].price} (fee: $${group.tpExecutions[0].fee})`
                                  : group.tpOrder.status}
                              </span>
                            </div>
                          </div>
                        )}

                        {/* SL order row */}
                        {group.slOrder && (
                          <div style={{ marginBottom: 10 }}>
                            <div style={{ color: '#9CA3AF', marginBottom: 4, fontWeight: 600, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Stop Loss order</div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', color: group.slExecutions.length > 0 ? '#EF4444' : '#6B7280', padding: '3px 0' }}>
                              <span>{group.slOrder.orderType} {group.slOrder.action} {group.slOrder.quantity} @ <b>{group.slOrder.stopPrice ?? group.slOrder.limitPrice ?? '—'}</b></span>
                              <span style={{ fontSize: '0.75rem' }}>
                                {group.slExecutions.length > 0
                                  ? `🛑 FILLED @ ${group.slExecutions[0].price} (fee: $${group.slExecutions[0].fee})`
                                  : group.slOrder.status}
                              </span>
                            </div>
                          </div>
                        )}

                        {/* Action buttons */}
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
                          {/* Apply whole trade in one click */}
                          {allGroupExecs.length > 0 && (
                            <button
                              onClick={() => { handleApplyTrade(group); setShowIBKRModal(false); }}
                              style={{
                                padding: '6px 14px', background: alreadyApplied ? '#374151' : '#10B981',
                                color: '#fff', border: 'none', borderRadius: 7, cursor: 'pointer', fontWeight: 600, fontSize: '0.82rem'
                              }}
                            >
                              {alreadyApplied ? '✓ Applied' : '⚡ Apply Trade'}
                            </button>
                          )}

                          {/* Add individual entry executions */}
                          {group.entryExecutions.map(e => (
                            <button key={e.execId}
                              onClick={() => handleAddAsAction(e)}
                              style={{ padding: '6px 12px', background: addedIbkrItemIds.has(e.execId) ? '#374151' : '#3B82F6', color: '#fff', border: 'none', borderRadius: 7, cursor: 'pointer', fontSize: '0.78rem' }}
                            >
                              {addedIbkrItemIds.has(e.execId) ? '✓' : '+'} Entry {e.dateTime.toFormat('HH:mm')}
                            </button>
                          ))}

                          {/* Add TP exit */}
                          {group.tpExecutions.map(e => (
                            <button key={e.execId}
                              onClick={() => handleAddAsAction(e)}
                              style={{ padding: '6px 12px', background: addedIbkrItemIds.has(e.execId) ? '#374151' : '#10B981', color: '#fff', border: 'none', borderRadius: 7, cursor: 'pointer', fontSize: '0.78rem' }}
                            >
                              {addedIbkrItemIds.has(e.execId) ? '✓' : '+'} TP Exit
                            </button>
                          ))}

                          {/* Add SL exit */}
                          {group.slExecutions.map(e => (
                            <button key={e.execId}
                              onClick={() => handleAddAsAction(e)}
                              style={{ padding: '6px 12px', background: addedIbkrItemIds.has(e.execId) ? '#374151' : '#EF4444', color: '#fff', border: 'none', borderRadius: 7, cursor: 'pointer', fontSize: '0.78rem' }}
                            >
                              {addedIbkrItemIds.has(e.execId) ? '✓' : '+'} SL Exit
                            </button>
                          ))}

                          {/* Set TP price */}
                          {group.tpOrder?.limitPrice != null && (
                            <button
                              onClick={() => setForm(prev => ({ ...prev, target: group.tpOrder.limitPrice.toString(), targetConfirmed: true }))}
                              style={{ padding: '6px 12px', background: form.target === group.tpOrder.limitPrice.toString() ? '#374151' : '#064E3B', color: '#10B981', border: '1px solid #10B981', borderRadius: 7, cursor: 'pointer', fontSize: '0.78rem' }}
                            >
                              {form.target === group.tpOrder.limitPrice.toString() ? '✓' : '→'} Set TP {group.tpOrder.limitPrice}
                            </button>
                          )}

                          {/* Set SL price */}
                          {group.slOrder && (group.slOrder.stopPrice ?? group.slOrder.limitPrice) != null && (
                            <button
                              onClick={() => {
                                const slP = (group.slOrder.stopPrice ?? group.slOrder.limitPrice).toString();
                                setForm(prev => ({ ...prev, stopLoss: slP, stopLossConfirmed: true }));
                              }}
                              style={{ padding: '6px 12px', background: form.stopLoss === (group.slOrder.stopPrice ?? group.slOrder.limitPrice)?.toString() ? '#374151' : '#450A0A', color: '#EF4444', border: '1px solid #EF4444', borderRadius: 7, cursor: 'pointer', fontSize: '0.78rem' }}
                            >
                              {form.stopLoss === (group.slOrder.stopPrice ?? group.slOrder.limitPrice)?.toString() ? '✓' : '→'} Set SL {group.slOrder.stopPrice ?? group.slOrder.limitPrice}
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Orphan Executions Section */}
              {!ibkrLoading && ibkrOrphans.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <div style={{ color: '#9CA3AF', fontSize: '0.8rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                    Ungrouped executions (no bracket order data)
                  </div>
                  {ibkrOrphans.map((item) => (
                    <div key={item.execId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: '#232733', borderRadius: 8, marginBottom: 6 }}>
                      <span style={{ color: '#D1D5DB', fontSize: '0.83rem' }}>
                        <b style={{ color: item.action === 'BUY' ? '#60A5FA' : '#F97316' }}>{item.action}</b>{' '}
                        {item.quantity} @ {item.price} — {item.dateTime.toFormat('LLL d, HH:mm:ss')}
                        <span style={{ color: '#6B7280' }}> fee: ${item.fee}</span>
                      </span>
                      <button
                        onClick={() => handleAddAsAction(item)}
                        style={{ padding: '5px 10px', background: addedIbkrItemIds.has(item.execId) ? '#374151' : '#3B82F6', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.78rem' }}
                      >
                        {addedIbkrItemIds.has(item.execId) ? '✓ Added' : '+ Add Action'}
                      </button>
                    </div>
                  ))}
                </div>
              )}

            </div>
          </div>
        )}
      </div>
    </div>
  );
}