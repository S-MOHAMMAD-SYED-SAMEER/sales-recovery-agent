import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describeMode } from '../src/routes/mode.js';
import { createApp } from '../src/app.js';

// The chat page: how a reply is drawn, and the header tag that says whether a real model is answering.
//
// The page is a single HTML file and the project has no browser in its tests, so the logic that
// matters lives in `web/format.js` (a plain script the page loads and these tests require), and the
// DOM it builds is checked with a stand-in document that REFUSES innerHTML, so "never parsed as HTML" is
// something the test enforces rather than a claim.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname, '../../web');
const page = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
const SraFormat = createRequire(import.meta.url)(path.join(webDir, 'format.js'));

// --- a document stand-in -------------------------------------------------------------------------------

function fakeDocument() {
  const make = (tag) => {
    const el = {
      tag,
      children: [],
      appendChild(child) {
        this.children.push(child);
        return child;
      },
    };
    for (const forbidden of ['innerHTML', 'outerHTML', 'insertAdjacentHTML']) {
      Object.defineProperty(el, forbidden, {
        set() {
          throw new Error(`${forbidden} was used`);
        },
      });
    }
    return el;
  };
  return {
    createElement: make,
    createTextNode: (text) => ({ text: String(text) }),
  };
}

/** The tree as a compact string: text as itself, elements as <tag>…</tag>. */
function show(node) {
  if ('text' in node) return node.text;
  return `<${node.tag}>${node.children.map(show).join('')}</${node.tag}>`;
}

function render(text) {
  const doc = fakeDocument();
  const container = doc.createElement('div');
  SraFormat.renderReply(doc, container, text);
  return container;
}

// --- inline code and bold ---------------------------------------------------------------------------------

test('a code span and a bold span are drawn, and the backticks and asterisks are not shown', () => {
  assert.equal(show(render('Yes, `WELCOME10` is valid.')), '<div>Yes, <code>WELCOME10</code> is valid.</div>');
  assert.equal(show(render('We offer a **30-day return window**.')), '<div>We offer a <strong>30-day return window</strong>.</div>');
  assert.equal(
    show(render('Use `WELCOME10` for **10% off** your first order.')),
    '<div>Use <code>WELCOME10</code> for <strong>10% off</strong> your first order.</div>'
  );
  assert.equal(show(render('**`WELCOME10`** is valid')), '<div><strong><code>WELCOME10</code></strong> is valid</div>');
});

test('the reply from the live app that prompted this: backticks around a code are gone', () => {
  const reply = 'The only code I can verify is `WELCOME10`, which gives 10% off for first-time customers.';
  const tree = render(reply);
  assert.ok(!show(tree).includes('`'));
  assert.equal(SraFormat.plainText(reply), 'The only code I can verify is WELCOME10, which gives 10% off for first-time customers.');
});

test('bullets are drawn as bullets, line by line, and other lines are untouched', () => {
  const reply = 'Here is what I can tell you:\n* Returns within 30 days\n- Prepaid labels for domestic orders\nAnything else?';
  assert.equal(
    SraFormat.plainText(reply),
    'Here is what I can tell you:\n• Returns within 30 days\n• Prepaid labels for domestic orders\nAnything else?'
  );
  // A dash inside a sentence, a negative number and an asterisk with nothing after it are not bullets.
  assert.equal(SraFormat.plainText('Well - maybe. -5 degrees. *'), 'Well - maybe. -5 degrees. *');
  assert.equal(SraFormat.plainText('5 * 3 = 15'), '5 * 3 = 15');
});

test('markers that do not form a pair are shown as typed', () => {
  for (const text of ['a stray ` backtick', 'an unclosed **bold', 'empty `` pair', 'empty **** bold', '** padded **', 'one * star', 'price: $5 ** 2']) {
    assert.equal(SraFormat.plainText(text), text, text);
    assert.ok(!show(render(text)).includes('<code>') && !show(render(text)).includes('<strong>'), text);
  }
});

test('a code span never contains bold, and a bold span that would start or end in a space is not one', () => {
  assert.equal(show(render('`**not bold**`')), '<div><code>**not bold**</code></div>');
  assert.equal(show(render('**a **b** c**')), '<div>**a <strong>b</strong> c**</div>');
});

test('line breaks are kept as newlines in text nodes, including Windows line endings', () => {
  assert.equal(show(render('one\ntwo\r\nthree')), '<div>one\ntwo\nthree</div>');
});

// --- safety ----------------------------------------------------------------------------------------------------

test('markup in a reply is shown as text: it is never turned into elements, and innerHTML is never touched', () => {
  const attacks = [
    '<img src=x onerror="alert(1)">',
    '<script>alert(1)</script>',
    '`<b>bold</b>` and **<i>italic</i>**',
    '[click](javascript:alert(1)) <a href="https://evil.example">here</a>',
    '&lt;already escaped&gt; &amp; <div onclick="x()">',
  ];
  for (const attack of attacks) {
    const tree = render(attack); // the stand-in throws if innerHTML (or similar) is set
    const rendered = show(tree);
    assert.ok(rendered.length > 0);
    // Only the three element types this module creates can exist in the tree, whatever the text says.
    const walk = (node) => ('text' in node ? [] : [node.tag, ...node.children.flatMap(walk)]);
    assert.ok(walk(tree).every((tag) => ['div', 'code', 'strong'].includes(tag)), `${attack} -> ${walk(tree).join(',')}`);
    // And the characters the attacker typed are all still there, as text.
    const text = SraFormat.plainText(attack);
    for (const marker of ['<img', '<script', '<a href', '<div onclick', 'javascript:alert(1)']) {
      if (attack.includes(marker)) assert.ok(text.includes(marker), `${marker} survived as text`);
    }
  }
});

// Every script the page runs. None of them may parse markup: a reply, a customer's message and a trace
// are data, and the only safe way to show data is as text nodes. The rule is "never", not "only literals".
const WEB_SCRIPTS = ['format.js', 'trace.js', 'session.js', 'app.js'];
const FORBIDDEN_MARKUP_APIS = /innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment|DOMParser|srcdoc|\beval\s*\(|new\s+Function\s*\(|setAttribute\(\s*['"]on/;

test('no script of the page can parse HTML, and the page has no inline script', () => {
  for (const file of WEB_SCRIPTS) {
    // Comments are free to name the APIs they warn about; only code is scanned.
    const source = fs.readFileSync(path.join(webDir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!FORBIDDEN_MARKUP_APIS.test(source), `${file} uses an API that parses markup or code`);
  }
  // Nothing runs from the HTML file itself, so there is nothing there to audit, and no handler attributes.
  assert.ok(!/<script(?![^>]*\bsrc=)/i.test(page), 'index.html has an inline script');
  assert.ok(!/\son[a-z]+\s*=/i.test(page), 'index.html has an inline event handler');
  // Every script file that exists in web/ is on the list above, so a new one cannot slip past the scan.
  const onDisk = fs.readdirSync(webDir).filter((f) => f.endsWith('.js')).sort();
  assert.deepEqual(onDisk, [...WEB_SCRIPTS].sort());
});

test('the page draws a reply with the formatter and loads its scripts in dependency order', () => {
  const app = fs.readFileSync(path.join(webDir, 'app.js'), 'utf8');
  assert.match(app, /SraFormat\.renderReply\(document, bubble, data\.reply\)/);
  const order = [...page.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(order, ['format.js', 'trace.js', 'session.js', 'app.js']);
});

test('the formatter is served next to the page', async (t) => {
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/format.js`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /renderReply/);
});

// --- the header tag ---------------------------------------------------------------------------------------------------

const KEY = 'AQ.secret-key-that-must-never-be-shown';

test('only a configured real provider is live, and it names its model', () => {
  assert.deepEqual(describeMode({ llmProvider: 'gemini', geminiModel: 'gemini-3.5-flash-lite', geminiApiKey: KEY }, true), {
    provider: 'gemini',
    live: true,
    model: 'gemini-3.5-flash-lite',
  });
  assert.deepEqual(describeMode({ llmProvider: 'anthropic', anthropicModel: 'claude-x', anthropicApiKey: KEY }, true), {
    provider: 'anthropic',
    live: true,
    model: 'claude-x',
  });
});

test('the demo provider, and a real provider that has no key, are not live and name no model', () => {
  assert.deepEqual(describeMode({ llmProvider: 'demo', geminiModel: 'gemini-3.5-flash-lite' }, true), { provider: 'demo', live: false, model: null });
  assert.deepEqual(describeMode({ llmProvider: 'gemini', geminiModel: 'gemini-3.5-flash-lite', geminiApiKey: '' }, false), {
    provider: 'gemini',
    live: false,
    model: null,
  });
});

test('the answer never contains the key, whatever the configuration', () => {
  for (const config of [
    { llmProvider: 'gemini', geminiModel: 'm', geminiApiKey: KEY },
    { llmProvider: 'anthropic', anthropicModel: 'm', anthropicApiKey: KEY },
    { llmProvider: 'demo', geminiApiKey: KEY, anthropicApiKey: KEY },
  ]) {
    assert.ok(!JSON.stringify(describeMode(config, true)).includes(KEY));
    assert.ok(!JSON.stringify(describeMode(config, false)).includes(KEY));
  }
});

test('/api/mode is served by the app and reports the demo provider under the test configuration', async (t) => {
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/mode`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['coldStartNotice', 'live', 'model', 'provider']);
  assert.equal(body.coldStartNotice, false, 'off unless SHOW_COLD_START_NOTICE=true');
  assert.equal(typeof body.live, 'boolean');
});

test('the page shows "Live · <model>" only from a live answer, and keeps Demo otherwise', () => {
  assert.deepEqual(SraFormat.modeLabel({ provider: 'gemini', live: true, model: 'gemini-3.5-flash-lite' }), {
    live: true,
    text: 'Live · gemini-3.5-flash-lite',
  });
  for (const answer of [
    { provider: 'demo', live: false, model: null },
    { provider: 'gemini', live: false, model: 'gemini-3.5-flash-lite' },
    { live: true },
    { live: true, model: '   ' },
    { live: 'true', model: 'x' },
    null,
    undefined,
    'live',
  ]) {
    assert.deepEqual(SraFormat.modeLabel(answer), { live: false, text: null }, JSON.stringify(answer));
  }
  // A very long model string cannot take over the header.
  assert.ok(SraFormat.modeLabel({ live: true, model: 'x'.repeat(500) }).text.length <= 70);

  // The page starts as Demo and changes only through textContent.
  assert.match(page, /<span class="tag" id="mode-tag">Demo<\/span>/);
  const app = fs.readFileSync(path.join(webDir, 'app.js'), 'utf8');
  assert.match(app, /tag\.textContent = mode\.text;/);
  assert.match(app, /fetch\('\/api\/mode'\)/);
});

// --- the cold-start notice: a hosting message, shown only when the flag is on --------------------------------------

test('the server reports the notice setting: on only when config says exactly true', async () => {
  const { describeUi } = await import('../src/routes/mode.js');
  assert.deepEqual(describeUi({ showColdStartNotice: true }), { coldStartNotice: true });
  assert.deepEqual(describeUi({ showColdStartNotice: false }), { coldStartNotice: false });
  assert.deepEqual(describeUi({}), { coldStartNotice: false });
  assert.deepEqual(describeUi({ showColdStartNotice: 'true' }), { coldStartNotice: false }, 'a string is not the parsed flag');
});

test('the page shows the notice only for the first message, and only when the server says the flag is on', () => {
  const on = { coldStartNotice: true };
  const off = { coldStartNotice: false };
  // flag ON: shown for the first message of a page load, not for later ones
  assert.equal(SraFormat.shouldShowColdStartNotice(on, false), true);
  assert.equal(SraFormat.shouldShowColdStartNotice(on, true), false);
  // flag OFF (the default, and any local run): never
  assert.equal(SraFormat.shouldShowColdStartNotice(off, false), false);
  assert.equal(SraFormat.shouldShowColdStartNotice(off, true), false);
  // an answer that never came, or an older server without the field: never
  for (const info of [null, undefined, {}, { coldStartNotice: 'true' }, { coldStartNotice: 1 }, 'on']) {
    assert.equal(SraFormat.shouldShowColdStartNotice(info, false), false, JSON.stringify(info));
  }
});

test('the page decides through that helper and starts with no notice until /api/mode answers', () => {
  const code = fs.readFileSync(path.join(webDir, 'app.js'), 'utf8');
  assert.match(code, /let modeInfo = null;/);
  assert.match(code, /if \(!SraFormat\.shouldShowColdStartNotice\(modeInfo, firstMessageDone\)\) return;/);
  assert.match(code, /modeInfo = info;/);
});

test('the flag is documented where a host owner looks: HOSTING.md, the README table and .env.example', () => {
  const root = path.resolve(webDir, '..');
  const hosting = fs.readFileSync(path.join(root, 'docs/HOSTING.md'), 'utf8');
  assert.match(hosting, /SHOW_COLD_START_NOTICE=true/);
  assert.match(hosting, /off\s+by default/);
  assert.match(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), /\| `SHOW_COLD_START_NOTICE` \| off \|/);
  assert.match(fs.readFileSync(path.join(root, 'server/.env.example'), 'utf8'), /^SHOW_COLD_START_NOTICE=$/m);
});
