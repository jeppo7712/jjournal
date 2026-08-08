import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { getWebSocketUrl } from '../utils/getWebSocketUrl';

const StatusContext = createContext(null);

export const StatusProvider = ({ children }) => {
  const [statusLogs, setStatusLogs] = useState([]);

  useEffect(() => {
    let cancelled = false;
    let websocket = null;
    let reconnectTimer = null;
    let reconnectAttempt = 0;

    const addLog = (log) => {
      setStatusLogs(prev => {
        const next = [...prev, log];
        return next.slice(-200);
      });
    };

    const connect = () => {
      if (cancelled) return;
      websocket = new WebSocket(getWebSocketUrl('/ws'));

      websocket.onopen = () => {
        reconnectAttempt = 0;
        addLog({
          id: `ws-open-${Date.now()}`,
          requestId: null,
          status: 'WebSocket connected',
          type: 'success',
          timestamp: new Date().toISOString(),
        });
      };

      websocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          addLog({
            id: `ws-msg-${Date.now()}-${Math.random()}`,
            requestId: data.requestId || null,
            status: data.status || JSON.stringify(data),
            type: data.type || 'info',
            timestamp: data.timestamp || new Date().toISOString(),
          });
        } catch (err) {
          addLog({
            id: `ws-parse-error-${Date.now()}`,
            requestId: null,
            status: 'Error parsing WebSocket message',
            type: 'error',
            timestamp: new Date().toISOString(),
          });
        }
      };

      websocket.onerror = () => {
        addLog({
          id: `ws-error-${Date.now()}`,
          requestId: null,
          status: 'WebSocket error',
          type: 'error',
          timestamp: new Date().toISOString(),
        });
      };

      websocket.onclose = () => {
        if (cancelled) return;
        addLog({
          id: `ws-close-${Date.now()}`,
          requestId: null,
          status: 'WebSocket disconnected — reconnecting…',
          type: 'warning',
          timestamp: new Date().toISOString(),
        });
        // Exponential backoff, capped at 30s, so a restarted/unreachable
        // backend doesn't leave the app silently without status updates
        // until a manual page reload.
        const delay = Math.min(30000, 1000 * 2 ** reconnectAttempt);
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (websocket) {
        websocket.onclose = null; // prevent the close handler from scheduling a reconnect after unmount
        websocket.close();
      }
    };
  }, []);

  const value = useMemo(() => ({ statusLogs }), [statusLogs]);
  return <StatusContext.Provider value={value}>{children}</StatusContext.Provider>;
};

export const useStatus = () => {
  const ctx = useContext(StatusContext);
  if (!ctx) {
    throw new Error('useStatus must be used within a StatusProvider');
  }
  return ctx;
};
