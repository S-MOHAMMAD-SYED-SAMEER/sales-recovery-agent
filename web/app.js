// The chat page. Everything on the screen is built with createElement/createTextNode and `textContent`:
// a reply, a customer's message and a trace are data, and none of them is ever parsed as HTML.
//
// What the Operator view shows is the `trace` the server returns with each reply (server/src/trace/):
// the steps it recorded while it ran. This file draws that and adds nothing to it. The only thing shown
// while a reply is pending is one "Working…" line, because that is all the page knows until the reply
// arrives; real step-by-step streaming (SSE) is planned for v1.1.
(function () {
  'use strict';

  const SESSION_KEY = 'sra_session_id';
  const THEME_KEY = 'sra_theme';
  const VIEW_KEY = 'sra_view';
  const HINT_MS = 2500;
  const WAKE_NOTICE_AFTER_MS = 2500;
  const NARROW = window.matchMedia('(max-width: 899px)');

  // Browser storage can be missing or throw (a private window, blocked site data). The page works
  // without it: it only remembers a session, a theme and a view.
  function readStored(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (err) {
      return null;
    }
  }
  function writeStored(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (err) {
      /* nothing to do */
    }
  }

  function newSessionId() {
    const id = crypto.randomUUID();
    writeStored(SESSION_KEY, id);
    return id;
  }
  let sessionId = readStored(SESSION_KEY) || newSessionId();

  const app = document.getElementById('app');
  const log = document.getElementById('log');
  const emptyState = document.getElementById('empty-state');
  const emptyStatus = document.getElementById('empty-status');
  const form = document.getElementById('chat-form');
  const input = document.getElementById('message');
  const sendButton = form.querySelector('button[type="submit"]');
  const newConvoButton = document.getElementById('new-convo');
  const suggestions = document.getElementById('suggestions');
  const hint = document.getElementById('composer-hint');
  const panel = document.getElementById('panel');
  const panelBody = document.getElementById('panel-body');
  const panelSub = document.getElementById('panel-sub');
  const panelClose = document.getElementById('panel-close');
  const viewCustomer = document.getElementById('view-customer');
  const viewOperator = document.getElementById('view-operator');
  const themeToggle = document.getElementById('theme-toggle');

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ---- theme -------------------------------------------------------------------------------------

  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

  function effectiveTheme() {
    const chosen = document.documentElement.getAttribute('data-theme');
    if (chosen === 'light' || chosen === 'dark') return chosen;
    return darkQuery.matches ? 'dark' : 'light';
  }

  function syncThemeButton() {
    const current = effectiveTheme();
    themeToggle.dataset.effective = current;
    const next = current === 'dark' ? 'light' : 'dark';
    themeToggle.setAttribute('aria-label', `Switch to the ${next} theme`);
    themeToggle.title = `Switch to the ${next} theme`;
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    writeStored(THEME_KEY, theme);
    syncThemeButton();
  }

  const savedTheme = readStored(THEME_KEY);
  if (savedTheme === 'light' || savedTheme === 'dark') document.documentElement.setAttribute('data-theme', savedTheme);
  syncThemeButton();
  // Until the visitor chooses, the page follows the system, including when it changes.
  darkQuery.addEventListener('change', syncThemeButton);
  themeToggle.addEventListener('click', () => applyTheme(effectiveTheme() === 'dark' ? 'light' : 'dark'));

  // ---- the turns, and which reply the panel shows -------------------------------------------------------

  // One entry per assistant reply: its element, what the customer asked, and the whole response.
  const replies = [];
  let selected = -1;
  let pending = false;

  function hideEmptyState() {
    if (emptyState) emptyState.hidden = true;
  }

  function showEmptyState(statusText) {
    if (!emptyState) return;
    if (emptyStatus) {
      emptyStatus.textContent = statusText || '';
      emptyStatus.hidden = !statusText;
    }
    emptyState.hidden = false;
  }

  function scrollToBottom() {
    log.scrollTop = log.scrollHeight;
  }

  function appendUserTurn(text) {
    hideEmptyState();
    const turn = make('div', 'turn user');
    turn.appendChild(make('div', 'bubble', text));
    log.appendChild(turn);
    scrollToBottom();
  }

  function chipRow(chips) {
    const meta = make('div', 'meta');
    for (const text of chips.tools) meta.appendChild(make('span', 'badge', text));
    for (const text of chips.sources) meta.appendChild(make('span', 'badge source', text));
    for (const text of chips.signals) meta.appendChild(make('span', 'badge signal', text));
    // Whether the guardrails ran on this reply, and whether one blocked it. Only from the trace.
    if (chips.guardrail) meta.appendChild(make('span', chips.guardrail.blocked ? 'badge guardrail blocked' : 'badge guardrail', chips.guardrail.label));
    return meta;
  }

  function appendAssistantTurn(userText, data) {
    hideEmptyState();
    const turn = make('div', 'turn assistant');
    const bubble = make('div', 'bubble');
    // Inline code and bold are drawn; everything is built from text nodes, never parsed as HTML.
    SraFormat.renderReply(document, bubble, data.reply);
    turn.appendChild(bubble);

    const chips = SraTrace.chipsFor(data);
    if (chips.tools.length || chips.sources.length || chips.signals.length || chips.guardrail) turn.appendChild(chipRow(chips));

    // Keyboard and touch way to the steps; only visible in the Operator view.
    const index = replies.length;
    const button = make('button', 'trace-btn', 'View steps');
    button.type = 'button';
    button.setAttribute('aria-pressed', 'false');
    button.dataset.index = String(index);
    turn.appendChild(button);

    turn.dataset.index = String(index);
    log.appendChild(turn);
    replies.push({ turn, button, userText, data });
    scrollToBottom();
    return index;
  }

  function appendSystemNotice(text, info) {
    hideEmptyState();
    const turn = make('div', 'turn system');
    turn.appendChild(make('div', info ? 'bubble info' : 'bubble', text));
    log.appendChild(turn);
    scrollToBottom();
  }

  function shorten(text, max) {
    const flat = String(text).replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  }

  function selectReply(index, { open = true } = {}) {
    selected = index;
    replies.forEach((r, i) => {
      r.turn.classList.toggle('selected', i === index);
      r.button.setAttribute('aria-pressed', i === index ? 'true' : 'false');
    });
    const reply = replies[index];
    if (!reply) {
      panelSub.textContent = 'Select a reply to see its steps.';
      panelBody.textContent = '';
      panelBody.appendChild(make('p', 'panel-empty', 'Send a message, then select its reply to see what the assistant did.'));
      return;
    }
    panelSub.textContent = `Reply to: “${shorten(reply.userText, 70)}”`;
    SraTrace.renderTrace(document, panelBody, reply.data.trace);
    panelBody.scrollTop = 0;
    if (open && NARROW.matches && currentView() === 'operator') panel.classList.add('open');
  }

  function closePanel() {
    panel.classList.remove('open');
  }

  // ---- Customer / Operator ---------------------------------------------------------------------------------

  function currentView() {
    return app.dataset.view === 'operator' ? 'operator' : 'customer';
  }

  function setView(view) {
    const operator = view === 'operator';
    app.dataset.view = operator ? 'operator' : 'customer';
    viewCustomer.setAttribute('aria-pressed', operator ? 'false' : 'true');
    viewOperator.setAttribute('aria-pressed', operator ? 'true' : 'false');
    writeStored(VIEW_KEY, app.dataset.view);
    if (!operator) {
      closePanel();
      return;
    }
    if (replies.length > 0) selectReply(selected >= 0 ? selected : replies.length - 1, { open: true });
    else selectReply(-1);
  }

  viewCustomer.addEventListener('click', () => setView('customer'));
  viewOperator.addEventListener('click', () => setView('operator'));
  panelClose.addEventListener('click', closePanel);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.classList.contains('open')) closePanel();
  });

  log.addEventListener('click', (e) => {
    if (currentView() !== 'operator') return;
    const turn = e.target.closest('.turn.assistant');
    if (!turn || turn.dataset.index === undefined) return;
    selectReply(Number(turn.dataset.index), { open: true });
  });

  // ---- one honest pending indicator ----------------------------------------------------------------------------

  let workingEl = null;

  function showWorking() {
    workingEl = make('div', 'turn assistant');
    const box = make('div', 'working');
    box.appendChild(make('span', null, 'Working…'));
    for (let i = 0; i < 3; i += 1) {
      const dot = make('span', 'dot');
      dot.setAttribute('aria-hidden', 'true');
      box.appendChild(dot);
    }
    workingEl.appendChild(box);
    log.appendChild(workingEl);
    scrollToBottom();
    if (currentView() === 'operator') {
      panelBody.textContent = '';
      panelBody.appendChild(make('p', 'panel-empty', 'Working… the steps appear here when the reply arrives.'));
    }
  }

  function hideWorking() {
    if (workingEl) workingEl.remove();
    workingEl = null;
  }

  // The first message of a visit can be slow while the hosted service starts up. Say what is happening,
  // but only once it has actually been slow. It reports a real wait and shows no percentage, countdown
  // or progress bar, because there is nothing real to base one on.
  let firstMessageDone = false;
  let wakeNoticeTimer = null;
  let wakeNoticeEl = null;

  function startWakeNotice() {
    if (firstMessageDone) return;
    wakeNoticeTimer = setTimeout(() => {
      hideEmptyState();
      wakeNoticeEl = make('div', 'turn system');
      wakeNoticeEl.appendChild(
        make('div', 'bubble info', 'Waking up the support assistant — this may take a few seconds on the first message.')
      );
      log.appendChild(wakeNoticeEl);
      scrollToBottom();
    }, WAKE_NOTICE_AFTER_MS);
  }

  function clearWakeNotice() {
    clearTimeout(wakeNoticeTimer);
    wakeNoticeTimer = null;
    if (wakeNoticeEl) {
      wakeNoticeEl.remove();
      wakeNoticeEl = null;
    }
    firstMessageDone = true;
  }

  // ---- the composer is locked while a reply is pending ---------------------------------------------------------------

  let hintTimer = null;

  function showHint() {
    hint.textContent = 'Wait for the reply…';
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
      hint.textContent = '';
    }, HINT_MS);
  }

  function clearHint() {
    clearTimeout(hintTimer);
    hint.textContent = '';
  }

  function setPending(value) {
    pending = value;
    // readOnly, not disabled: the box keeps focus and still receives key presses, so the hint can say why
    // nothing is being typed.
    input.readOnly = value;
    sendButton.disabled = value;
    form.setAttribute('aria-busy', value ? 'true' : 'false');
    for (const chip of suggestions.querySelectorAll('.suggestion-chip')) chip.disabled = value;
    if (!value) clearHint();
  }

  input.addEventListener('keydown', (e) => {
    if (!pending) return;
    // Any key that would have typed something (or deleted it) while the reply is still being written.
    if (e.key === 'Tab' || e.key === 'Shift' || e.key === 'Escape') return;
    e.preventDefault();
    showHint();
  });
  input.addEventListener('paste', (e) => {
    if (!pending) return;
    e.preventDefault();
    showHint();
  });

  async function sendMessage(message) {
    if (pending) {
      showHint();
      return;
    }
    appendUserTurn(message);
    setPending(true);
    showWorking();
    startWakeNotice();

    let newIndex = -1;
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message }),
      });
      const data = await res.json();
      clearWakeNotice();
      hideWorking();

      if (!res.ok) {
        appendSystemNotice(data.error || 'Sorry, something went wrong while processing that request. Please try again.');
      } else {
        newIndex = appendAssistantTurn(message, data);
      }
    } catch (err) {
      clearWakeNotice();
      hideWorking();
      appendSystemNotice("Sorry, we couldn't reach the assistant just now. Please try again in a moment.");
    } finally {
      setPending(false);
      input.focus();
    }

    if (currentView() === 'operator') {
      // A new reply is selected. On a narrow screen the sheet only changes if it was already open.
      if (newIndex >= 0) selectReply(newIndex, { open: panel.classList.contains('open') });
      else if (selected >= 0) selectReply(selected, { open: false });
      else selectReply(-1);
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const message = input.value.trim();
    if (!message) return;
    if (pending) {
      showHint();
      return;
    }
    input.value = '';
    sendMessage(message);
  });

  suggestions.addEventListener('click', (e) => {
    const chip = e.target.closest('.suggestion-chip');
    if (!chip || pending) return;
    sendMessage(chip.dataset.msg);
  });

  // On a phone the quick-start row scrolls sideways. A chip that is only partly in view is not scrolled to by
  // the browser when it takes keyboard focus, so a keyboard user would tab onto a half-hidden chip.
  suggestions.addEventListener('focusin', (e) => {
    if (e.target.classList && e.target.classList.contains('suggestion-chip')) e.target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });

  newConvoButton.addEventListener('click', () => {
    if (pending) {
      showHint();
      return;
    }
    sessionId = newSessionId();
    // Clear the turns but keep the empty state itself, then show it again.
    for (const child of Array.from(log.children)) {
      if (child !== emptyState) child.remove();
    }
    replies.length = 0;
    selected = -1;
    closePanel();
    if (currentView() === 'operator') selectReply(-1);
    showEmptyState('New conversation started — send a message to begin.');
    input.focus();
  });

  // The header says "Demo" until the server reports that a real model is configured. Only the provider's
  // model name is ever shown here, never a key. If the question cannot be answered the tag stays as it is.
  (async function showMode() {
    try {
      const res = await fetch('/api/mode');
      if (!res.ok) return;
      const mode = SraFormat.modeLabel(await res.json());
      const tag = document.getElementById('mode-tag');
      if (mode.live && tag) {
        tag.textContent = mode.text;
        tag.classList.add('live');
      }
    } catch (err) {
      /* keep the default tag */
    }
  })();

  // The remembered view, applied last so the panel has something to draw.
  if (readStored(VIEW_KEY) === 'operator') setView('operator');
  else selectReply(-1);
  closePanel();
  input.focus();
})();
