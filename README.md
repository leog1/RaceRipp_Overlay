# ACC Overlay

Modulärt overlay-paket för Assetto Corsa Competizione. **Funktionellt** som Race
Element (lätt, rensat, ingen FPS-förlust); **visuellt** som RaceLab (mörkt, polerat).

Frikopplad arkitektur: en **Python-motor** läser telemetri och publicerar JSON-ramar
över en **lokal WebSocket**; **overlays renderas som webb** (HTML/CSS/SVG/Canvas) och
*prenumererar* på bussen. Ett **Tauri-skal** (Rust) skapar de små transparenta
klick-igenom-fönstren ur ett registry och kör en kontrollpanel. Samma overlays kan
återanvändas som **browser source i OBS**.

```
┌ Tauri-skal (Rust) ─────────────────────────────┐
│  kontrollpanel   ·  fönstermanager (registry)   │
│  hotkey race/edit ·  startar motorn (sidecar)   │
└──────────────┬─────────────────────────────────┘
               │ skapar/positionerar
   ┌───────────▼───────────┐        ┌ Python-motor ─────────────┐
   │ overlay-fönster (webb) │◄──WS───┤ ACC (delat minne) / mock  │
   │ delta-bar, inputs-trace│  8777  │ MoTeC .ld → delta          │
   └────────────────────────┘        │ HTTP 8078 (OBS browser src)│
                                      └───────────────────────────┘
```

## Struktur
```
src/
  shared/tokens.css     ← ENDA designtoken-källan (alla overlays importerar)
  shared/bus.js         ← WebSocket-bussklient + skal-integration
  overlays/registry.json← katalog: ny overlay = ny rad här
  overlays/delta-bar/…  ← overlay-moduler (prenumererar på bussen)
  overlays/inputs-trace/…
  control-panel/…       ← kontrollpanelens UI
engine/                 ← Python-motorn (telemetri + delta + WS + OBS-HTTP)
src-tauri/              ← Rust-skalet (fönster, kommandon, sidecar, updater)
```

## Köra i utveckling
Kräver Rust, Node/pnpm, MSVC C++ build tools, WebView2, Python 3.11+.

**1) Motorn** (egen terminal — i dev startas den inte automatiskt):
```
cd engine
pip install -r requirements.txt
pip install git+https://github.com/gotzl/ldparser   # för MoTeC-delta
python -m acc_engine --root ../src
```
Utan ACC igång sänder motorn **mock-data** (så allt rör sig). Startar du ACC växlar
den automatiskt till riktig telemetri.

**2) Appen**:
```
pnpm install
pnpm tauri dev
```
Kontrollpanelen öppnas; overlays läggs ut enligt registret. **Ctrl+Alt+Space**
växlar race ⇄ edit — i edit-läge drar du varje overlay på plats (sparas när panelen
stängs). Opacitet/skala styrs per overlay i panelen.

## OBS
Motorns HTTP-server serverar overlays direkt. Lägg en **Browser Source** mot t.ex.
`http://127.0.0.1:8078/overlays/inputs-trace/index.html` (bredd/höjd enligt overlayn).
Samma WS-data driver både appen och OBS.

## MoTeC-referens (delta)
Klicka **Ladda MoTeC .ld** i panelen. Motorn resamplar referensvarvet till ett jämnt
distansrutnät (distans→tid) och beräknar `delta = din_varvtid − t_ref(din_position)`,
alltid jämfört i distans. `.ldx`-varvmarkörer hanteras ej — anta en `.ld` = ett varv.

## Bygga & paketera (Windows)
```
cd engine && python build_sidecar.py     # PyInstaller → src-tauri/binaries/acc-engine-<triple>.exe
```
Lägg sedan tillbaka sidecar-raden i `src-tauri/tauri.conf.json` under `bundle` (den är
borttagen så dev kör utan att motorn byggts):
```
"externalBin": ["binaries/acc-engine"],
```
Bygg sedan:
```
pnpm tauri build                          # installer i src-tauri/target/release/bundle/
```

## Auto-update via GitHub
1. Publikt repo. Byt `OWNER/REPO` i `src-tauri/tauri.conf.json` → `plugins.updater.endpoints`.
2. `pnpm tauri signer generate` → klistra **public key** i `plugins.updater.pubkey`;
   lägg **private key** + lösenord som repo-secrets `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)`.
3. `git tag v0.2.0 && git push origin v0.2.0` → GitHub Actions bygger installer +
   `latest.json`. Appens **Sök uppdatering** hittar och installerar nya versioner.

OS-kodsignering (SmartScreen) är medvetet uppskjuten — updater-signaturen räcker för
integritet; utan Authenticode klickar man "kör ändå" första gången.

## Lägga till en ny overlay (utan att röra kärnan)
1. Skapa `src/overlays/<id>/index.html` som importerar `../../shared/tokens.css` och
   prenumererar på `WsBus` från `../../shared/bus.js`; deklarera vilka kanaler den läser.
2. Lägg en rad i `src/overlays/registry.json` (id, url, storlek, standardläge).
3. Klart — skalet skapar fönstret, panelen listar den, looken ärvs via tokens.

## Licens
MIT (se `LICENSE`). Vi använder **inte** Race Elements (GPL-3.0) kod — endast idéer
om arkitektur. ACC läses via det publika Kunos-delade-minnet (`pyaccsharedmemory`).
