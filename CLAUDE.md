# SimMatrix — projektkontext (handoff)

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
- **Namn:** appen heter **SimMatrix** sedan 0.3.4 (hette "ACC Overlay"). Bytet är
  medvetet bara kosmetiskt — `identifier` och MSI:ns `upgradeCode` är orörda, se §8.8c
  innan du rör något namnrelaterat.
- **Repo:** publikt och heter fortfarande `leog1/RaceRipp_Overlay`. Medvetet: updater-
  endpointen i redan installerade 0.3.x pekar dit, och ett repo-namnbyte hade gjort dem
  beroende av GitHubs omdirigering för all framtid. OS-kodsignering (SmartScreen)
  uppskjuten; updater-signatur räcker.
- **Settings:** enkel JSON i app-config-mappen (ej LiteDB).
  Ligger i `%APPDATA%\com.accoverlay.app\settings.json`.
- **FPS (LÖST):** overlay-fönstren är **små och tajt sizade** runt innehållet — INTE ett
  fullskärms transparent fönster (det tvingar DWM att komponera hela skärmen varje frame).
  Dessutom: inga backdrop-blur över spelet (`--glass:none`), DOM-skrivningar bara vid
  ändring, 30 Hz-tak, animera bara `transform`/`opacity`. Detta löste användarens FPS-tapp.
  Sedan 0.3.6 stängs dessutom fönstret helt när grinden döljer overlayn (§8.5b) —
  ett dolt innehåll räcker inte, fönstret komponeras ändå.
- **Om någon föreslår "gör om allt till canvas för prestanda":** delta-baren ska
  förbli SVG/DOM. Den skriver bara vid ÄNDRING och kostar noll när inget rör sig,
  medan en canvas hade rensat och ritat om 30 ggr/s oavsett. Canvas ersätter
  målningsarbetet, det försvinner inte till GPU:n. Canvas är rätt för TÄTA traces
  (inputs-trace, kommande grafer) — det står redan i §4 och gäller fortfarande.
  Mätningen i §8.5b visade dessutom att kostnaden satt i komposition och
  renderloopar, inte i DOM-skrivningar.

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
| 4 | Inputs-trace (gas/broms + staplar) | KLAR, kopplad på bussen | ABS=gult trace, TC=blått; Canvas rullande; tidsfönster 2–10 s valbart; spökspår mot MoTeC-referensen |
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
engine/acc_test.py         delade minnet mot riktiga ACC (kör med spelet igång)
engine/broadcast_test.py   Broadcasting mot riktiga ACC (kör med spelet igång)
engine/build_sidecar.py    PyInstaller → src-tauri/binaries/acc-engine-<triple>.exe
engine/ldparser.py         GPL, gitignorerad, hämtas lokalt
src-tauri/src/lib.rs       fönstermanager, kommandon, sidecar+Job Object, hotkey, settings
src-tauri/tauri.conf.json  control-fönster, updater, externalBin, bundle.resources
tests/                     regressionstester — läs tests/README.md FÖRST, den
                           förklarar vad varje test bevakar och hur man visar att
                           ett test biter
.github/workflows/release.yml  CI: kör testerna, bygg installer + latest.json vid tagg
```

## 7. Status: verifierat vs kvar  (uppdaterad 2026-07-28, v0.3.2)
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

- **Utgåvorna 0.3.0 och 0.3.1 verifierade ur den PUBLICERADE MSI:n** (inte bara grön
  CI, §8.6c). Release har MSI + NSIS + båda `.sig` + `latest.json` med signatur för
  alla tre plattformsnycklar. MSI:n uppackad med 7-Zip: `verify_sidecar.py` hittar
  alla sex modulerna i den 21,2 MB stora CI-sidecarn (mindre än lokalbygget är
  normalt, §8.6c). Binären körd: MoTeC-referensen laddas
  (`varvtid≈136.250s → OK`, `bana Spa`), WS ger 30 fält utan NaN, telemetrin rör sig,
  Broadcasting registrerar, och OBS-HTTP:n svarar 200 på alla overlay-filerna.
  Obs: `refTotalMs` är `None` i den körningen — den sätts först när ACC är ansluten,
  så det är själva INLÄSNINGEN av referensen som är verifierad här, inte delta-vägen.
  Att kontrollera nya FÄLT i den publicerade ramen (inte bara att den startar) är
  vad som gör verifieringen värd något.

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

**Kvar att verifiera — läs detta först om du tar över:**
- **Att 0.3.1/0.3.2-fixarna faktiskt löste det som rapporterades i spelet.** Tre
  buggar kom från riktig körning av 0.3.0: overlays blinkade var 3–4 sekund,
  inputs-trace fick hack, och delta-overlayn visade ett MoTeC-delta ur depån och på
  fel bana. Orsakerna är hittade, förklarade (§8.6e, §8.8b) och täckta av tester som
  faller på den gamla koden — **men ingen har kört spelet efteråt.** Symptomen går
  inte att reproducera utan ACC. Detta är den enskilt viktigaste öppna punkten;
  fråga användaren innan du bygger vidare på antagandet att de är borta.
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

### 8.5b Dolda overlays kostade CPU ändå — `visibility:hidden` räcker inte
Synk-grinden dolde overlayn med `document.documentElement.style.visibility='hidden'`.
Sidan målade då ingenting — men **fönstret fanns kvar**, så Windows komponerade
fortfarande två transparenta always-on-top-fönster, och renderloopen tickade vidare
30 ggr/s och ritade canvas som ingen såg.

Mätt på den här maskinen (6 kärnor), båda overlays dolda av grinden och panelen
öppen men ofokuserad:

| | WebView2 totalt |
|---|---|
| Före | **6,30 %** av alla kärnor (37,8 % av en) |
| Efter | **2,46 %** av alla kärnor (14,8 % av en) |

Uppdelningen före visade var det satt: GPU-processen 17,8 % av en kärna, tre
renderare 8,4 + 4,8 + 4,5 %. Alltså komposition och renderloopar, inte JavaScript.

Tre ändringar, ingen med någon synlig effekt:
- **Stäng OS-fönstret**, inte bara innehållet (`getCurrentWindow().hide()`). Overlayn
  är ändå osynlig i det läget. CSS-dölningen ligger kvar som första försvar
  eftersom den verkar direkt medan fönsteranropet är async.
- **`startLoop` hoppar hela tick:en när grinden är på.** `lastT` flyttas ändå fram
  så `dt` inte hoppar vid återkomsten.
- **Panelens preview pausas när panelen inte syns** (`display:none` på iframen gör
  dokumentet orenderat, då kör webbläsaren inte dess rAF). Previewn är en FJÄRDE
  renderloop som annars gick medan man kör. Statusraden strypt till 4 Hz — den
  parsade 40 ramar/s för en prick som ändras någon gång per minut.

**Två fällor på vägen, båda värda att minnas:**
1. `hide()` kräver `core:window:allow-hide` i `capabilities/default.json`. Utan den
   avvisas anropet — och med ett `.catch(() => {})` blev det HELT tyst: overlayn såg
   ut att fungera, men fönstret doldes aldrig och CPU:n låg kvar. Samma svälj-fälla
   som §8.3. Felet loggas nu en gång.
2. Grinden fick BARA visa fönster den själv har dolt. Första versionen anropade
   `show()` på första anslutna ramen, vilket hade gjort en **avstängd** overlay
   synlig — Rust skapar den dold med `.visible(st.enabled)`. Synligheten är skalets
   beslut; grinden lånar den tillfälligt. `tests/overlay-gate.mjs` fångade det.

**Så mäter du om:** hitta WebView2-processerna som är barn (i valfritt led) till
`acc-overlay.exe`, summera `TotalProcessorTime` över 20 s och dela med tiden. Att
mäta `msedgewebview2` rakt av ger fel svar — det finns oftast andra program med
egna WebView2-processer på maskinen (här 14 totalt, varav 8 våra).

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

Den cachade ramen sparas och lämnas ut som **kopia** (`dataclasses.replace`). Första
versionen delade objekt, och eftersom `__main__` MUTERAR ramen efter `read()`
(`apply_reference` skriver om `delta`/`refTotalMs`/`deltaSource`) skrevs de ändringarna
rakt in i cachen — nästa hållna ram kom tillbaka med ett MoTeC-delta märkt som ACC:s.
Den buggen låg i den publicerade 0.3.1 och hittades vid en granskning, inte av testerna:
lägg alltid till en kontroll av att cachen är orörd av vad anroparen gör.

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

### 8.7b "Byt fart-integrationen mot banlängd × position" — nej, och varför
Ett återkommande förslag (senast i `Architecture Review & Feature Roa.md`) är att
ersätta fart-integrationen med `normalizedCarPosition × Static.trackLength` för
"perfekt synk". Det bygger på tre missförstånd, alla kontrollerade:

1. **Vi använder redan `normalizedCarPosition` live.** `delta()` tar den rakt av.
   Fart-integrationen används BARA för att bygga *referensfilens* distansaxel — och
   det gör vi för att ACC:s MoTeC-export saknar distanskanal (§8.7, mätt: 55 kanaler,
   noll med "dist"). Förslaget löser alltså inte problemet som finns.
2. **`Static.trackLength` finns inte** i pyaccsharedmemory. Broadcasting ger
   `trackMeters`, men bara när den är ansluten.
3. **Meter ger ingen extra precision.** Att multiplicera 0..1 med banlängden på båda
   sidor och jämföra i meter är matematiskt identiskt med att jämföra normaliserade
   positioner. Det är ett enhetsbyte.

"~15 ms drift" som brukar citeras är dessutom en felläsning: siffran är skillnaden
mellan `.ldx`-varvets längd (136,250 s) och filnamnets angivna 2:16.265 — ett mått på
hur exakt VARVGRÄNSERNA valdes, inte på live-synken. Att vi normaliserar den
integrerade distansen med sitt eget maxvärde tar dessutom bort hela den systematiska
skalfelskällan; kvar blir bara formfel, som är av andra ordningen.

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

Panelen kunde dessutom bara LÄGGA TILL en referens, aldrig ta bort den, och visade
alltid "Ingen referens laddad" även när en låg sparad. Följden var att ett oväntat
MoTeC-delta varken gick att förklara eller bli av med. Nu hämtas sökvägen med
`get_globals` vid start och en "Ta bort referens"-knapp anropar `set_reference` med
tom sträng; motorn ser det i `engine.config.json` och kör `ref.unload()`.

### 8.8c Namnbytet till SimMatrix: två saker som ALDRIG får ändras
Appen hette "ACC Overlay" fram till 0.3.4. Bytet är med flit **bara kosmetiskt** —
två fält lämnades orörda, och båda skulle kosta användardata om de rördes:

- **`identifier` i `tauri.conf.json` är kvar som `com.accoverlay.app`.** Den bygger
  `app_config_dir()`, alltså `%APPDATA%\com.accoverlay.app\settings.json`. Byter man
  den pekar appen på en tom mapp och alla tappar positioner, skalor, alternativ och
  referenssökväg — utan felmeddelande, det ser bara ut som en nyinstallation.
  Identifieraren är osynlig för användaren; det finns ingen vinst som väger upp det.
  Vill man ändå byta krävs en engångsmigrering av mappen FÖRST.
- **`bundle.windows.wix.upgradeCode` är låst till `fae11c9e-d58a-5c32-baa1-cb37c81e4136`.**
  Tauri härleder annars koden ur `productName` (Uuid v5 på `<productName>.exe.app.x64`
  — står i tauri-utils config.rs). Namnbytet hade alltså gett en NY kod, och Windows
  ser då utgåvan som en **annan app**: användaren får två installationer sida vid sida
  i stället för en uppdatering. Koden ovan är den som gällde för "ACC Overlay".
  Kontrollera med `pnpm tauri inspect wix-upgrade-code` — den skriver ut både den
  härledda och den låsta, och de SKA skilja sig åt nu.

Internt heter saker fortfarande `acc-*`: Cargo-paketet `acc-overlay`, sidecarn
`acc-engine`, Python-paketet `acc_engine`. Det är avsiktligt. Att döpa om dem berör
`externalBin`, `build_sidecar.py`, `verify_sidecar.py`, CI och `lib.rs` — risk utan
någon vinst för användaren, som aldrig ser namnen.

### 8.8d Spökspåren: referensen är indexerad på POSITION, traces på TID
Inputs-trace ritar referensvarvets gas/broms bakom dina egna. Den svåra biten är att
x-axeln i traces är TID (rullande fönster) medan referensen är indexerad på POSITION.

Lösningen är att INTE lösa det i overlayn: motorn skickar `refThrottle`/`refBrake` för
NUVARANDE position i varje ram, och overlayn sparar dem i samma sampel som sina egna
värden. Då ligger spöket i linje per konstruktion, utan någon positionsbokföring i
rit-koden. Skulle overlayn i stället ha slagit upp referensen själv hade den behövt
spara position per sampel och interpolera — mer kod på fel sida processgränsen.

Fyra saker att inte råka bryta:
- Spökvärdena sätts BARA när `deltaSource == "motec"`. Samma grind som deltat: gäller
  inte referensen (fel bana, ut-varv, ingen fil) ska inget spöke ritas heller.
- `.ld`-kanalerna har OLIKA samplingstakt (mätt: 60 Hz för gas/broms, 20 Hz för växel)
  och anges i PROCENT. Att slice:a dem med huvudkanalens index hade tyst gett fel data
  för varje kanal med annan frekvens — de interpoleras därför till en gemensam tidsbas
  före sortering, och skalas till 0..1.
- Latch enligt §8.5 (`REF_HOLD_MS`): motorn skickar null enstaka ramar vid mållinjen,
  och utan hållning fick spökspåret hål som syns som blink i en linje.
- `_drawGhost` får inte anropa `stroke()` på en tom path. Första versionen gjorde det
  60 ggr/s när ingen referens fanns — gratis arbete, och det gjorde dessutom
  ritanropen omöjliga att mäta i testet (med och utan referens gav samma siffra).

Mock-källan skickar också spökvärden, fasförskjutna 0,35 s. Det är enda sättet att SE
funktionen utan att ACC kör — samma skäl som mocken finns för alls.

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
Det finns tester i `tests/` — läs `tests/README.md`. `pnpm test` kör de fem
overlay-testerna (Node); de fem Python-testerna körs var för sig från repo-roten.
**CI kör alla utom `motec_reference.py`**, som kräver en `.ld` och därför alltid
hoppar över sig själv på en runner — se fällan om det längre ner.
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
# Tester:                 pnpm test  +  python tests/<namn>.py   (ALLTID från repo-roten)
```
Python-testerna körs **från repo-roten**, inte från `engine/` — de räknar ut sökvägar
med `parents[1]`. Kör man dem från `engine/` blir det `engine/tests/...` och Python
säger bara "No such file or directory", vilket är lätt att misstolka som ett trasigt
test. Samma sak gäller `engine/acc_test.py` och `engine/broadcast_test.py`: kör dem som
`python engine\acc_test.py` från roten.
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

**Läsordning för en assistent som tar över:** denna fil → `tests/README.md` →
`src/shared/tokens.css`. §8 är viktigast (fällor som redan kostat tid) och §7 säger
vad som faktiskt är verifierat kontra antaget — blanda inte ihop dem.

**Arbetssätt som gällt hittills och fungerat, behåll det:**
- **Mät, gissa inte.** Läs källan (Tauri i `~/.cargo/registry/`, pyaccsharedmemory i
  site-packages) i stället för att lita på minnet. Flera buggar i §8 hittades så.
- **Ett test som inte kan falla bevisar ingenting.** Kör varje nytt test mot koden
  FÖRE fixen. Går det inte (refaktorering, ny funktion) — bevisa tänderna på annat
  sätt, t.ex. en medvetet trasig variant inne i testet. Se §9.
- **Verifiera den publicerade artefakten**, inte att CI blev grön (§8.6c).
- **Fråga hellre än att anta om användarens data.** Inställningar, positioner och
  referenssökväg är användarens; ta säkerhetskopia innan test och återställ efteråt.
- Rör inte kärnan (`lib.rs`, `bus.js`, registry-schemat) i onödan — men när den
  behöver ändras, gör det ordentligt och dokumentera varför i §8.
