// Builds the app's WebSocket URL for a given path (e.g. '/ws').
//
// REST calls already use REACT_APP_API_URL to reach the backend — in dev
// that's a full URL like http://192.168.1.6:3999 (frontend and backend run
// as separate servers on different ports there), and in production it's ''
// (the backend serves the built frontend itself, so relative URLs resolve to
// the same origin). WebSocket connections need the same origin, just with
// ws(s):// instead of http(s)://, otherwise in dev they silently try to
// connect to the frontend dev server's own port, where nothing is listening.
export function getWebSocketUrl(path) {
  const apiUrl = process.env.REACT_APP_API_URL;
  if (apiUrl) {
    return apiUrl.replace(/^http/, 'ws') + path;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${path}`;
}
