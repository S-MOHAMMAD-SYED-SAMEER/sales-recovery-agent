// How an assistant reply is drawn: a small, safe subset of markdown.
//
// A model writes `WELCOME10` and **30-day** as if they were going to be rendered, and shown as plain
// text they appear as backticks and asterisks. This turns exactly three things into formatting:
//
//   `code`        an inline code span
//   **bold**      bold text
//   "* " or "- "  at the start of a line, a bullet (drawn as "•")
//
// and nothing else. Everything is built from text nodes and elements made with createElement; the
// reply is never parsed as HTML and never assigned to innerHTML, so whatever the model (or a
// customer who talked it into something) writes is shown as text. Markers that do not form a pair
// ("a stray ` or **", an empty pair, a bold that starts or ends in a space) are left as typed.
//
// Plain script, loaded by index.html and also required by the tests, so the same code is what runs.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SraFormat = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const BULLET = /^(\s*)[*-]\s+(?=\S)/;

  // Splits one line into [{ type: 'text' | 'code' | 'bold', text }]. Bold may contain code spans.
  function parseInline(line, { allowBold = true } = {}) {
    const parts = [];
    let buffer = '';
    const flush = () => {
      if (buffer) parts.push({ type: 'text', text: buffer });
      buffer = '';
    };

    let i = 0;
    while (i < line.length) {
      if (line[i] === '`') {
        const end = line.indexOf('`', i + 1);
        if (end > i + 1) {
          flush();
          parts.push({ type: 'code', text: line.slice(i + 1, end) });
          i = end + 1;
          continue;
        }
      }
      if (allowBold && line.startsWith('**', i)) {
        const end = line.indexOf('**', i + 2);
        const inner = end > i + 2 ? line.slice(i + 2, end) : '';
        if (inner && !/^\s/.test(inner) && !/\s$/.test(inner)) {
          flush();
          parts.push({ type: 'bold', children: parseInline(inner, { allowBold: false }) });
          i = end + 2;
          continue;
        }
      }
      buffer += line[i];
      i += 1;
    }
    flush();
    return parts;
  }

  // The whole reply as lines of parts. A bullet marker at the start of a line becomes "• ".
  function parseReply(text) {
    return String(text)
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => parseInline(line.replace(BULLET, '$1• ')));
  }

  function appendParts(doc, parent, parts) {
    for (const part of parts) {
      if (part.type === 'text') {
        parent.appendChild(doc.createTextNode(part.text));
      } else {
        const el = doc.createElement(part.type === 'code' ? 'code' : 'strong');
        if (part.type === 'code') el.appendChild(doc.createTextNode(part.text));
        else appendParts(doc, el, part.children);
        parent.appendChild(el);
      }
    }
  }

  // Fills `container` with the reply. `doc` is the document (a parameter so a test can pass a stand-in).
  // The container keeps white-space: pre-wrap, so the newlines between lines are real newlines in text nodes.
  function renderReply(doc, container, text) {
    const lines = parseReply(text);
    lines.forEach((parts, index) => {
      if (index > 0) container.appendChild(doc.createTextNode('\n'));
      appendParts(doc, container, parts);
    });
  }

  // The text a reply shows with the formatting removed, for tests and for a plain-text fallback.
  function plainText(text) {
    const flat = (parts) => parts.map((p) => (p.type === 'bold' ? flat(p.children) : p.text)).join('');
    return parseReply(text).map(flat).join('\n');
  }

  // The label for the header tag. "Live · <model>" only when the server says a real provider is configured.
  // Anything else, including a malformed answer, keeps the default.
  function modeLabel(info) {
    if (info && info.live === true && typeof info.model === 'string' && info.model.trim()) {
      return { live: true, text: `Live · ${info.model.trim().slice(0, 60)}` };
    }
    return { live: false, text: null };
  }

  // Whether to show the "waking up" notice for a slow first reply. Only when the server says so (SHOW_COLD_START_NOTICE),
  // and only for the first message of a page load. Anything else, including an answer that could not be read, means no
  // notice: it is a hosting message and would be untrue on a local run.
  function shouldShowColdStartNotice(info, firstMessageDone) {
    return Boolean(info) && info.coldStartNotice === true && !firstMessageDone;
  }

  return { parseInline, parseReply, renderReply, plainText, modeLabel, shouldShowColdStartNotice };
});
