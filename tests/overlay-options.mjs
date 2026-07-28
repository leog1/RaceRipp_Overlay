/* Typade alternativ: når de fram till overlayn INNAN första paint?
 *
 * Detta är §8.3 igen, en tredje gång. Skala och opacitet hämtades först async och
 * overlayn ritade ett frame i CSS-defaulten; fixen var att skalet injicerar dem med
 * initialization_script. Alternativ som påverkar LAYOUT (dold kolumn, antal rader,
 * tidsfönster) har exakt samma problem, och det syns bara i ett enda frame — alltså
 * bara mätbart här, inte på skärmen.
 *
 * Kör mot revisionen före ändringen för att se att det biter:
 *     node tests/overlay-options.mjs 12122b2
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadOverlay, htmlAtRevision, ROOT } from './lib/overlay-harness.mjs';

const REV = process.argv[2] || null;
const htmlOf = (id) => {
  if (!REV) return undefined;
  const p = path.join(os.tmpdir(), `${id}-${REV}.html`);
  fs.writeFileSync(p, htmlAtRevision(id, REV));
  return p;
};
if (REV) console.log(`(kör mot revision ${REV})\n`);

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'OK  ' : 'FEL '} ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed++;
}

const FRAME = (o = {}) => ({ throttle: 0, brake: 0, clutch: 0, abs: false, tc: false, ...o });

// ── 1. Registret måste vara läsbart och typat som Rust förväntar sig ────────
// registry.json kompileras in i lib.rs med include_str! och panik:ar vid fel form,
// vilket betyder att en trasig rad här inte ger ett byggfel utan en app som dör vid
// start. Billigt att kontrollera, dyrt att missa.
{
  const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/overlays/registry.json'), 'utf8'));
  const KINDS = new Set(['bool', 'int', 'float', 'enum', 'color']);
  const problems = [];
  for (const o of reg.overlays) {
    for (const d of o.options || []) {
      const kind = d.type || 'bool';
      if (!KINDS.has(kind)) problems.push(`${o.id}.${d.id}: okänd typ "${kind}"`);
      if (d.default === undefined) problems.push(`${o.id}.${d.id}: saknar default`);
      if (kind === 'enum' && !(d.values || []).some((v) => v.value === d.default))
        problems.push(`${o.id}.${d.id}: default finns inte bland values`);
      if ((kind === 'int' || kind === 'float') &&
          ((d.min != null && d.default < d.min) || (d.max != null && d.default > d.max)))
        problems.push(`${o.id}.${d.id}: default utanför min/max`);
    }
  }
  check('registry.json:s optionsscheman är välformade', problems.length === 0,
        problems.join('; ') || 'alla ok');
}

// ── 2. Injicerade alternativ gäller vid FÖRSTA renderingen ─────────────────
// Kolumnen ska vara dold redan innan overlayn ritat något, inte efter att ett
// async get_config-svar kommit.
{
  const h = await loadOverlay('inputs-trace', {
    html: htmlOf('inputs-trace'),
    init: { id: 'inputs-trace', scale: 1, opacity: 1, options: { clutch: false, window: 4.5 } },
  });
  const hides = h.writes({ el: 'col-clutch', key: 'display' });
  check('bool-alternativ appliceras före första renderingen',
        hides.length > 0 && hides[0].value === 'none',
        hides.length ? `första skrivning: ${JSON.stringify(hides[0].value)}` : 'kolumnen rördes aldrig');
}

// ── 3. Tal-alternativ når overlayn som ett TAL, inte en sträng ─────────────
// Ett värde som kommer som "4.5" i stället för 4.5 ger tyst NaN längre in.
{
  const mk = async (sec) => {
    const h = await loadOverlay('inputs-trace', {
      html: htmlOf('inputs-trace'),
      init: { id: 'inputs-trace', scale: 1, opacity: 1, options: { clutch: true, window: sec } },
      expose: ['trace'],
    });
    h.settle(FRAME({ throttle: 1 }), 5);
    return h;
  };
  const wide = await mk(10), narrow = await mk(2);
  const win = (h) => h.api.trace && h.api.trace.VISIBLE_MS;
  check('float-alternativ styr trace-fönstret',
        win(wide) === 10000 && win(narrow) === 2000,
        `10 s → ${win(wide)} ms, 2 s → ${win(narrow)} ms`);
}

// ── 4. Ett ogiltigt värde får inte sätta overlayn ur spel ─────────────────
// Rust klampar och typrättar innan värdet skickas, men overlayn ska ändå överleva
// att få skräp — settings.json redigeras för hand (§8.3b) och OBS/webbläsare har
// ingen Rust-validering alls framför sig.
{
  for (const bad of ['hej', null, NaN, -5]) {
    const h = await loadOverlay('inputs-trace', {
      html: htmlOf('inputs-trace'),
      init: { id: 'inputs-trace', scale: 1, opacity: 1, options: { clutch: true, window: bad } },
      expose: ['trace'],
    });
    h.settle(FRAME({ throttle: 1 }), 10);
    const w = h.api.trace && h.api.trace.VISIBLE_MS;
    const drew = h.writes({ el: 'trace', key: 'clearRect' }).length;
    check(`window=${String(bad)} ger ett vettigt fönster och overlayn ritar ändå`,
          drew > 0 && Number.isFinite(w) && w >= 1000, `fönster ${w} ms, ${drew} renderingar`);
  }
}

// ── 11. Panelens förhandsvisning måste kunna ta emot ändringar ────────────
// Previewn kör i en <iframe> och får INTE Tauris event — `__TAURI__` injiceras inte
// där. Följden var att previewn aldrig reagerade när man slog av/på ett alternativ;
// skillnaden syntes först i spelet. postMessage är därför en andra kanal, och den
// ligger FÖRE Tauri-kontrollen i wireShell just för att fungera utan Tauri.
{
  const h = await loadOverlay('inputs-trace', {
    html: htmlOf('inputs-trace'),
    init: { id: 'inputs-trace', scale: 1, opacity: 1, options: { clutch: true, window: 4.5 } },
    expose: ['trace'],
  });
  h.settle(FRAME({ throttle: 1 }), 5);
  const före = h.api.trace.VISIBLE_MS;

  h.message({ __simmatrix: true, kind: 'option', id: 'inputs-trace', option: 'window', value: 8 });
  check('postMessage från panelen når overlayn', h.api.trace.VISIBLE_MS === 8000,
        `${före} ms → ${h.api.trace.VISIBLE_MS} ms`);

  // Meddelanden för en ANNAN overlay ska ignoreras.
  h.message({ __simmatrix: true, kind: 'option', id: 'delta-bar', option: 'window', value: 2 });
  check('meddelande till annan overlay ignoreras', h.api.trace.VISIBLE_MS === 8000,
        `${h.api.trace.VISIBLE_MS} ms`);

  // Främmande meddelanden (andra bibliotek, andra iframes) ska inte tolkas alls.
  h.message({ kind: 'option', id: 'inputs-trace', option: 'window', value: 3 });
  check('meddelande utan vår markör ignoreras', h.api.trace.VISIBLE_MS === 8000,
        `${h.api.trace.VISIBLE_MS} ms`);
}

// ── 12. Opaciteten måste också nå förhandsvisningen ──────────────────────
// Rapporterat: previewn följde med på alternativen men INTE på opacitetsreglaget.
// Panelen postade bara `option`, aldrig `config` — så skala och opacitet nådde
// aldrig in i iframen.
{
  const h = await loadOverlay('inputs-trace', {
    html: htmlOf('inputs-trace'),
    init: { id: 'inputs-trace', scale: 1, opacity: 1, options: { clutch: true, window: 4.5 } },
  });
  h.settle(FRAME({ throttle: 1 }), 3);
  const skrivningar = () => h.writes({ el: 'ui', key: 'opacity' });
  const före = skrivningar().length;

  h.message({ __simmatrix: true, kind: 'config', id: 'inputs-trace', opacity: 0.35 });
  const nya = skrivningar().slice(före);
  check('config med opacitet når overlayn',
        nya.length > 0 && nya[nya.length - 1].value === '0.35',
        nya.length ? `satte ${nya[nya.length - 1].value}` : 'ingen skrivning');

  // Och config för en annan overlay ska ignoreras.
  h.message({ __simmatrix: true, kind: 'config', id: 'delta-bar', opacity: 0.9 });
  const efter = skrivningar();
  check('config till annan overlay ignoreras',
        efter[efter.length - 1].value === '0.35', efter[efter.length - 1].value);
}

// ── 13. Färgalternativ sätter CSS-variabeln, generiskt ───────────────────
// `col-<token>` → `--<token>`. Poängen är att en ny färg ska vara EN RAD i
// registry.json och noll kod i overlayn. Går det sönder märks det inte i CSS —
// färgen blir bara den gamla.
{
  const h = await loadOverlay('inputs-trace', {
    html: htmlOf('inputs-trace'),
    init: { id: 'inputs-trace', scale: 1, opacity: 1,
            options: { clutch: true, window: 4.5, 'col-green': '#00ff00' } },
  });
  const skriv = (namn) => h.writes({ el: 'documentElement', key: namn });
  check('färg ur INIT sätter CSS-variabeln före första paint',
        skriv('--green').some((w) => w.value === '#00ff00'),
        JSON.stringify(skriv('--green').map((w) => w.value)));

  h.message({ __simmatrix: true, kind: 'option', id: 'inputs-trace',
              option: 'col-red', value: '#123456' });
  check('färgändring i drift sätter variabeln',
        skriv('--red').some((w) => w.value === '#123456'), JSON.stringify(skriv('--red')));

  // Alfa: 8-siffrig hex ska gå rakt igenom, CSS förstår den.
  h.message({ __simmatrix: true, kind: 'option', id: 'inputs-trace',
              option: 'col-panel', value: '#12141680' });
  check('alfafärg (8-siffrig hex) når fram orörd',
        skriv('--panel').some((w) => w.value === '#12141680'), JSON.stringify(skriv('--panel')));

  // Ett col-alternativ som INTE är en sträng får inte skriva något alls.
  const föreSkräp = skriv('--grid').length;
  h.message({ __simmatrix: true, kind: 'option', id: 'inputs-trace',
              option: 'col-grid', value: 42 });
  check('icke-sträng skriver ingen CSS-variabel', skriv('--grid').length === föreSkräp,
        `${skriv('--grid').length - föreSkräp} skrivningar`);
}

// ── 14. Alla färger i registret måste ha giltiga standardvärden ──────────
// Rust validerar mot #rgb/#rgba/#rrggbb/#rrggbbaa och faller tillbaka på default
// vid fel — men är DEFAULTEN felskriven finns inget att falla tillbaka på.
{
  const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/overlays/registry.json'), 'utf8'));
  const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
  const fel = [];
  let antal = 0;
  for (const o of reg.overlays) {
    for (const d of o.options || []) {
      if (d.type !== 'color') continue;
      antal++;
      if (!hex.test(String(d.default))) fel.push(`${o.id}.${d.id}=${d.default}`);
      if (!d.id.startsWith('col-')) fel.push(`${o.id}.${d.id}: färg utan col--prefix`);
      // alfa i standardvärdet utan alpha:true går inte att ställa i panelen
      if (String(d.default).replace('#', '').length === 8 && !d.alpha)
        fel.push(`${o.id}.${d.id}: alfa i default men alpha saknas`);
    }
  }
  check(`alla ${antal} färgalternativ är välformade`, fel.length === 0, fel.join('; ') || 'ok');
}

console.log(failed ? `\n${failed} kontroll(er) misslyckades` : '\nAllt OK');
process.exit(failed ? 1 : 0);
