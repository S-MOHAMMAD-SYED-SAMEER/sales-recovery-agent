// What the page shows about a turn: the chips under an answer and the Operator panel's list of steps.
//
// Everything here is drawn from `trace` as the server recorded it (server/src/trace/). Nothing is
// animated, estimated or filled in: a step that is not in the trace is not on the screen, and when a
// reply carries no trace (an older server) the panel says so instead of guessing.
//
// A plain script that works both in the browser (it sets `SraTrace`) and in Node (the tests `require`
// it). Every node is built with createElement/createTextNode/createElementNS and `textContent`, never
// by parsing HTML, so nothing in a trace (a customer's own words included) can become markup.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SraTrace = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The wording a customer sees under a reply. Unknown names are shown as they are, never hidden.
  const TOOL_LABELS = {
    getOrderStatus: 'Checked order status',
    checkStock: 'Checked product availability',
    checkDiscount: 'Checked promotion',
    searchKnowledgeBase: 'Checked store information',
  };
  const SIGNAL_LABELS = {
    purchase_intent: 'Noticed: ready to buy',
    purchase_hesitation: 'Noticed: hesitation',
    price_concern: 'Noticed: price concern',
    shipping_concern: 'Noticed: delivery concern',
    return_concern: 'Noticed: returns concern',
    cart_abandonment_risk: 'Noticed: may leave without buying',
  };
  // The operator's wording: "Signal: hesitation".
  const SIGNAL_SHORT = {
    purchase_intent: 'ready to buy',
    purchase_hesitation: 'hesitation',
    price_concern: 'price concern',
    shipping_concern: 'delivery concern',
    return_concern: 'returns concern',
    cart_abandonment_risk: 'may leave without buying',
  };

  const isTrace = (trace) => Boolean(trace) && Array.isArray(trace.steps);
  const stepsOf = (trace, type) => (isTrace(trace) ? trace.steps.filter((s) => s && s.type === type) : []);
  const unique = (list) => [...new Set(list)];

  function num(n) {
    return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : null;
  }
  function ms(n) {
    const v = num(n);
    return v === null ? null : `${v} ms`;
  }
  function words(name) {
    return String(name).replace(/_/g, ' ');
  }

  // The chips under an answer: what the assistant checked, which store files it drew on, what it noticed.
  // From the trace when there is one; from the older `toolsUsed`/`signals` fields when there is not.
  function chipsFor(body) {
    const trace = body && body.trace;
    if (isTrace(trace)) {
      return {
        tools: unique(stepsOf(trace, 'tool').map((s) => TOOL_LABELS[s.name] || String(s.name))),
        sources: unique(stepsOf(trace, 'retrieve').flatMap((s) => (Array.isArray(s.sources) ? s.sources : []))),
        signals: unique(stepsOf(trace, 'signal').map((s) => SIGNAL_LABELS[s.signal] || String(s.signal))),
      };
    }
    return {
      tools: unique(((body && body.toolsUsed) || []).map((name) => TOOL_LABELS[name] || String(name))),
      sources: [],
      signals: unique(((body && body.signals) || []).map((s) => SIGNAL_LABELS[s.type] || String(s.type))),
    };
  }

  // ---- the steps as rows ------------------------------------------------------------------------

  function argsText(args) {
    if (!args || typeof args !== 'object') return null;
    const parts = Object.keys(args).map((k) => `${k}: “${args[k]}”`);
    return parts.length ? parts.join(', ') : null;
  }

  function rowFor(step) {
    switch (step.type) {
      case 'signal':
        return {
          kind: 'signal',
          icon: 'signal',
          tone: 'notice',
          label: `Signal: ${SIGNAL_SHORT[step.signal] || words(step.signal)}`,
          detail: [`Matched “${step.why}”`, typeof step.confidence === 'number' ? `Confidence ${step.confidence}` : null],
        };
      case 'model': {
        if (step.scripted) {
          return {
            kind: 'model',
            icon: 'model',
            tone: 'neutral',
            label: 'Demo assistant',
            detail: ['Scripted replies: no model was called', ms(step.latencyMs)],
          };
        }
        const tokens =
          typeof step.tokensIn === 'number' || typeof step.tokensOut === 'number'
            ? `${num(step.tokensIn) ?? '?'} tokens in · ${num(step.tokensOut) ?? '?'} out`
            : null;
        return {
          kind: 'model',
          icon: 'model',
          tone: 'neutral',
          label: 'Model call',
          detail: [[step.provider, step.model].filter(Boolean).join(' · '), ms(step.latencyMs), tokens],
        };
      }
      case 'tool': {
        const searched = step.name === 'searchKnowledgeBase';
        return {
          kind: 'tool',
          icon: searched ? 'search' : 'tool',
          tone: step.ok === false ? 'fail' : 'ok',
          label: searched ? 'Searched knowledge base' : `Called ${step.name}`,
          detail: [argsText(step.args), step.summary, ms(step.ms)],
        };
      }
      case 'retrieve': {
        if (step.unavailable) {
          return { kind: 'retrieve', icon: 'doc', tone: 'fail', label: 'Knowledge base unavailable', detail: [] };
        }
        const sources = Array.isArray(step.sources) ? step.sources : [];
        const items = (Array.isArray(step.chunks) ? step.chunks : []).map((c) => ({
          text: [c.id || c.source, c.heading, typeof c.relevance === 'number' ? `relevance ${c.relevance}` : null].filter(Boolean).join(' · '),
          tone: 'neutral',
        }));
        return {
          kind: 'retrieve',
          icon: 'doc',
          tone: 'ok',
          label: sources.length ? `Sources: ${sources.join(', ')}` : 'No relevant passages found',
          detail: [],
          items,
        };
      }
      default:
        return null;
    }
  }

  // The guardrail steps (one per policy) become one row, so a clean turn is a single "Guardrail: passed"
  // line, with the policies listed under it. A block names the policy and its reason.
  function guardrailRow(checks) {
    const blocked = checks.filter((c) => c.outcome === 'block');
    const items = checks.map((c) => ({ text: words(c.policy), tone: c.outcome === 'block' ? 'fail' : 'ok', mark: c.outcome === 'block' ? 'block' : 'pass' }));
    if (blocked.length === 0) {
      return { kind: 'guardrail', icon: 'shield-check', tone: 'ok', label: 'Guardrail: passed', detail: [`${checks.length} policies checked, none triggered`], items };
    }
    return {
      kind: 'guardrail',
      icon: 'shield-block',
      tone: 'fail',
      label: 'Guardrail: blocked',
      detail: [...blocked.map((c) => `${words(c.policy)}${c.reason ? `: ${c.reason}` : ''}`), 'The customer saw the safe fallback reply'],
      items,
    };
  }

  function buildView(trace) {
    if (!isTrace(trace)) return { rows: [], totalMs: null };
    const rows = [];
    let pending = [];
    const flush = () => {
      if (pending.length) rows.push(guardrailRow(pending));
      pending = [];
    };
    for (const step of trace.steps) {
      if (!step) continue;
      if (step.type === 'guardrail') {
        pending.push(step);
        continue;
      }
      flush();
      const row = rowFor(step);
      if (row) rows.push(row);
    }
    flush();
    for (const row of rows) row.detail = row.detail.filter(Boolean);
    return { rows, totalMs: typeof trace.totalMs === 'number' ? trace.totalMs : null };
  }

  // ---- drawing ----------------------------------------------------------------------------------

  const SVG_NS = 'http://www.w3.org/2000/svg';
  // Decorative 24x24 line icons, drawn by hand for this page.
  const ICONS = {
    search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M21 21l-4.3-4.3'],
    tool: ['M13 2L4 14h7l-1 8 9-12h-7z'],
    signal: ['M3 12h4l3-8 4 16 3-8h4'],
    model: ['M7 7h10v10H7z', 'M10 3v4', 'M14 3v4', 'M10 17v4', 'M14 17v4', 'M3 10h4', 'M3 14h4', 'M17 10h4', 'M17 14h4'],
    doc: ['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M9 13h6', 'M9 17h6'],
    'shield-check': ['M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z', 'M8.5 12l2.5 2.5 4.5-5'],
    'shield-block': ['M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z', 'M9.5 9.5l5 5', 'M14.5 9.5l-5 5'],
  };

  function el(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function icon(doc, name) {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    for (const d of ICONS[name] || ICONS.tool) {
      const path = doc.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    return svg;
  }

  function renderRow(doc, row) {
    const li = el(doc, 'li', `step step-${row.kind} tone-${row.tone}`);
    const badge = el(doc, 'span', 'step-icon');
    badge.appendChild(icon(doc, row.icon));
    li.appendChild(badge);

    const body = el(doc, 'div', 'step-body');
    body.appendChild(el(doc, 'p', 'step-label', row.label));
    for (const line of row.detail) body.appendChild(el(doc, 'p', 'step-detail', line));
    if (row.items && row.items.length) {
      const list = el(doc, 'ul', 'step-items');
      for (const item of row.items) {
        // The mark is text, so the pass/block difference is not carried by colour alone.
        const prefix = item.mark === 'block' ? '✕ ' : item.mark === 'pass' ? '✓ ' : '';
        list.appendChild(el(doc, 'li', `step-item tone-${item.tone}`, `${prefix}${item.text}`));
      }
      body.appendChild(list);
    }
    li.appendChild(body);
    return li;
  }

  // Replaces what `container` shows with the steps of `trace`. `doc` is a parameter so a test can pass a stand-in.
  function renderTrace(doc, container, trace) {
    container.textContent = '';
    const view = buildView(trace);
    if (view.rows.length === 0) {
      container.appendChild(el(doc, 'p', 'panel-empty', 'No steps were recorded for this reply.'));
      return view;
    }
    const list = el(doc, 'ol', 'steps');
    for (const row of view.rows) list.appendChild(renderRow(doc, row));
    container.appendChild(list);
    if (view.totalMs !== null) container.appendChild(el(doc, 'p', 'steps-total', `Total ${ms(view.totalMs)}`));
    return view;
  }

  return { TOOL_LABELS, SIGNAL_LABELS, SIGNAL_SHORT, chipsFor, buildView, renderTrace };
});
