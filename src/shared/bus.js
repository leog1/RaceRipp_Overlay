// ── Delad telemetribuss (klientsida) ────────────────────────────────────────
// Overlays prenumererar; de anropar aldrig spelet direkt. Motorn (Python-sidecar)
// publicerar JSON-ramar över denna WebSocket. Auto-reconnect om motorn startar om.
//
// Ramens fält (superset — varje overlay läser bara det den deklarerat):
//   connected  bool     ACC igång? (annars mock-data)
//   throttle brake clutch  0..1
//   abs tc     bool
//   gear       int
//   speedKph   number
//   rpm        int
//   steer      -1..1     normaliserad rattvinkel
//   delta      number|null   sekunder mot referensen (negativ = snabbare)
//   deltaSource 'motec'|'acc'|null   VILKEN referens delta kommer från:
//              'motec' = den laddade .ld-filen, 'acc' = ACC:s eget mått mot
//              session-bästa, null = inget delta att visa. MoTeC används bara när
//              banan matchar och det inte är ett ut-varv (CLAUDE.md §8.8b).
//   sessionBestMs int|null
//   lastLapMs  int|null
//   curLapMs   int|null   pågående varvtid (motorn använder den till deltat)
//   refTotalMs int|null   referensvarvets totaltid, bara satt när MoTeC gäller
//   driverName string
//   position   0..1      normalizedCarPosition
//   trackId    string    ACC:s bannamn ("Spa") — referensen matchas mot det
//   outLap     bool      varvet startade i depån → referensdelta är meningslöst
//   inPitLane  bool
//   completedLaps int
//   refThrottle refBrake  0..1|null   referensvarvets pedaler VID NUVARANDE POSITION
//              — spökspåren i inputs-trace. Satta bara när deltaSource === 'motec'.
//              Motorn skickar dem per ram just för att overlayn inte ska behöva
//              hålla reda på position: spara dem i samma sampel som dina egna värden
//              så ligger spöket i linje med det aktiva spåret, trots att trace-axeln
//              är TID och referensen är indexerad på POSITION.
//
// Broadcasting (ACC:s UDP-API, andra bilar). Alla null när det är av:
//   cars       array|null   per bil {i, spline, pos, laps, loc, kmh, deltaMs, bestMs …}
//   entries    obj|null     carIndex → {num, name, team, cls}. SE NEDAN.
//   sessionPhase focusedCarIndex trackName trackMeters
//   broadcast  'connecting'|'live'|'error'|null   broadcastError string|null
//
// VIKTIGT om `entries`: den är statisk och skickas bara när den ÄNDRATS, plus var
// 5:e sekund (så en OBS-flik som öppnas mitt i loppet också får den). `null` betyder
// alltså OFÖRÄNDRAD, inte BORTA — latcha senaste värdet, precis som HOLD_MS-mönstret
// i §8.5. `cars` skickas varje ram.

export const WS_URL = 'ws://127.0.0.1:8777';

export class WsBus {
  constructor(url = WS_URL) {
    this.url = url;
    this._subs = new Set();
    this._last = null;
    this.connected = false;
    this._connect();
  }
  /** subscribe(fn) → unsubscribe(). Sista ramen skickas direkt om den finns. */
  subscribe(fn) {
    this._subs.add(fn);
    if (this._last) fn(this._last);
    return () => this._subs.delete(fn);
  }
  _emit(f) {
    this._last = f;
    _lastConnected = !!(f && f.connected);
    if (_lastConnected) _everConnected = true;
    _applyGate();
    // Isolera prenumeranter: en som kastar får inte sluka framen för de andra.
    for (const fn of this._subs) { try { fn(f); } catch (e) { console.error('[bus]', e); } }
  }
  _connect() {
    let ws;
    try { ws = new WebSocket(this.url); }
    catch { return void setTimeout(() => this._connect(), 1000); }
    ws.onopen    = () => { this.connected = true; };
    ws.onmessage = (e) => { try { this._emit(JSON.parse(e.data)); } catch {} };
    ws.onerror   = () => { try { ws.close(); } catch {} };
    ws.onclose   = () => {
      this.connected = false;
      // Grinden utvärderas annars bara när en ram kommer in — dör motorn helt slutar
      // ramarna, och då hade nedräkningen aldrig gått klart och overlayn blivit
      // hängande synlig på sin sista bild.
      _lastConnected = false;
      _applyGate();
      setTimeout(_applyGate, GATE_HOLD_MS + 50);
      setTimeout(() => this._connect(), 1000);
    };
  }
}

// ── Synk-grind: dölj overlayn tills motorn är ansluten (global inställning) ──
// Styrs av kontrollpanelens "Endast när ACC kör". Utan Tauri (OBS/webbläsare)
// är grinden av → overlayn syns alltid.
let _hideUntilConnected = false;
let _lastConnected = false;
let _everConnected = false;             // har ACC varit ansluten NÅGON gång?
let _gateHidden = null;                 // senast skrivna läge (null = aldrig skrivet)
/* Ligger ett HELT ANNAT program överst? Skalet mäter det (lib.rs:foreground_is_foreign)
   och skickar bara vid ändring. Falskt tills vi vet bättre — kan skalet inte avgöra
   vilken process som har förgrunden ska overlayn ALDRIG döljas, för ett falskt
   positivt gör den osynlig mitt i en kurva. */
let _foreignFocus = false;

/** Skalet rapporterar att förgrundsfönstret bytt ägare. Exporterad för testerna. */
export function setForeignFocus(v) {
  const next = v === true;
  if (next === _foreignFocus) return;
  _foreignFocus = next;
  _applyGate();
}

// ── Startvärden från skalet ───────────────────────────────────────────────────
// lib.rs injicerar {id, scale, opacity, gate, hz, options} med initialization_script,
// INNAN sidan parsas. Det gör att skala/opacitet, grinden, takten och alternativen
// gäller redan vid första paint. Hämtades de bara med get_config/get_globals (async) ritade overlayn
// med CSS-defaulten tills svaret kom — såg avkapat ut när sparad skala var något
// annat — och blev anropet av med (t.ex. innan staten var registrerad) satt den kvar
// i fel skala tills man rörde skalreglaget.
// Saknas INIT (OBS, webbläsare, panelens preview) gäller CSS-defaulten, vilket är
// rätt där: då finns ingen sparad config att vara osynkad med.
export const INIT = (() => {
  try { return globalThis.__OVERLAY_INIT__ || null; } catch { return null; }
})();

// Körs vi i kontrollpanelens förhandsvisning? Där ska grinden inte slå till —
// annars blir previewn blank när ACC inte kör och ser trasig ut.
const IN_PREVIEW = (() => { try { return window.self !== window.top; } catch { return true; } })();

// ── Renderloop ───────────────────────────────────────────────────────────────
/** Startar en overlays renderloop med Hz-tak. Returnerar en stop()-funktion.
 *
 *  Loopen ägs HÄR och inte i varje overlay, för mönstret nedan är litet men lätt
 *  att få subtilt fel — två av flicker-buggarna i CLAUDE.md §8.5 satt i exakt de
 *  här raderna, i två kopior:
 *
 *  • Fast deadline, inte "nu minus förra renderingen". Det senare sköt en render
 *    ett helt refresh-intervall framåt vid minsta jitter, vilket syntes som ryck.
 *    Därför `nextT = Math.max(now, nextT + FRAME_MS)`.
 *  • `dt` skickas till tick så utjämning kan vara TIDSBASERAD (1-exp(-dt/tau)).
 *    En per-frame-lerp går 2,4× snabbare på 144 Hz än på 60 Hz.
 *  • `dtCap` klipper dt när fliken/fönstret varit pausat, annars hoppar allt
 *    utjämnat till målvärdet i ett enda skutt vid återkomsten.
 *
 *  Utan tak ritades canvasen om vid varje vsync (144 Hz på en gamingskärm) på ett
 *  transparent always-on-top-fönster — det var en del av FPS-tappet (§3).
 *
 *  ── Att BEGÄRA ett frame kostar även när man inte ritar ─────────────────────
 *  Hz-taket ovan hoppade bara ARBETET. rAF begärdes ändå vid varje vsync, och en
 *  begäran är inte gratis: GPU-processen skickar BeginFrame till renderaren, dess
 *  kompositortråd väcker huvudtråden, callbacken körs, ingen skada rapporteras.
 *  På 144 Hz blev det ~114 sådana rundor i sekunden PER overlay-fönster som gjorde
 *  exakt ingenting — och de håller dessutom hela framepipelinen aktiv i stället för
 *  att låta den gå ner i vila mellan ritningarna.
 *
 *  Därför sover loopen bort merparten av väntan i en TIMER och kopplar in rAF först
 *  de sista `WAKE_MARGIN_MS` före deadline. Marginalen finns för att Windows
 *  timerupplösning kan vara 15,6 ms: vaknar timern sent ska det fortfarande finnas
 *  gott om tid kvar till deadline, så att den sista biten görs av rAF och renderingen
 *  hamnar på rätt vsync. Utan marginal hade takten blivit ojämn i stället för billig,
 *  och en ojämn takt är precis vad §8.5 handlar om.
 *
 *  Är overlayn dold (grinden) finns ingen deadline att passa alls — då sover loopen
 *  i långa svep i stället för att ticka rAF 144 ggr/s bakom ett dolt fönster.
 *
 *  @param {(dt:number, now:number)=>void} tick  dt i sekunder, now = rAF-tiden (ms)
 *  @param {{hz?:number, dtCap?:number}} [opts]  hz: explicit → INIT.hz → 30
 */
/* Hur nära deadline vi växlar från timer till rAF.
   12 ms är valt mot Windows timerkorn på 15,6 ms: vaknar timern ett helt korn för
   sent hamnar vi 3,6 ms EFTER deadline, och renderingen görs då av första vsyncen
   därefter — alltså högst en skärmframe senare än om vi väntat med rAF hela vägen.
   Större marginal är inte säkrare, den är bara dyrare: varje vsync inom marginalen
   är en tom rAF-runda till. */
const WAKE_MARGIN_MS = 12;
/* Sovtid när grinden döljer overlayn. Ingen ritar, och att komma tillbaka styrs av
   WebSocket-ramar och skal-event — inte av loopen. */
const GATED_SLEEP_MS = 250;
/* Loopar som sover och behöver väckas när grinden slutar dölja overlayn. Utan detta
   hade den långa sovtiden ovan kostat upp till 250 ms med en INAKTUELL bild när man
   tabbade in i ACC igen — fönstret visas direkt, men innehållet är det som ritades
   innan grinden slog till. §8.5b:s regel är att återkomsten sker omedelbart. */
const _wakers = new Set();

export function startLoop(tick, opts = {}) {
  const hz = opts.hz || (INIT && INIT.hz) || 30;
  const FRAME_MS = 1000 / hz;
  const dtCap = typeof opts.dtCap === 'number' ? opts.dtCap : 0.25;
  let lastT = performance.now(), nextT = lastT, live = true;
  let timer = 0, raf = 0;

  function arm() {
    timer = 0;
    if (live) raf = requestAnimationFrame(step);
  }
  function schedule(now) {
    if (!live) return;
    // Dold overlay: inget att passa, sov långt. Annars sov bort allt utom
    // marginalen och låt rAF ta den sista biten så renderingen landar på en vsync.
    const wait = (_gateHidden === true)
      ? GATED_SLEEP_MS
      : nextT - now - WAKE_MARGIN_MS;
    if (wait > 1) timer = setTimeout(arm, wait);
    else arm();
  }
  function step(now) {
    raf = 0;
    if (!live) return;
    // Rita inte alls när overlayn är dold. Fönstret är OS-dolt i det läget, så
    // arbetet syns ingenstans. lastT flyttas fram så dt inte hoppar vid återkomsten,
    // och deadlinen flyttas med så vi inte vaknar till en hög förfallna frames.
    if (_gateHidden === true) { lastT = now; nextT = now + FRAME_MS; return schedule(now); }
    if (now < nextT) return schedule(now);
    nextT = Math.max(now, nextT + FRAME_MS);
    const dt = Math.min(dtCap, (now - lastT) / 1000); lastT = now;
    tick(dt, now);
    schedule(performance.now());
  }
  // Grinden släppte: rita så fort som möjligt i stället för att sova klart.
  const waker = () => {
    if (!live || raf) return;
    if (timer) { clearTimeout(timer); timer = 0; }
    nextT = performance.now();
    arm();
  };
  _wakers.add(waker);

  schedule(performance.now());
  return () => {
    live = false;
    _wakers.delete(waker);
    if (timer) { clearTimeout(timer); timer = 0; }
    if (raf) { try { cancelAnimationFrame(raf); } catch {} raf = 0; }
  };
}

// Hur länge `connected:false` måste hålla i sig innan grinden döljer overlayn.
// Grinden slog till på ETT enda frame förut, och det räckte för att båda overlays
// skulle blinka synligt med några sekunders mellanrum under körning. Att visa igen
// sker däremot direkt — man ska aldrig behöva vänta på att overlayn kommer tillbaka.
const GATE_HOLD_MS = 1500;
let _disconnectedAt = 0;

/* Är overlayn dold just nu? Renderloopar frågar den för att kunna hoppa arbetet
   helt — se startLoop. */
export function isGated() { return _gateHidden === true; }

let _editMode = false;

/** Edit-läge på/av. Exporterad för testerna; skalet skickar det som event. */
export function setEditMode(v) {
  const next = v === true;
  if (next === _editMode) return;
  _editMode = next;
  try { document.body.classList.toggle('edit-mode', _editMode); } catch {}
  // Både fönstret och CSS-dölningen måste tillbaka — att bara visa fönstret gav en
  // tom ruta att sikta på när man skulle dra overlayn på plats.
  _applyGate();
}
/* Skalet skapar fönstret redan dolt när grinden är på (lib.rs), och talar om det
   här. Utan initieringen hade bus.js trott att den aldrig dolt fönstret och därför
   vägrat visa det när ACC ansluter — overlayn hade blivit permanent osynlig. */
let _osHidden = (INIT && INIT.osHidden === true) ? true : null;

/* Är overlayn PÅSLAGEN? Det är skalets beslut (ögonknappen i panelen), inte
   grindens — grinden lånar bara synligheten tillfälligt medan ACC är borta.
   Utan Tauri (OBS, webbläsare) finns ingen av/på-knapp; då är den alltid på. */
let _enabled = !(INIT && INIT.enabled === false);

/** Skalet talar om att overlayn slagits av eller på. Exporterad för testerna.
 *
 *  Kör ALLTID om beslutet, även när värdet är oförändrat. Skälet är att eventet inte
 *  bara betyder "värdet ändrades" utan "skalet har just rört fönstret": en
 *  layoutaktivering skickar `enabled` för varje overlay i registret, och med grinden
 *  PÅ måste den som redan var påslagen ändå döljas igen. Den tidigare snabbutgången
 *  (`if (next === _enabled) return`) gjorde att fönstret blev kvar synligt över
 *  skrivbordet med spelet stängt — och inte gick att få bort, eftersom nästa
 *  layoutklick skickade samma oförändrade värde. */
export function setEnabled(v) {
  _enabled = v !== false;
  // Skalet har precis visat eller dolt fönstret själv, så vår bokföring över vad
  // GRINDEN har gjort är inte längre giltig. Nollställ den innan vi räknar om.
  _osHidden = null;
  // force: bokföringen är nollställd, alltså finns inget "vi dolde det" att luta sig
  // mot — men beslutet är ändå vårt att skriva ut (se _applyOsVisibility).
  if (_enabled) _applyOsVisibility(_gateHidden === true, true);
}

/* Dölj även OS-FÖNSTRET, inte bara innehållet.
   Mätt: med bara `visibility:hidden` låg WebView2 på 37 % av en kärna med båda
   overlays DOLDA — renderarna gick vidare och GPU-processen komponerade fortfarande
   två always-on-top-fönster. Att stänga fönstret tar bort båda kostnaderna, och
   eftersom overlayn ändå är osynlig i det läget syns ingen skillnad.
   CSS-dölningen ligger kvar som första försvar: den verkar direkt, medan
   fönsteranropet är async. */
function _applyOsVisibility(hidden, force = false) {
  /* En AVSTÄNGD overlay ägs HELT av skalet — grinden får varken dölja eller visa den.
     Utan detta återställde grinden fönstret vid varje återanslutning: att tabba ut ur
     ACC stallar det delade minnet (connected:false → grinden döljer), och när man
     tabbade in igen visade grinden fönstret på nytt — även om användaren just hade
     stängt av overlayn. Symptomet var att ögonknappen "inte fungerade".
     §8.5b:s regel "visa bara fönster grinden själv har dolt" räckte inte: grinden HADE
     dolt det, den visste bara inte att skalet höll det stängt av ett annat skäl. */
  if (!_enabled) { _osHidden = null; return; }
  // Edit-läget hanteras i _applyGate (både fönster och CSS); här är `hidden` redan
  // det slutgiltiga beslutet.
  const want = hidden;
  if (!force && want === _osHidden) return;
  // Visa BARA fönster vi själva har dolt. Utan det anropades show() på första
  // anslutna ramen, och en AVSTÄNGD overlay (som Rust skapar dold) hade då dykt upp
  // på skärmen. Overlayns synlighet är skalets beslut; grinden får bara låna den
  // tillfälligt.
  // `force` är undantaget och kommer BARA från setEnabled, alltså från skalet självt:
  // då är overlayn påslagen (kontrollerat ovan) och grinden är det enda som kan vilja
  // hålla den dold — så beslutet här ÄR det slutgiltiga. Med grinden på ropar skalet
  // aldrig show() själv (lib.rs:apply_visibility), och utan den här vägen hade en
  // påslagen overlay då aldrig kommit fram när ACC ansluter.
  if (!want && _osHidden !== true && !force) { _osHidden = want; return; }
  _osHidden = want;
  try {
    const T = globalThis.__TAURI__;
    if (!T || !T.window || IN_PREVIEW) return;
    const w = T.window.getCurrentWindow();
    // Svälj INTE felet. Första versionen hade .catch(() => {}) och då misslyckades
    // anropet tyst eftersom core:window:allow-hide saknades i capabilities —
    // overlayn såg ut att fungera men fönstret doldes aldrig, och CPU:n låg kvar.
    // Samma fälla som §8.3. Logga en gång, fall tillbaka på CSS-dölningen.
    (want ? w.hide() : w.show()).catch((e) => {
      if (!_osHideWarned) {
        _osHideWarned = true;
        console.warn('[bus] kunde inte dölja overlay-fönstret (saknad behörighet?):', e,
                     '— faller tillbaka på visibility:hidden, men CPU:n frigörs inte.');
      }
    });
  } catch {}
}
let _osHideWarned = false;

function _applyGate() {
  let hidden = false;
  if (!IN_PREVIEW && _hideUntilConnected) {
    if (!_lastConnected) {
      const now = Date.now();
      if (!_disconnectedAt) _disconnectedAt = now;
      // Fördröjningen finns för att en enstaka tappad ram MITT UNDER KÖRNING inte ska
      // släcka overlayn. Den ska inte gälla vid start: har vi aldrig varit anslutna
      // ska overlayn vara dold direkt. Annars syns den i ~1,5 s vid varje appstart,
      // vilket var precis vad som rapporterades.
      hidden = !_everConnected || (now - _disconnectedAt) >= GATE_HOLD_MS;
    } else {
      _disconnectedAt = 0;
    }
    /* Ett ANNAT program i förgrunden döljer direkt, utan hysteres: fördröjningen ovan
       finns för tappade ramar, och att tabba ur ACC är ingen tappad ram.
       Skälet till att detta behövs alls: ACC fortsätter skriva sitt delade minne när
       fönstret inte har fokus, så `connected` förblir true och grinden hade ingen
       anledning att dölja något — overlays låg kvar överst på skrivbordet. */
    if (_foreignFocus) hidden = true;
  } else {
    _disconnectedAt = 0;
  }
  // I edit-läge måste overlayn synas, annars går den inte att dra på plats. Det gäller
  // även CSS-dölningen: att bara visa FÖNSTRET gav en tom ruta att sikta på.
  if (_editMode) hidden = false;
  if (hidden === _gateHidden) return;   // skriv bara vid ändring (_emit körs 40 ggr/s)
  _gateHidden = hidden;
  document.documentElement.style.visibility = hidden ? 'hidden' : '';
  _applyOsVisibility(hidden);
  // Loopen sover långt medan overlayn är dold — väck den så bilden är färsk i samma
  // ögonblick som fönstret kommer tillbaka, inte upp till en sovperiod senare.
  if (!hidden) { for (const w of _wakers) { try { w(); } catch {} } }
}

// Grinden sätts direkt vid modulladdning, inte först när get_globals svarar.
if (INIT && typeof INIT.gate === 'boolean') {
  _hideUntilConnected = INIT.gate;
  _applyGate();
}

// ── Fontgrind ────────────────────────────────────────────────────────────────
/** Väntar in webbfonten innan overlayn visas (undviker synligt fontbyte), men
 *  ALDRIG längre än timeout: fonten hämtas över nätet och en spelrigg kan vara
 *  offline — då får overlayn inte bli hängande osynlig. */
export function fontsReady(timeoutMs = 1500) {
  const ready = (document.fonts && document.fonts.ready) || Promise.resolve();
  return Promise.race([ready, new Promise(r => setTimeout(r, timeoutMs))]);
}

// ── Skal-integration: lyssna på kontrollpanelens config + edit-läge ──────────
// applyConfig får {scale, opacity}. applyOption (valfri) får (id, value) per
// alternativ som overlayn deklarerat i registry.json. Fungerar även utan Tauri
// (t.ex. i OBS eller vanlig webbläsare) — då händer bara inget.
/* Färgalternativ heter `col-<token>` och sätter motsvarande CSS-variabel direkt.
   Generiskt med FLIT: en ny färg är en rad i registry.json och noll kod i overlayn,
   precis som resten av optionsschemat. Overlayn får värdet vidare också, för den
   som behöver reagera (inputs-trace läser om sina canvas-färger). */
function applyOne(applyOption, opt, val) {
  if (typeof opt === 'string' && opt.startsWith('col-') && typeof val === 'string' && val) {
    try { document.documentElement.style.setProperty('--' + opt.slice(4), val); } catch {}
  }
  if (applyOption) applyOption(opt, val);
}

/* Skalan är FÖNSTRETS egenskap och hör inte hemma i kontrollpanelens förhandsvisning:
   där ritas overlayn i naturlig storlek och krymps sedan av panelen för att passa
   rutan (§8.4c). Släpp därför aldrig igenom `scale` till en overlay som kör i previewn.

   Det är inte kosmetik utan en riktig bugg som var rapporterad: `get_config`
   NÅR fram in i iframen, medan `emit` inte gör det. På WebView2 injiceras
   init-skript i ALLA frames (wry: "scripts are always added to subframes"), så
   `__TAURI__` finns i previewn och `invoke` fungerar därifrån — men `emit` går via
   `webview.eval`, som bara kör i huvudframen. Följden blev precis det som
   rapporterades: att dra skalreglaget syntes inte i previewn (inget event kom fram),
   men NÄSTA gång iframen laddades om — dvs. när man bytte overlay och tillbaka —
   hämtade den den sparade skalan med get_config och previewn hoppade i storlek. */
function applyConfigFor(applyConfig, cfg) {
  if (!cfg) return;
  if (IN_PREVIEW && cfg.scale !== undefined) {
    const { scale, ...rest } = cfg;
    applyConfig(rest);
  } else {
    if (typeof cfg.scale === 'number') setScaleVar(cfg.scale);
    applyConfig(cfg);
  }
}

/* --ui-scale sätts HÄR och inte bara i den overlay som råkar använda den. Skälet är
   marginalen mellan innehållet och fönsterkanten: den ligger i registrets
   padLeft/padTop, och den måste skala med overlayn för att fönstret ska sitta lika
   tajt vid varje skala (annars klipps slagskuggan vid stora skalor och innehållet
   flyter in i onödig död yta vid små). Overlayn multiplicerar med var(--ui-scale) i
   CSS, alltså behöver variabeln finnas oavsett hur overlayn i övrigt skalar sitt
   innehåll — inputs-trace räknar t.ex. allt annat ur --H. */
function setScaleVar(scale) {
  try { document.documentElement.style.setProperty('--ui-scale', String(scale)); } catch {}
}

export function wireShell(applyConfig, applyOption) {
  // Injicerad skala/opacitet/alternativ appliceras FÖRST och synkront, före allt
  // async — annars hinner overlayn ritas i CSS-defaultens skala och ser avkapad ut.
  // Alternativen hör hit av samma skäl: ett alternativ som påverkar layout (dold
  // kolumn, antal rader) hade annars ritat ett frame i fel utseende.
  // Ligger utanför Tauri-kontrollen nedan så det gäller även om event-API:t saknas.
  if (INIT) {
    // Marginalen mot fönsterkanten först: den är GEOMETRI och måste gälla vid
    // första paint, precis som skalan (§8.3). Kommer den efteråt ritas ett frame
    // med CSS-fallbacken och overlayn hoppar några pixlar i sidled vid start.
    if (INIT.pad) {
      const p = INIT.pad;
      try {
        const root = document.documentElement.style;
        if (typeof p.l === 'number') root.setProperty('--pad-l', p.l + 'px');
        if (typeof p.t === 'number') root.setProperty('--pad-t', p.t + 'px');
      } catch {}
    }
    applyConfigFor(applyConfig, { scale: INIT.scale, opacity: INIT.opacity });
    if (INIT.options) {
      for (const [k, v] of Object.entries(INIT.options)) applyOne(applyOption, k, v);
    }
  }

  const T = globalThis.__TAURI__;

  // Denna overlays id (så vi kan filtrera config som gäller andra overlays).
  // INIT.id vinner, sedan ?id=: i kontrollpanelens förhandsvisning körs overlayn i
  // en iframe inuti "control"-fönstret, och då är fönstrets label fel.
  let label = (INIT && INIT.id) || null;
  try { if (!label) label = new URLSearchParams(location.search).get('id'); } catch {}
  if (!label && T) { try { label = T.window.getCurrentWindow().label; } catch {} }

  /* ANDRA kanalen: postMessage från kontrollpanelen.
     Tauri-eventen nedan når inte panelens förhandsvisning — den kör i en <iframe>,
     och `emit` går via `webview.eval`, som bara kör i HUVUDframen. (Däremot fungerar
     `invoke` därifrån: init-skript injiceras i alla frames på WebView2, så
     `__TAURI__` finns. Den asymmetrin är precis varför previewn kunde plocka upp en
     sparad skala den aldrig fick något event om — se applyConfigFor.)
     Följden var att previewn aldrig reagerade på att man slog av/på ett alternativ;
     man fick se skillnaden först i spelet. Den här lyssnaren ligger FÖRE
     Tauri-kontrollen just därför, och panelen postar ändringen direkt till iframen.
     Den syns dessutom omedelbart, utan att vänta in rundturen via Rust. */
  addEventListener('message', (ev) => {
    const p = ev.data;
    if (!p || p.__simmatrix !== true) return;
    if (p.id && label && p.id !== label) return;
    if (p.kind === 'option') applyOne(applyOption, p.option, p.value);
    else if (p.kind === 'config') applyConfigFor(applyConfig, p);
  });

  if (!T || !T.event) return;

  // Global grind: visa overlays först när ACC är ansluten ("Endast när ACC kör").
  try {
    T.core.invoke('get_globals').then(g => {
      _hideUntilConnected = !!(g && g.hide_until_connected);
      _applyGate();
    }).catch(() => {});
  } catch {}
  T.event.listen('globals', (e) => {
    const p = e.payload || {};
    _hideUntilConnected = !!p.hide_until_connected;
    _applyGate();
  });

  // Hämta sparad skala/opacitet/alternativ direkt vid start (undviker fel look först).
  try {
    if (label) T.core.invoke('get_config', { id: label }).then(cfg => {
      applyConfigFor(applyConfig, cfg || {});
      if (cfg && cfg.options) {
        for (const [k, v] of Object.entries(cfg.options)) applyOne(applyOption, k, v);
      }
    }).catch(() => {});
  } catch {}

  T.event.listen('config', (e) => {
    const p = e.payload || {};
    if (p.id && label && p.id !== label) return;   // ignorera annan overlays config
    applyConfigFor(applyConfig, p);
  });
  T.event.listen('option', (e) => {
    const p = e.payload || {};
    if (p.id && label && p.id !== label) return;   // ignorera annan overlays alternativ
    applyOne(applyOption, p.option, p.value);
  });
  // Av/på från panelens ögonknapp. Skalet visar/döljer fönstret själv; detta är bara
  // så grinden VET om det och slutar återställa en avstängd overlay (§8.5c).
  T.event.listen('enabled', (e) => {
    const p = e.payload || {};
    if (p.id && label && p.id !== label) return;
    setEnabled(p.enabled !== false);
  });
  // Vilket program ligger överst? ACC skriver sitt delade minne även utan fokus, så
  // `connected` säger ingenting om att man tabbat ut (§8.5c).
  T.event.listen('foreground', (e) => setForeignFocus((e.payload || {}).foreign === true));

  T.event.listen('edit-mode', (e) => setEditMode(e.payload === true));
  // I edit-läge: dra overlayn för att positionera (flyttar OS-fönstret).
  // Aldrig i previewn — där hade det dragit kontrollpanelens fönster.
  addEventListener('mousedown', (ev) => {
    if (IN_PREVIEW) return;
    if (!document.body.classList.contains('edit-mode')) return;
    if (ev.button !== 0) return;
    try { T.window.getCurrentWindow().startDragging(); } catch {}
  });
}
