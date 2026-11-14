import { useEffect } from 'react';
import { getWebSocketUrl } from './getWebSocketUrl';

// An open chart's connection to the server's live updates (/ws), kept
// alive: a dropped connection (the phone app sent to the background, a
// network blip, the server restarting) is opened again, at once when the
// page comes back into view, otherwise after 1 s, 2 s, 4 s … up to 30 s.
// Before, a chart's socket never came back and the chart stayed frozen
// until it was closed and opened again.
//
// onMessageRef.current(event) gets every message. onResumeRef.current()
// runs after a reconnect, and when the page comes back after a while out
// of view: bars stored meanwhile were never announced, so the chart
// reloads what's stored.
const MAX_DELAY_MS = 30000;
const RESUME_AFTER_HIDDEN_MS = 30000;

export default function useLiveSocket(active, onMessageRef, onResumeRef) {
  useEffect(() => {
    if (!active) return undefined;
    let ws = null;
    let timer = null;
    let attempt = 0;
    let closed = false;
    let hiddenSince = null;

    const resume = () => { if (onResumeRef.current) onResumeRef.current(); };

    // Lets go of a socket for good: its handlers off first, so a late close
    // event can't schedule a second connection.
    const drop = (socket) => {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        try { socket.close(); } catch (e) { /* already closing */ }
      }
    };

    const connect = () => {
      clearTimeout(timer);
      timer = null;
      const reconnecting = ws !== null;
      if (ws) drop(ws);
      ws = new WebSocket(getWebSocketUrl('/ws'));
      ws.onopen = () => {
        attempt = 0;
        if (reconnecting) resume();
      };
      ws.onmessage = (event) => { if (onMessageRef.current) onMessageRef.current(event); };
      ws.onclose = () => {
        if (closed) return;
        timer = setTimeout(connect, Math.min(MAX_DELAY_MS, 1000 * 2 ** attempt));
        attempt += 1;
      };
    };

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenSince = Date.now();
        return;
      }
      const away = hiddenSince !== null ? Date.now() - hiddenSince : 0;
      hiddenSince = null;
      if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        attempt = 0;
        connect(); // reloads once it's open
      } else if (away >= RESUME_AFTER_HIDDEN_MS) {
        resume();
      }
    };

    connect();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      closed = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      drop(ws);
    };
  }, [active, onMessageRef, onResumeRef]);
}
