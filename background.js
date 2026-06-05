/* Background service worker.
 * The content script (running in the https://chatwork.com page) can't reliably
 * reach http://localhost due to private-network / mixed-content rules, so it
 * asks the background worker — which holds host_permissions for localhost — to
 * make the request instead.
 */

const BRIDGE_URL = 'http://localhost:8766/reply';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'reply') return;

  fetch(BRIDGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: msg.message || '', instructions: msg.instructions || '' }),
  })
    .then(async (r) => {
      let data = {};
      try { data = await r.json(); } catch (e) { /* non-JSON */ }
      if (!r.ok) {
        sendResponse({ ok: false, error: data.error || ('HTTP ' + r.status) });
        return;
      }
      sendResponse({ ok: true, reply: data.reply || '' });
    })
    .catch((e) => {
      // A network failure here almost always means the bridge isn't running.
      sendResponse({
        ok: false,
        notReachable: true,
        error: String((e && e.message) || e),
      });
    });

  return true; // keep the message channel open for the async sendResponse
});
