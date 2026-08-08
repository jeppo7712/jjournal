import React, { useContext } from 'react';
import { TradeContext } from '../context/TradeContext';

const LoadingIndicator = () => {
  const { isFetching } = useContext(TradeContext);
  if (!isFetching) return null;
  return (
    <div className="loading-overlay" role="status" aria-label="Loading">
      <div className="spinner"></div>
    </div>
  );
};

export default LoadingIndicator;