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
Python-motor       →  läser ACC (delat minne = din bil, Broadcasting-UDP = de andra)
                      el. mock, räknar delta, sänder JSON-ramar
WebSocket (8777)   →  motorn publicerar; overlays PRENUMERERAR (anropar aldrig spelet)
HTTP (8078)        →  motorn serverar overlay-filerna som OBS browser source
Overlays (webb)    →  HTML/CSS/SVG/Canvas; en modul per overlay
```
**Kärnkrav:** ny overlay = ny modul + en rad i `registry.json`, **utan att röra kärnan**.
Overlays är "dumma renderare": DATA från WebSocket, CONFIG (skala/opacitet) från Rust-events.

Det gäller även overlayns EGNA inställningar: `options` i registret är ett deklarativt
schema (`type`: `bool` | `int` | `float` | `enum` | `color`, plus `min`/`max`/`step`/
`values`/`unit`), och kontrollpanelen bygger reglaget/väljaren generiskt ur det. Panelen
känner inte till en enda overlay vid namn. `type` får utelämnas och betyder då `bool`.
Rust validerar värdet mot schemat innan det sparas eller skickas (§8.3b).
`hz` i registret sätter overlayns rendertakt (§8.5).

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
  Arkitekturjämförelsen mot Race Element som motiverade §8.5:s delade renderloop,
  det typade optionsschemat och Broadcasting-källan (§8.6d) ligger i
  `.race-element-notes/findings.md` — **lokalt och gitignorerat**, eftersom det är
  research om GPL-kod. Finns den inte i din klon är det väntat; den behövs inte för
  att bygga, bara för att förstå varför de tre sakerna ser ut som de gör.
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
| 4 | Inputs-trace (gas/broms + staplar) | KLAR, kopplad på bussen | ABS=gult trace, TC=blått; Canvas rullande; tidsfönster 2–10 s valbart |
| 5 | Laptime log | **ej byggd** | röd rail, rubriker i amber, delta grön/röd |

**Nästa naturliga bygge:** en overlay i taget, helt klar (funktion+look+animation) innan nästa.
Mät referensbilder pixel-exakt FÖRST; bekräfta struktur i EN avstämning innan kod.

## 6. Filkarta
```
src/shared/tokens.css      designtokens (enda källan)
src/shared/bus.js          WsBus (prenumerera på WS) + wireShell (config/edit/drag)
                           + fontsReady + startLoop (delad renderloop, §8.5)
src/overlays/registry.json KATALOG över overlays (kärnan läser denna)
src/overlays/<id>/index.html  overlay-moduler
src/control-panel/index.html  kontrollpanelen (inkl. live-preview i iframe)
engine/acc_engine/         motorn: __main__, bus, http_static, frame, delta,
                           sources/{mock,acc,acc_broadcast}
engine/broadcast_test.py   Broadcasting mot riktiga ACC (kör med spelet igång)
engine/build_sidecar.py    PyInstaller → src-tauri/binaries/acc-engine-<triple>.exe
engine/ldparser.py         GPL, gitignorerad, hämtas lokalt
src-tauri/src/lib.rs       fönstermanager, kommandon, sidecar+Job Object, hotkey, settings
src-tauri/tauri.conf.json  control-fönster, updater, externalBin, bundle.resources
.github/workflows/release.yml  CI: bygg Windows-installer + latest.json vid tagg
```

## 7. Status: verifierat vs kvar  (uppdaterad 2026-07-27, v0.3.0)
**Verifierat genom att faktiskt köra:**
- **BÅDA ACC-källorna mot spelet igång** (2026-07-27, under hotlap). `acc_test.py`
  och `broadcast_test.py` kördes av användaren: Broadcasting ansluter på ett par
  sekunder och listar det som förväntas, delade minnet likaså. Det stänger den punkt
  som stått öppen sedan projektet startade.
  **Nivån på verifieringen:** bekräftat i drift av en människa som såg rimliga värden
  — inte en maskinell fält-för-fält-jämförelse mot kända sanningar. Dyker det upp ett
  enskilt fält som beter sig konstigt (särskilt i Broadcasting, §8.6d) är det alltså
  fortfarande där man ska titta först.
- Motorn: 39 Hz, alla ramfält, inga NaN; WS + OBS-HTTP serverar; två samtidiga
  instanser avslutar snyggt med tydligt portmeddelande i stället för traceback.
  Broadcasting-fälten finns men är `None` med `--broadcast off`.
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

- **Utgåva 0.3.0 verifierad ur den PUBLICERADE MSI:n** (inte bara grön CI, §8.6c).
  Alla 12 CI-steg gröna inklusive de nya testsstegen; release har MSI + NSIS + båda
  `.sig` + `latest.json` med signatur för alla tre plattformsnycklar. MSI:n uppackad
  med 7-Zip: `verify_sidecar.py` hittar alla sex modulerna i den 21,2 MB stora
  CI-sidecarn (mindre än lokalbygget är normalt, §8.6c). Binären körd: MoTeC-referensen
  laddas (`varvtid≈136.250s → OK`), WS ger 25 fält utan NaN, telemetrin rör sig,
  Broadcasting registrerar, och OBS-HTTP:n svarar 200 på alla fem overlay-filerna.
  Obs: `refTotalMs` är `None` i den körningen — den sätts först när ACC är ansluten,
  så det är själva INLÄSNINGEN av referensen som är verifierad här, inte delta-vägen.

- **Updater-kedjan hela vägen** (v0.2.5): tagg → CI → `latest.json` på
  `releases/latest/download/` med signatur för alla tre plattformsnycklar →
  nedladdningsbara artefakter. Den PUBLICERADE sidecarn är dessutom uppackad ur MSI:n
  och körd: MoTeC-referensen laddas (`varvtid≈136.250s → OK`), WS ger 17 fält, OBS-HTTP
  svarar 200, och loggen syns medan processen lever.
  **Verifiera alltid den publicerade artefakten, inte bara att CI blev grön** — 0.2.4
  var grön och trasig (§8.6c). Packa upp MSI:n med 7-Zip och kör
  `python engine/verify_sidecar.py <exe>`.
  Obs: starta den frysta exen via `Start-Process`, inte med `&` + omdirigering i Git
  Bash — det senare gav tyst ingen output och såg ut som att binären var trasig.

**Kvar att verifiera:**
- **Broadcasting under RIKTIGT lopp** — hittills bara sett med hotlap, alltså med i
  praktiken en bil. Entry list-flödet, omfrågan vid okänd bil och bortstädningen av
  bilar som lämnat sessionen (§8.6d) är testade mot en falsk server men aldrig mot ett
  fullt startfält. Kör `python engine/broadcast_test.py` i en multiplayer-session
  eller ett race mot AI.
- **Installation från MSI/NSIS** — installerarna byggs och binärerna är körda ur dem,
  men själva installationen (Program Files-layout, `resource_dir` där) är inte gjord.
- **DPI-fixen** (§8.2) — användarens skärm kör 100 % skalning, där logiska och
  fysiska pixlar är identiska, så buggen kan inte reproduceras lokalt. Kräver en
  skärm på 125/150 %.
- **"Sök uppdatering"-knappen i appen** — endpointen, signaturerna och artefakterna är
  verifierade (se ovan), men själva knappen i panelen är aldrig klickad, så
  nedladdning + installation genom `T.updater` är otestad.

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

Fixen: `lib.rs` injicerar
`window.__OVERLAY_INIT__ = {id, scale, opacity, gate, hz, options}` med
`initialization_script`, som körs innan dokumentet parsas. `bus.js` läser det
**synkront** och applicerar direkt; `get_config`/`get_globals` är sedan bara
bekräftelse. Lägg till nya startvärden HÄR, inte som ett nytt async-anrop.
`options` hör hit av exakt samma skäl: ett alternativ som påverkar LAYOUT (dold
kolumn, antal rader, tidsfönster) ritar annars ett frame i fel utseende.
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

Det skyddet gäller bara filer som inte går att PARSA. Ett giltigt JSON-dokument med
orimliga VÄRDEN (`"window": "hej"`, ett tal utanför min/max, en option som tagits bort
ur registret) slapp igenom och hamnade i overlayn. Nu kör `load_settings` alla options
genom `sanitize_option` mot registrets schema: fel typ och okända enum-värden faller
tillbaka på standardvärdet, tal klampas till min/max, okända nycklar städas bort.
`set_option` gör samma sak, så inte heller IPC:n kan skicka in skräp.
Rättade inläsningen något skrivs filen tillbaka städad — annars säger panelen och
disken olika saker och felet återuppstår varje start.

Overlays måste ändå tåla skräpvärden själva: i OBS och i en webbläsare finns ingen
Rust-validering framför dem.

**Bakåtkompatibilitet går åt BÅDA håll — och den ena riktningen missades.** Att ny kod
läser gamla filer verifierades (en `bool` är ett giltigt `Value`). Att **gammal kod inte
kan läsa nya filer** gjordes det inte: 0.2.5:s `HashMap<String, bool>` kvävs på
`"window": 4.5`, och då slår §8.3b:s skydd till precis som det ska — filen döps om till
`settings.corrupt.json` och allt går till standardvärden. Layout, skalor OCH
`reference_ld` försvinner alltså tyst om man kör en äldre build efter 0.3.0.

Det hände på riktigt under utvecklingen av 0.3.0. Räddningen är att inget är förlorat:
`settings.corrupt.json` ÄR den gamla filen, med referenssökväg och positioner intakta.
Lägg därför aldrig till ett fält i settings som en äldre version inte kan
deserialisera utan att tänka igenom nedgraderingsvägen — och kolla efter en
`settings.corrupt.json` innan du tror att någon tappat sina inställningar.

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

De två sista bodde i en kopia per overlay. De ligger nu i **`bus.js:startLoop(tick,
{hz, dtCap})`** — skriv ALDRIG en egen rAF-loop i en ny overlay, anropa den. Takten
kommer ur `hz` i `registry.json` via `__OVERLAY_INIT__` (§8.3), så en sällan-ändrad
widget kan köra 5 Hz utan att röra kärnan. `tick(dt, now)` får `dt` i sekunder;
använd det till all utjämning. `tests/overlay-loop.mjs` bevakar loopen och jämför
mot det trasiga mönstret för att bevisa att mätningen biter.

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

### 8.6e "Ingen ny data" är INTE "ACC är borta" — mock-inblandningen
Rapporterat från riktig körning i 0.3.0: overlays **blinkade** var tredje–fjärde
sekund, och inputs-trace fick **små hack** i graferna. Två symptom som såg helt olika
ut, en enda orsak.

`accSharedMemory.read_shared_memory()` returnerar `None` så fort fysikpaketets id inte
hunnit ändras sedan förra läsningen (den jämför `packed_id` och hela structen). Vi
pollar 40 Hz och ACC skriver i sin egen takt, så det händer regelbundet. `acc.py`
tolkade `None` som `Frame(connected=False)`, och då föll `__main__` tillbaka på
**MOCK-källan för just det framet**:
- mock-telemetri hamnade mitt i den riktiga → hacken i traces,
- `connected:false` → synk-grinden dolde båda overlays ett ögonblick → blinket.

`AccSource` håller nu senaste giltiga ram i `STALE_S` (2 s) i stället. Först därefter
rapporteras frånkoppling. **Motorn får aldrig blanda mock och riktig telemetri i samma
ström** — en overlay har ingen chans att se skillnad.

Grinden i `bus.js` fick samtidigt hysteres (`GATE_HOLD_MS`, 1,5 s): den döljer först
när `connected:false` hållit i sig, men visar igen omedelbart. En enstaka tappad ram
ska aldrig kunna släcka en overlay mitt i en kurva. `tests/overlay-gate.mjs` mäter det.
Notera att den första versionen av det testet såg bara på SLUTtillståndet och
passerade därför mot den buggiga koden — blinket syns bara om man räknar antalet
gånger overlayn dolts.

### 8.6d Broadcasting-UDP: fällor i den andra datakällan
`sources/acc_broadcast.py` läser ACC:s officiella Broadcasting Network (andra bilars
spline-position, entry list med förarnamn, sessionfas, bandata). Delat minne ger bara
DIN bil. Fyra saker som inte är självklara:

- **ACC:s config-JSON:er är UTF-16 LE UTAN BOM.** `utf-8-sig` kastar alltså inte — den
  ger en sträng full av nullbytes, vilket ser ut som en trasig fil långt senare.
  `read_config()` provar kodningar tills en faktiskt **parsar som JSON**, i stället för
  att lita på att avkodningen gick igenom.
- **Ingen portkonflikt av §8.1-typ.** Vi binder inte 9000; vi skickar TILL den från en
  efemär port. Flera klienter (vi, Race Element, SimHub) kan vara registrerade samtidigt.
- **Entry list kommer bara på begäran**, och ACC slänger den vid sessionsbyte. En
  `REALTIME_CAR_UPDATE` för okänd bil måste därför utlösa en omfrågan — men
  **rate-limitad till 1/s**, annars stormar det när hela startfältet är okänt.
  Bilar måste dessutom städas ur BÅDE `_cars` och `_entries`: en bil vi sett en
  positionsuppdatering för men aldrig fått en entry till finns bara i `_cars` och blev
  annars kvar för evigt (och drev en omfrågan varje sekund). Testet fångade det.
- **`entries` skickas inte varje ram.** Den är statisk: skickas vid ändring plus var
  5:e sekund, så en OBS-flik som öppnas mitt i loppet också får förarnamnen. `null`
  betyder alltså **oförändrad**, inte **borta** — latcha den, som HOLD_MS i §8.5.

Byte-layouten är skriven mot Kunos publika dokumentation. Den är körd mot riktiga ACC
(hotlap, 2026-07-27) och anslöt och gav rimliga värden — men bara med en bil på banan.
`tests/broadcast_protocol.py` (falsk UDP-server) testar parsern mot vår förståelse;
`engine/broadcast_test.py` med spelet igång testar förståelsen mot verkligheten. Kör
den i ett riktigt race innan du litar på entry list-flödet. Se §7.

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

### 8.8b MoTeC-referensen får inte användas bara för att den är laddad
Också rapporterat från 0.3.0: delta-overlayn visade ett referensdelta **direkt vid
utfart ur depån**, före första varvet, och mot en fil som inte hörde till banan som
kördes. Orsaken var en rad: `if ref.loaded:` skrev ALLTID över ACC:s eget delta.

Två villkor till krävs, och båda kommer ur riktiga fel:
- **Rätt bana.** `.ld`-huvudet har `venue` ("Spa"); jämför med ACC:s `Static.track`.
  Utan det ger en Spa-referens ett fullt rimligt utseende delta på Monza — position
  0..1 matchar ju alltid något. Jämförelsen är medvetet **slapp** (gemener, bara
  alfanumeriskt, delsträng åt båda håll) och **släpper igenom när något namn saknas**:
  ett falskt negativt hade tyst stängt av en referens som fungerar, vilket är värre.
- **Inte ut-varv.** Ett varv som börjat i depån kan inte jämföras med ett flygande
  varv. Regeln är "har depån berörts under det varv som körs NU" — vid mållinjen
  avgör om man är i depåfilen just då, eftersom depåutfarten på de flesta banor ligger
  EFTER linjen.

Faller något villkor behålls **ACC:s eget delta mot session-bästa**, vilket är precis
vad man vill se när ingen fil är vald. `deltaSource` i ramen säger vilken som gäller
(`"motec"` / `"acc"` / `null`). Skälet till att en referens inte används loggas en
gång per skäl — annars är det osynligt varför siffran plötsligt byter innebörd.

Ett undantag att inte råka bryta: när en giltig referens ger `None` (spikskyddet vid
mållinjen, §8.8) ska **inget** delta visas, inte ACC:s. Att växla mellan två olika
referenser mellan ramar får siffran att hoppa.

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
Det finns tester i `tests/` — läs `tests/README.md`. `pnpm test` kör de tre
overlay-testerna, `python tests/engine_smoke.py` och `python tests/motec_reference.py`
de andra.
- **Overlay-logik headless:** `tests/lib/overlay-harness.mjs` plockar ut overlayns
  modulskript, stubbar importerna, fejkar DOM:en och låter dig driva tiden frame för
  frame. Det är enda sättet att mäta något som varar ett enda frame.
  Två regler: kör alltid ett nytt test även mot revisionen FÖRE fixen
  (`node tests/overlay-delta-bar.mjs <rev>`) — passerar det där mäter det inte det du
  tror. Och kontrollera att overlayn faktiskt renderade innan du bedömer vad den
  renderade (`assertAlive`), annars passerar testet på en död overlay. Båda de
  misstagen gjordes när testerna skrevs.
  Bevakar du en REFAKTORERING går regel ett inte att tillämpa — koden har just
  flyttat. Bevisa tänderna på annat sätt: kör mot revisionen efter fixen men före
  flytten (ska passera identiskt) och mot en medvetet trasig variant inne i testet
  (`naivLoop` i `overlay-loop.mjs`).
  Harnessen fejkar bara det overlays faktiskt använder, och en för slapp stubb ÄR ett
  tyst testfel: `getComputedStyle` gav samma färg för alla tokens, så en kontroll av
  att ABS färgar bromstracet gult passerade även på en overlay som ritade allt i en
  färg. Ge stubbar värden som går att skilja åt.
- **Ett test som hoppar över sig själv skyddar ingenting i CI.**
  `motec_reference.py` kräver en `.ld` och hoppar därför alltid över sig själv på en
  runner. Under arbetet med 0.3.1 bröts `Reference.delta()` helt (en hjälpfunktion
  hamnade mitt i klassen och gjorde metoden till död kod) och **alla andra tester
  passerade ändå** — `delta_source.py` använde en fejkreferens som skuggade metoden.
  Har du ett test som kan hoppa över sig själv, se till att kärnlogiken också täcks av
  ett test utan filberoende (syntetisk referens i `delta_source.py`).
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
