import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

// The charts size themselves with a ResizeObserver (lightweight-charts'
// autoSize). When a chart opens inside a modal whose layout is still
// settling, the browser reports "ResizeObserver loop completed with
// undelivered notifications": harmless, the chart just redraws a frame later.
// The development error overlay shows it as a runtime error, so drop exactly
// that message before the overlay's own listener sees it (capture phase).
window.addEventListener('error', (event) => {
  if (typeof event.message === 'string' && event.message.startsWith('ResizeObserver loop')) {
    event.stopImmediatePropagation();
    event.preventDefault();
  }
}, true);

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
