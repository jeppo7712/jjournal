import React, { useState } from 'react';
import { FaCheckCircle, FaTimesCircle, FaExclamationTriangle, FaInfoCircle, FaChevronDown } from 'react-icons/fa';
import styles from './FlexGuide.module.css';

const apiBaseUrl = process.env.REACT_APP_API_URL || '';

// IBKR's Flex Query editor offers hundreds of checkboxes; these are the ones
// the journal reads (see modules/flexCheck.js, which checks a saved query
// against the same list).
const ACTIVITY_SECTIONS = [
  { section: 'Trades', options: 'Execution only', use: 'Importing your trades', need: 'Required' },
  { section: 'Cash Transactions', options: 'Every type, and Detail (not Summary)', use: 'Deposits, fees, interest, dividends and tax on the Capital page', need: 'Recommended' },
  { section: 'Cash Report', options: '—', use: 'Checking the journal\'s cash against IBKR\'s (coming next)', need: 'Recommended' },
  { section: 'Open Dividend Accruals', options: '—', use: 'Dividends announced but not paid yet', need: 'Optional' },
];

const GENERAL_SETTINGS = [
  ['Date Format', 'yyyyMMdd'],
  ['Time Format', 'HHmmss'],
  ['Date/Time Separator', '; (semi-colon)'],
  ['Display Account Alias in Place of Account ID', 'No'],
  ['Include Canceled Trades', 'No'],
  ['Breakout by Day', 'No'],
];

const STATUS_ICON = {
  ok: <FaCheckCircle className={styles.iconOk} aria-label="OK" />,
  missing: <FaTimesCircle className={styles.iconMissing} aria-label="Missing" />,
  warn: <FaExclamationTriangle className={styles.iconWarn} aria-label="Warning" />,
  info: <FaInfoCircle className={styles.iconInfo} aria-label="Note" />,
};

const QUERY_LABEL = { activity: 'Activity query', tradeConfirm: 'Trade Confirmation query' };

function Step({ number, title, children, open, onToggle }) {
  return (
    <div className={`${styles.step} ${open ? styles.stepOpen : ''}`}>
      <button type="button" className={styles.stepHead} onClick={onToggle} aria-expanded={open}>
        <span className={styles.stepNumber}>{number}</span>
        <span className={styles.stepTitle}>{title}</span>
        <FaChevronDown className={styles.chevron} aria-hidden="true" />
      </button>
      {open && <div className={styles.stepBody}>{children}</div>}
    </div>
  );
}

function CheckResults({ report }) {
  if (report.error) return <p className={styles.checkError}>{report.error}</p>;
  if (!report.tokenSet) return <p className={styles.muted}>No token saved for these accounts yet.</p>;
  return report.results.map(result => (
    <div key={result.purpose} className={styles.queryResult}>
      <h5>
        {QUERY_LABEL[result.purpose]}
        {result.queryId && <span className={styles.queryId}>{result.queryId}</span>}
      </h5>
      {!result.configured ? (
        <p className={styles.muted}>
          {result.purpose === 'tradeConfirm'
            ? 'Not set: today\'s trades import once IBKR refreshes the Activity statement overnight.'
            : 'Not set.'}
        </p>
      ) : result.error ? (
        <p className={styles.checkError}>
          IBKR answered: {result.error}
          {/expired/i.test(result.error) && ' — generate a new token (step 3).'}
          {/invalid/i.test(result.error) && ' — check the Query ID, and that the token belongs to the same IBKR login.'}
          {/too many/i.test(result.error) && ' — IBKR allows a request every minute or so; try again shortly.'}
        </p>
      ) : (
        <ul className={styles.checkList}>
          {result.checks.map((check, i) => (
            <li key={i} className={styles.check}>
              {STATUS_ICON[check.status]}
              <div>
                <span className={styles.checkLabel}>{check.label}</span>
                <span className={styles.checkDetail}>{check.detail}</span>
                {check.fix && <span className={styles.checkFix}>{check.fix}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  ));
}

// Step-by-step help for creating the Flex queries on IBKR's side, plus a
// check of the saved ones that says what's still missing.
const FlexGuide = () => {
  const [openStep, setOpenStep] = useState(null);
  const [checking, setChecking] = useState(null);
  const [reports, setReports] = useState({});
  const toggle = n => setOpenStep(prev => (prev === n ? null : n));

  const runCheck = async (set) => {
    setChecking(set);
    try {
      const res = await fetch(`${apiBaseUrl}/api/ibkr-flex/check?set=${set}&refresh=true`);
      const data = await res.json();
      setReports(prev => ({ ...prev, [set]: res.ok ? data : { error: data.error || 'Check failed' } }));
    } catch (err) {
      setReports(prev => ({ ...prev, [set]: { error: err.message } }));
    } finally {
      setChecking(null);
    }
  };

  return (
    <section className={styles.guide}>
      <div className={styles.header}>
        <div>
          <h3>Setting up the Flex queries</h3>
          <p>
            IBKR's Flex Query editor has hundreds of options. These steps tick only what the journal reads;
            then <strong>Check</strong> tests your saved queries and says what's still missing. IBKR renames
            menus now and then: if a label differs slightly, the check below still knows what's needed.
          </p>
        </div>
      </div>

      <div className={styles.steps}>
        <Step number={1} title="Create the Activity Flex Query (your history)" open={openStep === 1} onToggle={() => toggle(1)}>
          <p>In IBKR's Client Portal: <em>Performance &amp; Reports → Flex Queries</em>, then <em>+</em> next to <em>Activity Flex Query</em>. Give it any name, and tick these sections. In each one, <em>Select All</em> its fields: the journal picks what it needs.</p>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>Section</th><th>Options to tick</th><th>Used for</th><th /></tr></thead>
              <tbody>
                {ACTIVITY_SECTIONS.map(s => (
                  <tr key={s.section}>
                    <td className={styles.strong}>{s.section}</td>
                    <td>{s.options}</td>
                    <td>{s.use}</td>
                    <td><span className={`${styles.need} ${styles[`need${s.need}`]}`}>{s.need}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>Under <em>Delivery Configuration</em>: all your accounts, Format <strong>XML</strong>, Period <strong>Last 365 Calendar Days</strong>.</p>
          <p>Under <em>General Configuration</em> (leave the rest as it is):</p>
          <dl className={styles.settingsList}>
            {GENERAL_SETTINGS.map(([name, value]) => (
              <React.Fragment key={name}><dt>{name}</dt><dd>{value}</dd></React.Fragment>
            ))}
          </dl>
          <p>Save. The Query ID is the number shown next to the query's name in the list.</p>
        </Step>

        <Step number={2} title="Create the Trade Confirmation Flex Query (today's trades)" open={openStep === 2} onToggle={() => toggle(2)}>
          <p>
            The Activity statement only refreshes overnight. For trades made today, add a query under
            <em> Trade Confirmation Flex Query</em>: section <strong>Trade Confirmations</strong>, option
            <strong> Executions</strong>, <em>Select All</em> fields, Format <strong>XML</strong>, and the same General
            Configuration as above. Its period is always Today. Optional: without it, today's trades arrive the next day.
          </p>
        </Step>

        <Step number={3} title="Get a Flex Web Service token" open={openStep === 3} onToggle={() => toggle(3)}>
          <p>
            On the same Flex Queries page, open <em>Flex Web Service Configuration</em>, enable it and generate a
            token. Pick the longest validity IBKR offers; when it expires, the check below says so. One token covers
            all the queries of that IBKR login.
          </p>
        </Step>

        <Step number={4} title="Enter them here and link your accounts" open={openStep === 4} onToggle={() => toggle(4)}>
          <p>
            Paste the token and both Query IDs into <strong>Real accounts</strong> above, and save. A paper account is a
            separate IBKR login with its own queries and token: repeat steps 1-3 logged in there, for <strong>Paper accounts</strong>.
          </p>
          <p>
            Then in <em>Settings → Accounts</em>, enter each IBKR account ID (U… for real, DU… for paper) as the
            <strong> Broker account ID</strong> of the top-level journal account that mirrors it. That's how the cash
            activity of each IBKR account finds its journal account.
          </p>
        </Step>
      </div>

      <div className={styles.checkBox}>
        <div className={styles.checkHead}>
          <div>
            <h4>Check my queries</h4>
            <p className={styles.muted}>Runs the saved queries once and compares them with the list above. Save your changes first.</p>
          </div>
          <div className={styles.checkButtons}>
            {['real', 'paper'].map(set => (
              <button key={set} type="button" className={styles.checkButton} onClick={() => runCheck(set)} disabled={!!checking}>
                {checking === set ? 'Checking…' : `Check ${set} accounts`}
              </button>
            ))}
          </div>
        </div>
        {['real', 'paper'].filter(set => reports[set]).map(set => (
          <div key={set} className={styles.report}>
            <h4 className={styles.reportTitle}>{set === 'real' ? 'Real accounts' : 'Paper accounts'}</h4>
            <CheckResults report={reports[set]} />
          </div>
        ))}
      </div>
    </section>
  );
};

export default FlexGuide;
