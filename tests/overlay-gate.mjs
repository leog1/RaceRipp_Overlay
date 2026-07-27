/* Synk-grinden ("Endast när ACC kör") — döljer den overlayn för lättvindigt?
 *
 * Rapporterat från riktig körning (0.3.0): båda overlays blinkade var tredje–fjärde
 * sekund, som om de slogs av och på under en halv sekund. Grinden dolde overlayn så
 * fort EN ram hade connected:false, och motorn skickade sådana ramar när ACC:s delade
 * minne inte hunnit uppdateras (se tests/acc_source.py — det var grundorsaken).
 *
 * Motorn är fixad, men grinden ska ändå inte vara så nervös: en enstaka tappad ram får
 * aldrig kunna släcka overlayn mitt i en kurva. Det här testet mäter just det, och det
 * kan inte göras med ögat — blinket varade under ett halvt sekund.
 *
 * Kör:  node tests/overlay-gate.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'OK  ' : 'FEL '} ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed++;
}

/* Miljö. document.documentElement.style.visibility är det grinden faktiskt skriver,
   så vi loggar varje skrivning och mäter dem. */
let NOW = 100000;
const writes = [];
const winCalls = [];
function setupEnv(gate) {
  globalThis.__OVERLAY_INIT__ = { id: 'delta-bar', scale: 1, opacity: 1, gate };
  globalThis.Date = class extends Date { static now() { return NOW; } };
  globalThis.window = {};                       // inte i preview (self/top saknas → olika)
  globalThis.setTimeout = (fn) => fn && 0;      // timers körs inte av sig själva här
  globalThis.document = {
    documentElement: {
      style: new Proxy({}, {
        set(t, k, v) { if (k === 'visibility') writes.push({ at: NOW, value: v }); t[k] = v; return true; },
        get(t, k) { return t[k]; },
      }),
    },
  };
  globalThis.WebSocket = class {                // öppnar aldrig något
    constructor() { this.onopen = this.onmessage = this.onerror = this.onclose = null; }
    close() {}
  };
  // Tauri-stubb som LOGGAR hide/show. Anropen misslyckades tyst i verkligheten
  // (core:window:allow-hide saknades i capabilities) och overlayn såg ut att
  // fungera medan fönstret aldrig doldes — CPU:n låg kvar. Därför mäts de här.
  winCalls.length = 0;
  globalThis.__TAURI__ = {
    window: { getCurrentWindow: () => ({
      hide: () => { winCalls.push('hide'); return Promise.resolve(); },
      show: () => { winCalls.push('show'); return Promise.resolve(); },
    }) },
  };
}

let n = 0;
async function loadBus(gate) {
  writes.length = 0;
  setupEnv(gate);
  const url = pathToFileURL(path.join(ROOT, 'src/shared/bus.js')).href;
  return await import(`${url}?gate=${++n}`);
}

const hidden = () => (writes.length ? writes[writes.length - 1].value === 'hidden' : false);
/* Antal gånger overlayn DOLTS. Det är detta som är blinket — att bara titta på
   sluttillståndet missar det helt, eftersom overlayn hann komma tillbaka. Den första
   versionen av det här testet gjorde precis det misstaget och passerade mot den
   buggiga koden. */
const hideCount = (from = 0) => writes.slice(from).filter((w) => w.value === 'hidden').length;

// ── 1. En enstaka tappad ram får inte dölja overlayn ───────────────────────
// Detta ÄR den rapporterade buggen, mätt.
{
  const { WsBus } = await loadBus(true);
  const bus = new WsBus();
  bus._emit({ connected: true, throttle: 1 });
  check('ansluten ram visar overlayn', !hidden(), `${writes.length} skrivningar`);

  const before = writes.length;
  bus._emit({ connected: false });              // ETT tappat frame
  NOW += 25;
  bus._emit({ connected: true });
  check('ett tappat frame döljer ALDRIG overlayn', hideCount(before) === 0,
        writes.map((w) => w.value || '(synlig)').join(' → ') || 'inga skrivningar');
}

// ── 2. En kort svacka (en halv sekund) får inte heller blinka ─────────────
{
  const { WsBus } = await loadBus(true);
  const bus = new WsBus();
  bus._emit({ connected: true });
  const before = writes.length;
  for (let i = 0; i < 20; i++) { bus._emit({ connected: false }); NOW += 25; }   // 500 ms
  bus._emit({ connected: true });
  check('en halv sekunds avbrott döljer aldrig overlayn', hideCount(before) === 0,
        `${hideCount(before)} döljningar, ${writes.length - before} skrivningar`);
}

// ── 3. Men en RIKTIG frånkoppling ska dölja den ──────────────────────────
{
  const { WsBus } = await loadBus(true);
  const bus = new WsBus();
  bus._emit({ connected: true });
  for (let i = 0; i < 120; i++) { bus._emit({ connected: false }); NOW += 25; }  // 3 s
  check('ihållande frånkoppling döljer overlayn', hidden(),
        writes.map((w) => w.value || '(synlig)').join(' → '));
}

// ── 4. Den ska komma tillbaka DIREKT, inte efter en fördröjning ──────────
// Man ska aldrig behöva vänta på att overlayn dyker upp när man kör ut igen.
{
  const { WsBus } = await loadBus(true);
  const bus = new WsBus();
  for (let i = 0; i < 120; i++) { bus._emit({ connected: false }); NOW += 25; }
  check('dold efter frånkoppling', hidden());
  bus._emit({ connected: true });                // samma ögonblick, ingen tid går
  check('visas igen omedelbart vid återanslutning', !hidden(),
        writes.map((w) => w.value || '(synlig)').join(' → '));
}

// ── 5. Med grinden AV ska overlayn aldrig döljas ────────────────────────
{
  const { WsBus } = await loadBus(false);
  const bus = new WsBus();
  for (let i = 0; i < 200; i++) { bus._emit({ connected: false }); NOW += 25; }
  check('med grinden av döljs overlayn aldrig', !hidden(), `${writes.length} skrivningar`);
}

// ── 6. Inga onödiga DOM-skrivningar ────────────────────────────────────
// _emit körs 40 ggr/s; en skrivning per ram är precis det §8.5 varnar för.
{
  const { WsBus } = await loadBus(true);
  const bus = new WsBus();
  for (let i = 0; i < 200; i++) { bus._emit({ connected: true }); NOW += 25; }
  check('stabil anslutning ger högst en DOM-skrivning', writes.length <= 1,
        `${writes.length} skrivningar på 200 ramar`);
}

// ── 7. Fönstret ska OS-döljas, inte bara CSS-döljas ───────────────────────
// Mätt: med enbart visibility:hidden låg WebView2 på 37,8 % av en kärna med båda
// overlays dolda — renderarna gick vidare och GPU-processen komponerade fortfarande
// två always-on-top-fönster. Att stänga fönstren tog det till 14,8 %.
//
// Detta är också platsen där ett fel går tyst: anropet krävde
// core:window:allow-hide i capabilities, och utan den avvisades det medan overlayn
// såg ut att fungera precis som förut.
{
  const { WsBus } = await loadBus(true);
  const bus = new WsBus();
  bus._emit({ connected: true });
  check('inget fönsteranrop medan overlayn syns', winCalls.length === 0,
        winCalls.join(',') || 'inga anrop');

  for (let i = 0; i < 120; i++) { bus._emit({ connected: false }); NOW += 25; }
  check('fönstret döljs på OS-nivå vid frånkoppling', winCalls.includes('hide'),
        winCalls.join(',') || 'inga anrop');

  bus._emit({ connected: true });
  check('fönstret visas igen vid återanslutning',
        winCalls[winCalls.length - 1] === 'show', winCalls.join(','));
  check('ett anrop per lägesbyte, inte per ram', winCalls.length === 2,
        `${winCalls.length} anrop: ${winCalls.join(',')}`);
}

console.log(failed ? `\n${failed} kontroll(er) misslyckades` : '\nAllt OK');
process.exit(failed ? 1 : 0);
