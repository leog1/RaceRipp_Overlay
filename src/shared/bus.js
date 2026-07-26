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
  _emit(f) { this._last = f; for (const fn of this._subs) fn(f); }
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

// ── Skal-integration: lyssna på kontrollpanelens config + edit-läge ──────────
// Overlayn skickar in en callback som får {scale, opacity}. Fungerar även utan
// Tauri (t.ex. i OBS eller vanlig webbläsare) — då händer bara inget.
export function wireShell(applyConfig) {
  const T = globalThis.__TAURI__;
  if (!T || !T.event) return;

  // Denna overlays fönster-id (så vi kan filtrera config som gäller andra overlays).
  let label = null;
  try { label = T.window.getCurrentWindow().label; } catch {}

  // Hämta sparad skala/opacitet direkt vid start (undviker att den ser fel ut först).
  try { T.core.invoke('get_config', { id: label }).then(cfg => applyConfig(cfg || {})).catch(() => {}); } catch {}

  T.event.listen('config', (e) => {
    const p = e.payload || {};
    if (p.id && label && p.id !== label) return;   // ignorera annan overlays config
    applyConfig(p);
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
