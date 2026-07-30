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
 *   - ta bort `snapAxis`-anropen i pointermove  → 5 kontroller i 4 faller
 *   - ta första träffen i stället för närmaste  → 4 kontroller i 4 faller
 *   - strunta i `o.scale` i ovW()               → kontroll 3 och 4 faller
 *   - byt `st[grp.id] === true` mot `!== false` → 6 kontroller i 5 faller
 *   - sätt `stageK` till ett fast tal           → kontroll 2 faller
 * Alla fem är körda och föll. Kontroll 2 är därför medvetet räknad ur BEHÅLLAREN
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
  const defs = [
    { id: 'delta-bar', title: 'Delta + Lap-time Row', desc: 'D', url: 'overlays/delta-bar/index.html',
      base_width: 810, base_height: 310, x: 460, y: 40, scale: 1.0, opacity: 1, enabled: true,
      option_defs: [
        { id: 'predicted', label: 'Predicted-kolumn', default: true },
        { id: 'col-green', type: 'color', label: 'Snabbare', default: '#0DE622' },
      ], options: { predicted: true, 'col-green': '#0DE622' } },
    { id: 'inputs-trace', title: 'Inputs Trace', desc: 'I', url: 'overlays/inputs-trace/index.html',
      base_width: 744, base_height: 200, x: 100, y: 700, scale: 0.8, opacity: 0.9, enabled: true,
      option_defs: [
        { id: 'window', type: 'float', label: 'Tidsfönster', default: 4.5, min: 2, max: 10, step: 0.5, unit: ' s' },
      ], options: { window: 4.5 } },
    { id: 'lap-log', title: 'Laptime Log', desc: 'L', url: 'overlays/lap-log/index.html',
      base_width: 400, base_height: 500, x: 20, y: 20, scale: 1.2, opacity: 1, enabled: false,
      option_defs: [], options: {} },
  ];
  let layouts = [{ id: 'race', name: 'Race', active: true, slots: [] }];
  const slotsOf = () => defs.filter(d => d.enabled)
    .map(d => ({ id: d.id, title: d.title, x: d.x, y: d.y,
                 w: d.base_width * d.scale, h: d.base_height * d.scale }));

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

  // 3. Varje box ligger på rätt plats OCH har rätt storlek. Fixturens tre overlays
  //    har olika mått, skala och position med flit.
  console.log('3  boxarna ligger där overlayerna ligger');
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
       'bara påslagna overlays ska ritas, i registrets ordning');
  const b0 = boxes.find(b => b.id === 'delta-bar');
  nara(b0.x, 460 * k, 1.5, 'delta-bar x');
  nara(b0.y, 40 * k, 1.5, 'delta-bar y');
  nara(b0.w, 810 * 1.0 * k, 1.5, 'delta-bar bredd');
  nara(b0.h, 310 * 1.0 * k, 1.5, 'delta-bar höjd');
  const b1 = boxes.find(b => b.id === 'inputs-trace');
  nara(b1.w, 744 * 0.8 * k, 1.5, 'inputs-trace bredd (skala 0,8 måste räknas in)');
  nara(b1.y, 700 * k, 1.5, 'inputs-trace y');

  // 4. Snappning. Dragningen slutar 4 vypixlar från en rutnätslinje; boxens
  //    vänsterkant ska hamna EXAKT på linjen, och med snappningen av ska den
  //    ligga kvar där pekaren släppte.
  console.log('4  snappning mot rutnätet');
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
  /* delta-bar står på x=460 och är 810 bred. Rutnätet har 12 kolumner, alltså
     linjer var 160:e skärmpixel.
     A: dragningen slutar på 477, tre pixlar från linjen vid 480 — vänsterkanten
     snappar dit. */
  const snapped = await drag('delta-bar', 17);
  nara(snapped.pixelX, 480, 0.6, 'vänsterkanten skulle snappat till rutnätslinjen vid 480');
  nara(snapped.falt, 480, 0.6, 'positionsfältet ska säga samma sak som skärmvyn');
  nara(snapped.skickat?.args?.x ?? -1, 480, 0.6, 'set_position ska ha skickats med det snappade värdet');

  /* B: NÄRMASTE kandidat ska vinna, inte första träffen. Dragningen slutar på 473:
     vänsterkanten ligger 7 px från linjen vid 480, men HÖGERkanten (1283) bara 3 px
     från linjen vid 1280. Rätt svar är alltså 470 (snappat på högerkanten). En
     implementation som tar första träffen provar vänsterkanten först och svarar
     480 — samma sorts fel som gör att en bred overlay aldrig går att centrera. */
  const narmast = await drag('delta-bar', -7);
  nara(narmast.pixelX, 470, 0.6, 'högerkanten låg närmare — den ska vinna');
  nara(narmast.falt, 470, 0.6, 'positionsfältet efter närmast-snappningen');

  await cdp.eval(`document.getElementById('btnSnap').click();`);
  const fritt = await drag('delta-bar', 9);
  nara(fritt.pixelX, 479, 0.6, 'med snappningen av ska boxen ligga kvar där pekaren släppte');
  nara(fritt.falt, 479, 0.6, 'positionsfältet efter fri placering');
  await cdp.eval(`document.getElementById('btnSnap').click();`);   // tillbaka på

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
  lika(grp.map(g => g.id), ['lgrp-delta-bar', 'lgrp-inputs-trace'], 'en grupp per overlay i layouten');
  for (const g of grp){
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

  // 7. Ta bort ur layouten och lägga tillbaka. Medlemskap ÄR påslagen, alltså ska
  //    BÅDA vägarna gå genom set_enabled.
  console.log('7  lägg till och ta bort overlay ur layouten');
  const borttagen = await cdp.eval(`
    document.querySelector('#lgrp-inputs-trace .gremove').click();
    await new Promise(r => setTimeout(r, 220));
    return { boxar: [...document.querySelectorAll('.st-ov')].map(e => e.dataset.id),
             grupper: [...document.querySelectorAll('#layStack .grp')].map(g => g.id),
             anrop: window.__PANEL_TEST__.calls.filter(c => c.cmd === 'set_enabled').pop() };
  `);
  lika(borttagen.boxar, ['delta-bar'], 'boxen ska försvinna ur skärmvyn');
  lika(borttagen.grupper, ['lgrp-delta-bar'], 'gruppen ska försvinna ur stacken');
  lika(borttagen.anrop, { cmd: 'set_enabled', args: { id: 'inputs-trace', enabled: false } },
       'borttagning ska gå via set_enabled');

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

  // 8. Layoutlistan: aktiv layout markerad, och att klicka en annan aktiverar den.
  console.log('8  layoutlistan och aktiveringen');
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

  // 9. Inget fel kastades under hela mätningen.
  console.log('9  inga fel kastades under körningen');
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
