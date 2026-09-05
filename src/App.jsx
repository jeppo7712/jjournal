import React, { useState } from 'react';
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
          <Navigation
            onNewTrade={handleNewTrade}
            onNewNote={handleNewNote}
            setCurrentView={setCurrentView}
          />
          <main className="main-content">
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
          </main>
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
          <LoadingIndicator />
        </div>
      </TradeProvider>
    </StatusProvider>
  );
}

export default App;
