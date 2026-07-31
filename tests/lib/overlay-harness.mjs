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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installFakeTimers } from './fake-timers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/* Harnessens EGEN setTimeout, sparad innan de fejkade installeras. Utan den skulle
   `await new Promise(r => setTimeout(r, 0))` nedan hamna i den fejkade kön och
   aldrig köras — uppstarten hade hängt i stället för att flusha microtasks. */
const realSetTimeout = globalThis.setTimeout;

// Räknare för att bryta ESM-modulcachen vid varje loadOverlay (se importen nedan).
let loadCounter = 0;

/* Canvas-2D-stubb som RÄKNAR ritanrop i stället för att rita. Overlays som ritar
   traces (inputs-trace) har ingen DOM att mäta på — utan detta går de inte att
   testa alls, och då är den enda kvarvarande verifieringen att titta på skärmen,
   vilket inte fångar något som varar ett frame. */
function makeCtx(id, log) {
  const ctx = {
    canvas: null,
    setTransform() {}, save() {}, restore() {}, clip() {},
    beginPath() { log.push({ el: id, type: 'ctx', key: 'beginPath' }); },
    clearRect() { log.push({ el: id, type: 'ctx', key: 'clearRect' }); },
    rect() {}, moveTo() {}, lineTo() { log.push({ el: id, type: 'ctx', key: 'lineTo' }); },
    stroke() { log.push({ el: id, type: 'ctx', key: 'stroke', value: ctx.strokeStyle }); },
    lineWidth: 1, lineJoin: 'miter', miterLimit: 10, lineCap: 'butt', strokeStyle: '#000',
  };
  return ctx;
}

/** Fejkat element som loggar allt overlayn skriver till det. */
function makeEl(id, log, byId) {
  const classes = new Set();
  let ctx = null;
  const el = {
    id,
    children: [],
    attrs: {},
    // Layoutmått: overlays räknar canvasstorlek ur dem, och 0 ger division med noll.
    clientWidth: 600,
    clientHeight: 150,
    width: 600,
    height: 150,
    getContext() { return (ctx ||= makeCtx(id, log)); },
    // setProperty måste finnas, inte bara direktskrivning: overlays sätter sin skala
    // med style.setProperty('--ui-scale', …), och utan detta kastade harnessen —
    // eller värre, loggade inget och lät ett test passera på omätt kod.
    style: new Proxy({}, {
      get(t, k) {
        if (k === 'setProperty') {
          return (name, v) => { log.push({ el: id, type: 'style', key: name, value: v }); t[name] = v; };
        }
        if (k === 'removeProperty') {
          return (name) => { log.push({ el: id, type: 'style', key: name, value: null }); delete t[name]; };
        }
        if (k === 'getPropertyValue') return (name) => (name in t ? t[name] : '');
        return t[k];
      },
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
    // '#id' löses upp mot samma element-tabell som getElementById, så
    // root.querySelector('#trace') och document.getElementById('trace') ger SAMMA
    // element och testet kan mäta på det. Andra selektorer ('.graph') får ett
    // stabilt element döpt efter selektorn — vi matchar inte riktig CSS, vi ger
    // bara overlayn något att hålla i.
    querySelector(sel) {
      if (!byId || typeof sel !== 'string') return null;
      return byId(sel.startsWith('#') ? sel.slice(1) : sel);
    },
  };
  Object.defineProperty(el, 'innerHTML', { set() { el.children.length = 0; }, get: () => '' });
  /* textContent LOGGAS, den är inte bara en egenskap. Skälet är att en overlay som
     skriver samma text om och om igen ser identisk ut i DOM:en men kostar arbete
     varje frame — och utan loggpost går det inte att mäta. En medvetet trasig
     variant av varvtidsloggen (utan ändringskontroll) PASSERADE testet innan det
     här fanns, alltså exakt den slappa stubb §9 varnar för.
     Posten saknar `key` med flit: filter som söker attribut eller stilar
     (`{el:'arc', key:'d'}`) ska inte råka matcha den. */
  let text = '';
  Object.defineProperty(el, 'textContent', {
    get: () => text,
    set(v) { text = v; log.push({ el: id, type: 'text', value: v }); },
  });
  return el;
}

/**
 * @param {string} id          overlay-id (mappnamn under src/overlays/)
 * @param {object} opts
 * @param {string[]} opts.expose  namn i overlayns modulscope som testet behöver
 * @param {string}   opts.html    läs HTML härifrån i stället (för --old)
 * @param {object}   opts.init    värden att exponera som window.__OVERLAY_INIT__
 * @param {number}   opts.hz      klockans stegtakt = fejkad vsync (default 30)
 * @param {number}   opts.loopHz  overlayns renderloop-takt (default 30). Skild från
 *                                opts.hz just för att kunna testa Hz-taket: sätt
 *                                hz:144, loopHz:30 för att mäta att den kapar.
 * @param {boolean}  opts.preview kör overlayn som om den satt i kontrollpanelens
 *                                iframe (bus.js:IN_PREVIEW blir true)
 * @param {string}   opts.busFile alternativ sökväg till bus.js (för före/efter-bevis)
 */
export async function loadOverlay(id, opts = {}) {
  const file = opts.html || path.join(ROOT, 'src/overlays', id, 'index.html');
  const html = fs.readFileSync(file, 'utf8');
  const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  if (!m) throw new Error(`hittade inget modulskript i ${file}`);

  const log = [];
  const els = new Map();
  const byId = (elId) => {
    if (!els.has(elId)) els.set(elId, makeEl(elId, log, byId));
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
  globalThis.cancelAnimationFrame = () => {};
  // startLoop sover mellan renderingarna i en timer och kopplar in rAF först strax
  // före deadline. Timern måste därför följa TESTETS klocka, inte väggklockan.
  const timers = installFakeTimers(() => now);
  // Overlays lyssnar på 'message' (kontrollpanelens förhandsvisning skickar
  // ändringar den vägen — Tauris event når inte in i en iframe). Vi sparar
  // lyssnarna så testet kan skicka meddelanden med h.message().
  const listeners = new Map();
  globalThis.addEventListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  };
  // Varje token måste ge en EGEN färg. Returnerade den samma värde för allt gick
  // det inte att se skillnad på t.ex. --red och --abs, och ett test på att ABS
  // färgar bromstracet gult passerade även när overlayn ritade allt i en färg.
  // Värdet är påhittat men stabilt per namn — vi testar färgVAL, inte tokens.css.
  globalThis.getComputedStyle = () => ({
    getPropertyValue: (n) => '#' + [...String(n)]
      .reduce((a, c) => (a * 33 + c.charCodeAt(0)) >>> 0, 5381)
      .toString(16).padStart(6, '0').slice(-6),
  });
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.location = { search: '' };
  // bus.js avgör med `window.self !== window.top` om overlayn kör i kontrollpanelens
  // förhandsvisning. Två skilda objekt = iframe. Standardfallet (båda undefined) är
  // ett vanligt overlay-fönster, vilket är vad alla andra tester ska mäta.
  globalThis.window = opts.preview
    ? { devicePixelRatio: 1, self: { frame: 'preview' }, top: { frame: 'control' } }
    : { devicePixelRatio: 1 };
  globalThis.document = {
    getElementById: byId,
    createElement: () => makeEl('span', log, byId),
    querySelector: () => null,
    documentElement: makeEl('documentElement', log, byId),
    body: makeEl('body', log, byId),
    fonts: { ready: Promise.resolve() },
  };
  globalThis.__OVERLAY_INIT__ = opts.init || undefined;
  globalThis.__harnessSink = (fn) => { sink = fn; };

  // startLoop och wireShell STUBBAS INTE. Båda är det testerna faktiskt bevakar:
  // renderloopens deadline-logik (§8.5) och att startvärden gäller före första paint
  // (§8.3). En stubb av dem mäter ingenting — den handskrivna wireShell-stubben som
  // stod här applicerade t.ex. aldrig alternativ, så ett test på just det passerade
  // utan att overlayn ens fått värdet.
  //
  // bus.js är säker att ladda i Node: den bygger ingen WebSocket vid laddning och rör
  // bara globaler harnessen redan fejkat (därav att globalerna ovan sätts FÖRE
  // importen). Frågesträngen bryter ESM:s modulcache så INIT läses om för VARJE
  // loadOverlay — annars fryses den till det första anropets värden och tester med
  // olika init påverkar varandra.
  // opts.busFile pekar ut en ANNAN bus.js (t.ex. en äldre revision). Utan den går
  // det inte att bevisa att ett test på delad kod biter: overlayns HTML kan hämtas
  // ur git med htmlAtRevision, men bus.js laddas alltid från arbetsträdet.
  const busUrl = pathToFileURL(opts.busFile || path.join(ROOT, 'src/shared/bus.js')).href;
  const bus = await import(`${busUrl}?n=${++loadCounter}`);
  // opts.loopHz sätter takten i test; skild från opts.hz (fejkad vsync) så att
  // Hz-taket går att mäta. En overlay som anger egen hz vinner.
  globalThis.__harnessStartLoop = (tick, o = {}) =>
    bus.startLoop(tick, { ...o, hz: o.hz || opts.loopHz || 30 });
  globalThis.__harnessWireShell = bus.wireShell;

  // WsBus och fontsReady stubbas: den ena öppnar en riktig socket, den andra bara
  // väntar. Ingen av dem är det vi mäter.
  let code = m[1].replace(/^import[^\n]*\n/m, `
    class WsBus { subscribe(fn){ __harnessSink(fn); return () => {}; } }
    const fontsReady = () => Promise.resolve();
    const startLoop = globalThis.__harnessStartLoop;
    const wireShell = globalThis.__harnessWireShell;
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
  await new Promise((r) => realSetTimeout(r, 0));
  await new Promise((r) => realSetTimeout(r, 0));
  // Loopens första steg ligger i en timer (se startLoop). Kör den så rAF-kön är
  // laddad innan testet tickar första gången.
  timers.run();

  const stepMs = 1000 / (opts.hz || 30);
  return {
    api,
    log,
    el: byId,
    get now() { return now; },
    /** Skicka en telemetriram till overlayn (som bussen hade gjort). */
    push(frame) { if (sink) sink(frame); },
    /** Skicka ett postMessage, som kontrollpanelen gör mot förhandsvisningen. */
    message(data) { for (const fn of (listeners.get('message') || [])) fn({ data }); },
    /** Flytta klockan ett frame och kör overlayns rAF-callback.
     *  Timers körs FÖRST: loopen sover i en timer mellan renderingarna och begär
     *  rAF först strax före deadline, så utan det steget är rAF-kön tom. */
    tick(ms = stepMs) {
      now += ms;
      timers.run();
      const fn = rafQueue.shift();
      if (fn) fn(now);
      while (rafQueue.length > 1) rafQueue.shift();   // håll kön kort
      return now;
    },
    /** Lämna tillbaka globalerna (setTimeout m.fl.) till Node. */
    restore() { timers.restore(); },
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

/** En repo-fil som den såg ut i en given git-revision (för före/efter-bevis). */
export function fileAtRevision(relPath, rev = 'HEAD') {
  return execFileSync('git', ['show', `${rev}:${relPath}`], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 8 << 20,
  });
}

/** Overlayns HTML som den såg ut i en given git-revision (för före/efter-bevis). */
export function htmlAtRevision(id, rev = 'HEAD') {
  return fileAtRevision(`src/overlays/${id}/index.html`, rev);
}

export { ROOT };
