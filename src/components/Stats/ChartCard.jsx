import React from 'react';
import styles from './Stats.module.css';

// A Stats chart card: title and legend on the left, the figure the chart
// leads up to on the right, the chart, and the "how it's calculated" text
// folded away underneath.
//
// legend: [{ label, color, kind: 'line' | 'dot' }]
// tone: 'pos' | 'neg' | undefined (colours the headline figure)
const ChartCard = ({ title, legend, value, tone, caption, explanation, children }) => (
  <div className={styles.chartContainer}>
    <div className={styles.chartHead}>
      <div className={styles.chartHeadMain}>
        <h4>{title}</h4>
        {legend && legend.length > 0 && (
          <div className={styles.chartLegend}>
            {legend.map(item => (
              <span key={item.label} className={styles.chartLegendItem}>
                <i
                  className={item.kind === 'line' ? styles.chartKeyLine : styles.chartKeyDot}
                  style={{ background: item.color }}
                />
                {item.label}
              </span>
            ))}
          </div>
        )}
      </div>
      {value !== undefined && value !== null && (
        <div className={styles.chartHeadline}>
          <span className={`${styles.chartHeadValue} ${tone === 'pos' ? styles.valuePos : tone === 'neg' ? styles.valueNeg : ''}`}>
            {value}
          </span>
          {caption && <span className={styles.chartHeadCaption}>{caption}</span>}
        </div>
      )}
    </div>
    {children}
    {explanation && (
      <details className={styles.chartInfo}>
        <summary>How it’s calculated</summary>
        <p className={styles.chartExplanation}>{explanation}</p>
      </details>
    )}
  </div>
);

export default ChartCard;
