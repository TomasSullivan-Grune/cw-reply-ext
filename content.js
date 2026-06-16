/* Chatwork Reply — content script
 *
 * 1. Injects a small "↩" reply button under each message (anchored on the
 *    timeline_user-name testid, after the message timestamp).
 * 2. On click, opens a modal where the user types instructions for the reply.
 * 3. The original message text + instructions go to the local bridge (via the
 *    background worker), and Claude's draft reply is shown for review.
 * 4. "Reflect" appends the draft to the current composer, newline-separated,
 *    WITHOUT overwriting whatever is already typed.
 *
 * All injected DOM/CSS is prefixed `cwr-`.
 */
(function () {
  'use strict';

  /* ====================================================================== *
   *  COMPOSER DETECTION + APPEND                                            *
   * ====================================================================== */

  function findComposer() {
    return document.querySelector('#_chatText') ||
           document.querySelector('textarea[name="message"]') ||
           document.querySelector('[role="textbox"][contenteditable="true"]') ||
           document.querySelector('[contenteditable="true"]') ||
           document.querySelector('textarea') ||
           null;
  }

  function readComposer(node) {
    if (!node) return '';
    if (typeof node.value === 'string') return node.value;
    return node.innerText || node.textContent || '';
  }

  // Append text to the composer without clobbering the existing draft.
  function appendToComposer(text) {
    const node = findComposer();
    if (!node) return false;

    const existing = readComposer(node);
    const prefix = existing.trim() ? '\n' : '';

    if (typeof node.value === 'string') {
      // Plain <textarea>: set value and fire input so React/Chatwork sync.
      node.focus();
      node.value = existing + prefix + text;
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.selectionStart = node.selectionEnd = node.value.length;
      return true;
    }

    // contenteditable (React): move caret to end, then insertText so React
    // picks up the change through its synthetic event handlers.
    node.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('insertText', false, prefix + text);
    return true;
  }

  /* ====================================================================== *
   *  MODAL                                                                  *
   * ====================================================================== */

  let modalEl = null;
  let currentMessage = '';
  let currentSender = '';
  let currentRecipients = [];

  // Make Chatwork mention tags readable so it's clear the name that follows is
  // a RECIPIENT the sender addressed — not the sender of the message.
  function prettifyMentions(text) {
    return text
      .replace(/\[返信\s+aid=\d+\s+to=[\d-]+\]\s*([^\n\[]*)/g, function (_m, name) {
        return '↩ 宛先/To: ' + name.trim();
      })
      .replace(/\[rp\s+aid=\d+\s+to=[\d-]+\]\s*([^\n\[]*)/g, function (_m, name) {
        return '↩ 宛先/To: ' + name.trim();
      })
      .replace(/\[To:\d+\]\s*([^\n\[]*)/g, function (_m, name) {
        return '@宛先/To: ' + name.trim();
      });
  }

  // Chatwork puts the open room in the URL hash, e.g. "#!rid438334858".
  function getRoomId() {
    const m = /#!rid(\d+)/.exec(location.hash || '');
    return m ? m[1] : '';
  }

  function buildModal() {
    const overlay = document.createElement('div');
    overlay.className = 'cwr-overlay';
    overlay.innerHTML =
      '<div class="cwr-modal">' +
        '<div class="cwr-header">' +
          '<span class="cwr-title">Reply with Claude</span>' +
          '<button type="button" class="cwr-btn cwr-close" aria-label="Close">✕</button>' +
        '</div>' +
        '<div class="cwr-body">' +
          '<div class="cwr-notice" style="display:none"></div>' +
          '<div class="cwr-context">' +
            '<label class="cwr-label">Message you’re replying to</label>' +
            '<div class="cwr-sender"></div>' +
            '<div class="cwr-recipients" style="display:none"></div>' +
            '<div class="cwr-original"></div>' +
            '<label class="cwr-label">How should Claude reply?</label>' +
            '<textarea class="cwr-instructions" spellcheck="false" placeholder="e.g. 「了承したと伝えて、明日までに対応すると追記」 / Politely decline and propose next week"></textarea>' +
            '<div class="cwr-controls">' +
              '<button type="button" class="cwr-btn cwr-primary cwr-run">Generate</button>' +
              '<span class="cwr-status"></span>' +
            '</div>' +
          '</div>' +
          '<button type="button" class="cwr-expand" style="display:none">✎ Edit message &amp; instructions</button>' +
          '<div class="cwr-result" style="display:none">' +
            '<div class="cwr-result-head">' +
              '<label class="cwr-label">Draft reply</label>' +
              '<div class="cwr-result-actions">' +
                '<button type="button" class="cwr-btn cwr-copy">Copy</button>' +
                '<button type="button" class="cwr-btn cwr-primary cwr-reflect">Reflect → composer</button>' +
              '</div>' +
            '</div>' +
            '<textarea class="cwr-draft" spellcheck="false"></textarea>' +
          '</div>' +
          '<div class="cwr-error" style="display:none"></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    // Stop Chatwork's global key shortcuts from firing while typing here.
    ['keydown', 'keyup', 'keypress'].forEach(function (ev) {
      overlay.addEventListener(ev, function (e) {
        if (e.key === 'Escape') { closeModal(); return; }
        e.stopPropagation();
      }, true);
    });
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) closeModal(); });
    overlay.querySelector('.cwr-close').addEventListener('click', closeModal);
    overlay.querySelector('.cwr-run').addEventListener('click', runReply);
    overlay.querySelector('.cwr-expand').addEventListener('click', function () {
      overlay.classList.remove('cwr-collapsed');
      overlay.querySelector('.cwr-expand').style.display = 'none';
      overlay.querySelector('.cwr-instructions').focus();
    });
    overlay.querySelector('.cwr-copy').addEventListener('click', function (e) {
      copyToClipboard(overlay.querySelector('.cwr-draft').value, e.target);
    });
    overlay.querySelector('.cwr-reflect').addEventListener('click', function () {
      const draft = overlay.querySelector('.cwr-draft').value;
      if (!draft.trim()) return;
      if (appendToComposer(draft)) {
        closeModal();
      } else {
        showError('Couldn’t find the Chatwork message box to append to.');
      }
    });
    return overlay;
  }

  function setStatus(text, busy) {
    const s = modalEl.querySelector('.cwr-status');
    s.textContent = text || '';
    s.className = 'cwr-status' + (busy ? ' cwr-busy' : '');
  }

  function setNotice(text) {
    const n = modalEl.querySelector('.cwr-notice');
    if (!text) { n.style.display = 'none'; n.textContent = ''; return; }
    n.style.display = 'block';
    n.textContent = text;
  }

  function showError(msg, notReachable) {
    const box = modalEl.querySelector('.cwr-error');
    box.style.display = 'block';
    if (notReachable) {
      box.innerHTML =
        '<strong>Can’t reach the local bridge</strong> at http://localhost:8766.<br>' +
        'Start it in a terminal:<br><code>cd bridge &amp;&amp; node server.js</code><br>' +
        '(Claude Code must be installed and logged in.)';
    } else {
      box.textContent = msg || 'Something went wrong.';
    }
    setStatus('', false);
  }

  function runReply() {
    const overlay = modalEl;
    overlay.querySelector('.cwr-error').style.display = 'none';
    overlay.querySelector('.cwr-result').style.display = 'none';

    const instructions = overlay.querySelector('.cwr-instructions').value;
    if (!instructions.trim()) { showError('Tell Claude how you’d like to reply first.'); return; }
    setStatus('Drafting…', true);
    setNotice('');

    chrome.runtime.sendMessage({ type: 'reply', message: currentMessage, sender: currentSender, recipients: currentRecipients, instructions: instructions, roomId: getRoomId() })
      .then(function (resp) {
        if (!resp) { showError('No response from the extension background.'); return; }
        if (!resp.ok) { showError(resp.error, resp.notReachable); return; }
        if (resp.unmapped) { setNotice('No project context for this room.'); }
        overlay.querySelector('.cwr-draft').value = resp.reply || '';
        overlay.querySelector('.cwr-result').style.display = 'block';
        // Collapse the context so the draft is the focus; offer a way back.
        overlay.classList.add('cwr-collapsed');
        overlay.querySelector('.cwr-expand').style.display = 'block';
        setStatus('', false);
      })
      .catch(function (err) {
        showError(err && err.message ? err.message : String(err));
      });
  }

  function openModal(parsed, sender) {
    if (!modalEl) modalEl = buildModal();
    parsed = parsed || {};
    currentMessage = parsed.body || '';
    currentRecipients = parsed.recipients || [];
    currentSender = (sender || '').trim();
    setNotice('');

    const senderBox = modalEl.querySelector('.cwr-sender');
    senderBox.textContent = currentSender ? 'From: ' + currentSender : 'From: (unknown sender)';

    const recBox = modalEl.querySelector('.cwr-recipients');
    if (currentRecipients.length) {
      recBox.style.display = 'block';
      recBox.textContent = 'To: ' + currentRecipients.join('、');
    } else {
      recBox.style.display = 'none';
    }

    modalEl.querySelector('.cwr-original').textContent =
      prettifyMentions(currentMessage) || '(could not read the message text)';
    modalEl.querySelector('.cwr-instructions').value = '';
    modalEl.querySelector('.cwr-draft').value = '';
    modalEl.querySelector('.cwr-result').style.display = 'none';
    modalEl.querySelector('.cwr-error').style.display = 'none';
    // Always start expanded so the context is visible before generating.
    modalEl.classList.remove('cwr-collapsed');
    modalEl.querySelector('.cwr-expand').style.display = 'none';
    setStatus('', false);
    modalEl.classList.add('cwr-open');
    modalEl.querySelector('.cwr-instructions').focus();
  }

  function closeModal() { if (modalEl) modalEl.classList.remove('cwr-open'); }

  function copyToClipboard(text, btn) {
    const done = function () {
      const o = btn.textContent; btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = o; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { fallbackCopy(text, done); });
    } else { fallbackCopy(text, done); }
  }
  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (e) {}
    document.body.removeChild(ta);
  }

  /* ====================================================================== *
   *  BUTTON INJECTION                                                       *
   * ====================================================================== */

  // From a message's username node, find the enclosing message container.
  // We climb until we find an ancestor that also holds the <pre> message body.
  function findMessageContainer(nameEl) {
    let node = nameEl;
    for (let i = 0; i < 8 && node; i++) {
      if (node.querySelector && node.querySelector('pre')) return node;
      node = node.parentElement;
    }
    return null;
  }

  // The body is ALWAYS the full rendered text — we never risk dropping content
  // by trying to split it. Recipients are read only from mention "pills", which
  // Chatwork renders as anchor (<a>) elements; plain body text is never an
  // anchor, so this can't eat the message. Real links (http URLs) are excluded.
  // If mentions aren't anchors in some view, the To: line is simply omitted —
  // the body is still complete.
  function readMessage(container) {
    const pre = container.querySelector('pre');
    if (!pre) return { recipients: [], body: '' };

    let body = (pre.innerText || pre.textContent || '').trim();
    // Chatwork's "返信元" (jump-to-original-reply) button leaves its label in the
    // text, followed by blank lines and then the replied-to name. Relabel it
    // "reply to:" and pull the name onto the same line.
    body = body.replace(/返信元\s*/g, 'reply to: ');

    const recipients = [];
    pre.querySelectorAll('a').forEach(function (a) {
      const href = a.getAttribute('href') || '';
      const t = (a.innerText || a.textContent || '').trim();
      if (!t) return;
      if (/^https?:\/\//i.test(href) || /^https?:\/\//i.test(t)) return; // a real link, not a mention
      recipients.push(t.replace(/^(To|TO)\s*[:：]?\s*/, '').replace(/さん$/, ''));
    });

    return { recipients: recipients, body: body };
  }

  // Find the timestamp element inside the container, if any, to anchor below.
  function findTimeAnchor(container) {
    return container.querySelector('time') ||
           container.querySelector('[data-testid*="time" i]') ||
           null;
  }

  function createTrigger(container, senderName) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cwr-trigger';
    btn.textContent = '↩';
    btn.title = 'Reply with Claude';
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      openModal(readMessage(container), senderName);
    });
    return btn;
  }

  function injectButtons() {
    document.querySelectorAll('[data-testid="timeline_user-name"]').forEach(function (nameEl) {
      const container = findMessageContainer(nameEl);
      if (!container) return;
      if (container.getAttribute('data-cwr-injected')) return;
      container.setAttribute('data-cwr-injected', '1');

      const senderName = (nameEl.innerText || nameEl.textContent || '').trim();
      const btn = createTrigger(container, senderName);
      const time = findTimeAnchor(container);
      if (time && time.parentElement) {
        time.parentElement.insertBefore(btn, time.nextSibling);
      } else {
        // Fallback: drop the button right after the username row.
        const row = nameEl.closest('div') || nameEl.parentElement;
        if (row && row.parentElement) row.parentElement.insertBefore(btn, row.nextSibling);
        else container.appendChild(btn);
      }
    });
  }

  /* ====================================================================== *
   *  BOOT                                                                   *
   * ====================================================================== */

  function debounce(fn, ms) { let t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }
  new MutationObserver(debounce(injectButtons, 250))
    .observe(document.documentElement, { childList: true, subtree: true });
  injectButtons();
  setInterval(injectButtons, 2000);
})();
