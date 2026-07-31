/* Ryms overlayn — MED sin slagskugga — i fönstret den får? MÄTT i en riktig
 * webbläsare, vid tre skalor.
 *
 *   node tests/overlay-window-fit.mjs
 *
 * VARFÖR TESTET FINNS: ett overlay-fönster är transparent och klipper allt utanför
 * sig. Skuggan är alltså inte "utanför layouten" som på en vanlig webbsida — den
 * behöver riktig plats innanför fönsterkanten. Fönstret är därför INNEHÅLL +
 * SKUGGRUM (baseWidth/baseHeight i registry.json), och innehållet sitter en bit in
 * (padLeft/padTop).
 *
 * Det gick sönder på två sätt som båda var osynliga i koden:
 *   • marginalen stod i FASTA pixlar medan fönstret är base × skala, så vid stora
 *     skalor fanns det för lite plats åt vänster och upptill och skuggan klipptes;
 *   • marginalen räknas i en `calc()` med `var(--ui-scale)`, och en calc() med en
 *     ODEFINIERAD variabel är ogiltig — hela deklarationen faller bort och
 *     innehållet hamnar i fönstrets hörn. Det gällde precis de lägen som saknar
 *     __OVERLAY_INIT__: OBS, en vanlig webbläsare, panelens förhandsvisning.
 *
 * SIDORNA SERVERAS ÖVER HTTP och inte som file://. ES-moduler över file:// blockeras
 * av CORS, alltså laddas bus.js aldrig — och då tillämpas varken skalan eller
 * marginalen. Mätningen såg då ut att hitta fel som inte fanns (och hade missat de
 * som fanns). Samma serveringsväg som OBS använder, alltså.
 *
 * SÅ VISAR DU ATT TESTET BITER (§9): kör mot en medvetet trasig variant. Tre är
 * körda och alla föll:
 *   - ta bort `--ui-scale` ur BÅDE tokens.css och inputs-trace  → de två
 *     kontrollerna utan INIT faller (0 px marginal, alltså den ogiltiga calc:en)
 *   - lås inputs-traces #ui till fasta `top/left`               → 4 kontroller faller
 *   - sänk inputs-traces baseHeight till 222                    → bottenkravet
 *     faller vid alla tre skalorna
 *   - ta bort `motecMs` ur MATNINGSRAM                          → delta-barens
 *     contentWidth-krav faller vid alla tre skalorna (uppmätt 558,6 mot 736)
 *
 * MÄTNINGEN SKER I OVERLAYNS BREDASTE LÄGE. Fönstret ska rymma det den KAN visa, inte
 * det den råkar visa just nu: delta-baren har en spalt som bara finns när en MoTeC-fil
 * är vald, så sidan matas med en ram där allt är på (se MATNINGSRAM).
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const WEB = join(ROOT, 'src');

/* Skuggans RÄCKVIDD utanför innehållet, i pixlar vid skala 1,0. Talen är lästa ur
   overlayernas egen CSS (offset + blur, minus offset åt motsatt håll) och är det
   KRAV registret ska uppfylla — de får alltså inte räknas fram ur registret, då
   stämmer allt mot sig självt.
     delta-bar: diskens `0 24px 48px` och barens `0 16px 34px`, båda inuti en
                transform på 0,7143.
     inputs-trace: panelens `0 10px 30px` vid H=200.
   Saknas en overlay här FALLER testet: en ny overlay ska inte kunna glida in utan
   att någon tänkt igenom hur mycket plats dess skugga behöver. */
const SKUGGA = {
  'delta-bar':    { l: 34.3, t: 17.2, r: 24.3, b: 51.4 },
  'inputs-trace': { l: 30.0, t: 20.0, r: 30.0, b: 40.0 },
};
const SKALOR = [0.6, 1.0, 1.6];

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
  throw new Error('Hittar ingen Chrome. Sätt CHROME=<sökväg till chrome.exe> och kör igen.\n' +
                  'Provade:\n  ' + CHROME_CANDIDATES.join('\n  '));
}
if (typeof WebSocket === 'undefined'){
  throw new Error(`Node ${process.version} saknar global WebSocket (finns från v21). ` +
                  'CDP-klienten här bygger på den — kör testet med Node 22 eller senare.');
}

// ── liten statisk server (samma mime-mappning som motorns http_static) ──────────
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
               '.json': 'application/json', '.woff2': 'font/woff2', '.webp': 'image/webp',
               '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
  const file = join(WEB, rel);
  // Ingen väg ut ur src/: testet ska inte kunna servera repot.
  if (!file.startsWith(WEB) || !existsSync(file) || !statSync(file).isFile()){
    res.writeHead(404).end('nej'); return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
const port = await new Promise(ok => server.listen(0, '127.0.0.1', () => ok(server.address().port)));

// ── CDP ────────────────────────────────────────────────────────────────────────
let chromeErr = '', chromeExit = null;
const profil = mkdtempSync(join(tmpdir(), 'simmatrix-fit-'));
const dbg = 9500 + (process.pid % 400);
const chrome = spawn(findChrome(), [
  '--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${profil}`,
  '--remote-allow-origins=*', '--window-size=2400,1400', '--force-prefers-reduced-motion',
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
chrome.stderr.on('data', d => { chromeErr += d; });
chrome.on('exit', (code, sig) => { chromeExit = `kod ${code} signal ${sig}`; });

/* Se motsvarande konstant i panel-layout.mjs: 45 s för att en KALL CI-runner startar
   Chrome mot en tom profil långsammare än en utvecklingsmaskin, och tio sekunder
   räckte inte. Väntan mäts i väggklocka, inte i antal varv — varje varv gör en
   `fetch` som kan ta godtyckligt lång tid att ge upp. */
const CHROME_WAIT_MS = 45_000;

async function connect(){
  let target = null;
  const t0 = Date.now();
  while (Date.now() - t0 < CHROME_WAIT_MS){
    if (chromeExit) break;                 // dog Chrome finns inget att vänta på
    try {
      const list = await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json();
      target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch { target = null; }
    if (target) break;
    await new Promise(r => setTimeout(r, 100));
  }
  if (!target) throw new Error(`Chrome svarade inte med någon sidflik efter ` +
    `${Math.round((Date.now() - t0) / 1000)} s. chrome: ` +
    `${chromeExit ? 'avslutade med ' + chromeExit : 'kör fortfarande'} | ` +
    `stderr: ${chromeErr.trim() || '(tomt)'}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error('DevTools-socketen gick inte att öppna')); });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)){ waiting.get(m.id)(m); waiting.delete(m.id); } };
  const send = (method, params = {}) => new Promise((ok, no) => {
    const n = ++id;
    waiting.set(n, (m) => m.error ? no(new Error(method + ': ' + m.error.message)) : ok(m.result));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  return {
    send, close: () => ws.close(),
    async eval(expr){
      const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error('Fel i sidan: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result.value;
    },
    async wait(expr, vad, ms = 8000){
      const t0 = Date.now();
      while (Date.now() - t0 < ms){
        try { if (await this.eval(expr)) return true; } catch {}
        await new Promise(r => setTimeout(r, 80));
      }
      throw new Error(vad);
    },
  };
}

let fel = 0;
const krav = (v, min, vad) => {
  // En halv pixel slack: måtten går genom layout och avrundning i webbläsaren.
  if (!(v >= min - 0.5)){ console.error(`  FEL  ${vad}: ${v.toFixed(1)} px, behöver ${min.toFixed(1)} px`); fel++; }
};

const reg = JSON.parse(readFileSync(join(ROOT, 'src/overlays/registry.json'), 'utf8')).overlays;
/* En BUSS SOM MATAR. Fönstret ska rymma overlayns BREDASTE läge, och delta-baren har
   sedan 0.5.9 en spalt som bara finns när en MoTeC-fil är vald (`motecMs` i ramen).
   Utan data mäter testet alltså en smalare overlay än den registret beskriver, och
   kravet på contentWidth blir omöjligt att bedöma — samma familj som §8.4g: räkna
   bredden på det bredaste värdet fältet kan visa, inte på det som råkar stå där.
   WebSocket-klassen byts ut i stället för att starta en riktig server: motorn kan
   redan äga port 8777 på maskinen som kör testet, och en mätning som beror på det
   är ingen mätning. Ramen skickas om var 200:e ms — overlayns latch är 2 s och
   sidan hinner vänta längre än så på fonten. */
const MATNINGSRAM = {
  connected: true, motecMs: 136250, sessionBestMs: 138120, curLapMs: 45000,
  position: 0.5, throttle: 1, brake: 0, gear: 4, speedKph: 180, rpm: 7000,
  refs: { best:  { delta: -0.5, totalMs: 138120, throttle: 1, brake: 0, src: 'lap' },
          motec: { delta: 0.25, totalMs: 136250, throttle: 1, brake: 0, src: 'motec' } },
};
let cdp, initScript = null;
try {
  cdp = await connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.WebSocket = class {
      constructor(){
        this.readyState = 1; this.onopen = this.onmessage = this.onerror = this.onclose = null;
        const ram = { data: JSON.stringify(${JSON.stringify(MATNINGSRAM)}) };
        setTimeout(() => { this.onopen && this.onopen(); this.onmessage && this.onmessage(ram); }, 0);
        this._t = setInterval(() => { this.onmessage && this.onmessage(ram); }, 200);
      }
      send(){} close(){ clearInterval(this._t); }
    };`,
  });

  for (const d of reg){
    const behov = SKUGGA[d.id];
    if (!behov){
      console.error(`  FEL  ${d.id} saknas i SKUGGA-tabellen — hur mycket plats behöver dess skugga?`);
      fel++;
      continue;
    }
    for (const skala of SKALOR){
      // Injektionerna ACKUMULERAS i CDP: utan att ta bort den förra kör varje
      // navigering alla tidigare skript också, och vilken INIT som vinner beror på
      // ordningen. Ta bort den gamla först.
      if (initScript) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: initScript });
      // Samma injektion som lib.rs gör före sidan parsas (§8.3).
      initScript = (await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `window.__OVERLAY_INIT__ = ${JSON.stringify({
          id: d.id, scale: skala, opacity: 1, gate: false, enabled: true, osHidden: false,
          hz: d.hz ?? 30, options: {},
          pad: { l: d.padLeft ?? 0, t: d.padTop ?? 0 },
        })};`,
      })).identifier;
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/overlays/${d.id}/index.html` });
      /* Vänta på TVÅ saker, och båda har kostat en felmätning:
         • att bus.js hunnit tillämpa skalan (`--ui-scale`). Mäter man innan står
           overlayn kvar i skala 1 och siffrorna ser ut att bevisa något de inte gör.
         • att Montserrat faktiskt laddat. `document.fonts.status` är "loaded" redan
           innan något efterfrågats, alltså värdelöst här; delta-barens kolumner är
           ~107 px smalare i fallback-fonten. */
      await cdp.wait(
        `return !!document.getElementById('ui')` +
        ` && getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim() === '${skala}'` +
        ` && document.fonts.check('600 40px Montserrat');`,
        `${d.id} vid skala ${skala}: skalan eller fonten kom aldrig fram`);
      // `document.fonts.check` kan svara sant innan texten LAGTS OM — en mätning
      // direkt efteråt fick delta-baren 107 px för smal (fallback-fontens bredd).
      // `fonts.ready` väntar in hela laddningen, och två rAF ger layouten en chans.
      await cdp.eval(`await document.fonts.ready;
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));`);
      const m = await cdp.eval(`
        const r = document.getElementById('ui').getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      `);
      const winW = d.baseWidth * skala, winH = d.baseHeight * skala;
      const namn = `${d.id} vid skala ${skala}`;
      krav(m.x,                  behov.l * skala, `${namn}: plats åt skuggan till VÄNSTER`);
      krav(m.y,                  behov.t * skala, `${namn}: plats åt skuggan UPPTILL`);
      krav(winW - (m.x + m.w),   behov.r * skala, `${namn}: plats åt skuggan till HÖGER`);
      krav(winH - (m.y + m.h),   behov.b * skala, `${namn}: plats åt skuggan NEDTILL`);
      // Innehållet ska dessutom vara det registret säger att det är: skärmvyn i
      // Layout-fliken ritar boxen ur content_*, och ljuger de talen hamnar varje
      // overlay fel på skärmen utan att något syns i panelen.
      if (d.contentWidth)
        krav(2 - Math.abs(m.w - d.contentWidth * skala), 0,
             `${namn}: contentWidth säger ${d.contentWidth}, uppmätt ${(m.w / skala).toFixed(1)}`);
      if (d.contentHeight)
        krav(2 - Math.abs(m.h - d.contentHeight * skala), 0,
             `${namn}: contentHeight säger ${d.contentHeight}, uppmätt ${(m.h / skala).toFixed(1)}`);
      console.log(`OK?  ${namn}: fönster ${Math.round(winW)}×${Math.round(winH)}, ` +
                  `innehåll ${m.w.toFixed(0)}×${m.h.toFixed(0)} vid ${m.x.toFixed(0)},${m.y.toFixed(0)}`);
    }

    /* UTAN __OVERLAY_INIT__ — alltså OBS, en vanlig webbläsare och kontrollpanelens
       förhandsvisning. Marginalen måste gälla ändå, ur CSS-fallbacken, och det är
       precis det som gick sönder: den räknas i en `calc()` med `var(--ui-scale)`,
       och en calc() med en odefinierad variabel är ogiltig — deklarationen faller
       bort och innehållet hamnar i fönstrets hörn med skuggan avklippt. */
    if (initScript){
      await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: initScript });
      initScript = null;
    }
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/overlays/${d.id}/index.html` });
    await cdp.wait(`return !!document.getElementById('ui') && document.fonts.check('600 40px Montserrat');`,
                   `${d.id} utan INIT: sidan blev aldrig klar`);
    await cdp.eval(`await document.fonts.ready;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));`);
    const u = await cdp.eval(`
      const r = document.getElementById('ui').getBoundingClientRect();
      return { x: r.x, y: r.y };
    `);
    krav(u.x, behov.l, `${d.id} UTAN init (OBS/webbläsare): plats åt skuggan till VÄNSTER`);
    krav(u.y, behov.t, `${d.id} UTAN init (OBS/webbläsare): plats åt skuggan UPPTILL`);
    console.log(`OK?  ${d.id} utan INIT: innehållet börjar ${u.x.toFixed(0)},${u.y.toFixed(0)}`);
  }
} finally {
  try { cdp?.close(); } catch {}
  chrome.kill();
  server.close();
  try { rmSync(profil, { recursive: true, force: true }); } catch {}
}

if (fel){
  console.error(`\n${fel} kontroll(er) föll.`);
  process.exit(1);
}
console.log('\nOK — varje overlay ryms med sin skugga i sitt fönster, vid varje skala.');
