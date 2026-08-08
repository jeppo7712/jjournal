import React from 'react';
import { DateTime } from 'luxon';

// Free timezone picker, remembered globally (not per-symbol/component — the
// point is "always show me the same zone regardless of what I'm looking
// at"). 'exchange' and 'local' are sentinels resolved dynamically per
// symbol/browser; anything else is a literal IANA zone name the user picked
// once and wants everywhere, independent of which exchange the instrument
// actually trades on (the underlying stored times are always correct
// absolute instants — this only controls how they're displayed). Shared by
// TradeView and TradeModal so picking a zone in one place applies in both.
const DISPLAY_TIMEZONE_STORAGE_KEY = 'jjournal_display_timezone';

export const TIMEZONE_OPTIONS = [
  { value: 'exchange', label: "Exchange (instrument's own)" },
  { value: 'local', label: 'Local (this browser)' },
  { value: 'America/New_York', label: 'New York' },
  { value: 'America/Chicago', label: 'Chicago' },
  { value: 'America/Los_Angeles', label: 'Los Angeles' },
  { value: 'Europe/London', label: 'London' },
  { value: 'Europe/Amsterdam', label: 'Amsterdam / Berlin / Paris' },
  { value: 'Asia/Dubai', label: 'Dubai' },
  { value: 'Asia/Singapore', label: 'Singapore' },
  { value: 'Asia/Tokyo', label: 'Tokyo' },
  { value: 'Australia/Sydney', label: 'Sydney' },
  { value: 'UTC', label: 'UTC' },
];

export function loadStoredDisplayTimezone() {
  try {
    return localStorage.getItem(DISPLAY_TIMEZONE_STORAGE_KEY) || 'exchange';
  } catch {
    return 'exchange';
  }
}

export function storeDisplayTimezone(value) {
  try {
    localStorage.setItem(DISPLAY_TIMEZONE_STORAGE_KEY, value);
  } catch {
    // Storage full/unavailable — not worth surfacing an error for a UI preference.
  }
}

// Resolves the picker's value (a sentinel or a literal IANA zone) to the
// actual zone name to hand to Luxon.
export function resolveDisplayZone(displayTimezone, exchangeTimezone) {
  if (displayTimezone === 'exchange') return exchangeTimezone;
  if (displayTimezone === 'local') return 'local';
  return displayTimezone;
}

// Short label for the *resolved* zone (e.g. "America/New_York") — used
// wherever the actual zone name needs to be shown inline (e.g. next to a
// timestamp), as opposed to the picker itself which already shows the
// selected option's own label.
export function getDisplayZoneLabel(displayTimezone, exchangeTimezone) {
  if (displayTimezone === 'local') return DateTime.local().zoneName;
  if (displayTimezone === 'exchange') return exchangeTimezone;
  return displayTimezone;
}

export function TimezonePicker({ value, onChange, options = TIMEZONE_OPTIONS }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        background: '#2c303c',
        color: '#e0e2e6',
        border: '1px solid #3a3f4d',
        borderRadius: '8px',
        padding: '4px 8px',
        fontSize: '0.85em',
      }}
    >
      {options.map(opt => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
  );
}
