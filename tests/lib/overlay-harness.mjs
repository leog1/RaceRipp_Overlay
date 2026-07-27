/* Kör en overlays RIKTIGA renderloop utan webbläsare.
 *
 * Varför: overlay-buggar som "blinkar till" eller "tappar ett frame" kan inte
 * upptäckas på syn eller i en skärmdump — de varar ett enda frame. Här plockas
 * overlayns modulskript ut ur HTML:en, importerna byts mot stubbar, DOM:en fejkas
 * och tiden drivs manuellt. Då kan man mäta exakt vad overlayn skriver, frame för
 * frame.
 *
 * Kör samma test mot `git show HEAD:<fil>` (se --old i testerna) för att bevisa att
 * ett test faktiskt fångar buggen det påstår sig fånga.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Fejkat element som loggar allt overlayn skriver till det. */
function makeEl(id, log) {
  const classes = new Set();
  const el = {
    id,
    children: [],
    textContent: '',
    attrs: {},
    style: new Proxy({}, {
      set(t, k, v) { log.push({ el: id, type: 'style', key: k, value: v }); t[k] = v; return true; },
    }),
    classList: {
      add: (c) => { if (!classes.has(c)) { classes.add(c); log.push({ el: id, type: 'class', key: c, value: true }); } },
      remove: (c) => { if (classes.delete(c)) log.push({ el: id, type: 'class', key: c, value: false }); },
      toggle: (c, on) => {
        const next = on === undefined ? !classes.has(c) : !!on;
        if (next !== classes.has(c)) { next ? classes.add(c) : classes.delete(c); log.push({ el: id, type: 'class', key: c, value: next }); }
      },
      contains: (c) => classes.has(c),
    },
    setAttribute(k, v) { this.attrs[k] = v; log.push({ el: id, type: 'attr', key: k, value: v }); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    removeAttribute(k) { delete this.attrs[k]; },
    toggleAttribute(k, on) {
      const next = on === undefined ? !(k in this.attrs) : !!on;
      if (next) this.attrs[k] = ''; else delete this.attrs[k];
      log.push({ el: id, type: 'attr', key: k, value: next });
    },
    appendChild(c) { this.children.push(c); return c; },
    querySelector() { return null; },
  };
  Object.defineProperty(el, 'innerHTML', { set() { el.children.length = 0; }, get: () => '' });
  return el;
}

/**
 * @param {string} id          overlay-id (mappnamn under src/overlays/)
 * @param {object} opts
 * @param {string[]} opts.expose  namn i overlayns modulscope som testet behöver
 * @param {string}   opts.html    läs HTML härifrån i stället (för --old)
 * @param {object}   opts.init    värden att exponera som window.__OVERLAY_INIT__
 * @param {number}   opts.hz      klockans stegtakt (default 30)
 */
export async function loadOverlay(id, opts = {}) {
  const file = opts.html || path.join(ROOT, 'src/overlays', id, 'index.html');
  const html = fs.readFileSync(file, 'utf8');
  const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  if (!m) throw new Error(`hittade inget modulskript i ${file}`);

  const log = [];
  const els = new Map();
  const byId = (elId) => {
    if (!els.has(elId)) els.set(elId, makeEl(elId, log));
    return els.get(elId);
  };

  let now = 1000;
  let sink = null;                     // overlayns bus-prenumerant
  const rafQueue = [];

  // Global miljö. Sätts på globalThis eftersom overlaykoden körs som en funktion
  // i samma realm, inte i en egen sandlåda.
  globalThis.performance = { now: () => now };
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };
  globalThis.addEventListener = () => {};
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '#000000' });
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.location = { search: '' };
  globalThis.document = {
    getElementById: byId,
    createElement: () => makeEl('span', log),
    querySelector: () => null,
    documentElement: makeEl('documentElement', log),
    body: makeEl('body', log),
    fonts: { ready: Promise.resolve() },
  };
  globalThis.__OVERLAY_INIT__ = opts.init || undefined;
  globalThis.__harnessSink = (fn) => { sink = fn; };

  // Importen ersätts av stubbar: vi testar overlayn, inte bussen.
  let code = m[1].replace(/^import[^\n]*\n/m, `
    class WsBus { subscribe(fn){ __harnessSink(fn); return () => {}; } }
    const wireShell = (applyConfig) => {
      if (globalThis.__OVERLAY_INIT__ && applyConfig) applyConfig(globalThis.__OVERLAY_INIT__);
    };
    const fontsReady = () => Promise.resolve();
  `);
  const expose = opts.expose || [];
  if (expose.length) {
    code += `\n;globalThis.__exposed = {${expose
      .map((n) => `${n}: typeof ${n} !== "undefined" ? ${n} : undefined`)
      .join(', ')}};\n`;
  }
  new Function(code)();
  const api = globalThis.__exposed || {};

  // Overlayn startar sin renderloop i fontsReady().then(...). Släpp fram
  // microtask-kön så uppstarten faktiskt hinner köra — vi vill testa overlayns
  // riktiga startväg, inte anropa frame() bakvägen.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

  const stepMs = 1000 / (opts.hz || 30);
  return {
    api,
    log,
    el: byId,
    get now() { return now; },
    /** Skicka en telemetriram till overlayn (som bussen hade gjort). */
    push(frame) { if (sink) sink(frame); },
    /** Flytta klockan ett frame och kör overlayns rAF-callback. */
    tick(ms = stepMs) {
      now += ms;
      const fn = rafQueue.shift();
      if (fn) fn(now);
      while (rafQueue.length > 1) rafQueue.shift();   // håll kön kort
      return now;
    },
    /** Skicka samma ram i n frames (låter lerpar landa). */
    settle(frame, n = 60) { for (let i = 0; i < n; i++) { this.push(frame); this.tick(); } },
    /** Texten i ett element, sammansatt av dess teckenceller. */
    text(elId) {
      const e = byId(elId);
      return e.children.length ? e.children.map((c) => c.textContent).join('') : e.textContent;
    },
    /** Loggposter som matchar ett filter, i ordning. */
    writes(filter) {
      return log.filter((w) => Object.entries(filter).every(([k, v]) => w[k] === v));
    },
  };
}

/** Overlayns HTML som den såg ut i en given git-revision (för före/efter-bevis). */
export function htmlAtRevision(id, rev = 'HEAD') {
  return execFileSync('git', ['show', `${rev}:src/overlays/${id}/index.html`], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 8 << 20,
  });
}

export { ROOT };
