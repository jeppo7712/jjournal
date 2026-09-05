import React, { useContext, useMemo, useState, useEffect, useRef } from 'react';
import { Line } from 'react-chartjs-2';
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler } from 'chart.js';
import TradeList from '../TradeList/TradeList';
import { TradeContext, parseActionDate, formatDate } from '../../context/TradeContext';
import DatePicker from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';
import styles from './Dashboard.module.css';
import { DateTime } from 'luxon';
import { getRealisedPnL } from '../../context/TradeContext';
import { debounce } from 'lodash';


ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler);

const formatCustomDate = (date) => {
  if (!date) return '';
  const dt = typeof date === 'string' ? DateTime.fromISO(date) : DateTime.fromJSDate(date);
  if (!dt.isValid) return '';
  return dt.toFormat('dd MMM yy').toUpperCase();
};

const Dashboard = ({ onViewTrade, onEditTrade, onViewDayNote, customFilterDate, customFilterWeek }) => {
  const {
    stats,
    toggleFilter,
    setTimeFilter,
    timeFilter,
    filter,
    getTimeRange,
    customStartDate,
    customEndDate,
    setCustomStartDate,
    setCustomEndDate,
    showTrades,
    showDayNotes,
    toggleShowTrades,
    toggleShowDayNotes,
    filteredItems,
    symbolFilter,
    setSymbolFilter,
    clearSymbolFilter,
    setRestrictToActionsInRange,
    restrictToActionsInRange,
  } = useContext(TradeContext);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimeFilterMenu, setShowTimeFilterMenu] = useState(false);
  const [showOpenTrades, setShowOpenTrades] = useState(false);
  const [showGraphPopup, setShowGraphPopup] = useState(false);
  const [isGraphHidden, setIsGraphHidden] = useState(false);
  const [pnlChartType, setPnlChartType] = useState('realised'); // 'realised' or 'unrealised'
  const timeFilterRef = useRef(null);
  const menuRef = useRef(null);
  const datePickerRef = useRef(null);
  const bullseyeButtonRef = useRef(null);


  // Detect if graph is hidden based on window width
  useEffect(() => {
    const handleResize = () => {
      setIsGraphHidden(window.innerWidth <= 750);
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Debug log to verify filter state
  useEffect(() => {
  }, [filter]);

  useEffect(() => {
    if (customFilterDate) {
      setTimeFilter(null);
      const start = DateTime.fromJSDate(new Date(customFilterDate), { zone: 'local' }).startOf('day');
      const end = DateTime.fromJSDate(new Date(customFilterDate), { zone: 'local' }).endOf('day');
      setCustomStartDate(start.toISO());
      setCustomEndDate(end.toISO());
      setTimeFilter('CUSTOM');
      setShowDatePicker(false);
    } else if (customFilterWeek) {
      setTimeFilter(null);
      const start = DateTime.fromJSDate(new Date(customFilterWeek.start), { zone: 'local' }).startOf('day');
      const end = DateTime.fromJSDate(new Date(customFilterWeek.end), { zone: 'local' }).endOf('day');
      setCustomStartDate(start.toISO());
      setCustomEndDate(end.toISO());
      setTimeFilter('CUSTOM');
      setShowDatePicker(false);
    }
  }, [customFilterDate, customFilterWeek, setCustomStartDate, setCustomEndDate, setTimeFilter]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(event.target) &&
        timeFilterRef.current &&
        !timeFilterRef.current.contains(event.target)
      ) {
        setShowTimeFilterMenu(false);
      }
      if (
        datePickerRef.current &&
        !datePickerRef.current.contains(event.target) &&
        timeFilterRef.current &&
        !timeFilterRef.current.contains(event.target)
      ) {
        setShowDatePicker(false);
        setTimeFilter(null);
        setCustomStartDate(null);
        setCustomEndDate(null);
      }
    };

    if (showTimeFilterMenu || showDatePicker) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showTimeFilterMenu, showDatePicker]);

  const sortedTrades = useMemo(() => {
    return filteredItems
      .filter(item => (item.type === 'FUT' || item.type === 'STK') && (item.status === 'WIN' || item.status === 'LOSS' || item.status === 'WASH' || item.status === 'OPEN'))
      .map(trade => ({
        ...trade,
        relevantDate: trade.status === 'OPEN' ? trade.lastActionDate : trade.lastActionDate,
        realisedPnL: trade.status === 'OPEN' ? getRealisedPnL(trade) : trade.return || 0,
        side: trade.side, // Explicitly include side
      }))
      .sort((a, b) => {
        const dateA = a.relevantDate ? new Date(a.relevantDate) : new Date(0);
        const dateB = b.relevantDate ? new Date(b.relevantDate) : new Date(0);
        return dateA - dateB;
      });
  }, [filteredItems]);


  const chartLabels = sortedTrades.map(trade => formatDate(trade.relevantDate));

  const chartData = {
    labels: chartLabels,
    datasets: [
      {
        label: 'Realised P&L',
        data: sortedTrades.reduce((acc, trade) => {
          const last = acc.length ? acc[acc.length - 1] : 0;
          acc.push(last + (trade.realisedPnL || 0));
          return acc;
        }, []),
        borderColor: '#3B82F6',
        backgroundColor: 'rgba(59, 130, 246, 0.1)',
        tension: 0.3,
        fill: true,
        pointRadius: 0,
        pointHoverRadius: 0,
      },
    ],
  };

  function computeOpenLotsPerDay(trade) {
    const openLotsMap = new Map(); // Key: ISO date string, Value: { openQty, openCost, openFee, avgOpenCost }
    let openLots = [];
    const actions = trade.actions.sort((a, b) => DateTime.fromISO(a.dateTime) - DateTime.fromISO(b.dateTime));

    let currentDate = null;
    actions.forEach(action => {
      const actionDate = DateTime.fromISO(action.dateTime).startOf('day');
      if (!currentDate || !actionDate.hasSame(currentDate, 'day')) {
        if (currentDate) {
          const openQty = openLots.reduce((sum, lot) => sum + lot.quantity, 0);
          const openCost = openLots.reduce((sum, lot) => sum + lot.price * lot.quantity, 0);
          const openFee = openLots.reduce((sum, lot) => sum + lot.fee, 0);
          const avgOpenCost = openQty > 0 ? openCost / openQty : 0;
          openLotsMap.set(currentDate.toISODate(), { openQty, openCost, openFee, avgOpenCost });
        }
        currentDate = actionDate;
      }

      if (trade.side === 'LONG' && action.type === 'BUY') {
        openLots.push({
          quantity: Number(action.quantity || 0),
          price: Number(action.price || 0),
          fee: Number(action.fee || 0),
        });
      } else if (trade.side === 'SHORT' && action.type === 'SELL') {
        openLots.push({
          quantity: Number(action.quantity || 0),
          price: Number(action.price || 0),
          fee: Number(action.fee || 0),
        });
      } else if ((trade.side === 'LONG' && action.type === 'SELL') || (trade.side === 'SHORT' && action.type === 'BUY')) {
        let closeQty = Number(action.quantity || 0);
        while (closeQty > 0 && openLots.length > 0) {
          let lot = openLots[0];
          const qtyToClose = Math.min(lot.quantity, closeQty);
          // Prorate the lot's remaining fee down as it's closed, same fix as
          // matchLotsFIFO in TradeContext.js, so the fee left on a still-open
          // lot here (used below for openFee) doesn't double-count fee already
          // attributed to an earlier partial close of this same lot.
          lot.fee -= lot.fee * (qtyToClose / lot.quantity);
          lot.quantity -= qtyToClose;
          closeQty -= qtyToClose;
          if (lot.quantity <= 0) openLots.shift();
        }
      }
    });

    // Add the last date
    if (currentDate) {
      const openQty = openLots.reduce((sum, lot) => sum + lot.quantity, 0);
      const openCost = openLots.reduce((sum, lot) => sum + lot.price * lot.quantity, 0);
      const openFee = openLots.reduce((sum, lot) => sum + lot.fee, 0);
      const avgOpenCost = openQty > 0 ? openCost / openQty : 0;
      openLotsMap.set(currentDate.toISODate(), { openQty, openCost, openFee, avgOpenCost });
    }

    // For open trades, extend open lots until today
    if (trade.status === 'OPEN') {
      const lastDate = currentDate || DateTime.fromISO(trade.firstActionDate).startOf('day');
      const today = DateTime.now().startOf('day');
      for (let dt = lastDate.plus({ days: 1 }); dt <= today; dt = dt.plus({ days: 1 })) {
        openLotsMap.set(dt.toISODate(), { ...openLotsMap.get(lastDate.toISODate()) });
      }
    }

    return openLotsMap;
  }

  function computeUnrealisedPnLSeries(trades, historicalDataMap, startDate = null, endDate = null) {
    const relevantTrades = trades.filter(trade => ['OPEN', 'WIN', 'LOSS', 'WASH'].includes(trade.status) && (trade.type === 'FUT' || trade.type === 'STK'));
    if (relevantTrades.length === 0) {
      return { labels: [], series: [] };
    }

    const openLotsPerTrade = relevantTrades.map(trade => ({
      trade,
      openLotsMap: computeOpenLotsPerDay(trade), // computeOpenLotsPerDay remains the same
      lastPrice: null,
    }));

    const firstDates = relevantTrades
      .map(trade => DateTime.fromISO(trade.firstActionDate).startOf('day'))
      .filter(dt => dt.isValid);
    const earliestDateDefault = firstDates.length > 0 ? firstDates.reduce((min, dt) => (dt < min ? dt : min)) : DateTime.now().startOf('day');
    const today = DateTime.now().startOf('day');

    const earliestDate = startDate ? DateTime.fromISO(startDate).startOf('day') : earliestDateDefault;
    let latestDate = endDate ? DateTime.fromISO(endDate).startOf('day') : today;

    // Ensure earliestDate is not after latestDate, and latestDate is not before earliestDate
    if (earliestDate > latestDate) {
      // If the filter somehow results in an invalid range (e.g. "THIS YR" in a future year context for a past trade)
      // or if latestDate is before any trade activity that would be charted.
      // Potentially swap them or return empty if start is truly after end.
      // For now, let's cap latestDate at today if it's in the future from a filter.
      if (latestDate > today) latestDate = today;
      if (earliestDate > latestDate) return { labels: [], series: [] };
    }

    const days = Math.ceil(latestDate.diff(earliestDate, 'days').days) + 1;
    const labels = [];
    const series = [];

    for (let i = 0; i < days; i++) {
      const currentDate = earliestDate.plus({ days: i });
      const currentDateISO = currentDate.toISODate();
      labels.push(formatDate(currentDate)); // formatDate is from TradeContext
      let dailyUnrealised = 0;

      openLotsPerTrade.forEach(item => { // Renamed to avoid conflict with outer 'trade'
        const { trade, openLotsMap } = item;
        let currentLastPrice = item.lastPrice; // Use and update this scoped lastPrice

        // --- START MODIFICATION FOR LOTS LOOKUP ---
        let effectiveLots = null;
        // Get sorted keys from the trade's openLotsMap. Map keys are ISO date strings.
        const sortedMapDates = Array.from(openLotsMap.keys()).sort();

        for (const mapDateISO of sortedMapDates) {
          if (mapDateISO <= currentDateISO) {
            effectiveLots = openLotsMap.get(mapDateISO);
          } else {
            // Since sortedMapDates are ascending, no further mapDateISO will be <= currentDateISO.
            break;
          }
        }
        const lots = effectiveLots;
        // --- END MODIFICATION FOR LOTS LOOKUP ---

        if (!lots || lots.openQty <= 0) {
          // This means the trade was not open, had zero quantity on currentDateISO,
          // or currentDateISO is before the trade's first action.
          // Correctly contributes 0 to unrealised P&L for this day.
          return;
        }

        let price = null;
        const currentTradeHistoricalPrices = historicalDataMap[trade.symbol];

        if (trade.status === 'OPEN' && currentDate.hasSame(today, 'day') && trade.currentPrice) {
          price = trade.currentPrice;
        } else if (currentTradeHistoricalPrices) {
          price = currentTradeHistoricalPrices.get(currentDateISO) || null;
          // Original modification for price fallback on the first day of chart
          if (price === null && i === 0 && currentTradeHistoricalPrices && currentTradeHistoricalPrices.size > 0) {
            const availablePricesBeforeOrOnCurrent = Array.from(currentTradeHistoricalPrices.entries())
              .map(([dateStr, p]) => ({ date: DateTime.fromISO(dateStr), price: p }))
              .filter(entry => entry.date.isValid && entry.date <= currentDate)
              .sort((a, b) => b.date.toMillis() - a.date.toMillis());
            if (availablePricesBeforeOrOnCurrent.length > 0) {
              price = availablePricesBeforeOrOnCurrent[0].price;
            }
          }
        }
        let tickValue, tickSize, tickMultiplier;
        if (trade.type === 'STK') {
          tickValue = 1;
          tickSize = 1;
          tickMultiplier = 1;
        } else {
          tickValue = Number(trade.tick_value || trade.tickValue || 0);
          tickSize = Number(trade.tick_size || trade.tickSize || 0);
          tickMultiplier = tickValue !== 0 && tickSize !== 0 ? tickValue / tickSize : 1;
        }

        // Use last known price if current price is unavailable (for subsequent days)
        if (price === null && currentLastPrice !== null) { // Changed prevLastPrice to currentLastPrice
          price = currentLastPrice;
        } else if (price !== null) {
          item.lastPrice = price; // Update lastPrice for this trade in the openLotsPerTrade array
        } else {
          return; // If no price can be determined, skip this trade's contribution
        }

        const { avgOpenCost, openQty, openFee } = lots; // openFee from lots might be the fee up to that point

        let unrealised = 0;

        if (trade.side === 'LONG') {
          // For unrealised P&L, the 'openFee' typically refers to fees incurred to establish the currently open lots.
          // If openFee in 'lots' accumulates all fees, this is fine. If it's per-lot, care is needed.
          // Assuming 'avgOpenCost' already includes pro-rata buy fees.
          unrealised = (price - avgOpenCost) * openQty * tickMultiplier;
          // If 'openFee' represents total fees for *current* open lots, subtract it.
          // If avgOpenCost = (sum of (price*qty) + sum of fees) / total qty, then openFee subtraction might double count.
          // Assuming avgOpenCost is pure price average, and openFee is total fee for current open lots.
          unrealised -= (lots.openFee || 0);


        } else if (trade.side === 'SHORT') {
          unrealised = (avgOpenCost - price) * openQty * tickMultiplier;
          unrealised -= (lots.openFee || 0);
        }
        dailyUnrealised += unrealised;
      });
      series.push(dailyUnrealised);
    }
    return { labels, series };
  }

  const [historicalDataMap, setHistoricalDataMap] = useState({});
  const [isFetching, setIsFetching] = useState(false);

  const fetchHistoricalData = async () => {
    // Group symbols by trade type
    const symbolsByType = sortedTrades.reduce((acc, trade) => {
      if (!trade.symbol) return acc;
      const type = trade.type === 'FUT' ? 'FUT' : 'STK';
      if (!acc[type]) acc[type] = new Set();
      acc[type].add(trade.symbol);
      return acc;
    }, {});

    // Convert Sets to Arrays and filter missing symbols
    const fetchPromises = [];
    for (const [type, symbolSet] of Object.entries(symbolsByType)) {
      const symbols = [...symbolSet];
      const missingSymbols = symbols.filter(symbol => !historicalDataMap[symbol]);
      if (missingSymbols.length === 0) {
        continue;
      }

      fetchPromises.push(
        ...missingSymbols.map(symbol => (
          fetch(`${process.env.REACT_APP_API_URL}/api/historical/db?symbol=${encodeURIComponent(symbol)}&type=${type}&timeframe=1D&noRefresh=true`, {
            headers: { 'x-account-id': '1' }
          })
            .then(res => res.ok ? res.json() : [])
            .then(data => {
              const dateMap = new Map(data.map(bar => [DateTime.fromISO(bar.time).toISODate(), bar.close]));
              return [symbol, dateMap];
            })
            .catch(error => {
              console.error(`Error fetching ${symbol} (${type}):`, error);
              return [symbol, new Map()];
            })
        ))
      );
    }

    if (fetchPromises.length === 0) {
      return;
    }

    setIsFetching(true);
    try {
      const results = await Promise.all(fetchPromises);
      setHistoricalDataMap(prev => ({
        ...prev,
        ...Object.fromEntries(results),
      }));
    } catch (error) {
      console.error('Failed to fetch historical data:', error);
    } finally {
      setIsFetching(false);
    }
  };
  const debouncedFetchHistoricalData = useRef(debounce(fetchHistoricalData, 500));

  useEffect(() => {
    if (pnlChartType === 'unrealised') {
      fetchHistoricalData(); // Immediate fetch on chart type change
    }
  }, [pnlChartType]);

  useEffect(() => {
    if (pnlChartType === 'unrealised') {
      debouncedFetchHistoricalData.current();
    }
    return () => debouncedFetchHistoricalData.current.cancel();
  }, [sortedTrades]);

  const { labels: unrealisedLabels, series: unrealisedSeries } = useMemo(() => {
    // PERFORMANCE OPTIMIZATION:
    // If the user is looking at Realised P&L (default), DO NOT compute the expensive Unrealised P&L series.
    // This series iterates through every single action of every trade and is very heavy.
    if (pnlChartType !== 'unrealised') {
      return { labels: [], series: [] };
    }

    // Ensure getTimeRange is available from context, if not, this line will fail.
    // Assuming getTimeRange is correctly destructured from TradeContext.
    const timeRangeResult = timeFilter
      ? getTimeRange(timeFilter, customStartDate, customEndDate)
      : { start: null, end: null }; // Default if no timeFilter

    // Provide a fallback for destructuring if timeRangeResult is null/undefined
    const { start: filterStart, end: filterEnd } = timeRangeResult || { start: null, end: null };

    return computeUnrealisedPnLSeries(sortedTrades, historicalDataMap, filterStart, filterEnd);
  }, [sortedTrades, historicalDataMap, timeFilter, customStartDate, customEndDate, getTimeRange, pnlChartType]); // Added pnlChartType dependency


  const unrealisedChartData = {
    labels: unrealisedLabels,
    datasets: [
      {
        label: 'Unrealised P&L',
        data: unrealisedSeries,
        borderColor: '#EF4444',
        backgroundColor: 'rgba(239, 68, 68, 0.1)',
        tension: 0.3,
        fill: true,
        pointRadius: 0,
        pointHoverRadius: 0,
      },
    ],
  };


  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index',
      intersect: false,
    },
    layout: {
      padding: {
        top: 20,
        bottom: 15,
        right: 60,
      },
    },
    scales: {
      x: {
        display: true,
        ticks: {
          display: false
        },
        grid: { // Added to hide x-axis grid lines
          display: false
        }
      },
      y: {
        display: true,
        ticks: {
          color: '#9CA3AF',
          font: {
            size: 11
          },
          callback: value => `$${value}`,
        },
        grid: { // Added to hide y-axis grid lines
          display: false
        }
      },
    },
    plugins: {
      legend: {
        display: false
      },
      tooltip: {
        enabled: false
      },
    },
  };

  const verticalLinePlugin = {
    id: 'verticalLine',
    afterDraw: (chart) => {
      // Check if the plugin is explicitly disabled for this chart instance
      const pluginOptions = chart.options.plugins && chart.options.plugins.verticalLine;
      if (pluginOptions && pluginOptions.enabled === false) {
        return; // Do not draw if disabled
      }

      const { ctx, tooltip, scales: { x }, chartArea, data } = chart;
      if (!x) return;
      const dataset = data.datasets[0]; // Assuming you are interested in the first dataset
      const labels = data.labels;

      // Definition of the function to draw a line and labels for a given point index
      const drawLineAndLabels = (index, isRightEdgeOverride = null) => {
        if (index < 0 || index >= labels.length || !dataset.data[index]) {
          // Basic validation to prevent errors if index is out of bounds or data is missing
          return;
        }
        const xPos = x.getPixelForValue(index);
        const dateLabel = labels[index] || 'N/A';
        const pnlValue = dataset.data[index];

        // Determine text alignment:
        // 'true' for isRightEdgeOverride forces text to the left of the line (used for the first point).
        // 'false' for isRightEdgeOverride forces text to be centered on the line (used for the last point).
        // 'null' allows dynamic alignment based on position.
        const isRightEdge = isRightEdgeOverride !== null ? isRightEdgeOverride : xPos > chartArea.right - 20;

        ctx.save(); // Save context state

        // Draw vertical line
        ctx.beginPath();
        ctx.moveTo(xPos, chartArea.top);
        ctx.lineTo(xPos, chartArea.bottom);
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)'; // Line color
        ctx.stroke();

        // Configure text properties
        ctx.font = '11px Arial';
        ctx.fillStyle = '#F3F4F6'; // Text color
        ctx.textAlign = isRightEdge ? 'left' : 'center';
        const textXPos = isRightEdge ? xPos - 10 : xPos; // Adjust text X position based on alignment

        // Draw date label (bottom)
        ctx.textBaseline = 'top';
        const dateY = chartArea.bottom + 5;
        ctx.fillText(dateLabel, textXPos, dateY);

        // Draw P&L value (top)
        ctx.textBaseline = 'bottom';
        const pnlText = `$${pnlValue.toFixed(2)}`;
        const pnlY = chartArea.top - 5;
        ctx.fillText(pnlText, textXPos, pnlY);

        ctx.restore(); // Restore context state
      };

      const isHovering = tooltip && tooltip._active && tooltip._active.length > 0;

      if (isHovering) {
        // Mouse is hovering over a point
        const activePoint = tooltip._active[0];
        const index = activePoint.index;

        // Determine the alignment override for the hovered point
        let alignmentOverride = null; // Default to dynamic alignment
        if (index === 0) {
          alignmentOverride = true; // Hovering the first point: text to its left
        } else if (index === labels.length - 1) {
          alignmentOverride = false; // Hovering the last point: text centered
        }

        // Draw only the hovered point's details
        if (labels && labels.length > 0 && index >= 0 && index < labels.length) {
          drawLineAndLabels(index, alignmentOverride);
        }
      } else {
        // Mouse is NOT hovering: show default first and last point labels
        if (labels && labels.length > 0) {
          drawLineAndLabels(0, true); // Draw first point (text to its left)
          if (labels.length > 1) {
            // Ensure there is more than one point to draw a distinct last point
            drawLineAndLabels(labels.length - 1, false); // Draw last point (text centered)
          }
        }
      }
    },
  };

  // Ensure this plugin is registered with ChartJS if it isn't already elsewhere
  // ChartJS.register(verticalLinePlugin); // This line is already present in your Dashboard.jsx

  ChartJS.register(verticalLinePlugin);

  const statGrid = [
    [
      { label: 'WINS', value: stats.wins, pct: stats.winRate + '%', color: '#22C55E', onClick: () => toggleFilter('WIN'), filterValue: 'WIN' },
      { label: 'LOSSES', value: stats.losses, pct: stats.totalTrades ? Math.round((stats.losses / stats.totalTrades) * 100) + '%' : '0%', color: '#EF4444', onClick: () => toggleFilter('LOSS'), filterValue: 'LOSS' },
    ],
    [
      { label: 'OPEN', value: stats.open, pct: stats.totalTrades ? Math.round((stats.open / stats.totalTrades) * 100) + '%' : '0%', color: '#60A5FA', onClick: () => toggleFilter('OPEN'), filterValue: 'OPEN' },
      { label: 'WASH', value: stats.wash, pct: stats.totalTrades ? Math.round((stats.wash / stats.totalTrades) * 100) + '%' : '0%', color: '#A5ADBA', onClick: () => toggleFilter('WASH'), filterValue: 'WASH' },
    ],
    [
      { label: 'AVG W', value: '$' + Math.abs(stats.avgWin).toFixed(0), pct: (stats.avgWinPct ?? 0).toFixed(0) + '%', color: '#22C55E' },
      { label: 'AVG L', value: '$' + stats.avgLoss.toFixed(0), pct: (stats.avgLossPct ?? 0).toFixed(0) + '%', color: '#EF4444' },
    ],
  ];

  const timeFilters = [
    { label: 'TODAY', value: 'TODAY' },
    { label: 'YESTERDAY', value: 'YESTERDAY' },
    { label: 'THIS WK', value: 'THIS_WK' },
    { label: 'LAST WK', value: 'LAST_WK' },
    { label: 'THIS MO', value: 'THIS_MO' },
    { label: 'LAST MO', value: 'LAST_MO' },
    { label: 'LAST 3 MO', value: 'LAST_3_MO' },
    { label: 'THIS YR', value: 'THIS_YR' },
    { label: 'LAST YR', value: 'LAST_YR' },
    {
      label: timeFilter === 'CUSTOM' && customStartDate && customEndDate
        ? DateTime.fromISO(customStartDate).toFormat('yyyy-MM-dd') === DateTime.fromISO(customEndDate).toFormat('yyyy-MM-dd')
          ? formatCustomDate(customStartDate)
          : `${formatCustomDate(customStartDate)} - ${formatCustomDate(customEndDate)}`
        : 'CUSTOM',
      value: 'CUSTOM',
    },
  ];

  const totalPnl = useMemo(() => {
    return filteredItems
      .filter(item => (item.type === 'FUT' || item.type === 'STK') && (item.status === 'WIN' || item.status === 'LOSS' || item.status === 'WASH'))
      .reduce((sum, trade) => sum + (trade.return || 0), 0);
  }, [filteredItems]);

  const unrealisedPnl = useMemo(() => {
    return filteredItems
      .filter(item => (item.type === 'FUT' || item.type === 'STK') && item.status === 'OPEN')
      .reduce((sum, trade) => sum + (trade.currentReturn || 0), 0);
  }, [filteredItems]);

  const totalRealisedPnl = useMemo(() => {
    const closedPnL = filteredItems
      .filter(item =>
        (item.type === 'FUT' || item.type === 'STK') &&
        (item.status === 'WIN' || item.status === 'LOSS' || item.status === 'WASH')
      )
      .reduce((sum, trade) => sum + (trade.return || 0), 0);

    const openPnL = filteredItems
      .filter(item =>
        (item.type === 'FUT' || item.type === 'STK') &&
        item.status === 'OPEN'
      )
      .reduce((sum, trade) => sum + getRealisedPnL(trade), 0);

    return closedPnL + openPnL;
  }, [filteredItems]);

  const realisedPnlStat = {
    label: 'R P&L',
    value: '$' + Math.abs(totalRealisedPnl).toFixed(2),
    color: totalRealisedPnl >= 0 ? '#22C55E' : '#EF4444',
    onClick: () => {
      setPnlChartType('realised');
      if (isGraphHidden) setShowGraphPopup(true);
    },
  };
  const unrealisedPnlStat = {
    label: 'U P&L',
    value: '$' + Math.abs(unrealisedPnl).toFixed(2),
    color: unrealisedPnl >= 0 ? '#22C55E' : '#EF4444',
    onClick: () => {
      setPnlChartType('unrealised');
      if (isGraphHidden) setShowGraphPopup(true);
    },
  };

  const handleTimeFilterClick = (value) => {
    if (timeFilter === value) {
      setTimeFilter(null);
      setCustomStartDate(null);
      setCustomEndDate(null);
      setShowDatePicker(false);
      setRestrictToActionsInRange(false);
    } else {
      setTimeFilter(value);
      setRestrictToActionsInRange(true);
      if (value === 'CUSTOM') {
        const today = new Date();
        const defaultEnd = new Date(today);
        const defaultStart = new Date(today);
        defaultStart.setDate(today.getDate() - 30);
        defaultStart.setHours(0, 0, 0, 0);
        defaultEnd.setHours(0, 0, 0, 0);
        setCustomStartDate(defaultStart.toISOString());
        setCustomEndDate(defaultEnd.toISOString());
        setShowDatePicker(true);
      } else {
        setCustomStartDate(null);
        setCustomEndDate(null);
        setShowDatePicker(false);
      }
    }
    setShowTimeFilterMenu(false);
  };

  const handleTimeFilterButtonClick = () => {
    if (timeFilter) {
      setTimeFilter(null);
      setCustomStartDate(null);
      setCustomEndDate(null);
      setShowDatePicker(false);
      setShowTimeFilterMenu(false);
      setRestrictToActionsInRange(false);
    } else {
      setShowTimeFilterMenu(!showTimeFilterMenu);
    }
  };

  const handleBullseyeClick = () => {
    setRestrictToActionsInRange(!restrictToActionsInRange);
  };

  const handleDateRangeSelect = (dates) => {
    const [start, end] = dates;
    if (start && end) {
      const startDt = DateTime.fromJSDate(start, { zone: 'local' }).startOf('day');
      const endDt = DateTime.fromJSDate(end, { zone: 'local' }).endOf('day');
      setCustomStartDate(startDt.toISO());
      setCustomEndDate(endDt.toISO());
      setTimeFilter('CUSTOM');
      setShowDatePicker(false);
      setShowTimeFilterMenu(false);
    } else {
      setCustomStartDate(start ? DateTime.fromJSDate(start, { zone: 'local' }).startOf('day').toISO() : null);
      setCustomEndDate(end ? DateTime.fromJSDate(end, { zone: 'local' }).endOf('day').toISO() : null);
    }
  };

  const handleSymbolFilterChange = (e) => {
    setSymbolFilter(e.target.value);
  };

  const toggleShowOpenTrades = () => {
    setShowOpenTrades(!showOpenTrades);
    toggleFilter('OPEN');
  };

  const getTimeFilterLabel = () => {
    if (!timeFilter) return 'TIME FILTER';
    const filter = timeFilters.find(f => f.value === timeFilter);
    return filter ? filter.label : 'TIME FILTER';
  };

  return (
    <div className={styles.dashboard}>
      <div className={styles.topRow}>
        <div className={styles.graphBubble}>
          <div className={styles.graphArea}>
            <div className={styles.graphArea}>
              {pnlChartType === 'unrealised' && isFetching && <div>Loading unrealised P&L data...</div>}
              {pnlChartType === 'unrealised' && !isFetching && sortedTrades.filter(trade => ['OPEN', 'WIN', 'LOSS', 'WASH'].includes(trade.status)).length === 0 ? (
                <div>No relevant trades for unrealised P&L</div>
              ) : (
                pnlChartType === 'unrealised' && !isFetching && unrealisedLabels.length === 0 ? (
                  <div>No historical data available for unrealised P&L</div>
                ) : (
                  !isFetching && (
                    <Line
                      data={pnlChartType === 'realised' ? chartData : unrealisedChartData}
                      options={chartOptions}
                    />
                  )
                )
              )}
            </div>          </div>
        </div>
        <div className={styles.statsContainer}>
          <div className={styles.statsGrid}>
            <div className={styles.statGridCol}>
              {statGrid[0].map((stat, idx) => {
                const percentage = parseFloat(stat.pct) || 0;
                const circumference = 2 * Math.PI * 15;
                const strokeDashoffset = circumference - (percentage / 100) * circumference;
                const filterState = filter.find(f => f.type === stat.filterValue);
                const isActive = filterState?.mode === 'include';
                const isExcluded = filterState?.mode === 'exclude';
                return (
                  <div
                    key={idx}
                    className={`${styles.statBox} ${isActive ? styles.active : ''} ${isExcluded ? styles.excluded : ''}`}
                    style={{ borderColor: '#32384a', color: stat.color, cursor: stat.onClick ? 'pointer' : 'default' }}
                    onClick={stat.onClick}
                  >
                    <div className={styles.statLabel}>{stat.label}</div>
                    <div className={styles.statValue}>{stat.value}</div>
                    <div className={styles.statPctContainer}>
                      <svg className={styles.progressRing} width="34" height="34">
                        <circle
                          className={styles.progressRingCircle}
                          stroke="#3A3F4A"
                          strokeWidth="2"
                          fill="transparent"
                          r="15"
                          cx="17"
                          cy="17"
                        />
                        <circle
                          className={styles.progressRingCircle}
                          stroke={stat.color}
                          strokeWidth="2"
                          fill="transparent"
                          r="15"
                          cx="17"
                          cy="17"
                          strokeDasharray={circumference}
                          strokeDashoffset={strokeDashoffset}
                          style={{ transform: 'rotate(-90deg)', transformOrigin: 'center' }}
                        />
                      </svg>
                      <div className={styles.statPct}>{stat.pct}</div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className={styles.statGridCol}>
              {statGrid[1].map((stat, idx) => {
                const percentage = parseFloat(stat.pct) || 0;
                const circumference = 2 * Math.PI * 15;
                const strokeDashoffset = circumference - (percentage / 100) * circumference;
                const filterState = filter.find(f => f.type === stat.filterValue);
                const isActive = filterState?.mode === 'include';
                const isExcluded = filterState?.mode === 'exclude';
                return (
                  <div
                    key={idx}
                    className={`${styles.statBox} ${isActive ? styles.active : ''} ${isExcluded ? styles.excluded : ''}`}
                    style={{ borderColor: '#32384a', color: stat.color, cursor: stat.onClick ? 'pointer' : 'default' }}
                    onClick={stat.onClick}
                  >
                    <div className={styles.statLabel}>{stat.label}</div>
                    <div className={styles.statValue}>{stat.value}</div>
                    <div className={styles.statPctContainer}>
                      <svg className={styles.progressRing} width="34" height="34">
                        <circle
                          className={styles.progressRingCircle}
                          stroke="#3A3F4A"
                          strokeWidth="2"
                          fill="transparent"
                          r="15"
                          cx="17"
                          cy="17"
                        />
                        <circle
                          className={styles.progressRingCircle}
                          stroke={stat.color}
                          strokeWidth="2"
                          fill="transparent"
                          r="15"
                          cx="17"
                          cy="17"
                          strokeDasharray={circumference}
                          strokeDashoffset={strokeDashoffset}
                          style={{ transform: 'rotate(-90deg)', transformOrigin: 'center' }}
                        />
                      </svg>
                      <div className={styles.statPct}>{stat.pct}</div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className={styles.statGridCol}>
              {statGrid[2].map((stat, idx) => {
                const percentage = parseFloat(stat.pct) || 0;
                const circumference = 2 * Math.PI * 15;
                const strokeDashoffset = circumference - (percentage / 100) * circumference;
                return (
                  <div
                    key={idx}
                    className={styles.statBox}
                    style={{ borderColor: '#32384a', color: stat.color }}
                  >
                    <div className={styles.statLabel}>{stat.label}</div>
                    <div className={styles.statValue}>{stat.value}</div>
                    <div className={styles.statPctContainer}>
                      <svg className={styles.progressRing} width="34" height="34">
                        <circle
                          className={styles.progressRingCircle}
                          stroke="#3A3F4A"
                          strokeWidth="2"
                          fill="transparent"
                          r="15"
                          cx="17"
                          cy="17"
                        />
                        <circle
                          className={styles.progressRingCircle}
                          stroke={stat.color}
                          strokeWidth="2"
                          fill="transparent"
                          r="15"
                          cx="17"
                          cy="17"
                          strokeDasharray={circumference}
                          strokeDashoffset={strokeDashoffset}
                          style={{ transform: 'rotate(-90deg)', transformOrigin: 'center' }}
                        />
                      </svg>
                      <div className={styles.statPct}>{stat.pct}</div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className={styles.pnlAndButtonsCol}>
              <div
                className={styles.statBox}
                style={{ borderColor: '#32384a', color: realisedPnlStat.color, cursor: isGraphHidden ? 'pointer' : 'default' }}
                onClick={realisedPnlStat.onClick}
              >
                <div className={styles.statLabel}>{realisedPnlStat.label}</div>
                <div className={styles.statValue} style={{ color: realisedPnlStat.color }}>{realisedPnlStat.value}</div>
              </div>
              <div
                className={styles.statBox}
                style={{ borderColor: '#32384a', color: unrealisedPnlStat.color, cursor: isGraphHidden ? 'pointer' : 'default' }}
                onClick={unrealisedPnlStat.onClick}
              >
                <div className={styles.statLabel}>{unrealisedPnlStat.label}</div>
                <div className={styles.statValue} style={{ color: unrealisedPnlStat.color }}>{unrealisedPnlStat.value}</div>
              </div>
            </div>
          </div>
          <div className={styles.filterSections}>
            <div className={styles.filterSection}>
              <div className={styles.separatorContainer}>
                <div className={styles.separatorLine}></div>
                <div className={styles.separatorText}>more filters</div>
                <div className={styles.separatorLine}></div>
              </div>
              <div className={styles.buttonRow}>
                <div className={styles.toggleButtonGroup}>
                  <div
                    className={`${styles.toggleButton} ${showTrades ? styles.active : styles.excluded}`}
                    onClick={toggleShowTrades}
                  >
                    TRADES
                  </div>
                  <div
                    className={`${styles.toggleButton} ${showDayNotes ? styles.active : styles.excluded}`}
                    onClick={toggleShowDayNotes}
                  >
                    NOTES
                  </div>
                  <div
                    className={`${styles.toggleButton} ${styles.openTradesButton} ${filter.find(f => f.type === 'OPEN')?.mode === 'include' ? styles.active : ''} ${filter.find(f => f.type === 'OPEN')?.mode === 'exclude' ? styles.excluded : ''}`}
                    onClick={toggleShowOpenTrades}
                  >
                    OPENS
                  </div>
                </div>
                <div className={styles.timeFilterContainer}>
                  <div className={styles.timeFilterButtonContainer}>
                    <button
                      ref={timeFilterRef}
                      className={`${styles.timeFilterButton} ${timeFilter ? styles.active : ''}`}
                      onClick={handleTimeFilterButtonClick}
                      title="Set time filter"
                    >
                      {getTimeFilterLabel()}
                    </button>
                    {showTimeFilterMenu && (
                      <div ref={menuRef} className={`${styles.timeFilterMenu} ${showTimeFilterMenu ? styles.open : ''}`}>
                        {timeFilters.map((filter, idx) => (
                          <div
                            key={idx}
                            className={`${styles.timeFilterBox} ${timeFilter === filter.value ? styles.active : ''} ${filter.value === 'CUSTOM' ? styles.custom : ''}`}
                            onClick={() => handleTimeFilterClick(filter.value)}
                          >
                            {filter.label}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    ref={bullseyeButtonRef}
                    className={`${styles.bullseyeButton} ${restrictToActionsInRange ? styles.active : ''} ${!timeFilter ? styles.disabled : ''}`}
                    onClick={handleBullseyeClick}
                    title="Show only trades with actions in time range"
                    disabled={!timeFilter}
                    aria-pressed={restrictToActionsInRange}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      className={styles.bullseyeIcon}
                    >
                      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm0-14c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6zm0 10c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" />
                    </svg>
                  </button>
                </div>
                <div className={styles.symbolFilterContainer}>
                  <input
                    type="text"
                    className={`${styles.symbolFilterInput} ${symbolFilter.length > 0 ? styles.active : ''}`}
                    placeholder="Symbol Filter"
                    value={symbolFilter}
                    onChange={handleSymbolFilterChange}
                  />
                  {symbolFilter && (
                    <button
                      className={styles.clearSymbolFilter}
                      onClick={clearSymbolFilter}
                      title="Clear symbol filter"
                    >
                      x
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
          {showDatePicker && (
            <div ref={datePickerRef} className={styles.datePickerContainer}>
              <DatePicker
                selected={customStartDate ? new Date(customStartDate) : null}
                onChange={handleDateRangeSelect}
                startDate={customStartDate ? new Date(customStartDate) : null}
                endDate={customEndDate ? new Date(customEndDate) : null}
                selectsRange
                inline
                monthsShown={2}
                calendarClassName={styles.datePickerCalendar}
              />
            </div>
          )}
        </div>
      </div>
      <div className={styles.tradeListSection}>
        <TradeList
          onViewTrade={onViewTrade}
          onEditTrade={onEditTrade}
          onViewDayNote={onViewDayNote}
        />
      </div>
      {showGraphPopup && (
        <div className={styles.graphPopup}>
          <div className={styles.graphPopupContent}>
            <button
              className={styles.graphPopupClose}
              onClick={() => setShowGraphPopup(false)}
              title="Close graph"
            >
              x
            </button>
            <div className={styles.graphPopupArea}>
              <Line data={chartData} options={chartOptions} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Dashboard;