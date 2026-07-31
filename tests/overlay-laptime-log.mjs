/* Varvtidsloggen: rätt varv på rätt rad, och rätt sak när listan TÖMS.
 *
 * Overlayn är ny och har ingen revision "före fixen" att köra mot. Tänderna bevisas
 * därför på det andra sättet §9 tillåter: varje regel mäts mot ett läge där den
 * SKULLE bryta om koden gjorde det uppenbara i stället.
 *
 * De två som är värda mest:
 *   • `laps: null` = OFÖRÄNDRAD, `laps: []` = TÖMD (frame.py). Behandlas [] som
 *     "inget nytt" ligger förra sessionens varv kvar på skärmen, och det syns inte
 *     förrän någon kör två sessioner i rad.
 *   • Motorn skickar varven och väljer inte hur de jämförs. Visar overlayn fel
 *     jämförelse ser siffrorna precis lika rimliga ut — därför har varje läge
 *     tydligt skilda värden här.
 *
 *     node tests/overlay-laptime-log.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadOverlay, htmlAtRevision } from './lib/overlay-harness.mjs';

/* Argumentet är en git-revision ELLER en sökväg till en HTML-fil. Filvägen finns
   därför att overlayn är ny: det går inte att köra testet mot koden "före fixen", så
   tänderna bevisas i stället mot medvetet trasiga KOPIOR (se filens huvud och
   tests/README.md). Utan den vägen hade man fått redigera originalet och hoppas på
   att komma ihåg att ändra tillbaka. */
const ARG = process.argv[2] || null;
let htmlFile = null;
if (ARG && fs.existsSync(ARG)) {
  htmlFile = ARG;
  console.log(`(kör mot filen ${ARG})\n`);
} else if (ARG) {
  htmlFile = path.join(os.tmpdir(), `laptime-log-${ARG}.html`);
  fs.writeFileSync(htmlFile, htmlAtRevision('laptime-log', ARG));
  console.log(`(kör mot revision ${ARG})\n`);
}
const open = (o = {}) => loadOverlay('laptime-log', {
  html: htmlFile,
  expose: ['fmtLap', 'fmtDelta', 'fmtRunning', 'ROWS', 'DASH_C'],
  loopHz: 10,
  ...o,
});

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'OK  ' : 'FEL '} ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed++;
}

// En overlay som aldrig renderade får inte kunna passera något av testerna nedan.
function assertAlive(h, where) {
  if (!h.text('t0')) {
    console.log(`FEL  overlayn renderade aldrig (${where}) — översta raden är tom`);
    process.exit(1);
  }
}

/* Sex varv med tydligt skilda tider, ett depåvarv och ett klart bästa (varv 5).
   Tiderna är valda så att INGEN jämförelse råkar ge samma siffra som en annan. */
const LAPS = [
  { n: 1, ms: 141880, pit: true  },
  { n: 2, ms: 139500, pit: false },
  { n: 3, ms: 138900, pit: false },
  { n: 4, ms: 140100, pit: false },
  { n: 5, ms: 138120, pit: false },   // bästa
  { n: 6, ms: 138400, pit: false },
];
const FRAME = (laps, extra = {}) => ({ laps, curLapMs: 45230, completedLaps: 6, ...extra });

// Raderna är nyast överst: r0 = senast körda varv.
const radT = (h) => [0,1,2,3,4,5].map(i => h.text('t'+i));
const radN = (h) => [0,1,2,3,4,5].map(i => h.text('n'+i));
const radD = (h) => [0,1,2,3,4,5].map(i => h.text('d'+i));

// ── 1. Varven hamnar på rätt rad, nyast överst ──────────────────────────────
{
  const h = await open();
  h.settle(FRAME(LAPS), 6);
  assertAlive(h, 'grundrendering');
  check('nyast överst', radN(h).join(',') === '6,5,4,3,2,1', radN(h).join(','));
  check('varvtiderna formateras som mm:ss.mmm',
        h.text('t0') === '02:18.400' && h.text('t5') === '02:21.880',
        `${h.text('t0')} … ${h.text('t5')}`);
  check('bästa varvet får guldstrecket', h.el('r1').classList.contains('best'),
        `r1.best=${h.el('r1').classList.contains('best')}`);
  check('och ingen annan rad gör det',
        [0,2,3,4,5].every(i => !h.el('r'+i).classList.contains('best')));
  check('depåvarvet märks', h.el('r5').classList.contains('pit'));
  check('och visar PIT i delta-kolumnen i stället för en tid att jämföra med',
        h.text('d5') === 'PIT', JSON.stringify(h.text('d5')));
}

// ── 2. Jämför mot BÄSTA (standard) ──────────────────────────────────────────
{
  const h = await open();
  h.settle(FRAME(LAPS), 6);
  check('bästa varvet skriver BEST i stället för 0.00', h.text('d1') === 'BEST',
        JSON.stringify(h.text('d1')));
  check('övriga visar sitt påslag mot bästa',
        h.text('d0') === '+0.28' && h.text('d2') === '+1.98' && h.text('d3') === '+0.78',
        radD(h).join(' '));
  /* OFÄRGADE, och det är en regel och inte en glömska (§5c). Mot sessionens bästa är
     varje varv utom det bästa långsammare per definition — tecknet kan inte variera,
     och en färg som aldrig växlar säger ingenting. Den gör bara kolumnen till en
     vägg av rött över spelet. Det syntes först när overlayn renderades. */
  check('men färgas INTE: tecknet kan inte variera mot bästa, så färgen bär inget',
        [0,2,3,4].every(i => !h.el('d'+i).classList.contains('down')
                          && !h.el('d'+i).classList.contains('up')),
        radD(h).join(' '));
}

// ── 3. Jämför mot FÖREGÅENDE varv ───────────────────────────────────────────
// Samma varv, helt andra siffror. Visar overlayn fel jämförelse är felet osynligt.
{
  const h = await open({ init: { id: 'laptime-log', scale: 1, opacity: 1,
                                 options: { compare: 'previous' } } });
  h.settle(FRAME(LAPS), 6);
  check('varv 6 mot varv 5', h.text('d0') === '+0.28', JSON.stringify(h.text('d0')));
  check('varv 5 mot varv 4 (snabbare → grönt)',
        h.text('d1') === '-1.98' && h.el('d1').classList.contains('up'),
        `${h.text('d1')} up=${h.el('d1').classList.contains('up')}`);
  check('varv 4 mot varv 3 (långsammare → rött)',
        h.text('d2') === '+1.20' && h.el('d2').classList.contains('down'),
        `${h.text('d2')} down=${h.el('d2').classList.contains('down')}`);
  check('guldstrecket sitter kvar på sessionens bästa oavsett jämförelse',
        h.el('r1').classList.contains('best'));
  check('det äldsta synliga varvet har ingen föregångare och visar inget',
        h.text('d5') === 'PIT' || h.text('d5') === '', JSON.stringify(h.text('d5')));

  // Byte under körning: panelen skickar ett option-event. Gamla siffror får inte
  // ligga kvar — de betyder något annat efter bytet.
  h.message({ __simmatrix: true, kind: 'option', option: 'compare', value: 'best' });
  h.settle(FRAME(LAPS), 3);
  check('byte av jämförelse under körning skriver om kolumnen',
        h.text('d1') === 'BEST' && h.text('d2') === '+1.98', radD(h).join(' '));
}

// ── 4. `null` = oförändrad, `[]` = TÖMD ─────────────────────────────────────
// Kontraktets viktigaste halva. En overlay som latchar null måste ändå rensa på [].
{
  const h = await open();
  h.settle(FRAME(LAPS), 6);
  const before = radT(h).join('|');

  h.settle(FRAME(null), 6);
  check('laps: null lämnar listan orörd (motorn skickar den bara vid ändring)',
        radT(h).join('|') === before, radT(h).join('|'));

  h.settle(FRAME([]), 6);
  check('laps: [] TÖMMER listan — annars ligger förra sessionens varv kvar',
        radT(h).every(t => t === '') && radN(h).every(t => t === ''),
        radT(h).join('|'));
  check('och guldstrecket följer med bort',
        [0,1,2,3,4,5].every(i => !h.el('r'+i).classList.contains('best')));
}

// ── 5. Fönstret rullar när varven blir fler än raderna ──────────────────────
{
  const h = await open();
  const many = Array.from({ length: 14 }, (_, i) => ({ n: i + 1, ms: 138000 + i * 100, pit: false }));
  h.settle(FRAME(many, { completedLaps: 14 }), 6);
  check('bara de sex senaste visas, nyast överst',
        radN(h).join(',') === '14,13,12,11,10,9', radN(h).join(','));
  check('guldstrecket syns inte när bästa varvet rullat ur fönstret',
        [0,1,2,3,4,5].every(i => !h.el('r'+i).classList.contains('best')));
  // Jämförelsen mot föregående varv måste hämtas ur HELA historiken, inte ur de
  // synliga raderna — annars tappar understa raden sitt delta utan skäl.
  const p = await open({ init: { id: 'laptime-log', scale: 1, opacity: 1,
                                 options: { compare: 'previous' } } });
  p.settle(FRAME(many, { completedLaps: 14 }), 6);
  check('understa raden jämförs mot ett varv utanför fönstret', p.text('d5') === '+0.10',
        JSON.stringify(p.text('d5')));
}

// ── 6. Löpande varv ─────────────────────────────────────────────────────────
{
  const h = await open();
  h.settle(FRAME(LAPS), 6);
  check('löpande varv är nästa varvnummer', h.text('curN') === '7', JSON.stringify(h.text('curN')));
  check('och visas i tiondelar', h.text('curT') === '0:45.2', JSON.stringify(h.text('curT')));

  // Enstaka ramar utan curLapMs (ACC:s sentinelvärden mellan varv) får inte blinka.
  const stable = h.text('curT');
  const during = [];
  for (let i = 0; i < 3; i++){ h.push(FRAME(null, { curLapMs: null })); h.tick(); during.push(h.text('curT')); }
  check('3 tappade ramar ändrar inte den löpande tiden',
        during.every(t => t === stable), `${stable} → ${during.join(',')}`);

  for (let i = 0; i < 40; i++){ h.push(FRAME(null, { curLapMs: null })); h.tick(); }
  check('ihållande dataförlust ger platshållaren', h.text('curT') === h.api.DASH_C,
        JSON.stringify(h.text('curT')));
  check('platshållaren har samma teckenantal som ett värde',
        h.api.DASH_C.length === h.api.fmtRunning(45230).length,
        `${h.api.DASH_C} mot ${h.api.fmtRunning(45230)}`);
}

// ── 7. Reglagen ─────────────────────────────────────────────────────────────
{
  const h = await open({ init: { id: 'laptime-log', scale: 1, opacity: 1,
                                 options: { 'delta-column': false, 'current-lap': false } } });
  h.settle(FRAME(LAPS), 6);
  check('delta-kolumnen kan stängas av redan före första paint (§8.3)',
        radD(h).every(t => t === ''), radD(h).join('|'));
  check('men tiderna står kvar', h.text('t0') === '02:18.400', JSON.stringify(h.text('t0')));
  check('det löpande varvet kan döljas', h.el('cur').hidden === true, `hidden=${h.el('cur').hidden}`);

  h.message({ __simmatrix: true, kind: 'option', option: 'delta-column', value: true });
  h.settle(FRAME(LAPS), 3);
  check('och slås på igen under körning', h.text('d1') === 'BEST', JSON.stringify(h.text('d1')));
}

// ── 8. Fientliga ramar ──────────────────────────────────────────────────────
// NaN är klistrigt i en overlay: en gång skriven står den kvar tills något skriver
// över den. Loggen ska hellre visa ingenting än "NaN".
{
  const h = await open();
  for (const bad of [
    FRAME(null, { curLapMs: NaN }),
    FRAME([{ n: 1, ms: NaN, pit: false }]),
    FRAME([{ n: 2 }, null, { ms: 138000 }]),
    FRAME('inte en lista'),
    FRAME([], { curLapMs: undefined, completedLaps: null }),
  ]){
    h.settle(bad, 4);
  }
  const allt = [...radT(h), ...radD(h), ...radN(h), h.text('curT'), h.text('curN')].join(' ');
  check('inga NaN någonstans efter fem ovänliga ramar', !allt.includes('NaN'), allt.trim());

  // Och den återhämtar sig: en riktig ram efteråt ska rendera normalt.
  h.settle(FRAME(LAPS), 6);
  check('en riktig ram efteråt renderar normalt igen',
        h.text('t0') === '02:18.400' && h.text('d1') === 'BEST',
        `${h.text('t0')} / ${h.text('d1')}`);
}

// ── 9. Loopen ───────────────────────────────────────────────────────────────
// Overlayn ska inte skriva DOM när ingenting ändrats: listan ändras en gång per varv
// medan loopen går 10 ggr/s. Utan ändringskontroll blir det 600 skrivningar i minuten
// för sex rader som står stilla (§8.5).
{
  const h = await open({ hz: 144, loopHz: 10 });
  h.settle(FRAME(LAPS, { curLapMs: 45230 }), 40);
  const before = h.log.length;
  // Samma ram om och om igen, med OFÖRÄNDRAD löpande tid.
  for (let i = 0; i < 120; i++){ h.push(FRAME(null, { curLapMs: 45230 })); h.tick(); }
  check('en oförändrad ram ger noll DOM-skrivningar', h.log.length === before,
        `${h.log.length - before} skrivningar`);
}

console.log(failed ? `\n${failed} kontroll(er) misslyckades` : '\nAllt OK');
process.exit(failed ? 1 : 0);
