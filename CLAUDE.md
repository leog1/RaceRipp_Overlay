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

**Standardstorlek:** alla overlays ritar **200 px höga vid skala 1,0** (`--overlay-h`
i tokens.css). Poängen är att de ska se ut som en uppsättning, inte som olika program.
delta-bar och inputs-trace har nästan identiska proportioner (3,68:1 mot 3,72:1), så
samma höjd ger nästan identiska rektanglar (736×200 och 744×200). En ny overlay ska
räkna sin geometri ur det värdet, inte ur egna pixlar. `baseWidth`/`baseHeight` i
registret ska sitta TAJT runt det ritade innehållet plus plats för slagskuggan —
delta-baren låg på 1300×460 för 927×252 innehåll, alltså 373×208 död yta som DWM
komponerade i onödan (§3).

**Färganpassning:** varje overlay exponerar sina färger som `col-<token>`-alternativ i
`registry.json`. `bus.js` sätter automatiskt CSS-variabeln `--<token>`, så **en ny färg
är en rad i registret och noll kod i overlayn**. Men det garanterar bara att variabeln
SÄTTS — overlayn måste också faktiskt läsa den, och får inte hårdkoda färgen på det
element som syns mest. Båda felen har hänt och båda var osynliga (§8.4e). Betydelsebärande färger delas med
flit mellan element: pedalstapelns gröna och grafens gröna ÄR samma token, för de
betyder samma sak. Ytor och skuggor har `alpha: true` — `<input type="color">` kan
bara ge ogenomskinlig hex, så panelen kombinerar den med ett alfa-reglage och skickar
`#rrggbbaa`. Varje färgrad har dessutom ett **hexfält** (`.hexf`): färger kommer
nästan alltid någon annanstans ifrån — en liveryfil, ett teams färgprofil, en annan
overlay — och då vill man klistra in koden, inte sikta i en gradientruta. Det tar
`#RRGGBB`, `#RRGGBBAA` och kortformen `#RGB`, med eller utan brädgård. Ogiltig
inmatning **markeras** (`.bad`) men rensas aldrig medan man skriver; fältet återgår
till gällande värde vid blur/Enter. Sätter koden alfa uppdateras reglaget — och
`paintRange()` måste anropas för hand då, eftersom ett programmatiskt värde inte
utlöser något `input`.

**Kontrollpanelens chrome ligger också i tokens**, i ett eget block prefixat `--ui-`
(ytor, linjevikter, radier, typskala, fokusring, kolumnbredder). Overlays läser inget
därifrån — prefixet finns för att ett `col-<token>` i registret skriver rakt på
`--<token>` (§4) och aldrig ska kunna råka träffa panelens värden. Panelen har en egen
liten uppsättning regler som är värda att kunna innan man ändrar i den:
- **Djup kommer av kant + sheen, inte av kontrast.** Stegen mellan ytorna är små med
  flit. Kanten på en BEHÅLLARE är mörk (`--ui-edge-dk`), kanten på en liten KONTROLL
  är ljus (`--ui-edge`): en ljus kant säger "den här ytan fångar ljus", en mörk säger
  "här slutar materialet". Recepten — `--ui-raise`, `--ui-recess`, `--ui-lip`,
  `--ui-card-in` — utgår alla från att **ljuset kommer uppifrån**; det är den enda
  regeln som avgör om den ljusa raden ska ligga överst eller underst.
- **Ytornas RIKTNING bär betydelse (omgjort i 0.4.7).** Fyra djup:
  `--ui-surf-hi` (hovrad/vald rad) · `--ui-card` **ett steg ÖVER** `--app-bg` ·
  `--ui-stage` (förhandsvisningen) **ett steg UNDER** · `--ui-inset` (spår och fält,
  mörkast). Över panelen = något man RÖR VID, under = något man TITTAR IN I eller
  trycker ner. Fram till 0.4.6 låg korten på #08090a, alltså under panelen och med
  samma `--ui-recess` som previewn — rutan man BEDÖMER och rutan man STÄLLER IN såg
  då likadana ut och högerkolumnen blev ett grumligt fält utan hierarki. Dessutom
  ligger kontrollerna på `--ui-inset`: ett nedsänkt fält i ett nedsänkt kort har
  ingenstans att ta vägen, och reglagespåren syntes som svart på svart.
- **En yttre slagskugga betyder att elementet FLYTTAR SIG i z-led.** Alltså: menyer,
  tooltips, toasten. Ett kort eller en förhandsvisning som ligger stilla i sitt flöde
  får ingen — och särskilt inte ett kort som går kant i kant med sin behållare, där
  en suddig skugga under kanten läser som ett renderingsfel. Previewn bar tidigare
  `--ui-lift` UNDER sig och ett heltäckande `::after` med `--ui-recess` ÖVER sig;
  summan var en mörk bård runt rutan och en sotig rand tvärs över själva overlayn
  man satt och bedömde. Samtliga recept är dessutom dämpade i 0.4.7 (`--ui-lift`
  0,42 → 0,30, `--ui-raise` 0,34 → 0,24, `--ui-recess` 0,55/6 px → 0,42/5 px).
  **Behöver något djup: kant och sheen, inte oskärpa.**
- **Glow är en signal, inte en yta.** Panelen hade lysande halon på brandbaren,
  flikmarkören, rubrikstrecken, varje påslagen växlare och varje aktiv knapp. Var och
  en försvarbar, allihop tillsammans = amatörmässigt, och det var det första
  användaren reagerade på. Kvar finns bara två, båda nedtonade: statuslysdioden och
  växlarknoppen — saker vars ENDA uppgift är att synas i ögonvrån. Behöver ett element
  glow för att läsas är det färgen eller kontrasten som är fel.
- **En röd i panelen: `--ui-brand` (#A41F1F), samma som ordbilden.** Panelens chrome
  rör aldrig `--rail` (#D10404) — den är overlayernas och dessutom ställbar per
  overlay. Två röda intill varandra läser som två varumärken. Undantaget är
  `--red` (#FF3B3B) på motorstatusens offline-prick, som är en SIGNALfärg (§4:
  färg = betydelse), inte varumärke.
- **4-punktsraster.** Alla mått i panelen — padding, gap, radhöjd (`--ui-row-h`),
  radie, ikonstorlek, listbredd — är multiplar av 4. Typskalan har inga halvpixlar
  (12,5 px renderades som 12 på en skärm och 13 på nästa). Behöver du ett mellanting:
  ta grannvärdet, inte 2 px emellan.
- **En kontrollkolumn.** Alla rader har etiketten till vänster och kontrollen i en
  högerkolumn (`--ui-ctl-w`), så reglage, växlare och färgrutor landar på samma
  vertikala linje. Etiketterna har SAMMA typografi oavsett kontrolltyp — tidigare var
  reglageraderna versaler i `--dim` och växlarraderna gemener i `--ink`, och de två
  kortsorterna såg ut att komma från olika program.
- **Två sorters rubrik, och skillnaden är avsiktlig.** En KORTRUBRIK (`.card > h3`,
  `.list-head`) är versal, spärrad och **amber, utan streck** — där togs guldstrecket
  bort i 0.4.4 för att en rubrik som redan har versaler OCH egen färg inte behöver en
  tredje markör. En AVDELARRUBRIK inne i ett kort (`.subhead`, ny i 0.4.6) är versal,
  spärrad, **neutralt grå (`--dim`) och har en 2 px-stapel i `--ui-brand`**. Den ser ut
  att bryta mot regeln men gör tvärtom samma sak: bara EN signal bär färgen, och här är
  det stapeln i stället för texten. Skälet att den inte kan vara amber som kortrubriken
  är att den sitter tre gånger i SAMMA kort — tre amberrader i ett kort läser som tre
  kort som råkat växa ihop, medan en grå etikett med en liten färgstapel läser som
  avdelningar inuti ett. Blanda alltså inte ihop dem: lägg inte streck på en
  kortrubrik, och gör inte en `.subhead` amber.
- **Korten är exakt lika breda som förhandsvisningen.** `#previewBox` har
  `margin:16px 20px 0` och `.controls` `padding:16px 20px 24px` — samma 20 px, och
  ändras det ena måste det andra följa med. Två block med olika bredd ovanpå varandra
  läser som två olika vyer hur små pixlarna än är. (Korten satt först i en centrerad
  spalt med tak, `--ui-col-max` 820 px; den togs bort i 0.4.4 på användarens begäran.)
  Referens och Om behåller sin smala spalt (`.cards.single`) — de har ingen preview
  att linjera mot.
- **Alla kontrollkluster är 376 px breda.** Reglage 300 + gap 16 + värde 60 = 376;
  färgrad 200 (`.aslot`) + 16 + 96 (hexfält) + 16 + 48 (färgruta) = 376; väljaren är
  376 rakt av. Det är det som gör att etiketterna slutar på samma lodräta linje över
  hela kortet i stället för att sicksacka några pixlar. Lägger du till en ny
  kontrolltyp: räkna ut klustret och landa på 376.
- **Grönt betyder "på" i panelen** (PÅ-brickan, påslagna växlare). Därför är
  fokusringen amber och reglagens fyllnad neutralt vit — ett halvdraget reglage är
  inget tillstånd.
- **Vänsterlisten är en REN IKONLIST på 60 px (0.4.7).** Inga etiketter; namnet
  kommer i en tooltip vid hover/fokus. Aktiv flik = 40×40 bricka i `--ui-brand-fill`
  med ikonen i `--ui-brand-lt` (en ljus tint av samma röda — en tint är inte en
  andra kulör). Etiketterna sprängde listen två gånger (§8.4h) och tvingade fram
  fliknamn valda efter pixelbredd i stället för efter betydelse. **Ett fliknamn är
  därför inte längre bundet av listens bredd** — tooltipen växer fritt åt höger, och
  fliken som fick heta "Allmänt" heter "Inställningar" igen.
  Tooltip-spannet (`.nav .tip`) är RIKTIG text i DOM:en, inte ett `title`-attribut:
  det ger knappen dess tillgängliga namn (annars är fem knappar namnlösa för en
  skärmläsare) och Windows ritar inte sitt eget verktygstips ovanpå vårt.
- **Titelraden bär ordbilden ensam och statusen som brickor.** "CONTROL" som stod
  bredvid ordbilden är borta — appen har ett enda fönster, så etiketten skilde inte
  den här vyn från någon annan. Ordbilden är 20 px hög och inte 16: den är ritad
  459×55 med en ljus kontur per bokstav, och vid 16 px hamnar konturen under en
  pixel så bokstävernas hål sluts (mätt genom att rendera 16/18/20/22/24 bredvid
  varandra). Motor-/Broadcastingstatusen är tonade brickor vars YTA bär tillståndet
  — en 6 px prick är för lite yta för något man ska se i ögonvrån. **Offline är
  medvetet neutralt**, inte en röd bricka: en röd yta vid varje kallstart läser som
  ett fel, och att motorn inte hunnit upp är inget fel. Tillståndsklassen sitter på
  brickan och inte på pricken, för `:has()` finns först i Chromium 105.
- Reglagen är egenritade (`::-webkit-slider-*`); `accent-color` ger systemets. Den
  fyllda delen ritas som en gradient med brytpunkten i `--p`, som `paintRange()` i
  panelen sätter. En delegerad `input`-lyssnare täcker alla reglage, även de som byggs
  generiskt ur registret — men programmatiska värdeändringar utlöser inget `input`,
  därför körs `paintAll()` när en overlay väljs.

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
src/shared/preview-backgrounds/  inbyggda bakgrunder till panelens preview (§8.5d);
                           användarens egna ligger i app-config-mappen
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
- **Att ACC känns igen som förgrundsprocess** (§8.5c). Detektionen är körd och
  fungerar åt båda hållen mot andra program och mot vårt eget fönster, men **aldrig
  mot ACC**, eftersom spelet inte funnits på maskinen under arbetet. Slår
  igenkänningen fel göms overlays under HELA loppet — det är den enskilt största
  regressionsrisken i 0.4.2. Testa: starta ACC, kör ut på banan med "Endast när ACC
  kör" påslagen, och kontrollera att overlays syns i bilen och försvinner när du
  alt-tabbar. Gör de inte det är binärnamnet/sökvägen i `ACC_EXE_NAMES` /
  `ACC_PATH_HINT` fel.
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
- **Att 0.4.1 löste det som rapporterades i 0.4.0.** Fyra saker kom ur riktig
  användning: uppdateringen "återställdes" vid varje omstart (§8.8e), previewn tog åt
  sig skalan efter ett overlay-byte (§8.4d), delta-barens skuggreglage gjorde
  ingenting (§8.4e), och panelens layout gjordes om. Tre av dem är verifierade i
  drift här — previewn med skärmdumpar före/efter, färgkedjan genom att injicera
  `#C869FF`/`#FF0000` i `settings.json` och mäta pixeln (200,105,255) i delta-siffran,
  och båda täcks av tester som faller på den gamla koden. **Updater-fixen är den enda
  som inte går att bevisa förrän 0.4.1 ligger publicerad** — den kräver en
  installerad 0.4.0 som uppdaterar sig till 0.4.1 och startas om.
- **"Sök uppdatering"-knappen i appen** — nu klickad, av användaren, och det var så
  §8.8e hittades: knappen fungerade, `T.updater` laddade ner och körde installeraren,
  men installeraren var en MSI mot en NSIS-installation. Kvar att verifiera är att
  kedjan nu **landar i rätt katalog**: installera 0.4.0 (NSIS), uppdatera till 0.4.1,
  starta om och kontrollera att `Om`-fliken visar den nya versionen. Titta också efter
  en kvarlämnad `C:\Program Files\SimMatrix` från MSI-tiden.
- **Startstorleken på ANDRA skärmar än 1920×1080 @ 100 %** (0.4.3, §8.2b). Att panelen
  blir exakt 1440×900 är mätt i den riktiga appen med `GetWindowRect` (1456×909 outer
  minus Windows osynliga resize-ram). Men det är den enda skärm som funnits under
  arbetet, och där är `set_size` i praktiken en no-op — själva OMRÄKNINGEN är alltså
  aldrig körd skarpt. Testa på en 4K-skärm (200 % → ska bli 1440×900; 100 % → 2880×1800)
  och på en 1366×768-laptop (ska klampas till golvet 960×600, inte hamna utanför).
- **0.4.7:s designomgång i den riktiga appen.** Ikonlisten med tooltips, kortens nya
  yta och riktning, borttagna skuggor runt preview och kort, ordbilden 20 px,
  statusbrickorna, borttagen "CONTROL"-etikett och borttagen railprick.
  Verifierat genom att rendera panelen i Chrome headless mot en Tauri-stub i
  1440×900 / 1100×900 / 960×600 och MÄTA: preview och kort ligger på exakt samma
  x och bredd i alla tre (1060/720/580 px), ingen vågrät skroll någonstans,
  `--ui-card` = rgb(16,19,18), `--ui-stage` = rgb(8,9,10), previewns `box-shadow`
  är `none`. Tooltipen och den aktiva flikbrickan är sedda i skärmdump. Alla fem
  flikarna renderade. **Men ingenting är sett i den riktiga appen** — stubben har
  ingen fönsterhantering, så att titelraden fortfarande går att DRA i (ordbilden har
  `pointer-events:none`, brickorna `data-tauri-drag-region="deep"`, §8.4i) och att
  `#bcRow`:s felmeddelande syns som tooltip går inte att bevisa där. Testa båda.
- **Att Montserrat verkligen laddas i WebView2 och i OBS.** Vendoreringen är
  verifierad i Chrome: `document.fonts.check` sant för 500/600/700/800, båda
  `@font-face`-blocken `loaded`, och Åäö + ŁŚČğ ritas ur rätt block. Delta-baren
  renderad över HTTP visar Montserrat i "DELTA"/"P.SESSION BEST"/"PREDICTED".
  WebView2 är Chromium och bör bete sig likadant, men det är inte kört där, och
  OBS-vägen (motorns `http_static.py` med den nya `.woff2`-mappningen) är bara
  testad mot Pythons egen `http.server`, inte mot vår handler i drift.
- **0.4.6:s panelomgång i drift.** Motor-/Broadcastingstatusen flyttad till
  titelraden, två nya flikar (Layout, Allmänt) som ännu är tomma skal, och de tre
  inställningskorten sammanslagna till ett med avdelarrubriker. Verifierat genom att
  rendera panelen i Chrome headless mot en Tauri-stub och mäta pixlar: 1440×900 och
  960×600 (golvet), alla fem flikar, en overlay MED och en UTAN utseendealternativ,
  samt Broadcasting-raden framme. **Men ingenting är sett i den riktiga appen.**
  Två saker som stubben per definition inte kan bevisa: att titelraden fortfarande
  går att DRA i (fixat med `data-tauri-drag-region="deep"`, §8.4i — stubben har
  ingen fönsterhantering), och att `#bcRow`:s felmeddelande syns som tooltip.
  Testa båda genom att dra fönstret i statustexten och hovra över den.
  Notera också att headless Chrome under `--virtual-time-budget` fryser CSS-
  transitioner halvvägs — en avstängd växlare såg grön ut i en skärmdump och var
  det inte. Kör `--force-prefers-reduced-motion` innan du tror att du hittat en bugg.
- **0.4.4:s designomgång i spelet.** Ändringarna är rent visuella (nedtonad glow,
  helfärgad brandbar i ordbildens röda, fullbreda kort, borttagna rubrikstreck,
  mörka behållarkanter, 4-punktsraster) plus ett nytt hexfält på varje färgrad.
  Allt är mätt i webbläsare mot en mock — **ingen del är sedd med ACC igång.**
  Det som faktiskt kan gå fel i drift: de fullbreda korten på en liten panel (960 px
  golv, §8.2b) där reglagekolumnen på 376 px tar en tredjedel av bredden.
- **0.4.3:s panelomgång i spelet.** Designen, den statiska previewn, de 15 % mindre
  overlaysen i previewrutan och de mindre pedalsiffrorna är alla verifierade i
  webbläsare mot en körande motor (mock-data) — inte med ACC igång. Pedalsiffran
  mättes dessutom på en egen provsida, inte i drift: se att "100" faktiskt ser rätt ut
  vid full gas på banan.

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

### 8.2b Panelens startstorlek räknas mot skärmens LOGISKA storlek
Kontrollpanelen startar i **1440×900 på en 1920×1080-skärm** och håller samma ANDEL av
skärmen på andra upplösningar (75 % av bredden, 83,3 % av höjden). Ett fast pixelmått
hade gett en panel som täcker halva skärmen på en 1366-laptop och sitter som ett
frimärke på en 4K-skärm utan skalning.

Fällan är samma som §8.2: `Monitor::size()` ger **fysiska** pixlar medan
`set_size(LogicalSize)` tar **logiska**. `size_control_window()` konverterar med
`to_logical(scale_factor())`. Effekten är precis den man vill ha: en 4K-skärm i
Windows standardläge (200 %) har den logiska storleken 1920×1080 och panelen blir
alltså exakt 1440×900 — samma SYNLIGA storlek som på en 1080p-skärm. Körs samma skärm
utan skalning blir den 2880×1800, dvs. samma andel av ytan.

Två detaljer: golvet (960×600, samma som `minWidth`/`minHeight`) klampas mot skärmen
FÖRST, annars hamnar fönstret utanför en skärm som är mindre än golvet. Och
`win.center()` måste köras EFTER `set_size`, eftersom Tauris `center: true` redan har
centrerat den gamla storleken. `width`/`height` i `tauri.conf.json` är fallbacken om
skärmen inte går att fråga.

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

### 8.4b Förhandsvisningen får INTE Tauris event — men den KAN anropa invoke
§8.4 säger att `config`/`option` skickas till alla fönster och filtreras på id i
`bus.js`, och att previewn får sitt id via `?id=`. Det stämmer, men räcker inte:
previewn kör i en `<iframe>` inuti kontrollfönstret, och `emit` går via
`webview.eval()` — som bara kör i **huvudframen**. Previewn reagerade därför aldrig
på att man slog av/på ett alternativ; man fick se skillnaden först i spelet.

**Asymmetrin är hela poängen och den är lätt att gissa fel på — den här filen påstod
själv fel sak fram till 0.4.1.** Det är inte så att `__TAURI__` saknas i iframen:
wry dokumenterar rakt ut att *"on Windows, scripts are always added to subframes
regardless of the `for_main_frame_only` option"* (`wry-0.55.1/src/lib.rs:990`), så
init-skriptet — och därmed `window.__TAURI__` — finns i previewn. Det som INTE når
dit är eventen. Alltså:

| | når previewn? |
|---|---|
| `invoke` (IPC) | **ja** |
| `emit` / `event.listen` | **nej** (`webview.eval` = bara huvudframen) |

Att tro att hela Tauri saknas i iframen är dyrt: `wireShell` gör sitt `get_config`-
anrop bakom `if (!T || !T.event) return;`, och det anropet går alltså igenom. Det var
precis så FÖNSTRETS skala läckte in i previewn (§8.4d).

Lösningen är en ANDRA kanal: kontrollpanelen postar ändringen direkt till iframen
(`postMessage` med markören `__simmatrix`), och `bus.js` lyssnar på `message`
**före** Tauri-kontrollen så det fungerar utan Tauri överhuvudtaget. Bonus: previewn
uppdateras omedelbart, utan att vänta in rundturen via Rust.

Två saker att inte tappa: filtrera på `id` (annars svarar alla overlays på allt) och
kräv markören (annars tolkas meddelanden från andra bibliotek och iframes som
inställningar).

### 8.4c Förhandsvisningen: mät innehållet, inte fönstret
Tre fel i previewrutan hade samma rot — panelen resonerade om iframens MÅTT i stället
för om det som faktiskt ritas:

- **Skalreglaget klippte overlayn.** Iframen sattes till `base × skala` medan
  innehållet inuti behöll sin egen skala (config når inte in i en iframe, §8.4b).
  Previewn visar nu alltid overlayns NATURLIGA storlek; skalan påverkar den med flit
  inte alls, eftersom previewn ändå krymps för att passa rutan.
- **Innehållet var inte centrerat.** Overlays är förankrade uppe till vänster inuti
  sitt fönster (`#ui{top;left}`), så ett alternativ som ändrar bredden — dold
  kopplingsstapel, borttagen kolumn — knuffade bilden ur mitten. Panelen mäter nu
  `#ui`:s faktiska rektangel i iframen (samma origin, så det går) och centrerar DEN:
  `transform-origin:0 0` + `translate(-mitt × s) scale(s)`.
- **Opaciteten nådde aldrig fram.** Panelen postade bara `option`, aldrig `config`.

Mätningen kräver att iframen laddat, och måttet ändras när ett alternativ ändrar
dimensionerna — därför `refitSoon()` (dubbel rAF) efter load.

Overlayn ritas dessutom medvetet mindre än vad rutan rymmer (`PV_FILL`, 0,85). Fyller
den ut till kanten läser man den som "så här STOR blir den" i stället för "så här ser
den ut", och det finns ingen luft kvar för HUD-markeringarna och knapparna som bor i
rutans kanter. Taket 1 i `Math.min(..., 1)` står kvar separat: en liten overlay ska
aldrig FÖRSTORAS, för då ljuger previewn uppåt om detaljskärpan.

**En engångsmätning räcker inte.** Overlayn ritas först i fallback-font och byter till
Montserrat när den laddat, vilket ändrar bredden. Mätte vi bara vid load blev previewn
avklippt och rättades aldrig. En `ResizeObserver` på `#ui` inne i iframen fångar både
fontbytet och alla senare ändringar.

### 8.4d Skalan läckte in i previewn — via `get_config`, en omladdning senare
Rapporterat från riktig användning i 0.4.0: att dra skalreglaget syntes inte i
previewn (rätt, se §8.4c) — men bytte man till en annan overlay och **tillbaka**
hoppade previewn plötsligt i storlek. En inställning som "inte fungerade" och sedan
gjorde det, med en helt orelaterad handling emellan.

Orsaken är asymmetrin i §8.4b. Previewn får inget `config`-event när man drar
reglaget, så inget händer. Men att byta overlay sätter `pv.src` på nytt, och vid
laddningen kör `wireShell` sitt `get_config` — som **fungerar** från en iframe och
lämnar tillbaka den sparade skalan. Previewn plockade alltså upp en skala den aldrig
fick något event om, en omladdning för sent.

Fixen är en enda grind, `bus.js:applyConfigFor()`: **är `IN_PREVIEW` sant släpps
`scale` aldrig igenom, oavsett vilken av de fyra vägarna configen kom.** Opacitet och
alternativ går igenom som vanligt — en grind som slängt hela config-objektet hade
tystat opacitetsreglaget i previewn igen (§8.4c).

Panelen postar dessutom overlayns läge till iframen vid `onload` (`pushPreviewState`),
så previewn får sitt tillstånd från den som äger det i stället för att hämta det bakom
ryggen på panelen.

Två saker att inte upprepa:
- **En bugg som bara syns EFTER en orelaterad handling har oftast en omladdning i
  mitten.** Leta efter vad som körs vid init, inte efter vad som körs vid ändringen.
- `tests/overlay-preview.mjs` mäter detta. Harnessen fick två nya reglage för att
  kunna göra det alls: `preview: true` (sätter `window.self !== window.top` så
  `IN_PREVIEW` blir sant) och `busFile` (kör mot en **annan** `bus.js`). Det senare
  behövdes för §9:s regel om att ett test ska köras mot koden före fixen — buggen satt
  i delad kod, och `htmlAtRevision` når bara overlayns HTML.

### 8.4e Ett färgreglage utan mottagare ser ut att fungera
Rapporterat i 0.4.0: skuggreglaget på delta-baren gjorde ingenting. Reglaget fanns,
gick att dra, värdet sparades i `settings.json` och `--shadow` sattes på
`documentElement` — och ingenting hände, för delta-barens `box-shadow` stod
hårdkodad som `rgba(0,0,0,0.55)`. Samma sak för `col-panel` och `col-edge`, som inte
hade **någon** motsvarighet alls i den overlayn.

Det generiska `col-<token>` → `--<token>`-greppet (§4) är rätt, men det gör bara
halva jobbet: det garanterar att variabeln SÄTTS, aldrig att någon LÄSER den. Ett
sådant fel syns inte i `cargo check`, inte i CSS och inte i något test som mäter att
värdet når fram — bara i att skärmen inte ändrar sig.

Två fällor, och de kräver olika kontroller:
- **Ingen läser tokenen.** `tests/overlay-options.mjs` kontroll 15 följer
  `var(--x)`-kedjan genom `tokens.css` (inputs-trace använder `var(--depth)`, och
  `--depth` är byggd av `var(--shadow)` — den styrs alltså av `col-shadow` utan att
  nämna den) och läser även `getPropertyValue('--x')` i JS, som är hur inputs-trace
  hämtar sina canvas-färger.
- **Tokenen läses, men just det synliga elementet hårdkodar färgen.** Delta-barens JS
  satte bågens och siffrans färg med literalerna `'#0DE622'`/`'#FF3B3B'`. `--green`
  användes på annat håll i filen, så kontroll 15 blir nöjd. Kontroll 16 letar därför
  efter hex-literaler som är **identiska med ett färgalternativs standardvärde** —
  den enda signaturen som skiljer "medvetet fast färg" från "glömd token".

Går ett reglage inte att koppla till något: **ta bort det ur registret.** Ett
alternativ som inte gör något är sämre än inget alternativ.
`sanitize_options` städar bort nyckeln ur `settings.json` av sig själv.

### 8.4f Förhandsvisningen ska stå still — och två fel som CSS inte klagar på
Previewrutan låg i en pane som skrollade **som helhet**, så den försvann uppåt så fort
man arbetade sig ner genom färgreglagen. Det är precis fel: man ändrar en färg långt
ner i listan och ska se effekten utan att skrolla upp igen. Skrollen ligger nu på
`.controls` och panen har `overflow:hidden`; previewrutan är ett fast första barn.

**Lägg inte tillbaka `overflow-y:auto` på `#pane-overlays`.** Det ser ut som en
harmlös förenkling och tar bort hela poängen. Referens/Om har ingen preview och
skrollar som vanligt — det är därför reglerna är per pane och inte på `.pane`.

Två saker som inte syns i vare sig `cargo check`, CSS-validering eller något test:

- **Ett `hidden`-attribut som en display-regel slår ut.** Broadcasting-raden i
  vänsterlisten är `<div class="motor" id="bcRow" hidden>`, och `.motor{display:flex}`
  vinner över webbläsarens inbyggda `[hidden]{display:none}`. Raden låg alltså framme
  hela tiden som en tom röd prick under motorstatusen, och `row.hidden = true` i JS
  gjorde ingenting. Sätter du `display` på en klass vars element kan vara `hidden`,
  skriv regeln `.klass[hidden]{display:none}` i samma andetag.
- **En inline-SVG som background-image har ingen egen storlek.** `.osel`:s
  chevron skalades till hela rutan och blev en stor grå bock tills
  `background-size` sattes.

### 8.4g En siffra som ändrar bredd med värdet
Pedalsiffrorna i inputs-trace stod i `0.115·H` (23 px) medan stapeln är
`0.190·H` (38 px). Montserrat tabular är ~0,70 em per siffra, så `"100"` blir 2,1×
fontstorleken = 48 px — bredare än stapeln, och de tre talen flöt ihop till ett block.
Felet syns **bara vid tresiffriga värden**, alltså vid full pedal, vilket är varför det
låg kvar. Värdet är nu `0.086·H` (17,2 px → 36 px), uppmätt mot riktig rendering och
inte räknat: `0.092` gav exakt kant i kant och såg fortfarande trångt ut.

Generellt: **räkna alltid bredden på det BREDASTE värdet ett fält kan visa**, inte på
det som råkar stå där när du tittar. Samma familj som platshållarbredden i §8.5.

### 8.4h Två layoutfel som bara uppstår vid VISST INNEHÅLL
Båda hittades genom att mäta panelen i en webbläsare, inte genom att titta på den.
Ingen av dem syns i CSS:en, i `cargo check` eller ens i panelen om man råkar ha fel
overlay vald — och det är precis det som gör dem dyra.

- **Skrollremsan åt av kortens bredd.** Korten ska ligga kant i kant med
  förhandsvisningen (§4). De gjorde det — tills listan blev lång nog att skrolla.
  En skrollbar tas ur INNEHÅLLSbredden, så `.cards` blev 12 px smalare medan
  `#previewBox` (som ligger utanför skrollbehållaren) stod kvar. En overlay med sex
  färgrader låg alltså i linje och en med sju gjorde det inte.
  Fixen är `scrollbar-gutter:stable` plus en högerpadding som drar av exakt samma
  tal, båda ur `--ui-scrollbar`. Att bara reservera remsan räcker inte — då är
  kortet konsekvent 12 px för smalt i stället för ibland.
- **En list som växte av sitt eget innehåll.** `.rail` är `flex:0 0 80px`, vilket
  ser låst ut. Det är det inte: ett flexbarn har `min-width:auto`, alltså ett golv
  vid sitt min-content, och statusraden innehåller ordet "Broadcasting" som inte går
  att bryta. Listen gick från 80 till 97 px i samma sekund som Broadcasting-raden
  dök upp — mitt under körning, med hela panelen till höger flyttad i sidled.
  **`flex:0 0 <bredd>` låser ingenting utan `min-width:0`.** Lägg till det på varje
  flexbarn vars bredd är ett designbeslut.
  Den bakomliggande orsaken var dock typografisk: versalt "BROADCASTING" är ~88 px
  vid 10 px och kan aldrig få plats i en 80 px list. Statustexten är därför gemener
  medan flikarnas etiketter är versaler — ett medvetet undantag som dessutom bär
  information (etikett kontra live-status), inte en inkonsekvens att "rätta till".

**Samma fälla slog till igen i 0.4.6**, nu med en FLIKETIKETT. Den nya kugghjuls-
fliken hette först "Inställningar": versalt "INSTÄLLNINGAR" är ~95 px vid 10 px med
0,9 px spärr, och listen har 72 px innanför sin padding. Etiketten rann ut på båda
sidor om listen. `min-width:0` skyddar panelen från att FLYTTA sig, men det gör bara
felet snyggare — texten spillde fortfarande. Fliken fick därför heta "Allmänt".

**0.4.7 tog bort etiketterna helt** och därmed hela den här fällan: listen är en ren
ikonlist på 60 px och fliknamnet står i en tooltip (§4). När man två gånger har fått
välja ord efter hur många pixlar de tar är det inte ordet som är fel — det är att
etiketten står där. Fliken heter "Inställningar" igen.
`min-width:0` står kvar på `.rail`: regeln gäller varje flexbarn vars bredd är ett
designbeslut, och det finns ingen anledning att vänta på att något obrytbart flyttar
in i listen igen.

### 8.4i `data-tauri-drag-region` gäller BARA direkta klick
Titelraden är egen (`decorations:false`), och `.titlebar` bär `data-tauri-drag-region`.
Det ser ut att göra hela raden dragbar. Det gör det inte: `tauri-2.11.5`:s
`src/window/scripts/drag.js:66` returnerar `el === composedPath[0]` för ett **bart**
attribut — alltså drar bara klick där titelraden SJÄLV är målet. Varje barn i raden
blir en död yta.

Det är därför `.tb-logo` har `pointer-events:none` (ett trick som såg ut som en
detalj men är det som gör att man kan dra i loggan). När motorstatusen flyttades in i
titelraden i 0.4.6 återuppstod problemet på en ny yta.

Två lösningar, och valet beror på om elementet behöver pekhändelser:
- `pointer-events:none` — enklast, men elementet kan då inte ha tooltip, hover
  eller klick.
- `data-tauri-drag-region="deep"` — hela subträdet drar, och pekhändelser fungerar
  som vanligt. `#bcRow` bär Broadcasting-felet i sitt `title`, som är enda stället
  felet syns, så där krävdes "deep".

Attributet tar också värdet `"false"` (blockerar dragning för elementet OCH dess
föräldrar), vilket är rätt om man någon gång lägger ett textfält i titelraden.
Knappar behöver inget: `isClickableElement()` låter `BUTTON`, `INPUT`, `A` m.fl.
blockera dragning av sig själva.

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

**En tredje sak som följde av OS-dölningen:** grinden hade en fördröjning
(`GATE_HOLD_MS`) för att en tappad ram mitt under körning inte ska släcka overlayn.
Den gällde även VID START, så overlayn syntes i ~1,5 s vid varje appstart innan den
försvann — rapporterat från riktig användning. Fördröjningen gäller nu bara efter att
ACC varit ansluten någon gång, och `lib.rs` skapar dessutom fönstret med
`.visible(false)` när grinden är på, så det aldrig hinner ritas alls. Skalet skickar
då `osHidden:true` i `__OVERLAY_INIT__` — utan det hade bus.js trott sig aldrig ha
dolt fönstret och vägrat visa det när ACC ansluter, alltså en permanent osynlig
overlay.

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

### 8.5c Grinden ägde synligheten den inte hade rätt till
Rapporterat från riktig körning (0.4.1): mitt i en session dök overlays upp när man
tabbade ur ACC, och gick sedan **inte att stänga av** — ögonknappen såg ut att inte
göra någonting. Två symptom, två separata fel, och det ena dolde det andra.

**Fel 1: grinden återställde en AVSTÄNGD overlay.** Att tabba ur ACC stallar det
delade minnet en stund → `connected:false` → grinden döljer fönstret → man tabbar in
igen → `connected:true` → grinden `show()`:ar fönstret tillbaka. Den återställningen
brydde sig inte om att användaren stängt av overlayn, så varje ut- och intabbning
tände den igen.

§8.5b:s regel — *"grinden får BARA visa fönster den själv har dolt"* — såg ut att täcka
detta men gjorde det inte: grinden **hade** dolt fönstret. Den visste bara inte att
skalet höll det stängt av ett helt annat skäl. Regeln behöver alltså en andra del:
**en avstängd overlay ägs helt av skalet, och grinden får varken dölja eller visa
den.** `lib.rs` skickar `enabled` i `__OVERLAY_INIT__` och ett `enabled`-event vid
varje ändring; `bus.js:_applyOsVisibility` returnerar direkt när den är av.

Eventet skickas **före** `show()`/`hide()` i `set_enabled`, så bus.js har släppt sitt
anspråk innan skalet rör fönstret.

**Fel 2: `connected` säger ingenting om fokus.** ACC fortsätter skriva sitt delade
minne när fönstret inte har fokus, så grinden hade ingen anledning att dölja något —
overlays låg kvar överst på skrivbordet. Det går bara att lösa genom att fråga
Windows: `lib.rs:foreground_is_foreign()` läser förgrundsfönstrets process var 400:e
ms och skickar `foreground`-eventet **vid ändring**.

Funktionen är medvetet **fail-safe**: den svarar `true` bara när den POSITIVT
identifierat en främmande process. Inget förgrundsfönster, `OpenProcess` nekas
(förhöjd process), namnet går inte att läsa → `false`, alltså dölj inte. Ett falskt
positivt hade släckt overlayn mitt i en kurva; ett falskt negativt betyder bara att
den ligger kvar som förut. Våra egna fönster räknas aldrig som främmande — man ska
kunna använda kontrollpanelen medan man ser overlayn.

**Det enda verkligt farliga utfallet är att ACC inte känns igen** — då är ACC
"främmande" och overlays göms under hela loppet. Därför testas TVÅ oberoende
kännetecken och det räcker att ett slår till: binärnamnet
(`AC2-Win64-Shipping.exe`, Unreal-namnet) eller att sökvägen innehåller Steams
mappnamn `assetto corsa competizione`. Båda är stabila, men **ingen av dem är
verifierad mot spelet igång** — se §7. Går overlays inte att få fram i ACC är detta
första stället att titta, och användarens nödutgång är att slå av "Endast när ACC
kör".

Verifierat i drift här: ett annat program i förgrunden ger `foreign=true`, vårt eget
fönster ger `foreign=false`, och eventet skickas bara vid ändring (två rader i loggen,
inte 2,5 per sekund).

Beteendet hänger på **"Endast när ACC kör"**, som redan betyder "visa bara overlays
när ACC är relevant". Det är alltså användarens av-knapp även för detta, och en
inspelningsrigg som vill ha overlays framme hela tiden slår av den som förut.

Två saker till som föll ut av arbetet:
- **Ingen hysteres på fokus.** `GATE_HOLD_MS` finns för tappade ramar; att tabba ut är
  ingen tappad ram. Dölj direkt, visa direkt.
- **Edit-läget måste vinna över hela grinden, inte bara över fönstret.** Förut
  tvingades bara OS-synligheten på i edit-läge medan `visibility:hidden` låg kvar —
  man fick ett synligt men **tomt** fönster att sikta på när overlayn skulle dras på
  plats. `_applyGate` nollställer nu `hidden` i edit-läge, så både fönstret och
  innehållet kommer tillbaka.

### 8.5d Förhandsvisningens bakgrunder måste gå via data-URL
Panelen kan visa en banbild bakom overlayn. Det uppenbara vore att peka en
`<img>`/CSS-bakgrund på `../shared/preview-backgrounds/spa.webp` — och det fungerar
för de INBYGGDA bilderna. Men kravet var att man ska kunna **lägga till egna bilder i
en mapp**, och då håller det inte:

**Den paketerade appen läser sitt webbinnehåll ur ett arkiv inbäddat i exe:n, inte
från disk.** En fil användaren lägger i katalogen finns alltså inte på någon URL som
webviewen kan hämta — den skulle listas men aldrig gå att visa. (`bundle.resources`
lägger visserligen en KOPIA på disk i `resource_dir/web`, men den finns bara för
motorns OBS-HTTP-server och är inte det webviewen laddar.)

Därför lämnar `get_background` ut bilden som **data-URL**: samma väg för inbyggda och
egna, i dev som i release, utan att öppna asset-protokollet. Kostnaden är base64 över
IPC:n, vilket är oväsentligt när det sker vid ett klick — panelen cachar dessutom per
filnamn.

- Två kataloger: inbyggda i `resource_dir()/web/shared/preview-backgrounds` (dev:
  repots `src/shared/preview-backgrounds`), egna i
  `%APPDATA%\com.accoverlay.app\preview-backgrounds`. **Egna vinner vid namnkrock**,
  och bara den katalogen överlever en uppdatering — installeraren skriver över den
  andra.
- `get_background` tar ett FILNAMN, aldrig en sökväg. Utan kontrollen hade `../../..`
  i id:t lämnat ut vilken fil som helst på disken till webviewen.
- Listan läses om varje gång menyn öppnas. Det är hela poängen med "lägg en fil i
  mappen": den ska dyka upp utan omstart.
- Halftone-rastret är ren CSS (`radial-gradient` + `background-size`), inte en bild:
  det blir knivskarpt i alla storlekar och på alla DPI. Det ligger ovanför bakgrunden
  men **under** overlayn — ett raster över själva overlayn hade förstört precis det
  previewn finns för att bedöma.

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

**Det NSIS-installerarna gör vid ett namnbyte gick inte att låsa på samma sätt.**
NSIS avinstallationsnyckel härleds ur `productName`, så bytet gav en ny nyckel och den
gamla installationen blev **kvar**. På användarens maskin ligger fortfarande:

```
ACC Overlay  0.3.3  C:\Users\leo\AppData\Local\ACC Overlay      ← föräldralös
SimMatrix    0.4.x  C:\Users\leo\AppData\Local\SimMatrix
```

Den gamla kan avinstalleras för hand (`…\ACC Overlay\uninstall.exe`) och tar inte med
sig inställningarna — de bor i `%APPDATA%\com.accoverlay.app\` och delas av båda,
eftersom `identifier` med flit inte byttes. Det är alltså ofarligt att städa, men det
är också ett skäl till att inte döpa om produkten igen i onödan.

### 8.8e "Uppdateringen fungerar men försvinner när jag stänger appen"
Rapporterat från riktig användning av 0.4.0: användaren fick köra **Sök uppdatering
vid varje start**. Uppdateringen gick igenom, men nästa gång appen startades var den
gamla versionen tillbaka. Det låter som att något inte sparas — det är det inte.

`bundle.targets` stod på `"all"`, vilket på Windows bygger **både MSI och NSIS**.
tauri-action lägger då in båda i `latest.json`, och den generiska nyckeln som
updateraren faktiskt slår upp — `windows-x86_64` — pekade på **MSI:n**:

```
"windows-x86_64"       → SimMatrix_0.4.0_x64_en-US.msi     ← den updateraren använder
"windows-x86_64-msi"   → …_en-US.msi
"windows-x86_64-nsis"  → …_x64-setup.exe
```

Men den installerade appen kom från **NSIS**, som installerar per användare i
`%LOCALAPPDATA%\SimMatrix` (avinstallation i `HKCU\…\Uninstall\SimMatrix`). MSI:n
installerar per maskin i `C:\Program Files\`. Två olika installationstekniker på två
olika platser: MSI:n kan inte uppdatera NSIS-installationen, den lägger bara en ANNAN
kopia bredvid. Genvägen pekar kvar på den gamla — alltså "det återställs".

Fixen är att bara bygga **ett** installerformat: `"targets": ["nsis"]` plus
`bundle.windows.nsis.installMode: "currentUser"`, så att `windows-x86_64` pekar på
setup.exe och updateraren skriver över den installation som faktiskt körs.

- **Verifiera aldrig updateraren på "det stod Klart".** Kontrollera nyckeln
  `windows-x86_64` i den publicerade `latest.json` mot var appen ligger på disk:
  ```powershell
  curl -sL https://github.com/leog1/RaceRipp_Overlay/releases/latest/download/latest.json
  Get-ItemProperty HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\* |
    Where-Object DisplayName -match SimMatrix | Select DisplayName,DisplayVersion,InstallLocation
  ```
  Står det `.msi` i den ena och `AppData\Local` i den andra är det den här buggen.
- **`wix.upgradeCode` ligger kvar i konfigurationen** trots att MSI inte byggs. Den är
  inert där, men värdet är omöjligt att räkna ut i efterhand (§8.8c) — det står kvar
  som dokumentation ifall MSI någonsin ska tillbaka.
- **`process::exit(0)` i updateraren går förbi appens avslutsväg.**
  `tauri-plugin-updater`s `install_inner()` startar installeraren och avslutar
  processen direkt — varken `CloseRequested`-hanteraren eller `RunEvent::Exit` körs,
  så positioner som dragits under sessionen hade gått förlorade vid varje
  uppdatering. Panelen anropar därför `prepare_update` (sparar lägen + stoppar motorn)
  innan `downloadAndInstall()`. Lägg till nya "spara vid avslut"-saker på BÅDA
  ställena.
- Panelen visade tidigare samma text — *"Uppdateringar är inte konfigurerade än"* —
  för varje fel, inklusive riktiga installationsfel. Det var en direkt orsak till att
  buggen ovan var osynlig i två utgåvor. Visa alltid `errMsg(err)`.

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
- ~~Fonten hämtas från Google Fonts.~~ **LÖST i 0.4.7.** Montserrat ligger nu i
  `src/shared/fonts/` som **variabla** woff2 (latin + latin-ext), med `@font-face`
  i `tokens.css` — alltså en enda fil per unicode-block för hela viktskalan 100–900,
  och `wght`-raden är därför ett intervall och inte ett tal. Alla tre HTML-filerna
  importerar redan tokens, så `<link>`-raderna till Google kunde tas bort rakt av.
  Latin-ext ingår för att förarnamn ur Broadcasting-entry list är polska, tjeckiska
  och turkiska lika ofta som svenska. Licens: SIL OFL 1.1, fri att bunta i ett
  MIT-projekt. `http_static.py` mappar `.woff2` explicit — Pythons `mimetypes` känner
  den inte (kontrollerat: `guess_type` ger `None`), och en OBS-källa som ritar i fel
  font för att servern ljuger om innehållet är svår att hitta.
  Panelen sätter dessutom `font-family:inherit` på `button,input,select,textarea` en
  gång globalt: formulärkontroller ärver inte typsnitt, så varje ny kontroll som
  glömde sin egen `font:inherit` ritades i Segoe UI mitt bland Montserrat.
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
**`externalBin` gäller ALLA cargo-kommandon i `src-tauri/`, inte bara bygget.**
`tauri-build` validerar sökvägen vid KOMPILERING, så även `cargo check` och
`cargo test` faller direkt med
`resource path binaries\acc-engine-...exe doesn't exist` om sidecarn saknas — innan
en enda rad kod kompilerats. Lokalt märks det aldrig, för där ligger binären kvar
sedan förra bygget. I CI gör det det: `cargo test`-steget låg först före
sidecar-steget och fällde hela v0.4.2:s första release (bygget hoppades över, så
ingenting publicerades — men ingenting släpptes heller). Lägg alltid nya
cargo-steg **efter** "Bygg Python-motorn (sidecar)". Vill du reproducera felet
lokalt: byt namn på binären och kör `cargo test`.

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
