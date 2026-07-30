/* Regressionstest för delta-barens flicker.
 *
 * Alla fyra kontrollerna nedan MISSLYCKADES före fixen i commit dc9e231. Kör med
 * en revision som argument för att se dem misslyckas igen:
 *     node tests/overlay-delta-bar.mjs a31b1c1
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadOverlay, htmlAtRevision } from './lib/overlay-harness.mjs';

const REV = process.argv[2] || null;
let htmlFile = null;
if (REV) {
  htmlFile = path.join(os.tmpdir(), `delta-bar-${REV}.html`);
  fs.writeFileSync(htmlFile, htmlAtRevision('delta-bar', REV));
  console.log(`(kör mot revision ${REV})\n`);
}
const open = (o = {}) => loadOverlay('delta-bar', {
  html: htmlFile,
  expose: ['frame', 'render', 'specFor', 'DASH_D', 'DASH_L'],
  ...o,
});

// Ett test som kan passera på en död overlay är värdelöst: kontrollerna nedan
// kräver därför att overlayn faktiskt skrev något innan de bedömer VAD den skrev.
function assertAlive(h, where) {
  const wrote = h.writes({ el: 'arc', key: 'd' }).length;
  const text = h.text('deltaVal');
  if (!wrote || !text) {
    console.log(`FEL  overlayn renderade aldrig (${where}) — ${wrote} bågskrivningar, text ${JSON.stringify(text)}`);
    process.exit(1);
  }
}

/* Motorn skickar ALLA referenskällor som gäller i `refs` och väljer inte åt overlayn
   (frame.py) — reglaget `delta-source` gör det. Standardvalet är 'best', så en ram
   utan `refs.best` är en ram utan delta att visa. `delta`/`refTotalMs` ligger kvar i
   ramen för bakåtkompatibilitet men läses inte av overlayn. */
const FRAME = (delta, refs) => ({
  delta, sessionBestMs: 138120, refTotalMs: null, driverName: 'Test',
  refs: refs !== undefined ? refs
      : (typeof delta === 'number'
          ? { best: { delta, totalMs: 138120, throttle: null, brake: null, src: 'lap' } }
          : null),
});
const CELL = { d: 0.60, s: 0.30, m: 0.62 };     // .ch-bredder ur delta-bar/index.html

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'OK  ' : 'FEL '} ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed++;
}

// ── 1. Bågen får inte slås ut vid nollpassage ────────────────────────────────
// Tröskeln som tömde d-attributet under 0,6° gav ett tomt frame varje gång delta
// passerade noll. Det var det synliga blinket.
{
  const h = await open();
  h.settle(FRAME(-0.40), 60);
  assertAlive(h, 'nollpassage');
  const before = h.writes({ el: 'arc', key: 'd' }).length;
  for (let i = 0; i <= 100; i++) { h.push(FRAME(-0.05 + 0.001 * i)); h.tick(); }
  h.settle(FRAME(0.05), 40);
  const during = h.writes({ el: 'arc', key: 'd' }).slice(before);
  const empties = during.filter((w) => w.value === '').length;
  check('bågen slås aldrig ut under nollpassage', during.length > 50 && empties === 0,
        `${during.length} uppdateringar, ${empties} tomma`);

  // Färgen får vända EN gång, inte flimra.
  const flips = h.writes({ el: 'arc', key: 'stroke' }).length;
  check('färgen vänder högst en gång per nollpassage', flips >= 1 && flips <= 2, `${flips} strokeskrivningar totalt`);
}

// ── 2. Platshållare måste mäta som ett riktigt värde ────────────────────────
// Annars krymper siffran så fort ett värde saknas ett enda frame.
{
  const h = await open();
  const { specFor, DASH_D, DASH_L } = h.api;
  const width = (s) => specFor(s).reduce((a, c) => a + CELL[c], 0);
  for (const [ph, val, what] of [[DASH_D, '+0.12', 'delta'], [DASH_L, '02:18.120', 'varvtid']]) {
    const a = width(ph), b = width(val);
    check(`platshållaren för ${what} har samma bredd som ett värde`,
          a === b && ph.length === val.length, `${a}em mot ${b}em`);
  }
}

// ── 3. Enstaka null-ramar får inte synas ────────────────────────────────────
// Motorn skickar null vid mållinjen (delta.py:s spikskydd) och mellan varv.
{
  const h = await open();
  h.settle(FRAME(-0.33), 40);
  assertAlive(h, 'null-ramar');
  const stable = h.text('deltaVal');
  const during = [];
  for (let i = 0; i < 3; i++) { h.push(FRAME(null)); h.tick(); during.push(h.text('deltaVal')); }
  check('3 tappade ramar ändrar inte siffran',
        during.every((t) => t === stable), `${JSON.stringify(stable)} → ${JSON.stringify(during)}`);

  // Men en ihållande förlust ska faktiskt ge platshållaren.
  for (let i = 0; i < 40; i++) { h.push(FRAME(null)); h.tick(); }
  check('ihållande dataförlust ger platshållaren', h.text('deltaVal') === h.api.DASH_D,
        JSON.stringify(h.text('deltaVal')));
}

// ── 4. Stora deltan ska renderas, inte klampas ──────────────────────────────
// På långa banor (24h Nordschleife) är tiotals sekunder en äkta delta. Bredden får
// växa; det viktiga är att inget blir NaN och att den återgår till 5 celler.
{
  const h = await open();
  h.settle(FRAME(-0.33), 30);
  assertAlive(h, 'stora deltan');
  for (const v of [-0.33, 20, 100, -300]) {
    h.settle(FRAME(v), 90);
    const t = h.text('deltaVal');
    const d = h.el('arc').getAttribute('d');
    check(`delta ${v} renderas`, !t.includes('NaN') && typeof d === 'string' && !d.includes('NaN'),
          `text ${JSON.stringify(t)}`);
  }
  h.settle(FRAME(0.5), 90);
  check('återgår till 5 celler vid liten delta', h.text('deltaVal').length === 5,
        JSON.stringify(h.text('deltaVal')));
}

// ── 5. Delta-källan: reglaget ska vara det ENDA som styr siffran ────────────
// Motorn skickar alla källor samtidigt; visar overlayn fel källa är siffran fel utan
// att någonting ser trasigt ut. Källorna har därför tydligt skilda värden här.
const REFS = {
  last:  { delta: 1.50, totalMs: 140000, throttle: null, brake: null, src: 'lap' },
  best:  { delta: -0.50, totalMs: 138120, throttle: null, brake: null, src: 'lap' },
  motec: { delta: 0.25, totalMs: 136250, throttle: null, brake: null, src: 'motec' },
};
{
  const init = (source) => ({ id: 'delta-bar', scale: 1, opacity: 1,
                              options: { predicted: true, 'delta-source': source } });
  for (const [source, want] of [['best', '-0.50'], ['last', '+1.50'], ['motec', '+0.25']]) {
    const h = await open({ init: init(source) });
    h.settle(FRAME(null, REFS), 90);
    check(`delta-source=${source} visar den källans delta`, h.text('deltaVal') === want,
          `visade ${JSON.stringify(h.text('deltaVal'))}, väntade ${want}`);
  }

  // 'off' ska inte visa något delta alls — inte "det senaste vi råkade ha".
  const off = await open({ init: init('off') });
  off.settle(FRAME(null, REFS), 90);
  check("delta-source=off visar platshållaren", off.text('deltaVal') === off.api.DASH_D,
        JSON.stringify(off.text('deltaVal')));

  // En källa som inte finns i ramen (ingen .ld laddad, inget varv inspelat) är inte
  // ett fel — den ska bara inte visa något.
  const gone = await open({ init: init('motec') });
  gone.settle(FRAME(null, { best: REFS.best }), 90);
  check('saknad källa ger platshållaren, inte en annan källas värde',
        gone.text('deltaVal') === gone.api.DASH_D, JSON.stringify(gone.text('deltaVal')));

  // Byte under körning: panelen skickar ett option-event. Det gamla värdet får inte
  // ligga kvar i latchen (HOLD_MS) efter bytet — då visar overlayn en siffra som
  // redan bytt betydelse.
  const sw = await open({ init: init('best') });
  sw.settle(FRAME(null, REFS), 60);
  sw.message({ __simmatrix: true, kind: 'option', option: 'delta-source', value: 'last' });
  sw.settle(FRAME(null, REFS), 90);
  check('byte av källa under körning slår igenom', sw.text('deltaVal') === '+1.50',
        JSON.stringify(sw.text('deltaVal')));
  sw.message({ __simmatrix: true, kind: 'option', option: 'delta-source', value: 'off' });
  sw.push(FRAME(null, REFS)); sw.tick();
  check('växling till off håller inte kvar förra värdet ett enda frame',
        sw.text('deltaVal') === sw.api.DASH_D, JSON.stringify(sw.text('deltaVal')));
}

console.log(failed ? `\n${failed} kontroll(er) misslyckades` : '\nAllt OK');
process.exit(failed ? 1 : 0);
