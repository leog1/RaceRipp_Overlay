# Tester

Inget testramverk — bara skript som går att köra direkt och som slutar med exitkod
0/1. Syftet är regressionsskydd för buggar som är svåra att se med ögonen.

```
node tests/overlay-delta-bar.mjs      # flicker i delta-baren (kärnan)
python tests/engine_smoke.py          # motorn: ramschema, takt, portkonflikt
python tests/motec_reference.py       # MoTeC-delta mot en riktig .ld
```
`pnpm test` kör overlay-testet.

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

## engine_smoke.py
Startar motorn som subprocess och prenumererar på bussen. Utöver ramschema och takt
testas att en **andra** instans avslutar snyggt med förklaring i stället för
traceback, vilket är exakt vad som händer när en tidigare motor lever kvar och håller
port 8777.

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
