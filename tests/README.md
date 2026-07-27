# Tester

Inget testramverk — bara skript som går att köra direkt och som slutar med exitkod
0/1. Syftet är regressionsskydd för buggar som är svåra att se med ögonen.

```
node tests/overlay-delta-bar.mjs      # flicker i delta-baren (kärnan)
node tests/overlay-inputs-trace.mjs   # canvas-traces: Hz-tak, tidsbaserad utjämning
node tests/overlay-loop.mjs           # renderloopens takt under jitter
node tests/overlay-gate.mjs           # synk-grinden: blinkar overlayn?
node tests/overlay-options.mjs        # typade alternativ, före första paint
python tests/acc_source.py            # "ingen ny data" != frånkopplad, ut-varv
python tests/delta_source.py          # vilken referens deltat kommer från
python tests/engine_smoke.py          # motorn: ramschema, takt, portkonflikt
python tests/motec_reference.py       # MoTeC-delta mot en riktig .ld
python tests/broadcast_protocol.py    # Broadcasting-UDP mot en falsk ACC-server
```
`pnpm test` kör de fyra overlay-testerna.

**Harnessen stubbar INTE `bus.js`.** `startLoop` och `wireShell` importeras på riktigt
(bara `WsBus` och `fontsReady` är stubbar), eftersom det är just dem flera tester
bevakar. En handskriven stubb av `wireShell` stod här tidigare och applicerade aldrig
alternativ — testet på att alternativ gäller före första paint passerade alltså utan
att overlayn ens fått värdet.

Följden att känna till: `htmlAtRevision` rullar bara tillbaka **overlayns HTML**, inte
`src/shared/bus.js`. Kör du mot en gammal revision testas den gamla overlayn mot
DAGENS buss.

## overlay-delta-bar.mjs
Kör delta-barens **riktiga** renderloop utan webbläsare: modulskriptet plockas ut ur
HTML:en, importerna byts mot stubbar, DOM:en fejkas och tiden drivs manuellt
(`tests/lib/overlay-harness.mjs`). Det behövs eftersom flickret varade **ett enda
frame** — det syns inte i en skärmdump och inte för ögat, bara som en mätbar
DOM-skrivning.

Kontrollerar att bågen aldrig töms under en nollpassage, att färgen inte flimrar kring
noll, att platshållarna mäter exakt som ett riktigt värde, att enstaka `null`-ramar
från motorn inte slår igenom, och att stora deltan renderas utan att klampas.

**Kör det mot en gammal revision för att bevisa att det biter:**
```
node tests/overlay-delta-bar.mjs a31b1c1
```
Det ska misslyckas med 4 kontroller. Ett test som passerar mot koden före fixen mäter
inte det det påstår. Harnessen har därför också `assertAlive()`: kontrollerna vägrar
bedöma *vad* overlayn skrev innan de sett att den skrev något alls — annars kan ett
test passera på en overlay som aldrig ens renderade.

## overlay-inputs-trace.mjs
Canvas-overlayn är känsligare för renderloopen än delta-baren: den ritar om HELA
canvasen varje frame, medan delta-baren skriver DOM bara vid ändring. Harnessen har
därför en canvas-2D-stubb som räknar ritanrop (`clearRect`, `stroke`, `lineTo`) i
stället för att rita.

Kontrollerar att overlayn faktiskt ritar, att 30 Hz-taket håller på en 144 Hz-skärm,
att pedalstaplarnas utjämning är tidsbaserad, att ABS/TC ger egna trace-färger, och
att ovänliga ramar inte ger klistrig NaN.

**Kör mot en gammal revision för att bevisa att det biter:**
```
node tests/overlay-inputs-trace.mjs a31b1c1   # 3 kontroller ska misslyckas
node tests/overlay-inputs-trace.mjs 6bb9388   # ska passera helt
```
Den andra är lika viktig som den första: `6bb9388` är koden efter §8.5-fixarna men
före att loopen flyttades till `bus.js`. Att den passerar identiskt är beviset för att
refaktoreringen inte ändrade beteendet.

Utjämningskontrollen räknar RENDERINGAR, inte väggklockstid. Ett Hz-tak gör att
ackumulerad `dt` inte landar jämnt på en godtycklig tidpunkt, och den artefakten såg
ut som en bugg utan att vara det. Signaturen för den gamla per-frame-lerpen är i
stället att samma antal renderingar alltid ger samma värde, hur lång tid de än tog.

## overlay-loop.mjs
Bevakar `bus.js:startLoop` — den delade renderloopen som overlays använder i stället
för varsin kopia av deadline-mönstret i §8.5.

Detta test bevakar en **refaktorering**, inte en buggfix, så regeln ovan (kör mot
revisionen före fixen) går inte att tillämpa — koden har just flyttat. Tänderna
bevisas i stället inne i testet: samma mätning körs mot `naivLoop`, som är det
trasiga mönstret ("nu minus förra renderingen"). Under vsync-jitter ger den 23 tick
mot den riktiga loopens 31, och den kontrollen fallerar om skillnaden försvinner.

Kontrollerar också att `hz` kommer från anroparen (det är per-overlay-hz ur
`registry.json`), att `dt` är tidsbaserat och klippt vid `dtCap`, och att `stop()`
faktiskt stoppar.

## overlay-options.mjs
Bevakar de typade alternativen i `registry.json` (`type`: bool/int/float/enum/color).

Viktigast är att ett alternativ som påverkar LAYOUT gäller vid **första** renderingen,
inte när ett async `get_config` svarar — det är §8.3 en tredje gång, och det syns bara
i ett enda frame. Testet kontrollerar också att registrets scheman är välformade
(`registry.json` kompileras in i `lib.rs` med `include_str!` och panikar vid fel form,
så ett fel där ger ingen byggvarning utan en app som dör vid start), att tal kommer
fram som tal och inte strängar, och att overlayn överlever skräpvärden — OBS och
webbläsare har ingen Rust-validering framför sig.

## overlay-gate.mjs
Synk-grinden ("Endast när ACC kör"). I 0.3.0 blinkade båda overlays var tredje–fjärde
sekund under körning, eftersom grinden dolde dem så fort EN ram hade
`connected:false`. Grundorsaken låg i motorn (se `acc_source.py`), men grinden ska
ändå inte vara så nervös.

**Lärdom värd att upprepa:** första versionen av det här testet tittade bara på
SLUTtillståndet och passerade därför mot den buggiga koden — overlayn hann ju komma
tillbaka. Blinket syns bara om man räknar hur många gånger overlayn *dolts*. Kör
testet mot `git stash`:ad kod för att se att det biter (3 kontroller ska falla).

## acc_source.py
Grundorsaken till både blinket och hacken i traces i 0.3.0.
`read_shared_memory()` returnerar `None` när fysikpaketet inte hunnit uppdateras —
"ingen ny data", inte "ACC är borta". Källan tolkade det som frånkoppling och motorn
föll då tillbaka på MOCK-data för det framet.

Ett fejkat delat minne låter testet styra exakt när `None` kommer, vilket är omöjligt
mot riktiga ACC. `--old` återskapar felet så man ser att kontrollerna biter (3 ska
falla). Täcker också ut-varvsregeln, inklusive att det avgörande är om man är i
depåfilen när mållinjen passeras.

## delta_source.py
Vilken referens deltat kommer från. I 0.3.0 skrev MoTeC-filen alltid över ACC:s eget
delta, så overlayn visade ett referensdelta direkt ur depån och mot fel bana.

Kontrollerar valet, inte matematiken — **utom** en syntetisk referens utan filberoende.
Den finns av ett konkret skäl: `Reference.delta()` bröts helt under arbetet med 0.3.1
och alla andra tester passerade ändå, eftersom fejkreferensen här skuggade metoden och
`motec_reference.py` hoppar över sig själv utan en `.ld` (alltså alltid i CI).

## engine_smoke.py
Startar motorn som subprocess och prenumererar på bussen. Utöver ramschema och takt
testas att en **andra** instans avslutar snyggt med förklaring i stället för
traceback, vilket är exakt vad som händer när en tidigare motor lever kvar och håller
port 8777.

## broadcast_protocol.py
Startar en **falsk ACC-UDP-server** som svarar på registreringen och sänder paket
byggda byte för byte, och kontrollerar att `sources/acc_broadcast.py` tolkar dem rätt:
förarnamn/nummer/team ur entry list, spline/varv/position/växel ur realtidspaketen,
ogiltiga varvtider som `None` i stället för sentinelvärdet, bana och sessionfas.

Testar också de tre sätten det kan gå fel utan att synas: att okänd bil utlöser en
omfrågan av entry list men **rate-limitat**, att bilar som lämnat sessionen städas bort
ur både `_cars` och `_entries` (den kontrollen hittade en riktig bugg), och att
skräppaket loggas i stället för att fälla källan.

**Vad det INTE bevisar:** att vår tolkning stämmer med riktiga ACC. Byte-layouten är
skriven mot Kunos dokumentation och aldrig sedd i drift. Kör
`python engine/broadcast_test.py` med spelet igång för den delen — det är samma öppna
punkt som fältmappningen i `sources/acc.py` (CLAUDE.md §7).

## motec_reference.py
Kräver `engine/ldparser.py` (GPL, gitignorerad) och en `.ld`; utan argument används
referensen ur appens `settings.json`. Hoppar över sig själv om något saknas.

Viktigast här är spikskyddet: mållinje-artefakten (position wrappar innan varvtiden
nollställs) ska avvisas, medan äkta stora deltan ska visas. Tröskeln är proportionell
mot varvlängden, så testet kontrollerar båda banlängderna — Spa och ett skalat
Nordschleife-varv.

## Att lägga till en overlay-test
```js
const h = await loadOverlay('min-overlay', { expose: ['frame'] });
h.settle({ throttle: 1, brake: 0 }, 30);   // ram + 30 frames
h.writes({ el: 'nagot', key: 'd' });       // allt overlayn skrev dit
h.text('nagotId');                         // sammansatt text ur teckenceller
```
Harnessen fejkar bara det overlays faktiskt använder. Behöver din overlay mer av DOM:en
får du utöka `makeEl`/`document` där — håll det minimalt, poängen är mätbarhet, inte en
webbläsare.
