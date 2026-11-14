// Saves that are safe to repeat. A form sends a key of its own with a save
// (POST /trades' saveKey, the X-Save-Key header of modules/saveOnce.js) and
// keeps it until the server answers, so pressing Save again after a lost
// answer is recognised as the same save instead of booking it twice.

// Not crypto.randomUUID: Safari only has it over https.
export const newSaveKey = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;

// fetch's error when the server could not be reached: "Load failed"
// (Safari), "Failed to fetch" (Chrome), "NetworkError when attempting to
// fetch resource." (Firefox). A TypeError from a bug in the code is not it.
export const isNetworkError = err => err instanceof TypeError
  && /load failed|failed to fetch|networkerror/i.test(err.message);
