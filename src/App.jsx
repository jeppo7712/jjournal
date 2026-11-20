import React, { useState, useEffect, useCallback } from 'react';
import Dashboard from './components/Dashboard/Dashboard';
import Navigation from './components/Navigation/Navigation';
import TradeModal from './components/TradeModal/TradeModal';
import TradeView from './components/TradeView/TradeView';
import DayNote from './components/DayNote/DayNote';
import Settings from './components/Settings/Settings';
import Stats from './components/Stats/Stats';
import Capital from './components/Capital/Capital';
import Todo from './components/Todo/Todo';
import LoadingIndicator from './components/LoadingIndicator';
import { TradeProvider } from './context/TradeContext';
import { TagsProvider } from './context/TagsContext';
import { BrokerAlertsProvider } from './context/BrokerAlertsContext';
import { TodosProvider } from './context/TodosContext';
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
  // IBKR fills to bring into the trade window: it opens with the Flex
  // import for them already running ({ symbol, type, execIds }).
  const [fillsToImport, setFillsToImport] = useState(null);
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
    setFillsToImport(null);
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
    setFillsToImport(null);
    setSelectedTrade(trade);
    setShowTradeModal(true);
    setShowTradeView(false);
    setShowDayNote(false);
    setSelectedDayNote(null);
  };

  // IBKR fills not in the journal (Dashboard): into the open trade they
  // belong to, if there is one, or a new trade.
  const handleAddFills = ({ symbol, type, execIds }, openTrade = null) => {
    setFillsToImport({ symbol, type, execIds });
    setSelectedTrade(openTrade);
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
    setFillsToImport(null);
    setShowTradeModal(false);
    setShowTradeView(false);
    setSelectedTrade(null);
    setShowDayNote(false);
    setSelectedDayNote(null);
  };

  // Keyboard shortcuts: N new trade, J new day note, 1-5 switch pages. Only
  // when no window or dialog is open (a trade or note, a page's own form
  // such as the Todo form, a confirm) and nothing is being typed into: a
  // key pressed with focus on a form's button would switch the page away
  // and lose the form.
  const anyWindowOpen = showTradeModal || showTradeView || showDayNote;
  useEffect(() => {
    const VIEWS = { '1': 'dashboard', '2': 'stats', '3': 'capital', '4': 'todo', '5': 'settings' };
    const onKeyDown = (e) => {
      if (anyWindowOpen || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (document.querySelector('[aria-modal="true"]')) return;
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

  // A calendar day or week is a one-off request: the Dashboard applies it
  // to its filter and then drops it, so a filter cleared afterwards stays
  // cleared when the Dashboard is opened again.
  const clearCalendarFilter = useCallback(() => {
    setCustomFilterDate(null);
    setCustomFilterWeek(null);
  }, []);

  return (
    <StatusProvider>
      <TagsProvider>
      <TradeProvider>
      <BrokerAlertsProvider>
      <TodosProvider>
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
                onAddFills={handleAddFills}
                onViewTrade={handleViewTrade}
                onEditTrade={handleEditTrade}
                onViewDayNote={handleViewDayNote}
                customFilterDate={customFilterDate}
                customFilterWeek={customFilterWeek}
                onCustomFilterApplied={clearCalendarFilter}
                onOpenTodo={() => setCurrentView('todo')}
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
            {currentView === 'todo' && (
              <Todo onViewTrade={handleViewTrade} />
            )}
            </PageBoundary>
          </main>
          <ErrorBoundary resetKey={`${selectedTrade?.id}|${selectedDayNote?.id}|${showTradeModal}|${showTradeView}|${showDayNote}`}>
          {showTradeModal && (
            <TradeModal
              trade={selectedTrade}
              importFills={fillsToImport}
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
      </TodosProvider>
      </BrokerAlertsProvider>
      </TradeProvider>
      </TagsProvider>
    </StatusProvider>
  );
}

export default App;
