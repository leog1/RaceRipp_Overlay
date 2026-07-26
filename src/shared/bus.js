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
    for (const fn of this._subs) fn(f);
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
function _applyGate() {
  const hidden = _hideUntilConnected && !_lastConnected;
  document.documentElement.style.visibility = hidden ? 'hidden' : '';
}

// ── Skal-integration: lyssna på kontrollpanelens config + edit-läge ──────────
// applyConfig får {scale, opacity}. applyOption (valfri) får (id, value) per
// alternativ som overlayn deklarerat i registry.json. Fungerar även utan Tauri
// (t.ex. i OBS eller vanlig webbläsare) — då händer bara inget.
export function wireShell(applyConfig, applyOption) {
  const T = globalThis.__TAURI__;
  if (!T || !T.event) return;

  // Denna overlays fönster-id (så vi kan filtrera config som gäller andra overlays).
  let label = null;
  try { label = T.window.getCurrentWindow().label; } catch {}

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
    T.core.invoke('get_config', { id: label }).then(cfg => {
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
  addEventListener('mousedown', (ev) => {
    if (!document.body.classList.contains('edit-mode')) return;
    if (ev.button !== 0) return;
    try { T.window.getCurrentWindow().startDragging(); } catch {}
  });
}
