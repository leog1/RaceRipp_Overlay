/* Dash: växel, fart, rattvinkel och shift-lights.
 *
 * Overlayn är ny och har ingen revision "före fixen". Tänderna bevisas därför mot
 * medvetet trasiga KOPIOR — argumentet får vara en git-revision eller en sökväg till
 * en HTML-fil, precis som i overlay-laptime-log.mjs.
 *
 * Det som är värt att mäta är de lägen man inte råkar se när man tittar på overlayn:
 *   • `maxRpm` är 0 den första sekunden efter start och när ACC inte kör. Gissar
 *     overlayn ett tak då tänds lampor på fel varvtal — och slocknar igen när det
 *     riktiga taket kommer, alltså en blinkning vid varje sessionsstart.
 *   • Blinket vid rödvarv måste följa KLOCKAN. En frame-räknare blinkar 2,4× snabbare
 *     på 144 Hz än på 60 Hz (§8.5).
 *   • Rattvinkeln är det enda som skrivs varje frame. Står ratten still ska inget
 *     attribut skrivas alls.
 *
 *     node tests/overlay-dash.mjs
 *     node tests/overlay-dash.mjs /tmp/trasig.html
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadOverlay, htmlAtRevision } from './lib/overlay-harness.mjs';

const ARG = process.argv[2] || null;
let htmlFile = null;
if (ARG && fs.existsSync(ARG)) {
  htmlFile = ARG;
  console.log(`(kör mot filen ${ARG})\n`);
} else if (ARG) {
  htmlFile = path.join(os.tmpdir(), `dash-${ARG}.html`);
  fs.writeFileSync(htmlFile, htmlAtRevision('dash', ARG));
  console.log(`(kör mot revision ${ARG})\n`);
}
const open = (o = {}) => loadOverlay('dash', {
  html: htmlFile,
  expose: ['LEDS', 'litCount', 'gearText', 'FLASH_MS'],
  ...o,
});

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'OK  ' : 'FEL '} ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed++;
}
function assertAlive(h, where) {
  if (!h.text('gear') || !h.text('kph')) {
    console.log(`FEL  overlayn renderade aldrig (${where})`);
    process.exit(1);
  }
}

const F = (o = {}) => ({ gear: 4, speedKph: 188, rpm: 3000, maxRpm: 7600, steer: 0, ...o });
// Hur många lampor som lyser just nu, läst ur DOM:en och inte ur overlayns funktion.
const lit = (h) => Array.from({ length: 15 }, (_, i) => h.el('l' + i))
                        .filter(e => e.classList.contains('on')).length;
const rot = (h) => {
  const t = h.el('wrot').getAttribute('transform');
  const m = t && t.match(/rotate\(([-\d.]+)/);
  return m ? parseFloat(m[1]) : null;
};

// ── 1. Växel ────────────────────────────────────────────────────────────────
{
  const h = await open();
  h.settle(F(), 20);
  assertAlive(h, 'växel');
  for (const [g, want] of [[4, '4'], [1, '1'], [0, 'N'], [-1, 'R'], [8, '8']]) {
    h.settle(F({ gear: g }), 6);
    check(`gear ${g} visas som ${want}`, h.text('gear') === want, JSON.stringify(h.text('gear')));
  }
}

// ── 2. Fart: fast spalt, rätt enhet ─────────────────────────────────────────
{
  const h = await open();
  h.settle(F({ speedKph: 188 }), 60);
  check('farten avrundas till heltal', h.text('kph') === '188', JSON.stringify(h.text('kph')));
  check('enheten är km/h som standard', h.text('unit') === 'km/h', JSON.stringify(h.text('unit')));

  const mph = await open({ init: { id: 'dash', scale: 1, opacity: 1, options: { unit: 'mph' } } });
  mph.settle(F({ speedKph: 188 }), 60);
  check('mph räknas om redan före första paint (§8.3)',
        mph.text('kph') === '117' && mph.text('unit') === 'mph',
        `${mph.text('kph')} ${mph.text('unit')}`);
}

// ── 3. Shift-lights mot maxRpm ──────────────────────────────────────────────
// Det som gör raden meningsfull är att den räknas mot BILENS tak. 7000 varv är
// växlingsläge i en GT3 och halvvarv i en formelbil.
{
  const h = await open();
  h.settle(F({ rpm: 3000 }), 10);
  check('inga lampor långt under tröskeln', lit(h) === 0, `${lit(h)} lyser`);

  h.settle(F({ rpm: 6080 }), 10);   // exakt 80 % av 7600 = tröskeln
  check('inga lampor exakt vid tröskeln', lit(h) === 0, `${lit(h)} lyser`);

  h.settle(F({ rpm: 6840 }), 10);   // halvvägs mellan tröskel och tak
  check('halvvägs tänds ungefär halva raden', lit(h) === 8, `${lit(h)} lyser`);

  h.settle(F({ rpm: 7600 }), 10);
  check('vid taket lyser hela raden', lit(h) === 15, `${lit(h)} lyser`);

  // Samma varvtal, ANNAT tak → annat antal lampor. Utan den kontrollen kan overlayn
  // ignorera maxRpm helt och ändå se rimlig ut.
  h.settle(F({ rpm: 6840, maxRpm: 12000 }), 10);
  check('samma varvtal mot ett högre tak tänder inga lampor', lit(h) === 0,
        `${lit(h)} lyser vid 6840/12000`);

  // Banden: grönt först, rött sist.
  h.settle(F({ rpm: 7600 }), 10);
  check('sista lampan är röd', h.el('l14').classList.contains('hi'));
  check('första lampan är inte det', !h.el('l0').classList.contains('hi')
        && !h.el('l0').classList.contains('mid'));
  check('mittbandet finns', h.el('l10').classList.contains('mid'));
}

// ── 4. maxRpm = 0 är "vet inte", inte "noll varv" ───────────────────────────
// Läget råder den första sekunden efter start (STATIC-blocket är inte läst) och när
// ACC inte kör. Gissar overlayn ett tak blinkar raden vid varje sessionsstart.
{
  const h = await open();
  h.settle(F({ rpm: 7000, maxRpm: 0 }), 20);
  check('utan känt varvtalstak lyser INGEN lampa', lit(h) === 0, `${lit(h)} lyser`);
  h.settle(F({ rpm: 7000, maxRpm: 7600 }), 10);
  check('och raden kommer igång när taket väl anländer', lit(h) > 0, `${lit(h)} lyser`);
}

// ── 5. Blinket vid rödvarv följer KLOCKAN ───────────────────────────────────
// En frame-räknare hade blinkat 2,4× snabbare på 144 Hz. Vi driver samma väggtid i
// två olika takter och räknar växlingarna.
async function flips(hz) {
  const h = await open({ hz, loopHz: hz });
  h.settle(F({ rpm: 7600 }), 4);
  let n = 0, prev = h.el('leds').classList.contains('off');
  const steps = hz;                       // exakt 1 sekund väggtid
  for (let i = 0; i < steps; i++) {
    h.push(F({ rpm: 7600 })); h.tick();
    const now = h.el('leds').classList.contains('off');
    if (now !== prev) { n++; prev = now; }
  }
  return n;
}
{
  const a = await flips(60), b = await flips(144);
  check('blinket har samma takt på 60 och 144 Hz', Math.abs(a - b) <= 1, `${a} mot ${b} växlingar/s`);
  check('och blinkar faktiskt', a >= 6, `${a} växlingar/s`);

  const off = await open({ init: { id: 'dash', scale: 1, opacity: 1,
                                   options: { 'shift-flash': false } } });
  off.settle(F({ rpm: 7600 }), 30);
  check('blinket går att stänga av', !off.el('leds').classList.contains('flash'));
  check('men lamporna lyser ändå', lit(off) === 15, `${lit(off)} lyser`);
}

// ── 6. Rattvinkeln ──────────────────────────────────────────────────────────
{
  const h = await open();
  h.settle(F({ steer: 0 }), 40);
  check('rakt fram är 0°', Math.abs(rot(h)) < 0.5, `${rot(h)}°`);

  h.settle(F({ steer: 1 }), 90);
  check('fullt utslag ger standardutslaget 180°', Math.abs(rot(h) - 180) < 1, `${rot(h)}°`);

  h.settle(F({ steer: -0.5 }), 90);
  check('halvt utslag åt vänster ger -90°', Math.abs(rot(h) + 90) < 1, `${rot(h)}°`);

  const lock = await open({ init: { id: 'dash', scale: 1, opacity: 1,
                                    options: { 'wheel-lock': 300 } } });
  lock.settle(F({ steer: 1 }), 90);
  check('reglaget för rattutslag ändrar vinkeln', Math.abs(rot(lock) - 300) < 2, `${rot(lock)}°`);

  const off = await open({ init: { id: 'dash', scale: 1, opacity: 1, options: { wheel: false } } });
  off.settle(F(), 20);
  check('ratten går att dölja', off.el('wheel').hidden === true, `hidden=${off.el('wheel').hidden}`);
}

// ── 7. Utjämningen är TIDSBASERAD ───────────────────────────────────────────
// En per-frame-lerp landar olika långt beroende på skärmens takt. Samma VÄGGTID ska
// ge samma vinkel oavsett hur många frames den delats upp i (§8.5).
{
  const slow = await open({ hz: 30, loopHz: 30 });
  slow.settle(F({ steer: 0 }), 30);
  for (let i = 0; i < 3; i++) { slow.push(F({ steer: 1 })); slow.tick(); }   // 100 ms
  const fast = await open({ hz: 120, loopHz: 120 });
  fast.settle(F({ steer: 0 }), 120);
  for (let i = 0; i < 12; i++) { fast.push(F({ steer: 1 })); fast.tick(); }  // 100 ms
  check('samma väggtid ger samma rattvinkel i 30 och 120 Hz',
        Math.abs(rot(slow) - rot(fast)) < 6, `${rot(slow)}° mot ${rot(fast)}°`);
}

// ── 8. Står ratten still skrivs ingenting ───────────────────────────────────
// Rotationen är overlayns enda per-frame-skrivning. Utan avrundning och
// ändringskontroll skrivs attributet 30 ggr/s även när bilen står på rakan.
{
  const h = await open();
  h.settle(F({ steer: 0.25 }), 120);       // låt utjämningen landa
  const before = h.writes({ el: 'wrot' }).length;
  for (let i = 0; i < 60; i++) { h.push(F({ steer: 0.25 })); h.tick(); }
  check('en stillastående ratt ger noll attributskrivningar',
        h.writes({ el: 'wrot' }).length === before,
        `${h.writes({ el: 'wrot' }).length - before} skrivningar`);
}

// ── 9. Fientliga ramar ──────────────────────────────────────────────────────
{
  const h = await open();
  for (const bad of [
    F({ speedKph: NaN }), F({ rpm: NaN }), F({ maxRpm: NaN }), F({ steer: NaN }),
    F({ gear: null, speedKph: null, rpm: null, maxRpm: null, steer: null }),
    { }, F({ maxRpm: -5, rpm: 9000 }),
  ]) h.settle(bad, 6);
  const allt = [h.text('gear'), h.text('kph'), String(rot(h))].join(' ');
  check('inga NaN efter sju ovänliga ramar', !allt.includes('NaN'), allt);
  h.settle(F(), 60);
  check('och overlayn återhämtar sig', h.text('gear') === '4' && h.text('kph') === '188',
        `${h.text('gear')} ${h.text('kph')}`);
}

// ── 10. Latch: enstaka tappade ramar får inte blinka ────────────────────────
{
  const h = await open();
  h.settle(F(), 40);
  const stable = h.text('gear');
  const during = [];
  for (let i = 0; i < 3; i++) { h.push({}); h.tick(); during.push(h.text('gear')); }
  check('3 tomma ramar ändrar inte växeln', during.every(t => t === stable),
        `${stable} → ${during.join(',')}`);
  for (let i = 0; i < 40; i++) { h.push({}); h.tick(); }
  check('ihållande dataförlust ger platshållaren', h.text('gear') === '–',
        JSON.stringify(h.text('gear')));
  check('och släcker lamporna', lit(h) === 0, `${lit(h)} lyser`);
}

console.log(failed ? `\n${failed} kontroll(er) misslyckades` : '\nAllt OK');
process.exit(failed ? 1 : 0);
