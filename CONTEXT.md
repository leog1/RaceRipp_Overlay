# ACC Overlay — projektkontext (handoff)

> **Till en ny AI-assistent:** Läs denna fil + `README.md` + `src/shared/tokens.css`
> så har du hela bilden. Detta är ett pågående bygge; nedan står vad som är gjort,
> vad som är kvar, och vilka beslut som redan är fattade (ändra dem inte utan skäl).

## 1. Vad projektet är
Modulärt overlay-paket för **Assetto Corsa Competizione (ACC)**.
- **Funktionellt** som **Race Element**: lätt, rensat, praktiskt, ingen FPS-förlust.
- **Visuellt** som **RaceLab**: mörkt, polerat, animerat, premium.
- Kvalitetsribban är hög och användaren är detaljpetig ner till pixelnivå.
  Leverera aldrig platshållar-fulhet. Oklart designmässigt → **fråga, gissa inte**.

## 2. Arkitektur (frikopplad)
```
Tauri-skal (Rust)  →  skapar transparenta klick-igenom overlay-fönster ur registry,
                      kör kontrollpanel, startar motorn (sidecar), hotkey race/edit
Python-motor       →  läser ACC (delat minne) el. mock, räknar delta, sänder JSON-ramar
WebSocket (8777)   →  motorn publicerar; overlays PRENUMERERAR (anropar aldrig spelet)
HTTP (8078)        →  motorn serverar overlay-filerna som OBS browser source
Overlays (webb)    →  HTML/CSS/SVG/Canvas; en modul per overlay
```
**Kärnkrav:** ny overlay = ny modul + en rad i `registry.json`, **utan att röra kärnan**.
Overlays är "dumma renderare": DATA från WebSocket, CONFIG (skala/opacitet) från Rust-events.

## 3. Teknikval & beslut (redan fattade)
- **Skal:** Tauri 2 (WebView2) — låg RAM/GPU, pålitlig transparent + klick-igenom + always-on-top. Inte Electron.
- **Motor:** Python, `pyaccsharedmemory` (ACC delat minne, publik Kunos-SDK), `websockets`, `numpy`.
- **Referensvarv (delta):** MoTeC `.ld` via `gotzl/ldparser` (**en enda fil**, ej pip-paket, **GPL-3.0**).
  `.ldx`-varvmarkörer hanteras ej — anta en `.ld` = ett varv.
- **Licens:** **MIT**. Vi använder **inte** Race Elements (GPL) kod — bara idéer.
  `ldparser.py` committas **inte** (GPL) — hämtas lokalt, står i `.gitignore`.
- **Repo:** publikt. OS-kodsignering (SmartScreen) uppskjuten; updater-signatur räcker.
- **Settings:** enkel JSON i app-config-mappen (ej LiteDB).
- **FPS (LÖST):** overlay-fönstren är **små och tajt sizade** runt innehållet — INTE ett
  fullskärms transparent fönster (det tvingar DWM att komponera hela skärmen varje frame).
  Dessutom: inga backdrop-blur över spelet (`--glass:none`), DOM-skrivningar bara vid
  ändring, 30 Hz-tak, animera bara `transform`/`opacity`. Detta löste användarens FPS-tapp.

## 4. Designspråk & tokens (enda sanningskällan: `src/shared/tokens.css`)
Varje overlay importerar `tokens.css` och använder BARA variablerna. Nytt värde → lägg
till i tokens FÖRST. **Färg = betydelse, inte dekoration:**
- `--green #0DE622` snabbare/gas/vinner tid/negativ delta · `--red #FF3B3B` långsammare/broms/positiv delta
- `--amber #FBBF24` enda gulden: highlights, guldstreck, växelsiffra, tabellrubriker
- `--purple #C869FF` session/overall best · `--rail #D10404` brand-rail
- `--abs #ECC328` (broms-trace vid ABS) · `--tc #29A3FF` (gas-trace vid TC) · `--clutch #0000FF`
- Text: `--ink` primär, `--dim` etiketter, `--faint` saknat värde (grå streckad platshållare)
Typografi: **Montserrat**, SemiBold (600) primär; siffror alltid **tabular** (hoppar ej).
Animation: mjuk lerp mot målvärde; respektera `prefers-reduced-motion`.
Renderare per element: **SVG** (gauges/bågar/ikoner), **HTML/CSS** (paneler/text/staplar),
**Canvas** (täta traces/grafer, DPI-korrekt).

## 5. Overlay-katalog & status
| # | Overlay | Status | Not |
|---|---------|--------|-----|
| 1 | **Delta + varvtidsrad** | KLAR (look+funktion+animation), kopplad på bussen | cirkel: 0=topp, grön medurs=snabbare, full båge 180°=1.0 s |
| 2 | Delta-graf + minisektorer + hörnkarta | **ej byggd** | hörnkarta/kurvnummer/graf är **banberoende, ritas live** — hårdkoda ALDRIG kurvform |
| 3 | Inputs-HUD (växel/fart/ratt/pedaler) | delvis (inputs-trace KLAR & kopplad) | ratt-vinkel + växel/fart-modul återstår |
| 4 | Inputs-trace (gas/broms + staplar) | KLAR, kopplad på bussen | ABS=gult trace, TC=blått; Canvas rullande |
| 5 | Laptime log | **ej byggd** | röd rail, rubriker i amber, delta grön/röd |

**Nästa naturliga bygge:** en overlay i taget, helt klar (funktion+look+animation) innan nästa.
Mät referensbilder pixel-exakt FÖRST; bekräfta struktur i EN avstämning innan kod.

## 6. Filkarta
```
src/shared/tokens.css      designtokens (enda källan)
src/shared/bus.js          WsBus (prenumerera på WS) + wireShell (config/edit/drag)
src/overlays/registry.json KATALOG över overlays (kärnan läser denna)
src/overlays/<id>/index.html  overlay-moduler
src/control-panel/index.html  kontrollpanelen
engine/acc_engine/         motorn: __main__, bus, http_static, frame, delta, sources/{mock,acc}
src-tauri/src/lib.rs        fönstermanager, kommandon, sidecar, hotkey, settings
src-tauri/tauri.conf.json   control-fönster + updater + externalBin (sidecar)
.github/workflows/release.yml  CI: bygg Windows-installer + latest.json vid tagg
```

## 7. Status: verifierat vs kvar
**Verifierat på användarens Windows:** motorn kör, WS sänder, OBS-HTTP serverar,
båda overlays animeras i webbläsaren mot mock-data. (Datavägen är grön.)
**Kvar att verifiera:** `pnpm tauri dev` (multi-fönster/sidecar/hotkey/drag), riktig
ACC-telemetri (fältmappning i `sources/acc.py`), MoTeC-delta mot en riktig `.ld`
(`delta.py` — ldparser-API/kanalnamn), samt updater end-to-end.

## 8. Kända troliga justeringar (första riktiga bygget)
- Tauri-2 **capability** för egna kommandon om panelen ej kan anropa `get_overlays` m.fl.
- **sidecar/externalBin:** `externalBin` är borttagen ur config så DEV kör direkt.
  Lägg tillbaka den + bygg sidecar (`build_sidecar.py`) endast vid paketering; namnet måste vara `acc-engine-<target-triple>.exe`.
- **updater-pubkey** tom tills `pnpm tauri signer generate` körts.
- `sources/acc.py`: `pyaccsharedmemory`-fältnamn kan skilja mellan versioner (samlade på ett ställe).
- `delta.py`: verifiera `ldData.fromfile` + kanalnamn (distans/speed) mot en riktig `.ld`.

## 9. Så återupptar du i en ny chatt
1. Ge assistenten detta repo (eller åtminstone `CONTEXT.md` + `README.md` + `tokens.css`).
2. Säg vilken overlay/uppgift som står näst (t.ex. "bygg overlay 5, Laptime log").
3. Bifoga referensbild(er) rakt framifrån (transparent + mörk bakgrund; 2–3 tillstånd
   för element som ändrar färg/fyllning) — assistenten mäter pixel-exakt innan kod.
4. Håll principen: mät först, bekräfta struktur, en overlay i taget, ändra ej kärnan.

## 10. Kör/bygg (kort)
```
# Motor (egen terminal):  cd engine && pip install -r requirements.txt && python -m acc_engine --root ../src
# App:                    pnpm install && pnpm tauri dev
# MoTeC senare:           (i engine\)  hämta ldparser.py  →  lägg i .gitignore
# Paketera (Windows):     cd engine && python build_sidecar.py  &&  cd .. && pnpm tauri build
```
