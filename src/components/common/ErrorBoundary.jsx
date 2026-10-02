import React, { useContext } from 'react';
import { TradeContext } from '../../context/TradeContext';
import styles from './Dialogs.module.css';

// Without this, an error while rendering unmounts the whole app and leaves
// a black page. Catches it, shows what failed with a way back, and keeps
// the rest of the app (navigation, other pages) usable. `resetKey`: when
// it changes (e.g. another page or account is chosen), the part is tried
// again.
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info?.componentStack);
  }

  componentDidUpdate(prevProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className={styles.crash} role="alert">
        <div className={styles.crashCard}>
          <h2 className={styles.dialogTitle}>Something went wrong here</h2>
          <p className={styles.dialogMessage}>
            This part of the journal ran into an error and couldn't be shown. Your data is fine.
            Try again, or reload the page.
          </p>
          <pre className={styles.crashDetail}>{String(this.state.error?.message || this.state.error)}</pre>
          <div className={styles.actions}>
            <button type="button" className={styles.secondary} onClick={() => this.setState({ error: null })}>Try again</button>
            <button type="button" className={styles.primary} onClick={() => window.location.reload()}>Reload</button>
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;

// For a page: tried again when another page or account is chosen (an
// account whose data broke a page shouldn't keep it broken for the others).
export function PageBoundary({ view, children }) {
  const { currentAccountId } = useContext(TradeContext) || {};
  return <ErrorBoundary resetKey={`${view}|${currentAccountId}`}>{children}</ErrorBoundary>;
}
