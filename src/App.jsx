import React, { useState, useEffect } from 'react';
import Dashboard from './components/Dashboard/Dashboard';
import Navigation from './components/Navigation/Navigation';
import TradeModal from './components/TradeModal/TradeModal';
import TradeView from './components/TradeView/TradeView';
import DayNote from './components/DayNote/DayNote';
import Settings from './components/Settings/Settings';
import Stats from './components/Stats/Stats';
import Capital from './components/Capital/Capital';
import LoadingIndicator from './components/LoadingIndicator';
import { TradeProvider } from './context/TradeContext';
import { StatusProvider } from './context/StatusContext';
import { getNumberFormat, subscribeNumberFormat } from './utils/numberFormat';
import ErrorBoundary, { PageBoundary } from './components/common/ErrorBoundary';
import { DialogHost } from './components/common/Dialogs';
import './styles.css';

function App() {
  const [currentView, setCurrentView] = useState('dashboard');
  const [showTradeModal, setShowTradeModal] = useState(false);
  const [showTradeView, setShowTradeView] = useState(false);
  const [selectedTrade, setSelectedTrade] = useState(null);
  const [showDayNote, setShowDayNote] = useState(false);
  const [selectedDayNote, setSelectedDayNote] = useState(null);
  const [customFilterDate, setCustomFilterDate] = useState(null);
  const [customFilterWeek, setCustomFilterWeek] = useState(null);
  // The number format setting: when it changes, the page below is mounted
  // afresh so figures it computed and kept (memoised stats, chart options)
  // are formatted again. Open trade/note windows only re-render, so a
  // change arriving from another device can't throw away unsaved edits.
  const [numberFormat, setNumberFormatState] = useState(getNumberFormat);
  useEffect(() => subscribeNumberFormat(setNumberFormatState), []);

  const handleNewTrade = () => {
    setShowTradeModal(true);
    setSelectedTrade(null);
    setShowTradeView(false);
    setShowDayNote(false);
    setSelectedDayNote(null);
  };

  const handleTradeClick = (trade) => {
    if (trade.status === 'OPEN') {
      setSelectedTrade(trade);
      setShowTradeModal(true);
      setShowTradeView(false);
      setShowDayNote(false);
      setSelectedDayNote(null);
    } else {
      setSelectedTrade(trade);
      setShowTradeView(true);
      setShowTradeModal(false);
      setShowDayNote(false);
      setSelectedDayNote(null);
    }
  };

  const handleViewTrade = (trade) => {
    setSelectedTrade(trade);
    setShowTradeView(true);
    setShowTradeModal(false);
    setShowDayNote(false);
    setSelectedDayNote(null);
  };

  const handleEditTrade = (trade) => {
    setSelectedTrade(trade);
    setShowTradeModal(true);
    setShowTradeView(false);
    setShowDayNote(false);
    setSelectedDayNote(null);
  };

  const handleNewNote = () => {
    setShowDayNote(true);
    setSelectedDayNote(null);
    setShowTradeModal(false);
    setShowTradeView(false);
    setSelectedTrade(null);
  };

  const handleViewDayNote = (note) => {
    setSelectedDayNote(note);
    setShowDayNote(true);
    setShowTradeModal(false);
    setShowTradeView(false);
    setSelectedTrade(null);
  };

  const handleCloseModals = () => {
    setShowTradeModal(false);
    setShowTradeView(false);
    setSelectedTrade(null);
    setShowDayNote(false);
    setSelectedDayNote(null);
  };

  // Keyboard shortcuts: N new trade, J new day note, 1-4 switch pages. Only
  // when no trade/note window is open and nothing is being typed into.
  const anyWindowOpen = showTradeModal || showTradeView || showDayNote;
  useEffect(() => {
    const VIEWS = { '1': 'dashboard', '2': 'stats', '3': 'capital', '4': 'settings' };
    const onKeyDown = (e) => {
      if (anyWindowOpen || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const el = e.target;
      const tag = el && el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el && el.isContentEditable)) return;
      const key = e.key.toLowerCase();
      if (key === 'n') { e.preventDefault(); handleNewTrade(); }
      else if (key === 'j') { e.preventDefault(); handleNewNote(); }
      else if (VIEWS[key]) { e.preventDefault(); setCurrentView(VIEWS[key]); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const handleDayClick = (date, trades) => {
    if (trades.length === 1) {
      handleViewTrade(trades[0]);
    } else if (trades.length > 1) {
      setCustomFilterDate(date);
      setCustomFilterWeek(null);
      setCurrentView('dashboard');
    }
  };

  const handleWeekClick = (weekStart, weekEnd) => {
    setCustomFilterWeek({ start: weekStart, end: weekEnd });
    setCustomFilterDate(null);
    setCurrentView('dashboard');
  };

  return (
    <StatusProvider>
      <TradeProvider>
        <div className="app">
          <ErrorBoundary>
            <Navigation
              onNewTrade={handleNewTrade}
              onNewNote={handleNewNote}
              setCurrentView={setCurrentView}
              currentView={currentView}
            />
          </ErrorBoundary>
          <main className="main-content" key={numberFormat}>
            <PageBoundary view={currentView}>
            {currentView === 'dashboard' && (
              <Dashboard
                onViewTrade={handleViewTrade}
                onEditTrade={handleEditTrade}
                onViewDayNote={handleViewDayNote}
                customFilterDate={customFilterDate}
                customFilterWeek={customFilterWeek}
              />
            )}
            {currentView === 'settings' && (
              <Settings />
            )}
            {currentView === 'stats' && (
              <Stats
                setCurrentView={setCurrentView}
                onViewTrade={handleViewTrade}
                setCustomFilterDate={setCustomFilterDate}
                setCustomFilterWeek={setCustomFilterWeek}
              />
            )}
            {currentView === 'capital' && (
              <Capital />
            )}
            </PageBoundary>
          </main>
          <ErrorBoundary resetKey={`${selectedTrade?.id}|${selectedDayNote?.id}|${showTradeModal}|${showTradeView}|${showDayNote}`}>
          {showTradeModal && (
            <TradeModal
              trade={selectedTrade}
              onClose={handleCloseModals}
            />
          )}
          {showTradeView && selectedTrade && (
            <TradeView
              trade={selectedTrade}
              onClose={handleCloseModals}
              onEdit={handleEditTrade}
            />
          )}
          {showDayNote && (
            <DayNote
              note={selectedDayNote}
              onClose={handleCloseModals}
            />
          )}
          </ErrorBoundary>
          <LoadingIndicator />
          <DialogHost />
        </div>
      </TradeProvider>
    </StatusProvider>
  );
}

export default App;
