// The count on the app's icon when the journal runs as an installed web app
// (Safari "Add to Dock", Chrome/Edge "Install"), like Telegram Web's unread
// count. Uses the Badging API, which browsers only offer on HTTPS (or
// localhost), and Safari only shows once the user has allowed notifications.

export const APP_BADGE_PERMISSION_EVENT = 'app-badge-permission-changed';

// 'ready' | 'needs-permission' | 'denied' | 'insecure' | 'unsupported'
export function appBadgeState() {
  if (typeof window === 'undefined') return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  if (typeof navigator.setAppBadge !== 'function') return 'unsupported';
  // Chrome/Edge show the badge without a permission; Safari needs the
  // notification one. Where Notification is missing there's nothing to ask.
  if (typeof Notification === 'undefined') return 'ready';
  if (Notification.permission === 'granted') return 'ready';
  if (Notification.permission === 'denied') return 'denied';
  return 'needs-permission';
}

// Must be called from a click (Safari ignores the request otherwise).
export async function requestAppBadgePermission() {
  if (typeof Notification === 'undefined') return appBadgeState();
  try {
    await Notification.requestPermission();
  } catch (_) {
    // Older Safari only has the callback form.
    await new Promise(resolve => Notification.requestPermission(resolve));
  }
  window.dispatchEvent(new Event(APP_BADGE_PERMISSION_EVENT));
  return appBadgeState();
}

export function setAppBadge(count) {
  if (typeof navigator === 'undefined' || typeof navigator.setAppBadge !== 'function') return;
  const done = count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge();
  // Rejects when the page isn't an installed app or has no permission:
  // nothing to show then.
  if (done && typeof done.catch === 'function') done.catch(() => {});
}
