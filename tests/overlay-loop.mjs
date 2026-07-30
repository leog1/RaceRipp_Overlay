/* Regressionsvakt för bus.js:startLoop — renderloopens takt under jitter.
 *
 * OBS, till skillnad från tests/overlay-delta-bar.mjs: detta test bevakar en
 * REFAKTORERING, inte en buggfix. Det ska alltså passera både före och efter att
 * loopen flyttades ur overlays till bus.js — §9:s regel "kör testet mot revisionen
 * före fixen" går inte att tillämpa på kod som just flyttat. I stället bevisas
 * tänderna här inne: samma mätning körs mot `naivLoop` nedan, som är det mönster
 * §8.5 varnar för ("nu minus förra renderingen"). Fallerar den inte har testet
 * slutat mäta något.
 *
 * Kör:  node tests/overlay-loop.mjs
 */

// Globaler måste finnas innan bus.js laddas (modulen rör document vid laddning).
import { installFakeTimers } from './lib/fake-timers.mjs';

let NOW = 1000;
let RAF = [];
globalThis.performance = { now: () => NOW };
globalThis.requestAnimationFrame = (fn) => { RAF.push(fn); return RAF.length; };
globalThis.cancelAnimationFrame = () => {};
globalThis.document = { documentElement: { style: {} } };
/* Loopen sover mellan renderingarna i en timer och begär rAF först strax före
   deadline — annars kostar 114 av 144 rAF-begäranden i sekunden ingenting annat än
   väckningar. Timern måste därför följa TESTETS klocka. */
const TIMERS = installFakeTimers(() => NOW);

const { startLoop } = await import('../src/shared/bus.js');

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'OK  ' : 'FEL '} ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed++;
}

/* Det trasiga mönstret ur §8.5, för att bevisa att mätningen nedan skiljer dem åt:
   grinden mäter mot SENASTE RENDERINGEN, så minsta jitter skjuter en render ett
   helt refresh-intervall framåt. */
function naivLoop(tick, { hz = 30 } = {}) {
  const FRAME_MS = 1000 / hz;
  let lastRender = performance.now(), lastT = lastRender, live = true;
  function step(now) {
    if (!live) return;
    requestAnimationFrame(step);
    if (now - lastRender < FRAME_MS) return;
    lastRender = now;
    const dt = Math.min(0.25, (now - lastT) / 1000); lastT = now;
    tick(dt, now);
  }
  requestAnimationFrame(step);
  return () => { live = false; };
}

/** Kör en loop genom en serie vsync-intervall och returnerar alla tick.
 *  Räknar också hur många rAF-BEGÄRANDEN loopen gjorde: det är den kostnaden som
 *  finns kvar när Hz-taket bara hoppar arbetet, och den mäts i kontroll 6. */
function drive(loop, vsyncDeltas, opts = {}) {
  NOW = 1000; RAF = [];
  let rafAsks = 0;
  const realRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (fn) => { rafAsks++; return realRaf(fn); };
  const ticks = [];
  const stop = loop((dt, t) => ticks.push({ dt, t }), opts);
  TIMERS.run();
  for (const d of vsyncDeltas) {
    NOW += d;
    TIMERS.run();                           // timern kan ha förfallit under vsyncen
    const fn = RAF.shift();
    if (fn) fn(NOW);
    while (RAF.length > 1) RAF.shift();     // håll kön kort, som en riktig rAF
  }
  globalThis.requestAnimationFrame = realRaf;
  // Stoppa loopen innan nästa drive: annars ligger dess timer kvar i den fejkade
  // kön och räknas in i nästa mätning.
  stop();
  return { ticks, stop, rafAsks };
}

/* Deterministisk jitter (LCG) så testet ger samma svar varje körning. */
function vsync(seconds, hz = 60, jitterMs = 0) {
  const out = [];
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const nominal = 1000 / hz;
  for (let t = 0; t < seconds * 1000; t += nominal) {
    out.push(jitterMs ? nominal + (rnd() * 2 - 1) * jitterMs : nominal);
  }
  return out;
}

// ── 1. Jämn vsync: 30 Hz-loop på 60 Hz-skärm ska rendera varannan frame ──────
{
  const { ticks } = drive(startLoop, vsync(1), { hz: 30 });
  check('30 Hz på jämn 60 Hz-vsync ger ~30 tick/s', ticks.length >= 29 && ticks.length <= 31,
        `${ticks.length} tick`);
}

// ── 2. Jitter får inte tappa renderingar ────────────────────────────────────
// Detta är hela poängen med den fasta deadlinen. Naiva mönstret jämförs nedan.
{
  const jittery = vsync(1, 60, 3);
  const real = drive(startLoop, jittery, { hz: 30 }).ticks.length;
  const naiv = drive(naivLoop, jittery, { hz: 30 }).ticks.length;
  check('30 Hz håller takten trots vsync-jitter', real >= 29 && real <= 31, `${real} tick`);
  check('mätningen skiljer fast deadline från "nu minus förra renderingen"',
        naiv < 29, `naiv gav ${naiv} tick mot ${real}`);
}

// ── 3. Hz kommer från anroparen, inte en hårdkodad konstant ─────────────────
// Detta är det per-overlay-hz som registry.json nu kan sätta.
{
  const { ticks } = drive(startLoop, vsync(1), { hz: 5 });
  check('hz=5 ger ~5 tick/s', ticks.length >= 4 && ticks.length <= 6, `${ticks.length} tick`);
}

// ── 4. dt är tidsbaserat och klippt vid dtCap ───────────────────────────────
// Utan tak hoppar allt utjämnat till målvärdet i ett skutt när fönstret varit
// pausat; utan dt alls blir lerpen 2,4× snabbare på 144 Hz än på 60 Hz (§8.5).
{
  const { ticks } = drive(startLoop, [500, 16.7, 16.7, 16.7], { hz: 30, dtCap: 0.05 });
  const over = ticks.filter((t) => t.dt > 0.05);
  check('dt klipps vid dtCap efter en lång paus', ticks.length > 0 && over.length === 0,
        `${ticks.length} tick, största dt ${Math.max(...ticks.map((t) => t.dt)).toFixed(4)}s`);
  check('dt är tidsbaserat (inte konstant per frame)',
        ticks.length > 1 && ticks[1].dt > 0 && ticks[1].dt < 0.05,
        `dt[1] = ${ticks[1] ? ticks[1].dt.toFixed(4) : 'saknas'}s`);
}

// ── 5. stop() stoppar faktiskt ─────────────────────────────────────────────
{
  NOW = 1000; RAF = [];
  const ticks = [];
  const stop = startLoop((dt, t) => ticks.push(t), { hz: 30 });
  TIMERS.run();
  for (let i = 0; i < 10; i++) { NOW += 16.7; TIMERS.run(); const fn = RAF.shift(); if (fn) fn(NOW); }
  const before = ticks.length;
  stop();
  for (let i = 0; i < 20; i++) { NOW += 16.7; TIMERS.run(); const fn = RAF.shift(); if (fn) fn(NOW); }
  check('stop() avslutar loopen', before > 0 && ticks.length === before,
        `${before} tick före stop, ${ticks.length} efter`);
  check('stop() lämnar ingen timer kvar', TIMERS.pending === 0, `${TIMERS.pending} kvar`);
}

/* ── 6. En rAF-BEGÄRAN kostar även när man inte ritar ────────────────────────
   Hz-taket hoppade bara arbetet: rAF begärdes ändå vid varje vsync, och varje
   begäran är en BeginFrame från GPU-processen som väcker renderarens kompositor-
   och huvudtråd. På 144 Hz blev det ~114 tomma rundor i sekunden per overlay-
   fönster. Loopen sover därför i en timer och kopplar in rAF först nära deadline.

   Mätningen skiljer de två mönstren åt: `naivLoop` begär rAF vid VARJE vsync och
   ska alltså ligga nära 144, medan den riktiga loopen ska ligga en bra bit under.
   Taket är 100 och inte 30: marginalen (WAKE_MARGIN_MS) betalar för Windows
   timerupplösning på 15,6 ms, och den ska inte optimeras bort. */
{
  const ask = drive(startLoop, vsync(1, 144), { hz: 30 }).rafAsks;
  const naiv = drive(naivLoop, vsync(1, 144), { hz: 30 }).rafAsks;
  check('rAF begärs inte vid varje vsync', ask < 100, `${ask} begäranden/s på 144 Hz`);
  check('mätningen skiljer timerväckning från rAF vid varje vsync', naiv > 140,
        `naiv gav ${naiv} begäranden mot ${ask}`);
  // Takten får inte ha blivit ojämnare av att sparandet infördes.
  const t = drive(startLoop, vsync(1, 144), { hz: 30 }).ticks;
  const gaps = t.slice(1).map((x, i) => x.t - t[i].t);
  const worst = Math.max(...gaps.map((g) => Math.abs(g - 1000 / 30)));
  check('takten är fortfarande jämn på 144 Hz', t.length >= 29 && t.length <= 31 && worst < 8,
        `${t.length} tick, största avvikelse ${worst.toFixed(1)} ms`);
}

console.log(failed ? `\n${failed} kontroll(er) misslyckades` : '\nAllt OK');
process.exit(failed ? 1 : 0);
