# ACC Overlay — projektkontext (handoff)

> **Till en ny AI-assistent:** Läs denna fil + `README.md` + `src/shared/tokens.css`
> så har du hela bilden. Detta är ett pågående bygge; nedan står vad som är gjort,
> vad som är kvar, och vilka beslut som redan är fattade (ändra dem inte utan skäl).
>
> **§8 är den viktigaste sektionen.** Där står fällor som redan har kostat tid att
> upptäcka. Läs den innan du rör sidecarn, fönsterpositioner eller en overlays
> renderloop — flera av dem syns INTE i `cargo check` eller i en webbläsare.
>
> Denna fil är enda sanningskällan för projektkontexten. `CONTEXT.md` pekar hit.

## 1. Vad projektet är
Modulärt overlay-paket för **Assetto Corsa Competizione (ACC)**.
- **Funktionellt** som **Race Element**: lätt, rensat, praktiskt, ingen FPS-förlust.
- **Visuellt** som **RaceLab**: mörkt, polerat, animerat, premium.
- Kvalitetsribban är hög och användaren är detaljpetig ner till pixelnivå.
  Leverera aldrig platshållar-fulhet. Oklart designmässigt → **fråga, gissa inte**.
- Användaren kör svenska. Kod och kommentarer i repot är på svenska.

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

Faktisk processkedja i drift (mätt) — se §8.1, den är inte självklar:
```
acc-overlay.exe → acc-engine.exe (PyInstaller-bootloader) → acc-engine.exe (motorn, äger portarna)
```

## 3. Teknikval & beslut (redan fattade)
- **Skal:** Tauri 2 (WebView2) — låg RAM/GPU, pålitlig transparent + klick-igenom + always-on-top. Inte Electron.
- **Motor:** Python, `pyaccsharedmemory` (ACC delat minne, publik Kunos-SDK), `websockets`, `numpy`.
- **Referensvarv (delta):** MoTeC `.ld` via `gotzl/ldparser` (**en enda fil**, ej pip-paket, **GPL-3.0**).
  `.ldx`-varvmarkörer **hanteras** — `delta.py:_fastest_lap()` läser dem och väljer
  snabbaste hela varvet ur filen (ACC sparar hela sessioner, så utan detta jämförs
  man mot fel data). Saknas `.ldx` behandlas hela filen som ett varv.
- **Licens:** **MIT**. Vi använder **inte** Race Elements (GPL) kod — bara idéer.
  `ldparser.py` committas **inte** (GPL) — hämtas lokalt, står i `.gitignore`.
- **Repo:** publikt (`leog1/RaceRipp_Overlay`). OS-kodsignering (SmartScreen) uppskjuten;
  updater-signatur räcker.
- **Settings:** enkel JSON i app-config-mappen (ej LiteDB).
  Ligger i `%APPDATA%\com.accoverlay.app\settings.json`.
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
src/shared/bus.js          WsBus (prenumerera på WS) + wireShell (config/edit/drag) + fontsReady
src/overlays/registry.json KATALOG över overlays (kärnan läser denna)
src/overlays/<id>/index.html  overlay-moduler
src/control-panel/index.html  kontrollpanelen (inkl. live-preview i iframe)
engine/acc_engine/         motorn: __main__, bus, http_static, frame, delta, sources/{mock,acc}
engine/build_sidecar.py    PyInstaller → src-tauri/binaries/acc-engine-<triple>.exe
engine/ldparser.py         GPL, gitignorerad, hämtas lokalt
src-tauri/src/lib.rs       fönstermanager, kommandon, sidecar+Job Object, hotkey, settings
src-tauri/tauri.conf.json  control-fönster, updater, externalBin, bundle.resources
.github/workflows/release.yml  CI: bygg Windows-installer + latest.json vid tagg
```

## 7. Status: verifierat vs kvar  (uppdaterad 2026-07-27)
**Verifierat genom att faktiskt köra:**
- Motorn: 39 Hz, alla 17 ramfält, inga NaN; WS + OBS-HTTP serverar; två samtidiga
  instanser avslutar snyggt med tydligt portmeddelande i stället för traceback.
- `pnpm tauri dev`: kontrollpanel + båda overlay-fönstren skapas ur registret,
  sidecarn startar automatiskt, panelens preview renderar overlayn korrekt.
- **Sidecarn dödas** vid stängd panel OCH vid `taskkill /F` på appen (se §8.1).
- **MoTeC-deltan mot en riktig `.ld`** (Spa, Ferrari 296 GT3): `.ldx`-varvvalet ger
  136,250 s mot filnamnets 2:16.265 — 15 ms fel över ett helt varv (0,01 %).
  `ldData.fromfile` + kanalnamn fungerar.
- **`pnpm tauri build`**: MSI + NSIS-installer byggs. `bundle.resources` lägger de 6
  overlay-filerna i `web/` vid exen, `lib.rs` skickar `--root <resource_dir>/web` till
  sidecarn, och OBS-HTTP:n svarar 200 på `/overlays/delta-bar/index.html` m.fl. i
  release. Sidecarn städas upp även i release-bygget.
  Enda felet är sista steget: updater-signering kräver `TAURI_SIGNING_PRIVATE_KEY`,
  som bara finns som GitHub-secret — förväntat lokalt, CI sätter den.

**Kvar att verifiera:**
- **Riktig ACC-telemetri** — kräver att ACC körs ute på banan. Fältmappningen i
  `sources/acc.py` är skriven mot pyaccsharedmemory-doc men aldrig sedd i drift.
  `engine/acc_test.py` finns för just detta: kör den med ACC igång.
- **DPI-fixen** (§8.2) — användarens skärm kör 100 % skalning, där logiska och
  fysiska pixlar är identiska, så buggen kan inte reproduceras lokalt. Kräver en
  skärm på 125/150 %.
- **Updater end-to-end** — pubkey finns i configen, men flödet tagg → `latest.json`
  → "Sök uppdatering" är aldrig körd hela vägen. Kräver en riktig tagg + CI-körning.
- **Installation från MSI/NSIS** — installerarna byggs och release-exen fungerar från
  `target/release`, men själva installationen (Program Files-layout, resource_dir där)
  är inte körd.

## 8. Fällor som redan kostat tid — LÄS DENNA
### 8.1 Sidecarn: `child.kill()` räcker INTE på Windows
PyInstaller `--onefile` kör en bootloader som packar upp och startar den riktiga
motorn som ett **eget barn**. Tauris `CommandChild::kill()` gör `TerminateProcess`
på bara den direkta barnprocessen, och Windows dödar inte efterkommande. Resultat:
bootloadern dog, **motorn låg kvar och höll port 8777/8078** — och nästa appstart
fick en sidecar som inte kunde binda och dog tyst.

Lösningen i `lib.rs:confine_engine()` är ett **Job Object** med
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Handtaget läcks medvetet: OS:et stänger det
när appen dör *hur som helst*, vilket dödar hela trädet även vid krasch/taskkill.
Jobbet måste tilldelas **direkt efter spawn** — barn ärver jobbet vid skapandet, så
en sen tilldelning missar bootloaderns barn.

**Detta syns inte i `cargo check`.** Verifiera alltid så här:
```powershell
Get-CimInstance Win32_Process -Filter "Name='acc-engine.exe' OR Name='acc-overlay.exe'" |
  Select ProcessId, ParentProcessId, Name          # ska visa 3 processer i kedja
# stäng panelen, vänta 3 s, kör igen → ska vara tomt
netstat -ano | Select-String ':8777|:8078'          # ska vara tomt
```

### 8.2 Tauri: logiska vs fysiska pixlar
`WebviewWindowBuilder::position(x,y)` och `set_position(LogicalPosition)` tar
**logiska** pixlar. `outer_position()` returnerar **fysiska**. Att spara det ena och
återställa det andra får fönstren att vandra med skalfaktorn vid varje omstart på
allt utom 100 % skalning. `save_positions()` konverterar med
`to_logical(scale_factor())`. Verifierat i tauri 2.11.5-källan, inte gissat.

### 8.3 Startvärden får inte hämtas async — de måste finnas vid första paint
Detta gav två rapporterade buggar i 0.2.3 som såg helt olika ut men hade samma orsak.

Overlay-webviewarna anropade `get_config` och `get_globals` så fort de laddade. Två
problem med det:
1. `app.manage()` kördes EFTER fönsterskapandet, så anropen kunde landa innan
   `Mutex<Settings>` fanns. Kommandot svarade med fel, `bus.js` svalde det
   (`.catch`) — och då kom svaret **aldrig**.
2. Även när anropet lyckas är det async, så det finns alltid ett fönster där
   overlayn ritar med CSS-defaulten.

Symptomen: overlayn ritas i CSS-defaultens skala i ett fönster som skapats för den
**sparade** skalan → ser **avkapat** ut (och "löser sig" när man rör skalreglaget,
för det skickar ett `config`-event som faktiskt kommer fram). Och grinden "endast när
ACC kör" gäller aldrig → overlayn visas fast den ska vara dold.

Notera hur olika det kan se ut: delta-baren har `--ui-scale:0.9` hårdkodat i CSS, så
den råkade se rätt ut vid sparad skala 0,9 men avkapad vid allt annat. inputs-trace
har `--H:150px` (= skala 1.0), så vid sparad skala 0,6 ritades 558×150 px innehåll i
ett 360×120 px fönster — det som klipptes bort var nederkanten med traces och
pedalstaplar, alltså **såg den ut att inte finnas alls**.

Fixen: `lib.rs` injicerar `window.__OVERLAY_INIT__ = {id, scale, opacity, gate}` med
`initialization_script`, som körs innan dokumentet parsas. `bus.js` läser det
**synkront** och applicerar direkt; `get_config`/`get_globals` är sedan bara
bekräftelse. Lägg till nya startvärden HÄR, inte som ett nytt async-anrop.
Saknas INIT (OBS, webbläsare, panelens preview) gäller CSS-defaulten, vilket är rätt
där — då finns ingen sparad config att vara osynkad med.

### 8.3b Trasig settings.json fick tyst radera layouten
`load_settings` gjorde `unwrap_or_else(default_settings)` på parse-fel, och nästa
sparning skrev över filen med standardvärden. Ett avbrutet skrivpass eller en manuell
redigering med fel decimaltecken räckte för att alla positioner och skalor skulle
försvinna utan ett ord. Nu döps den trasiga filen om till `settings.corrupt.json`
och felet loggas.

(Upptäckt genom att `ConvertTo-Json` i PowerShell 5.1 skrev `0,6` med svensk locale
när settings redigerades i ett test. **Redigera aldrig JSON med PowerShell här** —
använd Python, som alltid skriver punkt.)

### 8.4 `emit` och inte `emit_to` för config/option
Kontrollpanelens preview kör overlayn i en **iframe inuti "control"-fönstret**, så
`emit_to("delta-bar", …)` når den aldrig. Därför skickas `config`/`option` till alla
fönster och filtreras på payloadens `id` i `bus.js`. Previewen får sitt id via
`?id=<overlay>` i iframe-URL:en, eftersom fönstrets label där är `control`.

### 8.5 Flicker-mönster att aldrig upprepa
Alla dessa fanns i delta-baren och gav synligt flimmer:
- **Tröskel som slår ut ett element helt.** `valueArc()` returnerade `''` när
  vinkeln var < 0,6°, vilket tömde bågens `d` i exakt ett frame vid varje
  nollpassage. Rita hellre alltid — en nollång båge med `stroke-linecap:butt`
  ritar ändå ingenting, men *poppar* inte.
- **Tecken/färg direkt ur ett utjämnat värde.** Ge det ett dödband (`DEADBAND`,
  ±0,02 s) och latcha föregående tecken, annars vänder grönt/rött fram och
  tillbaka kring noll.
- **Platshållare med annan bredd än värdet.** `–.––` var 1,20em mot värdets
  2,72em. Ge platshållaren explicit cell-spec (`SPEC` i delta-baren) så bredden
  är identisk.
- **Ingen latch på fält som kan saknas.** Motorn skickar enstaka `null`
  (mållinjeskyddet i `delta.py`, ACC:s sentinelvärden). Håll senaste giltiga värde
  i `HOLD_MS` (700 ms) innan du faller tillbaka på platshållaren.
- **DOM-skrivning varje ram utan ändringskontroll.** `_applyGate()` skrev
  `documentElement.style.visibility` 40 ggr/s.
- **Per-frame-lerp i stället för tidsbaserad.** `x += (mål-x)*0.28` går 2,4×
  snabbare på 144 Hz än 60 Hz. Använd `1-Math.exp(-dt/tau)`.
- **30 Hz-grind på "nu minus förra renderingen".** Minsta jitter sköt en render ett
  helt refresh-intervall. Använd fast deadline: `if(now<nextT)return;
  nextT=Math.max(now,nextT+FRAME_MS)`.

### 8.6 Motorn får aldrig dö tyst
ACC:s delade minne kan försvinna mitt i en session (alt-F4) och kasta. Utan
try/except runt källäsningen dog hela processen och varje overlay frös på sista
ramen — utan synligt fel, för sidecarns stderr syns inte i release.
Samma sak för `AccSource()`-konstruktorn och för portbindningar.

`bus.broadcast()` får inte awaita klienterna i tur och ordning: en trög klient
(minimerad OBS, strypt browserflik) stallade hela 40 Hz-loopen. Nu skickas parallellt
och en klient som ligger efter hoppar framen.

### 8.6b Sidecarns loggning nådde aldrig fram (stdout blockbuffras)
Som sidecar är stdout en **pipe**, inte en terminal, och då blockbuffrar Python. All
diagnostik i §8.6 var därför osynlig så länge motorn levde — den kom fram först när
processen dog. `main()` tvingar nu radbuffring med `reconfigure(line_buffering=True)`.
Lägg aldrig till loggning i motorn utan att kontrollera att den faktiskt syns i en
körande process, inte bara efter avslut.

### 8.6c CI byggde en trasig sidecar och rapporterade success
0.2.4 släpptes med en sidecar **utan ldparser**, alltså tyst avstängd MoTeC-delta.
Tre fel förstärkte varandra:
- `pip install git+https://github.com/gotzl/ldparser` **kan inte fungera** — repot har
  varken `setup.py` eller `pyproject.toml`, det är en enda fil. Hämta den råa filen
  till `engine/` i stället; PyInstaller hittar den via `--paths engine`.
- `shell: pwsh` stoppar **inte** på ett misslyckat native-kommando, och bara SISTA
  kommandots exitkod avgör om steget lyckades. pip-felet svaldes. Alla pwsh-steg
  sätter nu `$ErrorActionPreference = 'Stop'` och
  `$PSNativeCommandUseErrorActionPreference = $true`.
- PyInstaller **varnar bara** för ett `--hidden-import` som inte hittas. Bygget
  lyckas alltså med en modul mindre.

`engine/verify_sidecar.py` kontrollerar nu att arkivet innehåller acc_engine,
ldparser, pyaccsharedmemory, numpy och websockets. Den körs både av
`build_sidecar.py` och som eget CI-steg. **Lita aldrig på att ett grönt CI-bygge
betyder en fungerande sidecar** — verifiera innehållet.

En storleksskillnad är en ledtråd: CI:s sidecar är ~21 MB (ren miljö, bara
requirements.txt) mot ~58 MB lokalt (utvecklingsmiljön drar med tunga paket). Att den
är mindre är alltså normalt — men kontrollera vad som saknas, inte bara storleken.

Notera också: ldparser är **GPL-3.0** och bakas in i den distribuerade binären. Att
filen inte committas i det MIT-licensierade repot ändrar inte vad som gäller för
själva utgåvan. Det är ett medvetet val (se §3), men värt att veta om releaser börjar
spridas bredare.

### 8.7 ACC:s MoTeC-export har INGEN distanskanal
55 kanaler, noll med "dist" i namnet. `delta.py` integrerar därför **farten** till
distans — det är **normalvägen** för ACC-filer, inte ett undantag (felet blev 15 ms
över ett varv). Kanalmatchningen provar exakt namn före delsträng, för både `SPEED`
och `WHEEL_SPEED_LF` innehåller "speed".

### 8.8 Delta-spikskyddet är proportionellt mot varvlängden
Vid mållinjen kan position (wrappar till 0) och varvtid (nollställs) vara ur synk ett
frame → falsk spik med magnitud ≈ 0,99 × varvet. Tröskeln är **0,8 × varvtiden**, inte
en absolut sekundgräns: den skalar då själv mellan Spa (109 s) och Nordschleife
(388 s). **Klampa inte deltan och sätt ingen fast gräns** — på långa banor (24h
Nordschleife) är en äkta delta på tiotals sekunder både möjlig och intressant, och
användaren vill se hela den. Overlayns siffra får växa till 6–7 tecken då; det är
avsiktligt.

### 8.9 websockets-API:t
Installerat: **16.0**, där `websockets.serve` är den nya asyncio-implementationen.
`await websockets.serve(...)` ger ett `Server` med `close()`/`wait_closed()` — det
fungerar på både legacy (12–13) och nya (14–16), så `Bus.start()` är versionsneutral.
Handlern tar **ett** argument (`ws`), inte `(ws, path)`.

### 8.10 Öppna frågor / medvetna skulder
- **Fonten hämtas från Google Fonts** i alla tre HTML-filerna. `fontsReady()` gör att
  starten inte hänger utan nät, men en offline-rigg ritar i fallback-font och
  designen bryts. Rätt fix: vendorera Montserrat WOFF2 till `src/shared/fonts/`
  och lägga in `@font-face`. Kräver binärfilerna.
- `dist/` och `build/` (PyInstaller-output, ~140 MB) låg committade i historiken fram
  till 2026-07-27 och är nu avspårade + gitignorerade. Blobbarna finns kvar i äldre
  commits; en `git filter-repo` + force-push krävs för att verkligen ta bort dem.

## 9. Så verifierar du utan att gissa
Det finns tester i `tests/` — läs `tests/README.md`. `pnpm test` kör overlay-testet,
`python tests/engine_smoke.py` och `python tests/motec_reference.py` de andra.
- **Overlay-logik headless:** `tests/lib/overlay-harness.mjs` plockar ut overlayns
  modulskript, stubbar importerna, fejkar DOM:en och låter dig driva tiden frame för
  frame. Det är enda sättet att mäta något som varar ett enda frame.
  Två regler: kör alltid ett nytt test även mot revisionen FÖRE fixen
  (`node tests/overlay-delta-bar.mjs <rev>`) — passerar det där mäter det inte det du
  tror. Och kontrollera att overlayn faktiskt renderade innan du bedömer vad den
  renderade (`assertAlive`), annars passerar testet på en död overlay. Båda de
  misstagen gjordes när testerna skrevs.
- **Motorn:** starta som subprocess, anslut med `websockets.connect`, samla N ramar
  och kontrollera fält/takt/NaN. Starta en andra instans för att testa portkonflikt.
- **MoTeC:** `Reference().load(path)` mot en riktig `.ld` och skriv ut `lap_ms`,
  `t_at()` vid några distanser samt `delta()` för både äkta värden och
  mållinje-artefakten (`pos=0.999, cur_lap≈0`).
- **Rust-API:er:** läs källan i `~/.cargo/registry/src/*/tauri-2.11.5/` i stället för
  att lita på minnet. Logisk/fysisk-buggen (§8.2) hittades så.
- **Appen:** skärmdump med `System.Drawing.Graphics.CopyFromScreen`, och stäng
  kontrollpanelen med `WM_CLOSE` till rätt hwnd (appens `MainWindow` kan vara ett
  overlay-fönster, så enumerera fönster och matcha på titeln "Control").

## 10. Kör/bygg (kort)
```
# Motor (egen terminal):  cd engine && pip install -r requirements.txt && python -m acc_engine --root ../src
# App:                    pnpm install && pnpm tauri dev
# MoTeC:                  (i engine\) hämta ldparser.py från gotzl/ldparser (gitignorerad)
# Paketera (Windows):     cd engine && python build_sidecar.py  &&  cd .. && pnpm tauri build
```
`externalBin` **ligger kvar** i `tauri.conf.json`, så `pnpm tauri dev` kräver att
sidecarn är byggd en gång — och dev startar den automatiskt. Kör därför **inte**
motorn manuellt samtidigt: de krigar om port 8777 (den andra avslutar snyggt, men du
vet inte vilken som vann). Bygg om sidecarn efter varje ändring i `engine/`, annars
testar du gammal motorkod.

## 11. Så återupptar du i en ny chatt
1. Ge assistenten detta repo (CLAUDE.md läses automatiskt av Claude Code).
2. Säg vilken overlay/uppgift som står näst (t.ex. "bygg overlay 5, Laptime log").
3. Bifoga referensbild(er) rakt framifrån (transparent + mörk bakgrund; 2–3 tillstånd
   för element som ändrar färg/fyllning) — assistenten mäter pixel-exakt innan kod.
4. Håll principen: mät först, bekräfta struktur, en overlay i taget, ändra ej kärnan.
