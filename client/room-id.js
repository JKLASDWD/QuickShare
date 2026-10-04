'use strict';
// Shared by configuration and renderer forms so missing/legacy values cannot
// become literal "undefined" or "null" room names through DOM coercion.
((root) => {
  function normalizeRoomId(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    if (typeof value === 'number' && !Number.isFinite(value)) return '';
    const id = String(value).trim();
    return /^(undefined|null)$/i.test(id) ? '' : id;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { normalizeRoomId };
  else root.QuickShareRoomId = { normalizeRoomId };
})(typeof window === 'undefined' ? globalThis : window);
