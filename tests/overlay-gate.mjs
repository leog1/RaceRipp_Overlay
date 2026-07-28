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
function setupEnv(gate, extra) {
  globalThis.__OVERLAY_INIT__ = { id: 'delta-bar', scale: 1, opacity: 1, gate, ...extra };
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
async function loadBus(gate, extra) {
  writes.length = 0;
  setupEnv(gate, extra);
  const url = pathToFileURL(path.join(ROOT, 'src/shared/bus.js')).href;
  return await import(`${url}?gate=${++n}`);
}

const hidden = () => (writes.length ? writes[writes.length - 1].value === 'hidden' : false);
/* Antal gånger overlayn DOLTS. Det är detta som är blinket — att bara titta på
   sluttillståndet missar det helt, eftersom overlayn hann komma tillbaka. Den första
   versionen av det här testet gjorde precis det misstaget och passerade mot den
   buggiga koden. */
const hideCount = (from = 0) => writes.slice(from).filter((w) => w.value === 'hidden').length;

// ── 0. Vid START ska overlayn vara dold DIREKT, ingen fördröjning ─────────
// Rapporterat från riktig användning (0.3.6): overlays poppade upp vid appstart och
// försvann först efter ~1 sekund. GATE_HOLD_MS finns för att en tappad ram MITT
// UNDER KÖRNING inte ska släcka overlayn — den ska inte gälla innan man ens varit
// ansluten. Skalet skapar dessutom fönstret dolt, vilket testas separat nedan.
{
  const { WsBus } = await loadBus(true);
  const bus = new WsBus();
  bus._emit({ connected: false });               // första ramen, aldrig varit ansluten
  check('dold redan vid första frånkopplade ramen', hidden(),
        writes.map((w) => w.value || '(synlig)').join(' → ') || 'inga skrivningar');
  check('ingen synlig-skrivning före döljningen', hideCount() === 1 && writes.length === 1,
        `${writes.length} skrivningar: ${writes.map((w) => w.value || '(synlig)').join(' → ')}`);
}

// ── 0b. Skalet säger att fönstret redan är dolt ───────────────────────────
// lib.rs skapar fönstret med .visible(false) när grinden är på och skickar
// osHidden:true. Utan det hade bus.js trott sig aldrig ha dolt fönstret och därför
// vägrat visa det när ACC ansluter — overlayn hade blivit permanent osynlig.
{
  winCalls.length = 0;
  globalThis.__OVERLAY_INIT__ = { id: 'delta-bar', scale: 1, opacity: 1, gate: true, osHidden: true };
  const url = pathToFileURL(path.join(ROOT, 'src/shared/bus.js')).href;
  const { WsBus } = await import(`${url}?osh=${++n}`);
  const bus = new WsBus();
  bus._emit({ connected: false });
  check('inget extra hide-anrop när skalet redan dolt fönstret',
        !winCalls.includes('hide'), winCalls.join(',') || 'inga anrop');
  bus._emit({ connected: true });
  check('fönstret visas när ACC ansluter, trots att skalet dolde det',
        winCalls.includes('show'), winCalls.join(',') || 'inga anrop');
}

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
  bus._emit({ connected: true });                 // första ramen: dold → synlig
  const settled = writes.length;
  for (let i = 0; i < 200; i++) { bus._emit({ connected: true }); NOW += 25; }
  // Poängen är att inget upprepas PER RAM. Att grinden skriver en gång vid start
  // (dold) och en gång när ACC ansluter (synlig) är rätt — det är två lägesbyten.
  check('stabil anslutning ger INGA ytterligare DOM-skrivningar',
        writes.length === settled,
        `${writes.length - settled} extra på 200 ramar (${settled} vid uppstart)`);
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
  // Grinden döljer redan vid modulladdning (INIT.gate), sedan visar första
  // anslutna ramen igen. Två anrop är alltså rätt innan mätningen börjar.
  bus._emit({ connected: true });
  const base = winCalls.length;
  for (let i = 0; i < 100; i++) { bus._emit({ connected: true }); NOW += 25; }
  check('inget fönsteranrop per ram medan overlayn syns', winCalls.length === base,
        `${winCalls.length - base} extra: ${winCalls.join(',')}`);

  for (let i = 0; i < 120; i++) { bus._emit({ connected: false }); NOW += 25; }
  check('fönstret döljs på OS-nivå vid frånkoppling',
        winCalls[winCalls.length - 1] === 'hide', winCalls.join(','));
  const afterHide = winCalls.length;
  for (let i = 0; i < 100; i++) { bus._emit({ connected: false }); NOW += 25; }
  check('och döljs bara EN gång, inte per ram', winCalls.length === afterHide,
        `${winCalls.length - afterHide} extra: ${winCalls.join(',')}`);

  bus._emit({ connected: true });
  check('fönstret visas igen vid återanslutning',
        winCalls[winCalls.length - 1] === 'show', winCalls.join(','));
}

// ── 8. En AVSTÄNGD overlay får grinden aldrig visa ────────────────────────
// Rapporterat från riktig körning (0.4.1): overlays dök upp när man tabbade ut ur
// ACC och gick sedan inte att stänga av — ögonknappen såg ut att göra ingenting.
//
// Kedjan: att tabba ut ur ACC stallar det delade minnet → connected:false →
// grinden döljer → man tabbar in igen → connected:true → grinden "återställer"
// fönstret med show(). Den återställningen brydde sig inte om att overlayn var
// AVSTÄNGD, så varje ut- och intabbning tände den igen.
//
// §8.5b beskriver redan halva regeln ("visa bara fönster grinden själv har dolt"),
// men skyddet räckte inte: grinden HADE dolt fönstret — den visste bara inte att
// skalet redan höll det stängt av en annan anledning.
{
  const { WsBus } = await loadBus(true, { enabled: false });
  const bus = new WsBus();
  winCalls.length = 0;
  bus._emit({ connected: true });                     // ACC igång, overlay avstängd
  check('avstängd overlay visas inte när ACC ansluter',
        !winCalls.includes('show'), winCalls.join(',') || 'inga anrop');

  for (let i = 0; i < 120; i++) { bus._emit({ connected: false }); NOW += 25; }  // tabba ut
  bus._emit({ connected: true });                     // tabba in igen
  check('avstängd overlay överlever en ut- och intabbning',
        !winCalls.includes('show'), winCalls.join(',') || 'inga anrop');
}

// ── 9. Att stänga av MITT i en session ska hålla ─────────────────────────
// Samma bugg, men startad från påslaget läge: skalet döljer fönstret när man
// klickar på ögat, och nästa frånkoppling→återanslutning tände det igen.
{
  const { WsBus, setEnabled } = await loadBus(true, { enabled: true });
  const bus = new WsBus();
  bus._emit({ connected: true });
  winCalls.length = 0;

  setEnabled(false);                                  // ögonknappen i panelen
  for (let i = 0; i < 120; i++) { bus._emit({ connected: false }); NOW += 25; }
  bus._emit({ connected: true });
  check('overlay som stängts av under körning tänds inte av grinden',
        !winCalls.includes('show'), winCalls.join(',') || 'inga anrop');

  // …och när man slår på den igen ska grinden ta över ansvaret som vanligt.
  setEnabled(true);
  winCalls.length = 0;
  for (let i = 0; i < 120; i++) { bus._emit({ connected: false }); NOW += 25; }
  check('påslagen igen: grinden döljer den vid frånkoppling',
        winCalls[winCalls.length - 1] === 'hide', winCalls.join(',') || 'inga anrop');
  bus._emit({ connected: true });
  check('påslagen igen: grinden visar den vid återanslutning',
        winCalls[winCalls.length - 1] === 'show', winCalls.join(',') || 'inga anrop');
}

// ── 10. Tabba ur ACC ska dölja overlays ──────────────────────────────────
// Rapporterat tillsammans med bugg 8: overlays låg kvar överst på skrivbordet när
// man tabbade ur ACC mitt i en session. Grinden kunde inte se det — ACC fortsätter
// skriva sitt delade minne utan fokus, så `connected` förblir true hela tiden.
// Skalet mäter därför förgrundsfönstret och skickar hit resultatet.
{
  const { WsBus, setForeignFocus } = await loadBus(true);
  const bus = new WsBus();
  bus._emit({ connected: true });
  check('synlig medan ACC är överst', !hidden(), writes.map((w) => w.value || '(synlig)').join(' → '));

  winCalls.length = 0;
  setForeignFocus(true);                              // alt-tab till webbläsaren
  check('döljs när ett annat program tar förgrunden', hidden(), winCalls.join(',') || 'inga anrop');
  check('och fönstret döljs på OS-nivå, inte bara med CSS',
        winCalls[winCalls.length - 1] === 'hide', winCalls.join(',') || 'inga anrop');

  // Ingen hysteres åt det hållet: fördröjningen finns för tappade ramar, och att
  // tabba tillbaka ska ge overlayn omedelbart.
  setForeignFocus(false);
  check('kommer tillbaka direkt när ACC är överst igen', !hidden(),
        writes.map((w) => w.value || '(synlig)').join(' → '));

  // Ramarna fortsätter komma medan man är ute — de får inte tända overlayn igen.
  setForeignFocus(true);
  const before = writes.length;
  for (let i = 0; i < 100; i++) { bus._emit({ connected: true }); NOW += 25; }
  check('anslutna ramar tänder inte overlayn medan man är utanför ACC',
        hidden() && writes.length === before, `${writes.length - before} skrivningar`);
}

// ── 11. Med grinden AV gäller förgrunden inte heller ────────────────────
// "Endast när ACC kör" är användarens enda av-knapp för det här beteendet. Är den av
// ska overlays ligga kvar oavsett vad man tabbar till (t.ex. för OBS-inspelning).
{
  const { WsBus, setForeignFocus } = await loadBus(false);
  const bus = new WsBus();
  bus._emit({ connected: true });
  setForeignFocus(true);
  check('med grinden av döljer förgrunden ingenting', !hidden(),
        writes.map((w) => w.value || '(synlig)').join(' → ') || 'inga skrivningar');
}

// ── 12. Edit-läget vinner över allt ─────────────────────────────────────
// Man drar overlays på plats FRÅN kontrollpanelen, alltså med ACC i bakgrunden och
// ett annat fönster i förgrunden. Doldes innehållet där fanns inget att sikta på —
// fönstret visades men rutan var tom, eftersom CSS-dölningen låg kvar.
{
  const { WsBus, setForeignFocus, setEditMode } = await loadBus(true);
  const bus = new WsBus();
  bus._emit({ connected: false });
  setForeignFocus(true);
  check('dold utan ACC och utan fokus', hidden());
  setEditMode(true);
  check('edit-läge visar overlayn trots grind och främmande fokus', !hidden(),
        writes.map((w) => w.value || '(synlig)').join(' → '));
  setEditMode(false);
  check('och döljs igen när edit-läget lämnas', hidden(),
        writes.map((w) => w.value || '(synlig)').join(' → '));
}

console.log(failed ? `\n${failed} kontroll(er) misslyckades` : '\nAllt OK');
process.exit(failed ? 1 : 0);
