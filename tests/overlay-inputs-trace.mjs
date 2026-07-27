/* Regressionstest för inputs-trace: renderar den, och gör den det i rätt takt?
 *
 * Overlayn hade ingen testtäckning alls, och den är den av våra två som är
 * KÄNSLIGAST för renderloopen: den ritar canvas varje frame (till skillnad från
 * delta-baren som skriver DOM bara vid ändring). Två av felen i §8.5 syns bara här:
 * utan Hz-tak ritas canvasen om vid varje vsync, och med per-frame-lerp i stället
 * för tidsbaserad går pedalstaplarna 2,4× snabbare på 144 Hz än på 60 Hz.
 *
 * Kör mot en gammal revision för att se att den mäter något:
 *     node tests/overlay-inputs-trace.mjs 6bb9388
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadOverlay, htmlAtRevision } from './lib/overlay-harness.mjs';

const REV = process.argv[2] || null;
let htmlFile = null;
if (REV) {
  htmlFile = path.join(os.tmpdir(), `inputs-trace-${REV}.html`);
  fs.writeFileSync(htmlFile, htmlAtRevision('inputs-trace', REV));
  console.log(`(kör mot revision ${REV})\n`);
}
const open = (o = {}) => loadOverlay('inputs-trace', { html: htmlFile, ...o });

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'OK  ' : 'FEL '} ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed++;
}

const FRAME = (o = {}) => ({ throttle: 0, brake: 0, clutch: 0, abs: false, tc: false, ...o });

// ── 1. Overlayn ritar faktiskt ──────────────────────────────────────────────
// Utan detta kan allt nedan passera på en overlay som aldrig renderade.
{
  const h = await open();
  h.settle(FRAME({ throttle: 1 }), 30);
  const clears = h.writes({ el: 'trace', key: 'clearRect' }).length;
  const strokes = h.writes({ el: 'trace', key: 'stroke' }).length;
  check('canvasen ritas om och stroke:as', clears > 10 && strokes > 10,
        `${clears} clearRect, ${strokes} stroke`);
}

// ── 2. Hz-taket gäller — 144 Hz vsync får inte ge 144 renderingar ───────────
// Detta är hela FPS-poängen (§3): ett transparent always-on-top-fönster som ritar
// canvas vid varje vsync var en del av användarens FPS-tapp.
{
  const h = await open({ hz: 144, loopHz: 30 });
  for (let i = 0; i < 144; i++) { h.push(FRAME({ throttle: 0.5 })); h.tick(); }   // 1 s
  const renders = h.writes({ el: 'trace', key: 'clearRect' }).length;
  check('30 Hz-taket håller på en 144 Hz-skärm', renders >= 28 && renders <= 32,
        `${renders} renderingar på 144 vsync`);
}

// ── 3. Pedalstaplarna är tidsbaserade, inte per-frame ───────────────────────
// Den gamla koden hade `a = 0.28` per render, utan dt (a31b1c1). Dess signatur är
// att SAMMA ANTAL RENDERINGAR alltid ger samma värde, hur lång tid de än tog.
// Vi mäter exakt det: tre renderingar med 33 ms mellan sig mot tre med 100 ms.
// Tidsbaserat ska ge tydligt olika värden, per-frame exakt samma.
//
// Räknar renderingar i stället för att mäta på väggklockan med flit: ett Hz-tak
// gör att ackumulerad dt inte landar jämnt på en godtycklig tidpunkt, och den
// artefakten hade sett ut som en bugg utan att vara det.
{
  const afterRenders = async (loopHz, n) => {
    const h = await open({ hz: loopHz, loopHz });
    let guard = 0;
    while (h.writes({ el: 'trace', key: 'clearRect' }).length < n && guard++ < 500) {
      h.push(FRAME({ throttle: 1 })); h.tick();
    }
    return { pct: Number(h.el('v-throttle').textContent),
             renders: h.writes({ el: 'trace', key: 'clearRect' }).length };
  };
  const fast = await afterRenders(30, 3);     // ~33 ms per rendering
  const slow = await afterRenders(10, 3);     // ~100 ms per rendering
  check('lika många renderingar men längre dt ger högre värde (tidsbaserat)',
        fast.renders === slow.renders && slow.pct - fast.pct >= 8,
        `3×33 ms → ${fast.pct}%, 3×100 ms → ${slow.pct}% (${fast.renders}/${slow.renders} renderingar)`);
  check('stapeln når målvärdet till slut', (await afterRenders(30, 60)).pct >= 99,
        'efter ~2 s med full gas');
}

// ── 4. ABS/TC färgar rätt trace ────────────────────────────────────────────
// Färg = betydelse (§4): gult broms-trace vid ABS, blått gas-trace vid TC.
{
  const h = await open();
  h.settle(FRAME({ throttle: 0.8, brake: 0.6 }), 20);
  const plain = new Set(h.writes({ el: 'trace', key: 'stroke' }).map((w) => w.value));
  h.settle(FRAME({ throttle: 0.8, brake: 0.6, abs: true, tc: true }), 20);
  const all = new Set(h.writes({ el: 'trace', key: 'stroke' }).map((w) => w.value));
  check('ABS/TC ger nya trace-färger', all.size > plain.size,
        `${plain.size} färger utan ABS/TC, ${all.size} med`);
}

// ── 5. Ovänliga ramar får inte ge NaN ──────────────────────────────────────
// NaN är klistrigt: stapeln fastnar på scaleY(NaN) och etiketten visar "NaN".
{
  const h = await open();
  h.settle(FRAME({ throttle: 1 }), 20);
  for (const bad of [{}, { throttle: null }, { throttle: 'x' }, { throttle: NaN }]) {
    for (let i = 0; i < 10; i++) { h.push(bad); h.tick(); }
  }
  const label = h.el('v-throttle').textContent;
  const transforms = h.writes({ el: 'f-throttle', key: 'transform' });
  const bad = transforms.filter((w) => String(w.value).includes('NaN')).length;
  check('trasiga ramar ger varken NaN-etikett eller NaN-transform',
        !String(label).includes('NaN') && bad === 0,
        `etikett ${JSON.stringify(String(label))}, ${bad} NaN-transformer`);
}

console.log(failed ? `\n${failed} kontroll(er) misslyckades` : '\nAllt OK');
process.exit(failed ? 1 : 0);
