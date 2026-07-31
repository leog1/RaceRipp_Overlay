/* Layout-fliken, MÄTT i en riktig webbläsare.
 *
 *   node tests/panel-layout.mjs
 *
 * Varför en riktig webbläsare och inte harnessen: det som kan gå sönder här är
 * GEOMETRI — var en box hamnar, om den snappar mot rätt linje, om skärmvyn och
 * inställningsstacken linjerar. Ingen av de sakerna syns i DOM:en; de finns bara
 * i layouten, alltså i `getBoundingClientRect`.
 *
 * Panelen körs mot en Tauri-STUBB som svarar på samma kommandon som lib.rs, med
 * fixturdata där varje overlay har olika mått och position — en stubb som ger
 * samma värden överallt hade gjort varje placeringsfel osynligt (§9: en för slapp
 * stubb ÄR ett tyst testfel).
 *
 * Sidan DRIVS över CDP i stället för med `--dump-dom`: mätningen måste klicka
 * (öppna fliken, dra en box, ta bort en overlay) och vänta in layouten mellan
 * stegen. `--force-prefers-reduced-motion` av samma skäl som i 0.5.1-mätningen:
 * under virtuell tid fryser CSS-transitioner halvvägs och ett stängt tillstånd
 * kan se öppet ut.
 *
 * SÅ VISAR DU ATT TESTET BITER (§9): kör det mot en medvetet trasig variant.
 * Prova t.ex. i src/control-panel/index.html
 *   - ta bort `snapAxis`-anropen i pointermove   → 5 kontroller i 4 faller
 *   - ta första träffen i stället för närmaste   → 4 kontroller i 4 faller
 *   - strunta i `o.scale` i ovW()                → kontroll 3 och 4 faller
 *   - byt `st[grp.id] === true` mot `!== false`  → 6 kontroller i 5 faller
 *   - sätt `stageK` till ett fast tal            → kontroll 2 faller
 *   - rita FÖNSTRET i placeBox (o.x/o.y i st.f.  → 9 kontroller faller
 *     ovX/ovY)
 *   - låt layRemove anropa set_enabled           → kontroll 7 faller
 *   - snappa mot skärmen i st.f. den användbara  → 6 kontroller i 4 faller
 *     ytan (start=0, span=skärmen)
 *   - ta bort masteroff-klassen i paintMaster    → kontroll 11 faller
 *   - strunta i paddingen i placeBox (bara scale)  → 3 kontroller i 12 faller
 *   - låt stageFramesWanted strunta i fliken       → kontroll 12 (rivet) faller
 *   - lägg tillbaka den gamla skrollloopen (läs    → 2 kontroller i 13 faller
 *     scrollTop som sanning, ge upp vid kanten)
 * Alla tolv är körda och föll. Kontroll 2 är därför medvetet räknad ur BEHÅLLAREN
 * och inte ur panelens `stageK`: en kontroll som hämtar omräkningsfaktorn ur koden
 * den granskar stämmer alltid mot sig själv och kan inte falla.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const PANEL = pathToFileURL(join(ROOT, 'src/control-panel/index.html')).href;

const CHROME_CANDIDATES = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

function findChrome(){
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  // Inget tyst hopp över: ett test som kan hoppa över sig själv skyddar ingenting
  // (§9). Saknas Chrome ska det synas som ett fel, med vägen att rätta det.
  throw new Error('Hittar ingen Chrome. Sätt CHROME=<sökväg till chrome.exe> och kör igen.\n' +
                  'Provade:\n  ' + CHROME_CANDIDATES.join('\n  '));
}

/* ── Tauri-stubben ───────────────────────────────────────────────────────────
   Skrivs in FÖRE dokumentets egna skript (Page.addScriptToEvaluateOnNewDocument),
   precis som lib.rs:s initialization_script gör i den riktiga appen.
   Skärmen är 1920×1080 och overlayerna har MEDVETET olika storlek, skala och
   position — en fixtur där allt är lika hade passerat även om panelen ritade alla
   boxar på samma ställe. */
const STUB = `
window.__PANEL_TEST__ = { calls: [] };
(function(){
  const SCREEN = { width: 1920, height: 1080 };
  /* Fönstret är STÖRRE än innehållet: base_* är innehåll + skuggrum, medan content_ och pad_
     beskriver det man faktiskt ser. Fixturen har därför olika padding på de två
     overlays som ingår — en fixtur utan padding hade gjort hela innehållsräkningen
     osynlig (en box på fönstrets plats och en på innehållets ser likadana ut när
     paddingen är noll). */
  const defs = [
    { id: 'delta-bar', title: 'Delta + Lap-time Row', desc: 'D', url: 'overlays/delta-bar/index.html',
      base_width: 800, base_height: 274, content_width: 736, content_height: 200,
      pad_left: 36, pad_top: 20,
      x: 424, y: 40, scale: 1.0, opacity: 1, enabled: true, member: true,
      /* Tio färgrader utöver de två första, och det är INTE utfyllnad: kontroll 13
         mäter hjulet, och en lista som får plats i rutan går inte att skrolla — då
         mäter testet ingenting alls. Fixturen måste alltså vara minst lika lång som
         en riktig overlays (delta-baren har tolv färger). */
      option_defs: [
        { id: 'predicted', label: 'Predicted-kolumn', default: true },
        { id: 'col-green', type: 'color', label: 'Snabbare', default: '#0DE622' },
        ...Array.from({ length: 10 }, (_, i) => (
          { id: 'col-x' + i, type: 'color', label: 'Färg ' + i, default: '#123456' })),
      ], options: Object.assign({ predicted: true, 'col-green': '#0DE622' },
        ...Array.from({ length: 10 }, (_, i) => ({ ['col-x' + i]: '#123456' }))) },
    { id: 'inputs-trace', title: 'Inputs Trace', desc: 'I', url: 'overlays/inputs-trace/index.html',
      base_width: 808, base_height: 264, content_width: 744, content_height: 200,
      pad_left: 32, pad_top: 22,
      x: 100, y: 700, scale: 0.8, opacity: 0.9, enabled: true, member: true,
      option_defs: [
        { id: 'window', type: 'float', label: 'Tidsfönster', default: 4.5, min: 2, max: 10, step: 0.5, unit: ' s' },
      ], options: { window: 4.5 } },
    { id: 'lap-log', title: 'Laptime Log', desc: 'L', url: 'overlays/lap-log/index.html',
      base_width: 400, base_height: 500, content_width: 400, content_height: 500,
      pad_left: 0, pad_top: 0,
      x: 20, y: 20, scale: 1.2, opacity: 1, enabled: false, member: false,
      option_defs: [], options: {} },
  ];
  let layouts = [{ id: 'race', name: 'Race', active: true, slots: [] }];
  // Sloten bär INNEHÅLLETS rektangel (så gör layout_info i lib.rs) och om overlayn
  // är dold just nu — en dold medlem hör kvar i layouten.
  const slotsOf = () => defs.filter(d => d.member)
    .map(d => ({ id: d.id, title: d.title,
                 x: d.x + d.pad_left * d.scale, y: d.y + d.pad_top * d.scale,
                 w: d.content_width * d.scale, h: d.content_height * d.scale,
                 enabled: d.enabled }));

  const invoke = async (cmd, args = {}) => {
    window.__PANEL_TEST__.calls.push({ cmd, args });
    const d = defs.find(x => x.id === args.id);
    switch (cmd){
      case 'get_overlays': return defs.map(x => ({ ...x, always_on_top: true }));
      case 'get_screen':   return SCREEN;
      case 'get_globals':  return { hide_until_connected: false, preview_background: '',
                                    hotkey: 'Ctrl+Alt+Space', reference_ld: '' };
      case 'list_backgrounds': return [];
      case 'list_presets': return [];
      case 'list_layouts': return layouts.map(l => ({ ...l, slots: l.active ? slotsOf() : l.slots }));
      case 'set_position': if (d){ d.x = args.x; d.y = args.y; } return null;
      case 'set_scale':    if (d) d.scale = args.scale; return null;
      case 'set_opacity':  if (d) d.opacity = args.opacity; return null;
      case 'set_enabled':  if (d) d.enabled = args.enabled; return null;
      // Medlemskap är EGET sedan 0.5.4: att dölja en overlay får inte kasta ut den
      // ur layouten. Stubben håller isär dem precis som lib.rs gör.
      case 'set_member':   if (d) d.member = args.member; return null;
      case 'set_option':   if (d) d.options[args.option] = args.value; return null;
      case 'create_layout':
        layouts.forEach(l => l.active = false);
        layouts.push({ id: 'ny', name: args.name, active: true, slots: [] });
        return 'ny';
      case 'activate_layout':
        layouts.forEach(l => l.active = l.id === args.id);
        return null;
      case 'delete_layout': layouts = layouts.filter(l => l.id !== args.id); return null;
      case 'rename_layout': { const l = layouts.find(l => l.id === args.id); if (l) l.name = args.name; return null; }
      case 'duplicate_layout': layouts.push({ id: 'kopia', name: args.name || 'kopia', active: false, slots: slotsOf() }); return 'kopia';
      default: return null;
    }
  };
  window.__TAURI__ = {
    core: { invoke },
    event: { listen: async () => (() => {}) },
    app:  { getVersion: async () => '0.5.1' },
  };
  // Fångar fel som annars bara syns i konsolen — panelen har legat tyst nog förut
  // att ett kastat undantag i uppstarten inte märktes (§7).
  window.__PANEL_TEST__.errors = [];
  addEventListener('error', e => window.__PANEL_TEST__.errors.push(String(e.message)));
  addEventListener('unhandledrejection', e => window.__PANEL_TEST__.errors.push('rejection: ' + e.reason));
})();
`;

// Allt vi vet om Chrome-processen, i ett stycke. Läggs på varje anslutningsfel: på en
// CI-runner är det enda man har att gå på.
let chromeErr = '', chromeExit = null;
function chromeDiag(){
  return [
    'chrome: ' + (chromeExit ? 'avslutade med ' + chromeExit : 'kör fortfarande'),
    'stderr: ' + (chromeErr.trim() || '(tomt)'),
  ].join(' | ');
}

/* ── liten CDP-klient ────────────────────────────────────────────────────────
   Node har global WebSocket och fetch, så det behövs inget beroende — men BARA från
   Node 21. På 20 finns ingen global WebSocket, och felet blir ett naket
   "WebSocket is not defined" mitt i en release. Säg det rakt ut i stället. */
if (typeof WebSocket === 'undefined'){
  throw new Error(`Node ${process.version} saknar global WebSocket (finns från v21). ` +
                  'CDP-klienten här bygger på den — kör testet med Node 22 eller senare.');
}
async function connect(port){
  // Filtrera på type:'page'. /json/list listar ÄVEN bakgrundssidor och
  // tjänstearbetare för det som ligger i profilen, och de kommer först — ansluter
  // man till en sådan får man en fungerande men helt tom kontext, vilket ser ut som
  // att panelen aldrig laddade.
  let target = null;
  for (let i = 0; i < 100; i++){
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch { target = null; }
    if (target) break;
    await new Promise(r => setTimeout(r, 100));
  }
  if (!target) throw new Error('Chrome svarade inte med någon sidflik på felsökningsporten. ' + chromeDiag());
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, no) => {
    ws.onopen = ok;
    // Vanligaste orsaken här är Origin-kontrollen ovan; säg det i felet i stället för
    // att lämna ett naket "WS-fel".
    ws.onerror = (e) => no(new Error('kunde inte öppna DevTools-socketen (' +
      (e && e.message ? e.message : 'okänt fel') + ') ' + chromeDiag()));
  });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)){ waiting.get(m.id)(m); waiting.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((ok, no) => {
    const n = ++id;
    waiting.set(n, (m) => m.error ? no(new Error(method + ': ' + m.error.message)) : ok(m.result));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  return {
    send,
    close: () => ws.close(),
    // Kör `expr` om och om igen tills den svarar sant. Varje omgång är ett eget
    // Runtime.evaluate, alltså mot den kontext som gäller just då.
    async wait(expr, vad, ms = 8000){
      const t0 = Date.now();
      let sist = '(inget svar)';
      while (Date.now() - t0 < ms){
        try { if (await this.eval(expr)) return true; }
        catch(e){ sist = e.message; }
        await new Promise(r => setTimeout(r, 80));
      }
      let extra = '';
      try {
        extra = await this.eval(`return 'tauri:' + !!window.__TAURI__
          + ' url:' + location.pathname.split('/').pop()
          + ' fel:' + JSON.stringify(window.__PANEL_TEST__ && window.__PANEL_TEST__.errors);`);
      } catch {}
      throw new Error(`${vad} (sista fel: ${sist}) ${extra}`);
    },
    async eval(expr){
      const r = await send('Runtime.evaluate', {
        expression: `(async () => { ${expr} })()`,
        awaitPromise: true, returnByValue: true,
      });
      if (r.exceptionDetails)
        throw new Error('Fel i sidan: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result.value;
    },
  };
}

// ── kontroller ──────────────────────────────────────────────────────────────
let fel = 0;
const nara = (a, b, tol, vad) => {
  const ok = Math.abs(a - b) <= tol;
  if (!ok){ console.error(`  FEL  ${vad}: ${a} skulle varit ${b} (±${tol})`); fel++; }
  return ok;
};
const lika = (a, b, vad) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok){ console.error(`  FEL  ${vad}: ${JSON.stringify(a)} skulle varit ${JSON.stringify(b)}`); fel++; }
  return ok;
};
const sant = (v, vad) => { if (!v){ console.error(`  FEL  ${vad}`); fel++; } return !!v; };

const profil = mkdtempSync(join(tmpdir(), 'simmatrix-panel-'));
const port = 9333 + (process.pid % 400);
const chrome = spawn(findChrome(), [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profil}`,
  // Chrome avvisar DevTools-anslutningar med en `Origin`-header sedan 111. Skickar
  // klienten en (Node-versionerna gör olika) stängs socketen direkt, och felet syns
  // bara som "Chrome svarade inte". Tillåt den uttryckligen.
  '--remote-allow-origins=*',
  '--window-size=1440,900', '--force-prefers-reduced-motion',
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  // Headless-Chrome stryper timers i fönster den anser vara i bakgrunden, och
  // panelens uppstart ligger bakom en `Promise.race` med en 1,5-sekunders timer.
  // Utan de här flaggorna kan starten dröja godtyckligt länge och testet ser
  // flakigt ut i stället för att mäta något.
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  'about:blank',
  // stderr fångas i stället för att kastas bort: startar Chrome inte alls är dess egen
  // utskrift det ENDA som säger varför, och utan den blir CI-felet "Chrome svarade
  // inte" — en återvändsgränd man inte kan felsöka på distans.
], { stdio: ['ignore', 'ignore', 'pipe'] });
chrome.stderr.on('data', d => { chromeErr += d; });
chrome.on('exit', (code, sig) => { chromeExit = `kod ${code} signal ${sig}`; });

let cdp;
try {
  cdp = await connect(port);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  await cdp.send('Page.navigate', { url: PANEL });
  /* Väntan görs som UPPREPADE korta anrop från Node och inte som en loop inne i
     sidan: `Runtime.evaluate` binder till den kontext som gäller NÄR anropet görs,
     och direkt efter Page.navigate är det fortfarande about:blank. En loop där
     hade snurrat sex sekunder i fel dokument och rapporterat en tom panel. */
  await cdp.wait(`
    return !!(document.getElementById('list')?.querySelector('.lrow')
           && document.getElementById('layList')?.querySelector('.lrow'));
  `, 'panelen blev aldrig klar', 20000);

  // 1. Fliken går att öppna och inget kastades under uppstarten.
  console.log('1  panelen startar och layout-fliken öppnas');
  const errs = await cdp.eval(`return window.__PANEL_TEST__.errors;`);
  lika(errs, [], 'panelen kastade fel under uppstart');
  await cdp.eval(`
    document.querySelector('.nav[data-sec="layout"]').click();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise(r => setTimeout(r, 120));
  `);
  sant(await cdp.eval(`return document.getElementById('app').dataset.section === 'layout';`),
       'layout-fliken blev inte aktiv');

  // 2. Skärmvyn har SKÄRMENS proportioner. En vy med fel form ljuger om var något
  //    ligger, och felet är osynligt tills man jämför med spelet.
  console.log('2  skärmvyn har skärmens proportioner');
  /* Måtten läses ur den RENDERADE skärmen (clientWidth, alltså utan kanten) och
     aldrig ur panelens egen `stageK`. En kontroll som hämtar omräkningsfaktorn ur
     koden den ska granska kan inte falla: sätter man stageK till ett fast tal
     stämmer allt fortfarande mot sig självt. Förväntad storlek räknas därför fram
     ur BEHÅLLAREN, precis som fitStage borde göra. */
  const st = await cdp.eval(`
    const el = document.getElementById('stScreen'), clip = document.getElementById('stClip');
    const pad = 22 * 2;
    // Kanten är en outline och tar ingen plats — inget att räkna bort här.
    const kVantat = Math.min((clip.clientWidth - pad) / 1920, (clip.clientHeight - pad) / 1080);
    return { w: el.clientWidth, h: el.clientHeight, kVantat };
  `);
  nara(st.w / st.h, 1920 / 1080, 0.01, 'skärmvyns proportion');
  sant(st.w > 200, 'skärmvyn ritades aldrig ut (bredd ' + Math.round(st.w) + ')');
  nara(st.w, 1920 * st.kVantat, 1.5, 'skärmvyn ska fylla ut rutan (fitStage räknar fel skalfaktor)');

  /* 3. Varje box ligger på rätt plats OCH har rätt storlek. Boxen ska visa
        INNEHÅLLET och inte fönstret: fönstret bär overlayns skuggrum, och ritade
        vyn hela fönstret hamnade det man ser en bit in från den plats man siktade
        på — en osynlig marginal som inte gick att ta bort. Väntevärdena räknas
        därför ur content_ och pad_ och inte ur base_. */
  console.log('3  boxarna visar innehållet, inte fönstret');
  const k = st.w / 1920;
  // Skärmens 1 px kant räknas bort: boxarna är positionerade mot dess INNERkant.
  const boxes = await cdp.eval(`
    const el = document.getElementById('stScreen');
    const sc = el.getBoundingClientRect();
    return [...document.querySelectorAll('.st-ov')].map(b => {
      const r = b.getBoundingClientRect();
      return { id: b.dataset.id, x: r.x - sc.x - el.clientLeft, y: r.y - sc.y - el.clientTop,
               w: r.width, h: r.height };
    });
  `);
  lika(boxes.map(b => b.id), ['delta-bar', 'inputs-trace'],
       'bara medlemmar ska ritas, i registrets ordning');
  const b0 = boxes.find(b => b.id === 'delta-bar');
  nara(b0.x, (424 + 36) * k, 1.5, 'delta-bar x (fönstrets x + vänstermarginalen)');
  nara(b0.y, (40 + 20) * k, 1.5, 'delta-bar y');
  nara(b0.w, 736 * 1.0 * k, 1.5, 'delta-bar bredd = INNEHÅLLET, inte base_width');
  nara(b0.h, 200 * 1.0 * k, 1.5, 'delta-bar höjd = innehållet');
  const b1 = boxes.find(b => b.id === 'inputs-trace');
  nara(b1.w, 744 * 0.8 * k, 1.5, 'inputs-trace bredd (skala 0,8 måste räknas in)');
  nara(b1.x, (100 + 32 * 0.8) * k, 1.5, 'inputs-trace x (marginalen skalar med overlayn)');
  nara(b1.y, (700 + 22 * 0.8) * k, 1.5, 'inputs-trace y');
  // Talfälten säger samma sak som vyn: innehållets koordinater, inte fönstrets.
  const falt = await cdp.eval(`
    const f = document.querySelectorAll('#lgrp-delta-bar .posf input');
    return [Number(f[0].value), Number(f[1].value)];
  `);
  lika(falt, [460, 60], 'positionsfälten ska visa innehållets koordinater');

  /* 4. Snappning. Två saker mäts: att måltavlorna ligger inuti KANTMARGINALEN (den
        användbara ytan, inte skärmen), och att NÄRMASTE kandidat vinner — annars
        snappar en bred overlay alltid på sin vänsterkant och går aldrig att
        centrera. Väntevärdena räknas fram här ur marginalen och celltätheten, alltså
        ur samma indata panelen har, och inte ur panelens egna variabler (§9). */
  console.log('4  snappning mot rutnätet innanför kantmarginalen');
  const MARGIN = 8, COLS = 12;              // panelens standardvärden
  const safeX = MARGIN, safeW = 1920 - 2 * MARGIN;
  // Tröskeln är 7 VYpixlar; testfallet nedan bygger på att båda kandidaterna ryms
  // inom den. Säg ifrån om rutan blivit så liten att fallet inte längre är
  // konkurrensutsatt — annars passerar det av fel skäl.
  sant(7 / k > 9, 'skärmvyn är för nedskalad för att fallet ska pröva "närmast vinner" (' +
       (7 / k).toFixed(1) + ' skärmpixlar)');
  // dScreen är förflyttningen i SKÄRMpixlar; pekaren rör sig dScreen × stageK i vyn.
  const drag = async (id, dScreen) => cdp.eval(`
    const el = document.querySelector('.st-ov[data-id="${id}"]');
    const sc = document.getElementById('stScreen');
    const k = sc.clientWidth / 1920;          // ur renderingen, inte ur panelens stageK
    const r = el.getBoundingClientRect();
    const d = ${dScreen} * k;
    const opt = { bubbles: true, pointerId: 1, button: 0, isPrimary: true };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opt, clientX: r.x + 5, clientY: r.y + 5 }));
    el.dispatchEvent(new PointerEvent('pointermove', { ...opt, clientX: r.x + 5 + d, clientY: r.y + 5 }));
    el.dispatchEvent(new PointerEvent('pointerup',   { ...opt, clientX: r.x + 5 + d, clientY: r.y + 5 }));
    await new Promise(r2 => requestAnimationFrame(r2));
    const q = el.getBoundingClientRect(), s = sc.getBoundingClientRect();
    return { pixelX: (q.x - s.x - sc.clientLeft) / k,
             falt: Number(document.querySelector('#lgrp-delta-bar .posf input').value),
             skickat: window.__PANEL_TEST__.calls.filter(c => c.cmd === 'set_position').pop() };
  `);
  /* A: delta-barens innehåll står på x=460 och är 736 brett. Dras det 135 px åt
     höger hamnar MITTEN på 963, tre pixlar från den användbara ytans mitt (960) —
     ingen annan kandidat är i närheten. Rätt svar är alltså 592 (= 960 − 736/2).
     Att det INTE är en rutnätslinje är poängen: mitten finns oavsett täthet och är
     det man oftast siktar mot. */
  const snapped = await drag('delta-bar', 135);
  nara(snapped.pixelX, safeX + safeW / 2 - 736 / 2, 0.6, 'mitten skulle snappat till skärmens mitt');
  nara(snapped.falt, 592, 0.6, 'positionsfältet ska säga samma sak som skärmvyn');
  // Det som skickas till Rust är FÖNSTRETS position, alltså innehållets minus
  // vänstermarginalen. Skickas innehållets koordinat hamnar overlayn 36 px fel på
  // skärmen — och det syns inte i vyn, som ritar innehållet.
  nara(snapped.skickat?.args?.x ?? -1, 592 - 36, 0.6,
       'set_position ska ha fått FÖNSTRETS x (innehållet minus vänstermarginalen)');

  /* B: NÄRMASTE kandidat ska vinna, inte första träffen. Dragningen slutar på 432:
     vänsterkanten ligger 5,8 px från inputs-traces vänsterkant (423,2) men MITTEN
     bara 1,3 px från rutnätslinjen vid 801,33. Rätt svar är alltså 433 (= 801,33 −
     368, avrundat). En implementation som tar första träffen provar vänsterkanten
     först och svarar 423 — samma sorts fel som gör att en bred overlay aldrig går
     att centrera. */
  const narmast = await drag('delta-bar', 432 - 592);
  nara(narmast.pixelX, 433, 0.6, 'mitten låg närmare rutnätslinjen — den ska vinna');
  nara(narmast.falt, 433, 0.6, 'positionsfältet efter närmast-snappningen');

  await cdp.eval(`document.getElementById('btnSnap').click();`);
  const fritt = await drag('delta-bar', 9);
  nara(fritt.pixelX, 442, 0.6, 'med snappningen av ska boxen ligga kvar där pekaren släppte');
  nara(fritt.falt, 442, 0.6, 'positionsfältet efter fri placering');
  await cdp.eval(`document.getElementById('btnSnap').click();`);   // tillbaka på

  /* C: KANTMARGINALEN. Dras boxen ut mot vänsterkanten ska den stanna på
     marginalen och inte på skärmens kant — det var hela felet: en box i hörnet av
     vyn la innehållet en bit in från skärmens hörn, och marginalen gick varken att
     se eller ändra. Med marginalen satt till noll ska samma dragning ge x=0. */
  const motKant = await drag('delta-bar', -442 + MARGIN + 2);
  nara(motKant.pixelX, MARGIN, 0.6, 'vänsterkanten ska snappa till kantmarginalen');
  const nollad = await cdp.eval(`
    const inp = [...document.querySelectorAll('#lgrp-__view input[type=range]')].pop();
    inp.value = 0;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 120));
    return { safeDold: document.getElementById('stSafe').hidden };
  `);
  sant(nollad.safeDold, 'den streckade kantrutan ska försvinna vid marginal 0');
  const utanMarginal = await drag('delta-bar', -MARGIN - 2);
  nara(utanMarginal.pixelX, 0, 0.6, 'med marginal 0 ska boxen kunna gå ända ut i kanten');
  // Tillbaka till standardvärdet så resten av mätningen står på känd mark.
  await cdp.eval(`
    const inp = [...document.querySelectorAll('#lgrp-__view input[type=range]')].pop();
    inp.value = ${MARGIN};
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 120));
  `);

  // 5. Inställningsgrupperna är STÄNGDA som standard. Uttryckligt krav: fem öppna
  //    listor hade begravt skärmvyn.
  console.log('5  overlay-grupperna är hopfällda tills man öppnar dem');
  const grp = await cdp.eval(`
    return [...document.querySelectorAll('#layStack .grp')].map(g => ({
      id: g.id,
      stangd: g.classList.contains('closed'),
      aria: g.querySelector('.ghead').getAttribute('aria-expanded'),
      hojd: g.querySelector('.gbody').getBoundingClientRect().height,
      rader: g.querySelector('.gcount').textContent,
    }));
  `);
  lika(grp.map(g => g.id), ['lgrp-__view', 'lgrp-delta-bar', 'lgrp-inputs-trace'],
       'skärmvyns egna inställningar först, sedan en grupp per overlay i layouten');
  // Skärmvyns grupp är ÖPPEN som standard — den beskriver ytan allt annat ligger på,
  // och en stängd grupp där hade dolt att måtten och marginalen går att ändra alls.
  sant(!grp[0].stangd && grp[0].hojd > 40, 'skärmvy-gruppen ska vara öppen som standard');
  for (const g of grp.slice(1)){
    sant(g.stangd, g.id + ' skulle varit hopfälld');
    lika(g.aria, 'false', g.id + ' aria-expanded');
    nara(g.hojd, 0, 0.5, g.id + ' gbody-höjd i stängt läge');
    sant(Number(g.rader) > 0, g.id + ' saknar radantal (en stängd grupp måste säga hur mycket som ligger under)');
  }
  // …och de öppnas.
  const oppnad = await cdp.eval(`
    document.querySelector('#lgrp-delta-bar .ghead').click();
    await new Promise(r => setTimeout(r, 320));
    const g = document.getElementById('lgrp-delta-bar');
    return { stangd: g.classList.contains('closed'),
             hojd: g.querySelector('.gbody').getBoundingClientRect().height,
             rader: [...g.querySelectorAll('.gbody > .row')].length };
  `);
  sant(!oppnad.stangd && oppnad.hojd > 40, 'gruppen gick inte att öppna');
  sant(oppnad.rader >= 5, 'gruppen ska ha position, skala, opacitet och overlayns egna alternativ, ' +
                          'fick ' + oppnad.rader + ' rader');

  // 6. Skärmvyn och inställningsstacken linjerar (§4b). Två block med olika bredd
  //    ovanpå varandra läser som två olika vyer.
  console.log('6  skärmvy och inställningar linjerar, ingen vågrät skroll');
  const linje = await cdp.eval(`
    const a = document.getElementById('stageBox').getBoundingClientRect();
    const b = document.getElementById('layStack').getBoundingClientRect();
    return { ax: a.x, aw: a.width, bx: b.x, bw: b.width,
             skroll: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  `);
  nara(linje.bx, linje.ax, 1.0, 'stackens vänsterkant mot skärmvyns');
  nara(linje.bw, linje.aw, 1.0, 'stackens bredd mot skärmvyns');
  nara(linje.skroll, 0, 0.5, 'vågrät skroll');

  /* 7. DÖLJA ÄR INTE ATT TA BORT. Det var samma sak till 0.5.3, och följden var att
        ögonknappen i Overlays-fliken kastade ut overlayn ur layouten man byggt.
        Ögat ska nu bara skriva `enabled` — boxen ligger kvar, nedtonad — och × ska
        skriva `member`. */
  console.log('7  dölj, visa, ta bort och lägg tillbaka');
  const dold = await cdp.eval(`
    document.querySelector('#lgrp-inputs-trace .ghide').click();
    await new Promise(r => setTimeout(r, 220));
    const box = document.querySelector('.st-ov[data-id="inputs-trace"]');
    return { boxar: [...document.querySelectorAll('.st-ov')].map(e => e.dataset.id),
             nedtonad: !!box && box.classList.contains('off'),
             grupper: [...document.querySelectorAll('#layStack .grp')].map(g => g.id),
             anrop: window.__PANEL_TEST__.calls.filter(c => c.cmd === 'set_enabled').pop(),
             medlemsanrop: window.__PANEL_TEST__.calls.filter(c => c.cmd === 'set_member').length };
  `);
  lika(dold.boxar, ['delta-bar', 'inputs-trace'], 'en dold overlay ska ligga kvar i skärmvyn');
  sant(dold.nedtonad, 'den dolda boxen ska ritas nedtonad');
  lika(dold.grupper, ['lgrp-__view', 'lgrp-delta-bar', 'lgrp-inputs-trace'],
       'gruppen ska ligga kvar i stacken');
  lika(dold.anrop, { cmd: 'set_enabled', args: { id: 'inputs-trace', enabled: false } },
       'att dölja ska gå via set_enabled');
  lika(dold.medlemsanrop, 0, 'att dölja får ALDRIG röra medlemskapet');
  await cdp.eval(`
    document.querySelector('#lgrp-inputs-trace .ghide').click();
    await new Promise(r => setTimeout(r, 220));
  `);

  const borttagen = await cdp.eval(`
    document.querySelector('#lgrp-inputs-trace .gremove').click();
    await new Promise(r => setTimeout(r, 220));
    return { boxar: [...document.querySelectorAll('.st-ov')].map(e => e.dataset.id),
             grupper: [...document.querySelectorAll('#layStack .grp')].map(g => g.id),
             anrop: window.__PANEL_TEST__.calls.filter(c => c.cmd === 'set_member').pop() };
  `);
  lika(borttagen.boxar, ['delta-bar'], 'boxen ska försvinna ur skärmvyn');
  lika(borttagen.grupper, ['lgrp-__view', 'lgrp-delta-bar'], 'gruppen ska försvinna ur stacken');
  lika(borttagen.anrop, { cmd: 'set_member', args: { id: 'inputs-trace', member: false } },
       'borttagning ska gå via set_member');

  const tillagd = await cdp.eval(`
    document.getElementById('btnLayAdd').click();
    await new Promise(r => setTimeout(r, 60));
    const rader = [...document.querySelectorAll('.pop .popitem .nm')].map(e => e.textContent);
    document.querySelectorAll('.pop .popitem')[0].click();
    await new Promise(r => setTimeout(r, 220));
    return { meny: rader, boxar: [...document.querySelectorAll('.st-ov')].map(e => e.dataset.id) };
  `);
  lika(tillagd.meny, ['Inputs Trace', 'Laptime Log'],
       'menyn ska visa exakt de overlays som INTE ingår');
  lika(tillagd.boxar, ['delta-bar', 'inputs-trace'], 'den tillagda ska dyka upp i skärmvyn');

  /* 8. Att välja en box i vyn ska markera dess grupp i listan under. Utan det är
        flikens trängsta ögonblick att dra en box och sedan leta rätt på just dess
        rad bland flera likadana rubriker — och "ta bort" sitter i den raden. */
  console.log('8  vald box markeras i inställningslistan');
  const markerad = await cdp.eval(`
    const box = document.querySelector('.st-ov[data-id="inputs-trace"]');
    box.dispatchEvent(new PointerEvent('pointerdown',
      { bubbles: true, pointerId: 3, button: 0, isPrimary: true, clientX: 0, clientY: 0 }));
    box.dispatchEvent(new PointerEvent('pointerup',
      { bubbles: true, pointerId: 3, button: 0, isPrimary: true, clientX: 0, clientY: 0 }));
    await new Promise(r => setTimeout(r, 80));
    return [...document.querySelectorAll('#layStack .lgrp')]
      .filter(g => g.classList.contains('picked')).map(g => g.id);
  `);
  lika(markerad, ['lgrp-inputs-trace'], 'exakt den valda overlayns grupp ska vara markerad');

  /* 9. Skärmvyns egna inställningar: en egen upplösning ändrar vyns FORM (annars
        går den inte att ställa in för en annan skärm än den panelen står på), och
        antalet skärmar ritar skarvarna — en overlay mitt i en skarv är delad i två
        av ramarna, och det syns inte på en enda stor yta. */
  console.log('9  egen upplösning och skärmskarvar');
  const pickDD = async (index, label) => cdp.eval(
    `const dd = [...document.querySelectorAll('#lgrp-__view .dd-btn')][${index}];\n` +
    `dd.click();\n` +
    `await new Promise(r => setTimeout(r, 80));\n` +
    `const rad = [...document.querySelectorAll('.pop .popitem')]\n` +
    `  .find(i => i.textContent.includes(${JSON.stringify(label)}));\n` +
    `if (!rad) throw new Error('ingen menyrad som innehåller ' + ${JSON.stringify(label)});\n` +
    `rad.click();\n` +
    `await new Promise(r => setTimeout(r, 260));`);

  await pickDD(0, '5760');
  const bred = await cdp.eval(`
    const el = document.getElementById('stScreen');
    return { form: el.clientWidth / el.clientHeight,
             text: document.getElementById('stRes').textContent };
  `);
  nara(bred.form, 5760 / 1080, 0.02, 'skärmvyn ska ta den egna upplösningens form');
  sant(bred.text.includes('5760'), 'måttet i hörnet ska säga vilken upplösning som gäller');

  await pickDD(1, '3');
  const skarvar = await cdp.eval(`
    const el = document.getElementById('stScreen');
    const k = el.clientWidth / 5760;
    return { antal: document.querySelectorAll('#stSeams i').length,
             x: [...document.querySelectorAll('#stSeams i')].map(i => parseFloat(i.style.left) / k) };
  `);
  lika(skarvar.antal, 2, 'tre skärmar ska ge två skarvar');
  nara(skarvar.x[0], 1920, 1.5, 'första skarven');
  nara(skarvar.x[1], 3840, 1.5, 'andra skarven');

  // Tillbaka till skärmen och en skärm, så resten av mätningen står på känd mark.
  await pickDD(1, '1 (en skärm)');
  await pickDD(0, 'Skärmen');
  nara(await cdp.eval(`const el = document.getElementById('stScreen');
                       return el.clientWidth / el.clientHeight;`),
       1920 / 1080, 0.02, 'valet "Skärmen" ska ge skärmens form igen');

  // 10. Layoutlistan: aktiv layout markerad, och att klicka en annan aktiverar den.
  console.log('10 layoutlistan och aktiveringen');
  const lista = await cdp.eval(`
    return { rader: [...document.querySelectorAll('#layList .lrow')].map(r => ({
               namn: r.querySelector('.ltitle').textContent,
               bricka: r.querySelector('.lstate').textContent,
               aktiv: r.classList.contains('on'),
               miniatyr: r.querySelectorAll('.lthumb rect').length })),
             namnrad: document.getElementById('layName').textContent };
  `);
  lika(lista.rader.length, 1, 'antal layouter');
  sant(lista.rader[0].aktiv && lista.rader[0].bricka === 'aktiv', 'den aktiva layouten ska vara markerad');
  lika(lista.rader[0].miniatyr, 2, 'miniatyren ska rita en rektangel per overlay i layouten');
  lika(lista.namnrad, 'Race', 'banderollen ska namnge den aktiva layouten');

  const skapad = await cdp.eval(`
    document.getElementById('btnLayNew').click();
    const inp = document.querySelector('#listLayouts .pb-form input');
    inp.value = 'Natt';
    document.querySelector('#listLayouts .pb-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise(r => setTimeout(r, 250));
    return { namn: [...document.querySelectorAll('#layList .ltitle')].map(e => e.textContent),
             aktiv: document.getElementById('layName').textContent,
             skapaAnrop: window.__PANEL_TEST__.calls.filter(c => c.cmd === 'create_layout').pop() };
  `);
  lika(skapad.namn, ['Race', 'Natt'], 'den nya layouten ska hamna i listan');
  lika(skapad.aktiv, 'Natt', 'en ny layout blir aktiv');
  lika(skapad.skapaAnrop?.args, { name: 'Natt' }, 'create_layout ska ha fått namnet');

  /* 11. Driftblocket. De tre reglagen hör inte till en flik — de avgör om något
         syns på skärmen alls, och tills 0.5.5 låg grinden i overlay-listans fot,
         alltså oåtkomlig från Layout-fliken. Det mätta: att blocket finns i BÅDA
         flikarna, att huvudströmbrytaren går hela vägen till set_overlays_on, och
         att skärmvyn säger ifrån när allt är släckt (annars ritar vyn fem overlays
         på en tom skärm). */
  console.log('11 driftblocket når båda flikarna');
  const drift = await cdp.eval(`
    const syns = (el) => !!(el && el.getClientRects().length);
    const rad = (id) => document.getElementById(id);
    const iLayout = { master: syns(rad('masterSwitch')), gate: syns(rad('gateSwitch')), mock: syns(rad('mockSwitch')) };
    document.querySelector('.nav[data-sec="overlays"]').click();
    await new Promise(r => setTimeout(r, 200));
    const iOverlays = { master: syns(rad('masterSwitch')), gate: syns(rad('gateSwitch')), mock: syns(rad('mockSwitch')) };
    document.querySelector('.nav[data-sec="installningar"]').click();
    await new Promise(r => setTimeout(r, 120));
    const iInst = syns(rad('masterSwitch'));
    document.querySelector('.nav[data-sec="layout"]').click();
    await new Promise(r => setTimeout(r, 250));
    return { iLayout, iOverlays, iInst };
  `);
  lika(drift.iLayout, { master: true, gate: true, mock: true }, 'driftblocket i Layout-fliken');
  lika(drift.iOverlays, { master: true, gate: true, mock: true }, 'driftblocket i Overlays-fliken');
  sant(!drift.iInst, 'driftblocket ska INTE följa med till flikar utan overlay-lista');

  const master = await cdp.eval(`
    const inp = document.querySelector('#masterSwitch input');
    inp.checked = false; inp.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 200));
    const av = { anrop: window.__PANEL_TEST__.calls.filter(c => c.cmd === 'set_overlays_on').pop(),
                 tonad: document.getElementById('stScreen').classList.contains('masteroff'),
                 kolumn: document.getElementById('midcol').dataset.master };
    inp.checked = true; inp.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 200));
    return { av, pa: { anrop: window.__PANEL_TEST__.calls.filter(c => c.cmd === 'set_overlays_on').pop(),
                       tonad: document.getElementById('stScreen').classList.contains('masteroff') } };
  `);
  lika(master.av.anrop?.args, { value: false }, 'huvudströmbrytaren av ska anropa set_overlays_on');
  sant(master.av.tonad, 'skärmvyn ska visa att inget syns när strömbrytaren är av');
  lika(master.av.kolumn, 'off', 'kolumnen ska tona de reglage som inte kan göra något');
  lika(master.pa.anrop?.args, { value: true }, 'huvudströmbrytaren på ska anropa set_overlays_on');
  sant(!master.pa.tonad, 'markeringen ska släppa när strömbrytaren slås på igen');

  /* 12. Boxarnas innehåll. Boxen är fortfarande MÅTTET (kontroll 3 mäter det), men
         den ritar numera overlayn själv. Två saker kan gå sönder osynligt: iframens
         geometri (den ritar FÖNSTRET och boxen är innehållet, alltså ska den skjutas
         upp/vänster med overlayns padding × skalan), och monteringen — lämnar man
         fliken måste dokumentet RIVAS, inte bara döljas, annars lever dess WebSocket
         vidare mitt i ett lopp (§8.5f). */
  console.log('12 boxarna ritar overlayn, och rivs när fliken lämnas');
  const inneh = await cdp.eval(`
    const sc = document.getElementById('stScreen');
    return [...sc.querySelectorAll('.st-ov')].map(b => {
      const r = b.getBoundingClientRect();
      const f = b.querySelector('.ovfrm');
      const fr = f.getBoundingClientRect();
      return { id: b.dataset.id, live: b.classList.contains('live'), src: (f.dataset.src || ''),
               dx: fr.x - r.x, dy: fr.y - r.y, w: fr.width, h: fr.height,
               matt: b.querySelector('.dim').textContent };
    });
  `);
  const f0 = inneh.find(b => b.id === 'delta-bar');
  sant(f0 && f0.live && f0.src.includes('delta-bar/index.html'),
       'delta-barens box ska ha laddat overlayn');
  nara(f0.w, 800 * 1.0 * k, 1.5, 'iframen ska ha FÖNSTRETS bredd × skala × vyns skala');
  nara(f0.dx, -36 * 1.0 * k, 1.5, 'iframen ska skjutas vänster med overlayns padding');
  nara(f0.dy, -20 * 1.0 * k, 1.5, 'iframen ska skjutas upp med overlayns padding');
  lika(f0.matt, '736×200', 'måttchippen ska visa innehållets storlek i skärmpixlar');
  const f1 = inneh.find(b => b.id === 'inputs-trace');
  nara(f1.w, 808 * 0.8 * k, 1.5, 'skalan ska räknas in i innehållet också');
  nara(f1.dx, -32 * 0.8 * k, 1.5, 'paddingen skalar med overlayn');
  lika(f1.matt, '595×160', 'måttet följer skalan (744×200 vid 0,8)');

  const rivet = await cdp.eval(`
    document.querySelector('.nav[data-sec="overlays"]').click();
    await new Promise(r => setTimeout(r, 250));
    const efter = [...document.querySelectorAll('.st-ov .ovfrm')].map(f => f.dataset.src || '');
    document.querySelector('.nav[data-sec="layout"]').click();
    await new Promise(r => setTimeout(r, 300));
    const igen = [...document.querySelectorAll('.st-ov .ovfrm')].map(f => (f.dataset.src || '').split('?')[0]);
    return { efter, igen };
  `);
  lika(rivet.efter, ['', ''], 'iframen ska rivas när man lämnar Layout-fliken');
  lika(rivet.igen, ['../overlays/delta-bar/index.html', '../overlays/inputs-trace/index.html'],
       'och laddas om när man kommer tillbaka');

  /* 13. Skrollen i inställningslistan. Hjulet mäts med RIKTIGA (trusted) events över
         CDP — ett syntetiskt `new WheelEvent` skrollar ingenting och hade mätt
         ingenting. Buggen som testet bevakar: loopen läste tillbaka `scrollTop` som
         sanning, och eftersom värdet avrundas och webbläsaren klampar mot sin egen
         kant tolkade den en frame utan synlig rörelse som "kanten är nådd" och gav
         upp — nästa snäpp började då om från den avrundade positionen och den redan
         beställda sträckan försvann. Mätt före fixen: fem snäpp uppåt från botten
         flyttade 300 px i stället för 500. */
  console.log('13 hjulet tappar ingen sträcka vid ändarna');
  await cdp.eval(`
    document.querySelector('.nav[data-sec="overlays"]').click();
    await new Promise(r => setTimeout(r, 250));
    document.querySelectorAll('#pane-overlays .grp.closed .ghead').forEach(h => h.click());
    await new Promise(r => setTimeout(r, 250));
  `);
  const ruta = await cdp.eval(`
    const b = document.querySelector('#pane-overlays .controls');
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, max: b.scrollHeight - b.clientHeight };
  `);
  sant(ruta.max > 400, 'inställningslistan måste vara skrollbar för att mätningen ska betyda något ('
       + Math.round(ruta.max) + ' px)');
  const snurra = async (fran, dy) => {
    await cdp.eval(`document.querySelector('#pane-overlays .controls').scrollTop = ${fran};`);
    await new Promise(r => setTimeout(r, 300));
    for (let i = 0; i < 5; i++){
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: ruta.x, y: ruta.y,
                                                   deltaX: 0, deltaY: dy, pointerType: 'mouse' });
      // Kort paus mellan snäppen: utan den slår Chromium ihop hjulhändelser som kommer
      // i samma tick, och då mäter testet webbläsarens hopslagning i stället för vår
      // loop. 40 ms är fortfarande snabbare än ett handled hinner snurra.
      await new Promise(r => setTimeout(r, 40));
    }
    await new Promise(r => setTimeout(r, 900));
    return cdp.eval(`return document.querySelector('#pane-overlays .controls').scrollTop;`);
  };
  const ned = Math.min(500, ruta.max);
  nara(await snurra(0, 100), ned, 25, 'fem snäpp nedåt från toppen ska flytta 5 × 100 px');
  nara(await snurra(ruta.max, -100), ruta.max - ned, 25, 'fem snäpp uppåt från botten ska flytta lika långt');

  // 14. Inget fel kastades under hela mätningen.
  console.log('14 inga fel kastades under körningen');
  lika(await cdp.eval(`return window.__PANEL_TEST__.errors;`), [], 'fel under körningen');

} finally {
  try { cdp?.close(); } catch {}
  chrome.kill();
  try { rmSync(profil, { recursive: true, force: true }); } catch {}
}

if (fel){
  console.error(`\n${fel} kontroll(er) föll.`);
  process.exit(1);
}
console.log('\nOK — layout-fliken mäter rätt.');
