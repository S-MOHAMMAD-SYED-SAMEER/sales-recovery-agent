// The conversation a page load belongs to.
//
// Every page load starts a NEW conversation, the same as the "New conversation" button. The chat on the
// screen is empty at load, so the server must not continue an older conversation either: the model and the
// guardrails would be using earlier questions and verified discount codes that the viewer cannot see.
// Nothing about the conversation is kept in browser storage. (An id an earlier version of this page kept
// there is deleted on load.)
//
// A plain script that works in the browser (it sets `SraSession`) and in Node (the tests `require` it).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SraSession = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LEGACY_KEY = 'sra_session_id';

  // `storage` is localStorage (or a stand-in), `randomId` makes an id the server accepts (1-64 characters of
  // letters, digits, "-" or "_": crypto.randomUUID() does). Storage may be missing or throw; neither matters.
  function startSession(storage, randomId) {
    try {
      if (storage && typeof storage.removeItem === 'function') storage.removeItem(LEGACY_KEY);
    } catch (err) {
      /* nothing to clean up */
    }
    return randomId();
  }

  return { startSession, LEGACY_KEY };
});
