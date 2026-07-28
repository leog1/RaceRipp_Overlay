/* Kontrollpanelens förhandsvisning får ALDRIG ta åt sig fönstrets skala.
 *
 * Rapporterat från riktig användning: att dra skalreglaget syntes inte i previewn
 * (rätt — previewn visar naturlig storlek och krymps av panelen, §8.4c), men bytte
 * man till en annan overlay och tillbaka hoppade previewn plötsligt i storlek.
 *
 * Orsaken är en asymmetri i Tauri som är lätt att gissa fel på:
 *   • `emit` går via webview.eval → kör BARA i huvudframen → previewn får inga event.
 *   • `invoke` går via IPC:n, och på WebView2 injiceras init-skript i ALLA frames
 *     (wry: "scripts are always added to subframes"), så `__TAURI__` FINNS i iframen.
 * Alltså: previewn får inget config-event när man drar reglaget, men hämtar den
 * sparade skalan med get_config nästa gång iframen laddas om — dvs. vid overlay-byte.
 *
 * Fixen är en enda grind i bus.js (applyConfigFor). Testet nedan kör mot både den
 * nya och den GAMLA bus.js för att bevisa att det biter:
 *     node tests/overlay-preview.mjs            (arbetsträdet — allt ska vara OK)
 *     node tests/overlay-preview.mjs <rev>      (jämför mot bus.js i <rev>)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadOverlay, fileAtRevision } from './lib/overlay-harness.mjs';

const REV = process.argv[2] || null;
let busFile;
if (REV) {
  busFile = path.join(os.tmpdir(), `bus-${REV}.js`);
  fs.writeFileSync(busFile, fileAtRevision('src/shared/bus.js', REV));
  console.log(`(kör mot bus.js i revision ${REV})\n`);
}

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'OK  ' : 'FEL '} ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed++;
}

const OPTS = { clutch: true, window: 4.5 };
// inputs-trace skriver skalan som --H (= 200px × skala) på documentElement, och
// opaciteten som style.opacity på #ui. Två skilda mätpunkter, alltså går det att se
// att skalan filtreras bort UTAN att opaciteten också gör det.
const scaleWrites = (h) => h.writes({ el: 'documentElement', key: '--H' }).map((w) => w.value);
const opacityWrites = (h) => h.writes({ el: 'ui', key: 'opacity' }).map((w) => w.value);

const open = (preview, init) =>
  loadOverlay('inputs-trace', { preview, busFile, init });

// ── 1. INIT-vägen ───────────────────────────────────────────────────────────
// I ett riktigt overlay-fönster injicerar lib.rs skalan och den MÅSTE gälla före
// första paint (§8.3). I previewn finns ingen INIT — men grinden ska hålla ändå,
// och den här riktningen är billig att kontrollera.
{
  const win = await open(false, { id: 'inputs-trace', scale: 1.4, opacity: 1, options: OPTS });
  check('vanligt overlay-fönster tar skalan ur INIT',
        scaleWrites(win).includes('280px'), JSON.stringify(scaleWrites(win)));

  const pv = await open(true, { id: 'inputs-trace', scale: 1.4, opacity: 1, options: OPTS });
  check('förhandsvisningen ignorerar skalan ur INIT',
        !scaleWrites(pv).length, JSON.stringify(scaleWrites(pv)));
}

// ── 2. config-vägen (det som faktiskt läckte) ──────────────────────────────
// get_config går inte att köra utan Tauri, men den och postMessage-kanalen går
// genom SAMMA grind i wireShell. Mät den.
{
  const pv = await open(true, { id: 'inputs-trace', scale: 1, opacity: 1, options: OPTS });
  pv.settle({ throttle: 1, brake: 0, clutch: 0, abs: false, tc: false }, 3);

  pv.message({ __simmatrix: true, kind: 'config', id: 'inputs-trace', scale: 1.6, opacity: 0.5 });
  check('förhandsvisningen ignorerar skala i config',
        !scaleWrites(pv).length, JSON.stringify(scaleWrites(pv)));
  // …men opaciteten i SAMMA meddelande ska fortfarande gå fram. En grind som slänger
  // hela config-objektet hade tystat opacitetsreglaget i previewn igen (§8.4c).
  check('men opaciteten i samma config går fram',
        opacityWrites(pv).at(-1) === '0.5', JSON.stringify(opacityWrites(pv)));

  const win = await open(false, { id: 'inputs-trace', scale: 1, opacity: 1, options: OPTS });
  win.message({ __simmatrix: true, kind: 'config', id: 'inputs-trace', scale: 1.6, opacity: 0.5 });
  check('ett riktigt overlay-fönster tar fortfarande emot skala i config',
        scaleWrites(win).at(-1) === '320px', JSON.stringify(scaleWrites(win)));
}

// ── 3. Alternativ ska fortfarande nå previewn ──────────────────────────────
// Grinden gäller BARA skalan. Slår den ut alternativen är previewn tillbaka där den
// var innan §8.4b — den visar något annat än det man ställt in.
{
  const pv = await open(true, { id: 'inputs-trace', scale: 1, opacity: 1,
                                options: { ...OPTS, 'col-green': '#00ff00' } });
  const green = pv.writes({ el: 'documentElement', key: '--green' }).map((w) => w.value);
  check('färgalternativ når förhandsvisningen', green.includes('#00ff00'), JSON.stringify(green));

  const hides = pv.writes({ el: 'col-clutch', key: 'display' });
  pv.message({ __simmatrix: true, kind: 'option', id: 'inputs-trace', option: 'clutch', value: false });
  const nya = pv.writes({ el: 'col-clutch', key: 'display' }).slice(hides.length);
  check('bool-alternativ når förhandsvisningen',
        nya.length > 0 && nya.at(-1).value === 'none', JSON.stringify(nya.map((w) => w.value)));
}

console.log(failed ? `\n${failed} kontroll(er) misslyckades` : '\nAllt OK');
process.exit(failed ? 1 : 0);
