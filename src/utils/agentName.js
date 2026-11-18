// What the Todo page calls the external agent that writes to the list (its
// "agent" badge). One app-wide setting (Settings → General), stored in the
// server's config like the number format, and cached in this browser.

const STORAGE_KEY = 'jjournal_agent_name';
export const DEFAULT_AGENT_NAME = 'Agent';

function loadStored() {
  try {
    return localStorage.getItem(STORAGE_KEY) || DEFAULT_AGENT_NAME;
  } catch {
    return DEFAULT_AGENT_NAME;
  }
}

let current = loadStored();
const listeners = new Set();

export function getAgentName() {
  return current;
}

export function setAgentName(value) {
  const next = (typeof value === 'string' && value.trim()) || DEFAULT_AGENT_NAME;
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Storage unavailable: the server config still has it.
  }
  listeners.forEach(fn => fn(next));
}

export function subscribeAgentName(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
