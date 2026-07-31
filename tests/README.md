# Tester

Inget testramverk — bara skript som går att köra direkt och som slutar med exitkod
0/1. Syftet är regressionsskydd för buggar som är svåra att se med ögonen.
**Varje test bevakar en fälla som står förklarad i `CLAUDE.md` §8** — orsaken bor där,
här står vad testet mäter och hur man visar att det biter.

```
node tests/overlay-delta-bar.mjs      # flicker i delta-baren (kärnan)
node tests/overlay-inputs-trace.mjs   # canvas-traces: Hz-tak, tidsbaserad utjämning
node tests/overlay-loop.mjs           # renderloopens takt under jitter
node tests/overlay-gate.mjs           # synk-grinden: blinkar overlayn?
node tests/overlay-options.mjs        # typade alternativ, före första paint
node tests/overlay-preview.mjs        # previewn får aldrig fönstrets skala
node tests/panel-layout.mjs           # layout-fliken, driftblocket, hjulskrollen (Chrome)
node tests/overlay-window-fit.mjs     # ryms overlayn + skuggan i fönstret? (Chrome)
python tests/acc_source.py            # "ingen ny data" != frånkopplad, ut-varv
python tests/delta_source.py          # vilken referens deltat kommer från
python tests/lap_recorder.py          # motorns egna varvinspelningar (förra/bästa)
python tests/engine_smoke.py          # motorn: ramschema, takt, portkonflikt
python tests/motec_reference.py       # MoTeC-delta mot en riktig .ld
python tests/broadcast_protocol.py    # Broadcasting-UDP mot en falsk ACC-server
python tests/mock_toggle.py           # mock-data av/på i drift (engine.config.json)
```
`pnpm test` kör de sex overlay-testerna. `pnpm test:panel` kör de två som behöver en
webbläsare (panel-layout och overlay-window-fit). Python-testerna körs **från
repo-roten**.

`panel-layout.mjs` och `overlay-window-fit.mjs` är de enda testerna med yttre
beroenden: de startar **Chrome**
headless och driver sidan över CDP med global `WebSocket`, som finns **från Node 21**
(CI kör 22 av det skälet — på 20 föll steget med `WebSocket is not defined`).
Det ligger därför i ett **eget script och ett eget CI-jobb**, inte i `pnpm test`: en
releasepipeline ska inte kunna falla på att en runner saknar en webbläsare, och
bygget behöver ingen. Jobbet gatar alltså inte releasen — men det går rött när
testet faller, så felet är fortfarande synligt. Det är skillnaden mot att hoppa
över det. Hittas ingen Chrome FALLER testet med en
sökvägslista i felet — det hoppar aldrig tyst över sig själv (§9). Egen sökväg:
`CHROME=<...\chrome.exe> node tests/panel-layout.mjs`. GitHubs `windows-latest` har
Chrome förinstallerad, så det går igenom i CI som det är.

## Harnessen (`tests/lib/overlay-harness.mjs`)
Plockar ut overlayns modulskript ur HTML:en, byter importerna mot stubbar, fejkar DOM:en
och låter dig driva tiden frame för frame. Det är enda sättet att mäta något som varar
**ett enda frame** — flickret syns inte i en skärmdump och inte för ögat.

**Harnessen stubbar INTE `bus.js`.** `startLoop` och `wireShell` importeras på riktigt
(bara `WsBus` och `fontsReady` är stubbar), eftersom det är just dem flera tester
bevakar. En handskriven stubb av `wireShell` stod här tidigare och applicerade aldrig
alternativ — testet på att alternativ gäller före första paint passerade alltså utan
att overlayn ens fått värdet.

Följden att känna till: `htmlAtRevision` rullar bara tillbaka **overlayns HTML**, inte
`src/shared/bus.js`. Kör du mot en gammal revision testas den gamla overlayn mot
DAGENS buss. Sitter buggen i bussen — som §8.4d gjorde — går det inte att bevisa så.
Använd då `loadOverlay(..., { busFile })` med en `bus.js` skriven ur git
(`fileAtRevision('src/shared/bus.js', rev)`); det är precis vad
`overlay-preview.mjs <rev>` gör.

**Harnessen driver också TIMERS** (`tests/lib/fake-timers.mjs`), bundna till samma
fejkade klocka som rAF. `startLoop` sover mellan renderingarna i en `setTimeout` och
begär rAF först nära deadline, så ett harness som bara driver rAF ser en loop som aldrig
kommer igång. `h.tick()` kör förfallna timers FÖRST och sedan rAF-callbacken. Node:s
riktiga `setTimeout` sparas undan innan bytet — annars hade harnessens egen
microtask-flush hamnat i den fejkade kön och hängt uppstarten.

Tre flaggor/rutiner som är lätta att missa:
- `preview: true` — kör overlayn som om den satt i kontrollpanelens iframe
  (`window.self !== window.top`, alltså `IN_PREVIEW` i `bus.js`).
- `busFile` — alternativ sökväg till `bus.js`.
- `assertAlive()` — kontrollerna vägrar bedöma *vad* overlayn skrev innan de sett att
  den skrev något alls. Utan den kan ett test passera på en overlay som aldrig renderade.

**En för slapp stubb ÄR ett tyst testfel.** `getComputedStyle` gav samma färg för alla
tokens, så en kontroll av att ABS färgar bromstracet gult passerade även på en overlay
som ritade allt i en färg. Ge stubbar värden som går att skilja åt. Harnessen fejkar
bara det overlays faktiskt använder; behöver din overlay mer av DOM:en får du utöka
`makeEl`/`document` — håll det minimalt, poängen är mätbarhet, inte en webbläsare.

## overlay-delta-bar.mjs
Bågen töms aldrig under en nollpassage, färgen flimrar inte kring noll, platshållarna
mäter exakt som ett riktigt värde, enstaka `null`-ramar slår inte igenom, stora deltan
renderas utan att klampas (§8.5, §8.8). Dessutom att reglaget `delta-source` är det ENDA
som styr siffran (§8.8f): varje källa har ett eget värde i testramen, så en overlay som
visar fel källa syns — annars är felet osynligt, siffran ser lika rimlig ut.
```
node tests/overlay-delta-bar.mjs a31b1c1     # 4 kontroller ska misslyckas
```

## overlay-inputs-trace.mjs
Canvas-overlayn ritar om HELA canvasen varje frame (delta-baren skriver DOM bara vid
ändring), så den är känsligare för renderloopen. Harnessen har en canvas-2D-stubb som
RÄKNAR ritanrop (`clearRect`, `stroke`, `lineTo`) i stället för att rita.
Kontrollerar att overlayn faktiskt ritar, att 30 Hz-taket håller på en 144 Hz-skärm, att
pedalstaplarnas utjämning är tidsbaserad, att ABS/TC ger egna trace-färger och att
ovänliga ramar inte ger klistrig NaN.
```
node tests/overlay-inputs-trace.mjs a31b1c1   # 3 kontroller ska misslyckas
node tests/overlay-inputs-trace.mjs 6bb9388   # ska passera helt
```
**Spökkontrollerna går inte längre att köra mot revisioner före 0.5.0.** Ramkontraktet
bytte där: referensvärdena kommer nu ur `refs`-kartan (en post per källa) i stället för
ur `refThrottle`/`refBrake`, och en gammal overlay ser alltså ingen referens över
huvud taget. Loop- och utjämningskontrollerna ovan är opåverkade — de rör inga
referensfält.
Den andra är lika viktig som den första: `6bb9388` är koden efter §8.5-fixarna men före
att loopen flyttades till `bus.js`. Att den passerar identiskt är beviset för att
refaktoreringen inte ändrade beteendet.

Utjämningskontrollen räknar RENDERINGAR, inte väggklockstid. Ett Hz-tak gör att
ackumulerad `dt` inte landar jämnt på en godtycklig tidpunkt, och den artefakten såg ut
som en bugg utan att vara det. Signaturen för den gamla per-frame-lerpen är i stället att
samma antal renderingar alltid ger samma värde, hur lång tid de än tog.

## overlay-loop.mjs
Bevakar `bus.js:startLoop` — den delade renderloopen (§8.5). Detta test bevakar en
**refaktorering**, inte en buggfix, så "kör mot revisionen före fixen" går inte att
tillämpa. Tänderna bevisas i stället inne i testet: samma mätning körs mot `naivLoop`,
det trasiga mönstret ("nu minus förra renderingen"). Under vsync-jitter ger den 23 tick
mot den riktiga loopens 31, och kontrollen fallerar om skillnaden försvinner.
Kontrollerar också att `hz` kommer från anroparen (per-overlay-hz ur `registry.json`),
att `dt` är tidsbaserat och klippt vid `dtCap`, och att `stop()` faktiskt stoppar.

Kontroll 6 mäter något annat än takten: **hur många rAF-BEGÄRANDEN loopen gör**. Hz-taket
hoppar bara arbetet, och en begäran som inte ritar något är ändå en BeginFrame som väcker
två trådar per overlay-fönster (§8.5). Loopen sover därför i en timer och kopplar in rAF
först nära deadline — 85 begäranden i sekunden i stället för 145 på en 144 Hz-skärm, med
takten mätt oförändrad i samma körning. `naivLoop` ligger kvar på 145 och visar att
mätningen skiljer mönstren åt. **Loopen går alltså inte att driva med bara rAF längre:**
testet installerar `tests/lib/fake-timers.mjs`, som binder `setTimeout` till testets egen
klocka. Ett test som glömmer det ser en loop som aldrig startar — och skulle "passera"
genom att mäta noll frames.

## overlay-options.mjs
De typade alternativen i `registry.json` (bool/int/float/enum/color). Viktigast är att ett
alternativ som påverkar LAYOUT gäller vid **första** renderingen, inte när ett async
`get_config` svarar (§8.3) — det syns bara i ett enda frame. Kontrollerar också att
registrets scheman är välformade (`registry.json` kompileras in i `lib.rs` med
`include_str!` och panikar vid fel form, så ett fel där ger ingen byggvarning utan en app
som dör vid start), att tal kommer fram som tal och inte strängar, och att overlayn
överlever skräpvärden — OBS och webbläsare har ingen Rust-validering framför sig.

Två kontroller bevakar att varje färgalternativ faktiskt **styr** något (§8.4e), och de
fångar olika fel:
- **15** följer `var(--x)` genom `tokens.css` (inputs-trace använder `var(--depth)`, som
  är byggd av `var(--shadow)` — den styrs alltså av `col-shadow` utan att nämna den) och
  läser även `getPropertyValue('--x')`, som är hur inputs-trace hämtar sina canvas-färger.
- **16** letar hex-literaler identiska med ett färgalternativs standardvärde. Delta-baren
  satte bågens och siffrans färg med `'#0DE622'`/`'#FF3B3B'` i JS medan `--green`
  användes på annat håll i filen — kontroll 15 blev nöjd, men de två mest synliga
  elementen bytte aldrig färg.

Kör dem mot koden före fixen med `git stash push -- src/overlays src/shared/tokens.css`
(testfilen måste ligga kvar i arbetsträdet, annars stashas kontrollerna med).

## overlay-preview.mjs
Previewn ska släppa FÖNSTRETS skala men behålla opacitet och alternativ, och ett riktigt
overlay-fönster ska fortfarande ta emot skalan — båda riktningarna mäts i samma körning
(§8.4c, §8.4d). Buggen satt i delad kod, så tänderna bevisas med `busFile`:
```
node tests/overlay-preview.mjs HEAD    # 2 kontroller ska misslyckas
```

## overlay-gate.mjs
Synk-grinden ("Endast när ACC kör"): en enstaka `connected:false` får inte släcka
overlayn, och grinden får bara visa fönster den själv har dolt (§8.5b, §8.5c, §8.6e).

**Lärdom värd att upprepa:** första versionen tittade bara på SLUTtillståndet och
passerade därför mot den buggiga koden — overlayn hann ju komma tillbaka. Blinket syns
bara om man räknar hur många gånger overlayn *dolts*. Kör mot `git stash`:ad kod för att
se att det biter (3 kontroller ska falla).

Sista blocket mäter RENDERLOOPEN under grinden (§8.5): dold overlay ska varken rita
eller be om frames (3 rAF-begäranden på 144 vsync i stället för 144), och när grinden
släpper ska en rendering ske på FÖRSTA framet — annars visas telemetri som är upp till
en sovperiod gammal i samma ögonblick som man tabbar in i bilen. Tar man bort
`_wakers`-anropet i `_applyGate` faller två kontroller.

## acc_source.py
Ett fejkat delat minne låter testet styra exakt när `read_shared_memory()` ger `None`,
vilket är omöjligt mot riktiga ACC. Bevakar att "ingen ny data" inte tolkas som
frånkoppling (§8.6e) och ut-varvsregeln, inklusive att det avgörande är om man är i
depåfilen när mållinjen passeras (§8.8b). `--old` återskapar felet så man ser att
kontrollerna biter (3 ska falla).

Kontroll 7 bevakar **snabbvägen förbi `read_shared_memory()`** (§8.6f): biblioteket
`copy.deepcopy`:ar hela physics-strukturen per ram (206,7 µs mätt) bara för att nästa ram
jämföra `suspension_travel` (0,2 µs), och läser om det statiska blocket varje gång.
Kontrollerna räknar hur ofta varje block läses, alltså att dedupen ger exakt samma
`None`-svar som förut och att STATIC läses om efter `STATIC_S` men inte per ram. Bevisade
tänder: tas dedupen bort faller 2 kontroller, läses STATIC varje ram faller 1.

## delta_source.py
Vilken referens deltat kommer från (§8.8b, §8.8f) — valet, inte matematiken.
Täcker båda halvorna: de gamla fälten (`delta`/`deltaSource`, oförändrade för
bakåtkompatibilitet) och `refs`-kartan, där motorn lägger ALLA källor som gäller så att
overlayn kan välja. Kontrollerna på kartan handlar mest om vad som INTE ska ligga i
den: ingen `last` innan ett varv är inspelat, ingen `motec` på ut-varv eller fel bana,
ingen nyckel alls när en källa saknar giltigt delta, och `None` i stället för en tom
dict när ingen källa finns — en overlay ska inte behöva skilja "tom" från "saknas". **Utom** en
syntetisk referens utan filberoende, som finns av ett konkret skäl: `Reference.delta()`
bröts helt en gång och alla andra tester passerade ändå, eftersom fejkreferensen här
skuggade metoden och `motec_reference.py` hoppar över sig själv utan en `.ld` (alltså
alltid i CI).

## lap_recorder.py
Motorn spelar in varven själv så att "förra varvet" och "sessionens bästa" blir riktiga
referenser med både delta och pedalkurva (§8.8f). Det testet mäter är BAKSIDAN: vilka
varv som INTE får bli referens — depån berörd, täcker inte hela banan, orimlig varvtid,
ramar som inte är anslutna (mock får aldrig blandas in, §8.6e), banbyte och en
varvräknare som går bakåt.

Varje sådan regel körs mot en MEDVETET TRASIG variant av inspelaren, definierad inne i
testet (`UtanDepakoll`, `UtanTackningskrav`). Utan det visar kontrollen bara att koden
gör som koden gör; med den ser man att just den regeln är det som stoppar det dåliga
varvet. Samma grepp som `naivLoop` i `overlay-loop.mjs`.

## engine_smoke.py
Startar motorn som subprocess och prenumererar på bussen. Utöver ramschema och takt
testas att en **andra** instans avslutar snyggt med förklaring i stället för traceback —
exakt vad som händer när en tidigare motor lever kvar och håller port 8777 (§8.1).

## broadcast_protocol.py
En **falsk ACC-UDP-server** svarar på registreringen och sänder paket byggda byte för
byte; testet kontrollerar att `sources/acc_broadcast.py` tolkar dem rätt (förarnamn,
nummer, team, spline/varv/position/växel, ogiltiga varvtider som `None` i stället för
sentinelvärdet, bana, sessionfas). Plus de tre sätten det kan gå fel utan att synas
(§8.6d): att okänd bil utlöser en omfrågan men **rate-limitat**, att bilar som lämnat
sessionen städas ur både `_cars` och `_entries` (den kontrollen hittade en riktig bugg),
och att skräppaket loggas i stället för att fälla källan.

**Vad det INTE bevisar:** att vår tolkning stämmer med riktiga ACC. Byte-layouten är
skriven mot Kunos dokumentation och bara sedd i drift med en bil på banan. Kör
`python engine/broadcast_test.py` i ett riktigt race för den delen (CLAUDE.md §7).

## motec_reference.py
Kräver `engine/ldparser.py` (GPL, gitignorerad) och en `.ld`; utan argument används
referensen ur appens `settings.json`. **Hoppar över sig själv om något saknas — alltså
alltid i CI**, så kärnlogiken måste täckas av `delta_source.py` också.

Viktigast här är spikskyddet (§8.8): mållinje-artefakten (position wrappar innan
varvtiden nollställs) ska avvisas medan äkta stora deltan ska visas. Tröskeln är
proportionell mot varvlängden, så testet kontrollerar båda banlängderna — Spa och ett
skalat Nordschleife-varv.

## panel-layout.mjs
Layout-flikens **geometri**, mätt i en riktig webbläsare: skärmvyns proportioner, att
varje box ligger och mäter som overlayns INNEHÅLL gör (inte som fönstret — fönstret bär
ett skuggrum, och ritar vyn det hamnar det man ser en bit in från den plats man siktade
på), att snappningen väljer NÄRMASTE kandidat (inte första träffen — annars går en bred
overlay aldrig att centrera) och att den snappar mot den användbara ytan INNANFÖR
kantmarginalen, att en vald box markeras i inställningslistan, att en egen upplösning
ändrar vyns form och att antalet skärmar ritar skarvarna, att inställningsgrupperna är
hopfällda tills man öppnar dem (utom skärmvyns egen, som är öppen), att skärmvyn och
stacken linjerar utan vågrät skroll, och — viktigast — att **dölja inte är att ta bort**:
ögat skriver `set_enabled` och boxen ligger kvar nedtonad, × skriver `set_member`
(CLAUDE.md §2).

Samma test mäter fem saker till, och flera av dem har inget med geometri att göra — de
ligger här för att de kräver en riktig webbläsare:
- **Driftblocket** (ACC-grind, mock-data) finns i BÅDA flikarna och inte i de andra.
  Innan blocket fanns låg ACC-grinden i overlay-listans fot och gick alltså inte att nå
  från Layout-fliken. Kontrollen mäter också att den globala huvudströmbrytaren är
  BORTA — den fanns i 0.5.5 och togs bort igen, och testet finns för att den inte ska
  smyga tillbaka: av/på hör hemma per overlay eller i en layout, och en tredje nivå
  ovanpå dem ger bara ett läge där panelen visar något som påslaget medan skärmen är tom.
- **Kantmarginalen är en GRÄNS**, inte bara en streckad ruta: en dragning förbi kanten
  stannar på marginalen, ett för stort tal i positionsfältet klampas, och en marginal
  som växer drar in det som hamnade utanför. Snappningen är avstängd i den kontrollen
  med flit — med den på hade dragningen landat rätt ändå och testet hade mätt
  snappningen i stället för gränsen.
- **Versionen i titelraden**: grön prick när man kör senaste, amber med den NYA
  versionens nummer när det finns en, och — det som är lätt att fuska bort — varken
  eller innan kontrollen svarat. Stubbens updater kastar i sitt utgångsläge just för
  att det neutrala tillståndet ska gå att mäta.
- **Boxarnas innehåll**: iframen ritar FÖNSTRET och skjuts upp/vänster med overlayns
  padding × skalan (boxen är innehållet), måttchippen visar innehållets storlek, och
  dokumentet RIVS när man lämnar fliken — döljs det bara lever dess WebSocket vidare
  mitt i ett lopp (CLAUDE.md §8.5f).
- **Hjulskrollen i inställningslistan** (§8.4k): fem snabba snäpp ska flytta 5 × 100 px
  från BÅDA ändarna. Händelserna skickas som riktiga (trusted) hjulhändelser över CDP —
  ett `new WheelEvent` skrollar ingenting — med en kort paus emellan, annars slår
  Chromium ihop dem och testet mäter hopslagningen i stället för loopen. Fixturen har
  därför tolv färgrader: en lista som får plats i rutan går inte att skrolla, och då
  mäter kontrollen ingenting alls.

Harnessen duger inte här: det som kan gå sönder finns bara i layouten, alltså i
`getBoundingClientRect`. Panelen körs därför i headless Chrome mot en Tauri-stubb och
drivs över CDP — `--dump-dom` räcker inte när mätningen måste klicka och vänta in
layouten mellan stegen.

Två saker som gjorde testet trubbigt innan de rättades, och som är lätta att återinföra:
- **Räkna aldrig med panelens egen `stageK`.** En kontroll som hämtar omräkningsfaktorn
  ur koden den granskar stämmer alltid mot sig själv: `stageK = 0.4` passerade. Förväntad
  storlek räknas nu fram ur BEHÅLLAREN.
- **Fixturen måste ha olika värden per overlay.** Två overlays med samma mått, skala och
  position hade gjort varje placeringsfel osynligt (samma fälla som den slappa
  `getComputedStyle`-stubben ovan).

Kräver Chrome. Se listan högst upp för hur den pekas ut.

**Väntan på Chrome är 45 s, inte 10.** Båda Chrome-testerna föll en gång i CI med
*"Chrome svarade inte med någon sidflik"* medan Chrome KÖRDE och inte hade skrivit ett
ord på stderr: en kall runner startar Chrome mot en tom profil betydligt långsammare än
en utvecklingsmaskin, och tio sekunder räckte inte. Väntan mäts i väggklocka och inte i
antal varv (varje varv gör en `fetch` som kan ta godtyckligt lång tid att ge upp), och
den bryts direkt om Chrome-processen dör — då finns det inget att vänta på, och felet
ska komma på en sekund med processens stderr i meddelandet i stället för efter 45.
**Sänk inte tillbaka fönstret.** Det kostar ingenting när allt fungerar (loopen bryter
på första svaret) och är enda skillnaden mellan ett grönt bygge och ett rött som inte
säger varför.

## overlay-window-fit.mjs
**Bevakar:** att varje overlay ryms i sitt fönster MED sin slagskugga, vid skala 0,6 /
1,0 / 1,6 — och att `contentWidth`/`contentHeight` i registret är sanna. Ett
overlay-fönster är transparent och klipper allt utanför sig, så skuggan behöver
riktig plats innanför kanten (`baseWidth` = innehåll + skuggrum, `padLeft`/`padTop` =
var innehållet börjar). Skärmvyn i Layout-fliken ritar `content_*`, så ljuger de
talen hamnar varje overlay fel på skärmen utan att något syns i panelen.

Sidorna serveras över **HTTP** och inte som `file://`: ES-moduler över `file://`
blockeras av CORS, alltså laddas `bus.js` aldrig och varken skalan eller marginalen
tillämpas — mätningen ser då ut att hitta fel som inte finns. Sista passet kör
**utan `__OVERLAY_INIT__`**, alltså som OBS och en vanlig webbläsare gör det: där
gäller CSS-fallbacken, och den räknas i en `calc()` med `var(--ui-scale)` — en
`calc()` med en odefinierad variabel är ogiltig, och då hamnar innehållet i
fönstrets hörn med skuggan avklippt. Det var en riktig bugg.

Skuggans räckvidd står som en tabell i testet (läst ur overlayernas CSS) och är det
KRAV registret ska uppfylla. En overlay som saknas i tabellen får testet att falla:
en ny overlay ska inte kunna glida in utan att någon räknat på dess skuggrum.

**Visa att panel-layout biter:** utöver de åtta äldre varianterna (se filens huvud) är
sex nya körda och samtliga föll — strunta i paddingförskjutningen i `placeBox` (12), låt
`stageFramesWanted` strunta i vilken flik som är framme (12), lägg tillbaka den
gamla skrollloopen som läser `scrollTop` som sanning (13, tappar 100–200 px), ta bort
`clampAxis`-anropen ur `moveTo` (14, fem kontroller), ta bort `keepAllInside` ur
marginalreglagets `change` (14, en kontroll), och sätt `.ok` på versionsraden innan
kontrollen svarat (15).

**Visa att overlay-window-fit biter:** tre varianter är körda och föll — ta bort `--ui-scale` ur
både `tokens.css` och inputs-trace (de två kontrollerna utan INIT faller), lås
inputs-traces `#ui` till fasta `top/left` (4 kontroller), sänk dess `baseHeight`
till 222 (bottenkravet vid alla tre skalorna).

## mock_toggle.py
**Bevakar:** att mock-data går att stänga av och på i drift. Panelens reglage skriver
`engine.config.json` (Rust), motorn pollar filen en gång i sekunden — motorn är en egen
process och nås inte med ett Tauri-event. Testet startar motorn med `--source mock`, ger
den en egen configfil och växlar flaggan fram och tillbaka.

Tre saker det faktiskt mäter, och alla tre har gått sönder i något utkast:
- att motorn läser flaggan **alls**,
- att den läser om filen **när den ändras** (mtime-jämförelsen — filen skrivs med en
  framflyttad tidsstämpel, annars kan två skrivningar inom samma klocktick se identiska
  ut på Windows),
- att bussen **lever vidare** med mock av. Ramen ska komma men vara tom
  (`connected: false`, ingen telemetri); en tystnad hade sett ut som en krasch för
  overlays, som skiljer på "ingen data" och "motorn borta" (CLAUDE.md §8.6e).

Discriminatorn är `speedKph` och inte `connected`: mock-källan rapporterar med flit
`connected: false` (den är inte ACC), så det enda som skiljer en mock-ram från en tom
ram är att det finns telemetri i den.

**Visa att det biter:** ta bort `use_mock` ur fallback-raden i `engine/acc_engine/
__main__.py` (`frame = mock.read() if mock else ...`) — kontroll 2 faller. Körd.

## Att lägga till en overlay-test
```js
const h = await loadOverlay('min-overlay', { expose: ['frame'] });
h.settle({ throttle: 1, brake: 0 }, 30);   // ram + 30 frames
h.writes({ el: 'nagot', key: 'd' });       // allt overlayn skrev dit
h.text('nagotId');                         // sammansatt text ur teckenceller
```
Och kör det mot revisionen FÖRE fixen. Passerar det där mäter det inte det du tror.
