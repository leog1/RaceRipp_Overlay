/* Fejkade timers bundna till testets EGEN klocka.
 *
 * Varför de behövs: bus.js:startLoop sover bort merparten av väntan mellan två
 * renderingar i en `setTimeout` och kopplar in rAF först strax före deadline (det
 * är hela poängen — en rAF-begäran kostar även när man inte ritar). Ett test som
 * bara driver rAF ser då en loop som aldrig kommer igång, och skulle "passera"
 * genom att mäta noll frames.
 *
 * Node:s riktiga setTimeout duger inte: testklockan är påhittad (`performance.now`
 * är stubbad) och rör sig i hopp, medan en riktig timer följer väggklockan. Timers
 * måste alltså förfalla mot SAMMA klocka som allt annat i testet.
 *
 * `installFakeTimers` byter ut globalerna. Anropa `run()` varje gång klockan
 * flyttats fram — den kör allt som förfallit, inklusive timers som nya timers
 * lägger till på samma tidpunkt.
 */

/** @param {() => number} nowFn testets klocka i ms */
export function installFakeTimers(nowFn) {
  const real = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
  const pending = new Map();          // id → { at, fn }
  let seq = 1;

  globalThis.setTimeout = (fn, ms = 0, ...args) => {
    const id = seq++;
    pending.set(id, { at: nowFn() + Math.max(0, Number(ms) || 0), fn, args });
    return id;
  };
  globalThis.clearTimeout = (id) => { pending.delete(id); };
  // Ingen overlay använder intervall; att låta dem gå till den riktiga timern hade
  // gjort ett test som råkar skapa ett odeterministiskt.
  globalThis.setInterval = globalThis.setTimeout;
  globalThis.clearInterval = globalThis.clearTimeout;

  return {
    /** Kör allt som förfallit vid nowFn(). Nya timers på samma tid körs också. */
    run() {
      for (let guard = 0; guard < 10000; guard++) {
        let next = null;
        for (const [id, t] of pending) {
          if (t.at <= nowFn() && (next === null || t.at < pending.get(next).at)) next = id;
        }
        if (next === null) return;
        const t = pending.get(next);
        pending.delete(next);
        t.fn(...(t.args || []));
      }
      throw new Error('fejkade timers: oändlig kedja (över 10000 körningar)');
    },
    get pending() { return pending.size; },
    restore() { Object.assign(globalThis, real); },
  };
}
