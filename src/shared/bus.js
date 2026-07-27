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

// Körs vi i kontrollpanelens förhandsvisning? Där ska grinden inte slå till —
// annars blir previewn blank när ACC inte kör och ser trasig ut.
const IN_PREVIEW = (() => { try { return window.self !== window.top; } catch { return true; } })();

function _applyGate() {
  const hidden = !IN_PREVIEW && _hideUntilConnected && !_lastConnected;
  if (hidden === _gateHidden) return;   // skriv bara vid ändring (_emit körs 40 ggr/s)
  _gateHidden = hidden;
  document.documentElement.style.visibility = hidden ? 'hidden' : '';
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
  const T = globalThis.__TAURI__;
  if (!T || !T.event) return;

  // Denna overlays id (så vi kan filtrera config som gäller andra overlays).
  // ?id= vinner över fönstrets label: i kontrollpanelens förhandsvisning körs
  // overlayn i en iframe inuti "control"-fönstret, och då är labeln fel.
  let label = null;
  try { label = new URLSearchParams(location.search).get('id'); } catch {}
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
