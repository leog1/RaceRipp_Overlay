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
//   delta      number|null   sekunder mot referens (null = ingen referens)
//   sessionBestMs int|null
//   lastLapMs  int|null
//   driverName string
//   position   0..1      normalizedCarPosition
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
    ws.onclose   = () => { this.connected = false; setTimeout(() => this._connect(), 1000); };
  }
}

// ── Synk-grind: dölj overlayn tills motorn är ansluten (global inställning) ──
// Styrs av kontrollpanelens "Endast när ACC kör". Utan Tauri (OBS/webbläsare)
// är grinden av → overlayn syns alltid.
let _hideUntilConnected = false;
let _lastConnected = false;
let _gateHidden = null;                 // senast skrivna läge (null = aldrig skrivet)

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
 *  @param {(dt:number, now:number)=>void} tick  dt i sekunder, now = rAF-tiden (ms)
 *  @param {{hz?:number, dtCap?:number}} [opts]  hz: explicit → INIT.hz → 30
 */
export function startLoop(tick, opts = {}) {
  const hz = opts.hz || (INIT && INIT.hz) || 30;
  const FRAME_MS = 1000 / hz;
  const dtCap = typeof opts.dtCap === 'number' ? opts.dtCap : 0.25;
  let lastT = performance.now(), nextT = lastT, live = true;
  function step(now) {
    if (!live) return;
    requestAnimationFrame(step);
    if (now < nextT) return;
    nextT = Math.max(now, nextT + FRAME_MS);
    const dt = Math.min(dtCap, (now - lastT) / 1000); lastT = now;
    tick(dt, now);
  }
  requestAnimationFrame(step);
  return () => { live = false; };
}

function _applyGate() {
  const hidden = !IN_PREVIEW && _hideUntilConnected && !_lastConnected;
  if (hidden === _gateHidden) return;   // skriv bara vid ändring (_emit körs 40 ggr/s)
  _gateHidden = hidden;
  document.documentElement.style.visibility = hidden ? 'hidden' : '';
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
export function wireShell(applyConfig, applyOption) {
  // Injicerad skala/opacitet/alternativ appliceras FÖRST och synkront, före allt
  // async — annars hinner overlayn ritas i CSS-defaultens skala och ser avkapad ut.
  // Alternativen hör hit av samma skäl: ett alternativ som påverkar layout (dold
  // kolumn, antal rader) hade annars ritat ett frame i fel utseende.
  // Ligger utanför Tauri-kontrollen nedan så det gäller även om event-API:t saknas.
  if (INIT) {
    applyConfig({ scale: INIT.scale, opacity: INIT.opacity });
    if (applyOption && INIT.options) {
      for (const [k, v] of Object.entries(INIT.options)) applyOption(k, v);
    }
  }

  const T = globalThis.__TAURI__;
  if (!T || !T.event) return;

  // Denna overlays id (så vi kan filtrera config som gäller andra overlays).
  // INIT.id vinner, sedan ?id=: i kontrollpanelens förhandsvisning körs overlayn i
  // en iframe inuti "control"-fönstret, och då är fönstrets label fel.
  let label = (INIT && INIT.id) || null;
  try { if (!label) label = new URLSearchParams(location.search).get('id'); } catch {}
  if (!label) { try { label = T.window.getCurrentWindow().label; } catch {} }

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
      applyConfig(cfg || {});
      if (applyOption && cfg && cfg.options) {
        for (const [k, v] of Object.entries(cfg.options)) applyOption(k, v);
      }
    }).catch(() => {});
  } catch {}

  T.event.listen('config', (e) => {
    const p = e.payload || {};
    if (p.id && label && p.id !== label) return;   // ignorera annan overlays config
    applyConfig(p);
  });
  T.event.listen('option', (e) => {
    const p = e.payload || {};
    if (p.id && label && p.id !== label) return;   // ignorera annan overlays alternativ
    if (applyOption) applyOption(p.option, p.value);
  });
  T.event.listen('edit-mode', (e) => {
    document.body.classList.toggle('edit-mode', e.payload === true);
  });
  // I edit-läge: dra overlayn för att positionera (flyttar OS-fönstret).
  // Aldrig i previewn — där hade det dragit kontrollpanelens fönster.
  addEventListener('mousedown', (ev) => {
    if (IN_PREVIEW) return;
    if (!document.body.classList.contains('edit-mode')) return;
    if (ev.button !== 0) return;
    try { T.window.getCurrentWindow().startDragging(); } catch {}
  });
}
