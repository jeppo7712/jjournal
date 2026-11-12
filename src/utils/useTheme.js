import { useSyncExternalStore } from 'react';
import { getTheme, subscribeTheme } from './theme';

// The current theme ('dark' | 'light'); the component re-renders when it
// changes, so colours drawn in JavaScript (charts) can follow it.
export default function useTheme() {
  return useSyncExternalStore(subscribeTheme, getTheme, () => 'dark');
}
