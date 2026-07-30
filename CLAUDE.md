# SimMatrix — projektkontext (handoff)

> **Till en ny AI-assistent:** Läs denna fil + `README.md` + `src/shared/tokens.css`
> så har du hela bilden. Detta är ett pågående bygge; nedan står vad som är gjort,
> vad som är kvar, och vilka beslut som redan är fattade (ändra dem inte utan skäl).
> > **§8 är den viktigaste sektionen.** Där står fällor som redan har kostat tid att
> upptäcka. Läs den innan du rör sidecarn, fönsterpositioner eller en overlays
> renderloop — flera av dem syns INTE i `cargo check` eller i en webbläsare.
> > **§7 säger vad som är VERIFIERAT kontra antaget.** Blanda inte ihop dem.
> > Denna fil är enda sanningskällan för projektkontexten. `CONTEXT.md` pekar hit.

> Filen hålls medvetet fri från versionslogg: den beskriver hur systemet ÄR och
> vilka regler som gäller, inte i vilken ordning det blev så. Historik finns i
> `git log`. Nämn en version bara när den är löpande relevant (t.ex. "otestat sedan
> X" i §7).
## 1. Vad projektet är
Modulärt overlay-paket för **Assetto Corsa Competizione (ACC)**.
Version 0.5.2.
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
`values`/`unit`/`alpha`/`gradient`), och kontrollpanelen bygger reglaget/väljaren
generiskt ur det. Panelen känner inte till en enda overlay vid namn. `type` får utelämnas
och betyder då `bool`. Rust validerar värdet mot schemat innan det sparas eller
skickas (§8.3b).

`"gradient": true` på ett färgalternativ betyder att värdet får vara en
**tvåstoppsgradient** i stället för en färg, i exakt formen
`linear-gradient(<0..360>deg, <hex> 0%, <hex> 100%)` — panelen bygger den och
`lib.rs:is_gradient()` validerar den tecken för tecken (värdet går rakt in i CSS, se
§8.4j). Flaggan hör BARA på ett alternativ vars token används som en YTA
(`background`): en gradient är ogiltig i `stroke`, `fill`, `border-color` och
`background-color`, och elementet slutar då ritas i stället för att falla tillbaka på
något. Kontrollera var tokenen faktiskt används först — delta-barens `col-track` sitter
på `stroke` och får alltså INTE flaggan, medan inputs-traces `col-track`
(pedalspalternas botten) är en `background` och får den.
`hz` i registret sätter overlayns rendertakt (§8.5).

**Delta hör också till overlayn.** Motorn räknar ut ALLA referenskällor som gäller
(förra varvet, sessionens bästa, MoTeC-filen) och lägger dem i ramens `refs`; VALET görs
av reglaget `delta-source` i varje overlay som kan visa ett delta. Motorn vet alltså
ingenting om panelens inställningar, och två overlays kan visa olika referens samtidigt.
Se §8.8f — där står varför det inte får bli en global inställning.

**`presets` i registret följer samma regel.** En preset är ett sparat
UTSEENDE — `scale`, `opacity` och de `options` den nämner:
```json
"presets": [{ "id": "natt", "label": "Natt", "opacity": 0.8,
              "options": { "col-green": "#0DE622" } }]
```
Fyra saker som är avsiktliga och lätta att råka bryta:
- **Presetten är PARTIELL.** Fält den inte nämner lämnas ORÖRDA. `sanitize_preset`
  får därför INTE anropa `sanitize_options`, som fyller i registrets standardvärden —
  då hade en färgpreset tyst nollställt varje annat alternativ i samma overlay.
  Det finns ett test som faller på precis den förväxlingen.
- **`scale` bör utelämnas i en INBYGGD preset.** Skalan är monitorberoende, och en
  färgpreset som samtidigt tvingar 1,2× på någon som kört in sin layout är
  påträngande. En preset man sparar SJÄLV fångar däremot allt, för då är det just den
  kombinationen man vill tillbaka till.
- **Position och av/på ingår inte.** Position är layout, inte utseende; och en preset
  ska aldrig kunna släcka en overlay man just tänt.
- **Inbyggda i `registry.json`, egna i `settings.json`** (`presets`-kartan, per
  overlay-id). En inbyggd ska finnas på en NY installation, och en fil i
  app-config-mappen följer per definition inte med en nedladdning. Egna presets ligger
  utanför `OverlayState` med flit, så de överlever `reset_overlay`: "nollställ
  utseendet" ska inte kasta de utseenden man sparat.
  Vill du BEFORDRA en egen preset till inbyggd: kopiera objektet ur `settings.json`
  in i registret (`list_presets` returnerar hela värdet, så panelen kan visa det som ska
  klistras in). Registret har tre TOMMA platshållare per overlay. Panelen visar dem
  streckade och oklickbara — att i stället dölja dem hade gjort att platserna såg ut att
  inte finnas förrän de fylldes, och då vet man inte att de går att fylla.
**`layouts` i settings.json är nästa nivå ovanför presetsen.** En preset är utseendet
på EN overlay; en **layout** är hela skärmen: vilka overlays som är på, var de sitter,
hur stora de är och hur de ser ut. Tre regler som hänger ihop och som var för sig är
lätta att bryta:
- **Medlemskap ÄR påslagen.** "Lägg till i layouten" och "ta bort" är `set_enabled` —
  samma väg som ögonknappen i Overlays-fliken. Två sätt att slå på samma overlay hade
  oundvikligen glidit isär. Följden: en layout kan aldrig innehålla en overlay den
  samtidigt släcker, och `sanitize_layouts` rättar ett `enabled:false` som ändå dyker upp.
- **Exakt EN layout är aktiv, och den är LIVE-BUNDEN.** `save_settings` kör
  `sync_active_layout`, som speglar det gällande läget in i den aktiva layouten vid varje
  sparning. Det finns alltså inget spara-steg, och — viktigare — ingen andra sanning:
  `settings.overlays` ÄR läget, layouten är en kopia av det. Lägg inte till en väg som
  skriver till en layout direkt.
- **Att välja en layout är att aktivera den.** Panelens skärmvy visar alltid det gällande
  läget, alltså de riktiga fönstren. Att kunna redigera en INAKTIV layout hade krävt en
  andra redigeringsväg som inte syns någonstans medan man använder den.
`activate_layout` skriver ut layouten: storlek, POSITION, always-on-top, av/på och
samtliga `config`/`option`-event. Position är det tillägg mot `apply_preset` som är lätt
att glömma — utan den står overlayn kvar där förra layouten lade den, vilket är precis
det man bytte layout för att slippa. Att ta bort en layout släcker ingenting: läget bor
i `overlays` och står kvar.

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
`ldparser.py` committas **inte** (GPL), utan hämtas lokalt och står i `.gitignore`. Den
  bakas ändå in i den distribuerade binären, så GPL gäller för själva UTGÅVAN även om
  filen inte ligger i repot. Medvetet val, men värt att veta om releaser sprids bredare.
  Arkitekturjämförelsen mot Race Element som motiverade §8.5:s delade renderloop,
  det typade optionsschemat och Broadcasting-källan (§8.6d) ligger i
  `.race-element-notes/findings.md` — **lokalt och gitignorerat**, eftersom det är
  research om GPL-kod. Finns den inte i din klon är det väntat.
- **Namn:** appen heter **SimMatrix** (hette "ACC Overlay" t.o.m. 0.3.3). Bytet är
  medvetet bara kosmetiskt — `identifier` och MSI:ns `upgradeCode` är orörda, se §8.8c
  innan du rör något namnrelaterat.
  Internt heter saker fortfarande `acc-*` (Cargo-paketet `acc-overlay`, sidecarn
`acc-engine`, Python-paketet `acc_engine`); att döpa om dem berör `externalBin`,
`build_sidecar.py`, `verify_sidecar.py`, CI och `lib.rs` — risk utan vinst för
  användaren, som aldrig ser namnen.
- **Repo:** publikt och heter fortfarande `leog1/RaceRipp_Overlay`. Medvetet:
  updater-endpointen i redan installerade 0.3.x pekar dit, och ett namnbyte hade gjort
  dem
  beroende av GitHubs omdirigering för all framtid. OS-kodsignering (SmartScreen)
  uppskjuten; updater-signatur räcker.
- **Settings:** enkel JSON i `%APPDATA%\com.accoverlay.app\settings.json` (ej LiteDB).
- **FPS (LÖST):** overlay-fönstren är **små och tajt sizade** runt innehållet — INTE ett
  fullskärms transparent fönster (det tvingar DWM att komponera hela skärmen varje frame).
  Dessutom: inga backdrop-blur över spelet (`--glass:none`), DOM-skrivningar bara vid
  ändring, 30 Hz-tak, animera bara `transform`/`opacity`. Detta löste användarens FPS-tapp.
  Fönstret **stängs helt** när grinden döljer overlayn (§8.5b) —
  ett dolt innehåll räcker inte, fönstret komponeras ändå.
- **Om någon föreslår "gör om allt till canvas för prestanda":** delta-baren ska
  förbli SVG/DOM. Den skriver bara vid ÄNDRING och kostar noll när inget rör sig,
  medan en canvas hade rensat och ritat om 30 ggr/s oavsett — canvas ersätter
  målningsarbetet, det försvinner inte till GPU:n. Canvas är rätt för TÄTA traces
  (inputs-trace, kommande grafer).
  Mätningen i §8.5b visade dessutom att kostnaden satt i komposition och
  renderloopar, inte i DOM-skrivningar.

(Ett sådant förslag ligger i den gitignorerade `optimeringsförslag_gemini.md`; svaret på
det är den här punkten.)
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
delta-baren låg en gång på 1300×460 för 927×252 innehåll, alltså 373×208 död yta som DWM
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

Typografi: **Montserrat**, SemiBold (600) primär; siffror alltid **tabular** (hoppar
ej). Animation: mjuk lerp mot målvärde; respektera `prefers-reduced-motion`. Renderare
per element: **SVG** (gauges/bågar/ikoner), **HTML/CSS** (paneler/text/staplar),
**Canvas** (täta traces/grafer, DPI-korrekt).
### 4b. Kontrollpanelens chrome
Ligger också i tokens, i ett eget block prefixat `--ui-`
(ytor, linjevikter, radier, typskala, fokusring, kolumnbredder). Overlays läser inget
därifrån — prefixet finns för att ett `col-<token>` i registret skriver rakt på
`--<token>` (§4) och aldrig ska kunna råka träffa panelens värden. Reglerna:
- **Djup kommer av kant + sheen, inte av kontrast.** Stegen mellan ytorna är små med
  flit. Kanten på en BEHÅLLARE är mörk (`--ui-edge-dk`), på en liten KONTROLL ljus
  (`--ui-edge`): ljus kant = "ytan fångar ljus", mörk = "här slutar materialet". Recepten
`--ui-raise`, `--ui-recess`, `--ui-lip`, `--ui-card-in` utgår alla från att **ljuset
  kommer uppifrån** — det avgör om den ljusa raden ligger överst eller underst.
- **Ytornas RIKTNING bär betydelse.** `--ui-surf-hi` (hovrad/vald rad) · `--ui-card` ett
  steg ÖVER `--app-bg` · `--ui-stage` (previewn) ett steg UNDER · `--ui-inset` (spår och
  fält, mörkast). Över panelen = något man RÖR VID, under = något man TITTAR IN I. Lägg
  därför inte kortet på previewns yta (rutan man BEDÖMER och rutan man STÄLLER IN blir
  likadana och högerkolumnen tappar hierarkin), och inte kontrollerna på `--ui-inset`
  (nedsänkt fält i nedsänkt kort → reglagespår svart på svart).
- **Yttre slagskugga = elementet flyttar sig i z-led.** Alltså bara menyer, tooltips,
  toasten. Ett kort eller en preview som ligger stilla i sitt flöde får ingen — särskilt
  inte ett kort kant i kant med sin behållare, där en suddig skugga under kanten läser
  som ett renderingsfel.
  **Behöver något djup: kant och sheen, inte oskärpa.**
- **Glow är en signal, inte en yta.** Bara två kvar, båda nedtonade: statuslysdioden och
  växlarknoppen — saker vars ENDA uppgift är att synas i ögonvrån. Behöver ett element
  glow för att läsas är det färgen eller kontrasten som är fel.
- **En röd i panelen: `--ui-brand` (#A41F1F), samma som ordbilden.** Panelens chrome
  rör aldrig `--rail` (#D10404) — den är overlayernas och ställbar per overlay, och två
  röda intill varandra läser som två varumärken. Rött används BARA varumärkesbärande:
  brandbaren, aktiva flikbrickan, ordbilden. Undantaget är `--red` (#FF3B3B) på
  motorstatusens offline-prick, som är en SIGNALfärg (§4) och inte varumärke.
- **Brandbaren är TVÅ linjer à 1 px: röd överst, vit (`--ink`) under.** Summan är samma
  2 px som en enkel linje, alltså ingen layoutändring. Två
  tunna linjer i olika kulör läser som en rand på en bilsida; en enda 2 px-linje
  läser bara som "här slutar titelraden". Vitt är redan ordbildens konturfärg. Gör dem
  inte 2 px var — då blir det en 4 px bård som
  konkurrerar med titelraden.
- **Kanterna är dämpade (`--ui-edge-dk` 0,45).** Den mörka kanten sitter på kort, list,
  listkolumn, menyer, verktygsblock och varje liten knapp
  samtidigt, och en nästan svart 1 px-linje mot en yta som bara är några
  luminanssteg ljusare gör att konturerna läses före innehållet.
  Kortet har i stället `--ui-card-wash`, en ljusvask på 2,2 % över övre dryga
  tredjedelen. **Den ska förbli precis på gränsen till omärklig:** en gradient man
  KAN SE blir en gradient man ser åtta gånger i ett kort med åtta rader, och då läser ytan
  som blank plast i stället för material.
- **4-punktsraster.** Padding, gap, radhöjd (`--ui-row-h`), ikonstorlek,
  listbredd: multiplar av
4. Typskalan har inga halvpixlar
  (12,5 px renderades som 12 på en skärm och 13 på nästa). Behöver du ett mellanting:
  ta grannvärdet, inte 2 px emellan.
- **Radierna är SMÅ och pillerformer finns inte.** `--ui-r-xs/sm/md/lg` = 2/4/6/8 px
  (halverade i 0.5.1 från 6/10/14). En 14 px radie på ett 1000 px brett kort läser som
  en app-widget, inte som ett instrument, och tillsammans med `border-radius:999px` på
  varje bricka och chip var det den tydligaste kvarvarande signalen om att gränssnittet
  var genererat snarare än ritat — mätverktyg har nästan raka hörn. Kvar som piller är
  BARA växlarens spår och knopp: den är en pinnswitch och läser fel som rektangel.
  Lägg alltså inte tillbaka 999 px på listbrickan, presetchipsen eller menytaggarna,
  och håll nya radier i tokens (inga råa px i en regel).
- **En kontrollkolumn, och alla kluster är 376 px breda.** Etikett vänster, kontroll i
  högerkolumnen (`--ui-ctl-w`). Reglage 300 + gap 16 + värde 60 = 376; färgrad 200
  (`.aslot`) + 16 + 96 (hexfält) + 16 + 48 (färgruta) = 376; väljaren 376 rakt av. Det
  är det som gör att etiketterna slutar på samma lodräta linje i stället för att
  sicksacka några pixlar — ny kontrolltyp: räkna ut klustret och landa på
376. Etiketterna har SAMMA typografi oavsett kontrolltyp, annars ser de två kortsorterna
  ut att komma från olika program.
  **Gradientknappen får INTE en egen kolumn** utan bor först i `.aslot` (24 + 12 px av
  alfa-reglagets plats). En egen kolumn hade krympt klustret på ALLA färgrader för en
  knapp som finns på tre av tolv. Och `.aslot` måste ha `min-width:0` — se §8.4h, den
  fällan slog till en tredje gång just här.
- **Två sorters rubrik, och skillnaden är avsiktlig.** KORTRUBRIK (`.card
> h3`, `.list-head`): versal, spärrad, **amber, utan streck** — versaler plus egen färg
  behöver ingen tredje markör. GRUPPRUBRIK i inställningsstacken (`.ghead`): versal,
  spärrad, **neutralt grå (`--dim`) med en 2 px amberstapel**. Samma princip, bara EN
  signal bär färgen — här stapeln i stället för texten. Stapeln kan inte vara
  `--ui-brand`: den sitter fyra gånger i samma stack, och fyra röda markörer upprepar
  ordbildens färg där den inte identifierar något. Lägg alltså inte streck på en
  kortrubrik, och gör inte en grupprubrik amber i TEXTEN.
- **Inställningarna är EN yta indelad i hopfällbara grupper (`.stack` > `.grp`).**
  Här låg fram till 0.5.1 ett enda kort med fyra rubriker rakt i flödet. Det gick isär på
  två sätt: rubrikerna var det enda som skilde grupperna åt (en lista med tolv färgrader
  flöt ihop med gruppen ovanför), och det fanns ingen väg att fälla ihop en grupp man
  inte arbetar i — tolv färgrader tvingade fram skrollning för att nå ett reglage tre
  rader ovanför. Reglerna nu:
  - **Separationen är EN linje i behållarens egen kulör** (`--ui-edge-dk` mellan
    grupper), ingen egen bakgrund, ingen inre radie, ingen skugga. Ytan ska förbli en;
    separationen ska gå att SE men inte att räkna. Vill du avdela något inne i en yta:
    linje, inte nytt lager (samma regel som "djup kommer av kant och sheen").
  - **Hela rubrikraden är knappen**, 40 px hög, med radantal till höger. Antalet finns
    för hopfällt läge: en stängd grupp måste säga hur mycket som ligger under den.
  - **Läget sparas i `localStorage`, inte i `settings.json`.** Det är panelens vy-state
    — det hör inte till en overlay, ska inte följa med en preset och ska inte kunna
    göra settings.json ogiltig (§8.3b). Utan localStorage är allt öppet, vilket är rätt
    utgångsläge.
  - **En tom grupp döljs HELT** (`.grp[hidden]`), inte bara sina rader: en tom
    hopfällbar grupp är värre än ingen grupp.
- **Stacken är exakt lika bred som förhandsvisningen.** `#previewBox` har
  `margin:16px 20px 0` och `.controls` `padding:0 20px 24px` (+ `margin-top:16px`) —
  samma 20 px, och ändras det ena måste det andra följa med. Två block med olika bredd
  ovanpå varandra läser som två olika vyer hur små pixlarna än är. Referens, Om och
  Inställningar behåller sin smala spalt (`.cards.single`); de har ingen preview
  att linjera mot.
- **Grönt betyder "på"** (PÅ-brickan, påslagna växlare). Därför är
  fokusringen amber och reglagens fyllnad neutralt vit — ett halvdraget reglage är
  inget tillstånd.
- **Vänsterlisten är en REN IKONLIST på 60 px.** Namnet
  kommer i en tooltip vid hover/fokus. Aktiv flik = 40×40 bricka i `--ui-brand-fill`
  med ikonen i `--ui-brand-lt` (en ljus tint av samma röda — en tint är inte en
  andra kulör). Etiketterna sprängde listen två gånger (§8.4h), så **ett fliknamn är inte
  längre bundet av listens bredd**.
  Tooltip-spannet (`.nav .tip`) är RIKTIG text i DOM:en, inte ett `title`-attribut:
  det ger knappen dess tillgängliga namn (annars är fem knappar namnlösa för en
  skärmläsare) och Windows ritar inte sitt eget verktygstips ovanpå vårt.
- **Presetraden ligger MELLAN previewn och kortet.** En preset är en genväg till hela
  kortets innehåll, så den hör ovanför det den
  skriver — inte nere bland de reglage den skriver över. Den är syskon till
`.controls` (som äger skrollen, §8.4f) och står därför kvar bredvid previewn där man ser
  effekten. Ingen egen kortyta och ingen kant: med ram och bakgrund läser vyn som tre
  staplade lådor.
  Etiketten heter **PRESET och inte UTSEENDE** — stacken under har redan en
  grupprubrik med det ordet.
  **Luften under presetraden ligger i `.controls`:s `margin-top`, aldrig i dess
  `padding-top`.** En padding tillhör innehållet och skrollar bort: högst upp fanns 16 px,
  men efter en pixels skroll låg stackens överkant kant i kant med presetraden — det var
  det som såg ut som en kollision. Marginalen ligger utanför skrollboxen och står still.
  **Aktiv preset RÄKNAS UT** ur nuvarande värden (`presetMatches`), den lagras inte
  som "senast valda": rör man ett reglage efteråt stämmer en lagring inte längre, och en
  markör som ljuger är värre än ingen markör. Markören är amber (grönt betyder "på", och
  en preset är inget tillstånd man slår på). `markActivePreset()` togglar BARA klassen och
  bygger inte om DOM:en — den anropas 60 ggr/s medan man drar ett reglage, och en
  ombyggnad dödar hover (×-knappen försvinner under pekaren) och startar om chipsens
  sidoskroll.
- **Titelraden bär ordbilden till vänster och statusen i MITTEN.** Ordbilden är ritad
  459×55 med en ljus kontur per bokstav; vid för låg höjd hamnar konturen under en
  pixel så bokstävernas hål sluts (mätt genom att rendera 16/18/20/22/24 bredvid
  varandra). Statusen är PRICK + TEXT, ingen yta och ingen kant — en 36 px titelrad har
  inte plats för en tredje ram, och en pillerform där läste som en knapp man kan trycka
  på. Två regler som är lätta att råka bryta:
  - **Bara PRICKEN bär färg.** Texten är alltid `--dim`. Den var tonad i tillståndets
    kulör fram till 0.5.1 och lästes då som en glöd omkring orden: två färgade fält för
    EN uppgift, i den enda raden som ska vara helt lugn. Behöver tillståndet mer vikt är
    det pricken som ska växa. Offline-pricken är röd (`--red` är en SIGNALfärg, §4);
    resten av raden förblir neutral, för att motorn inte hunnit upp vid en kallstart är
    inget fel.
  - **Gruppen är absolut centrerad** (`.tb-center`, `left:50%` + `translateX(-50%)`) och
    ligger inte i flödet: i flödet hamnade "mitten" där ordbildens plus knapparnas bredd
    råkade lägga den, och den FLYTTADE sig i sidled när Broadcasting-raden dök upp mitt
    under körning. Den bär `data-tauri-drag-region="deep"` själv (§8.4i).
  Tillståndsklassen sitter på raden och inte på pricken, för `:has()` finns först i
  Chromium 105.
- Reglagen är egenritade (`::-webkit-slider-*`); `accent-color` ger systemets. Den
  fyllda delen är en gradient med brytpunkten i `--p`, som `paintRange()` sätter. En
  delegerad `input`-lyssnare täcker alla reglage, även de som byggs
  generiskt ur registret — men programmatiska värdeändringar utlöser inget `input`,
  därför körs `paintAll()` när en overlay väljs.
  **Greppet är en FADER** (10×18 px, nästan raka hörn) och inte en boll: en vit cirkel
  på ett pillerformat spår är varje webbformulärs reglage, en stående rektangel i ett
  rakt spår är en potentiometer. Skala inte greppet vid hover (det gjorde den runda) —
  en fader som växer ser ut att glida ur sitt spår; den ljusnar i stället.
- **EN meny i hela panelen (`.pop` + `.popitem`).** Ankaret får vara antingen knappen
  själv eller en behållare runt den — `popTrigger()` letar på båda hållen (§8.4l). Både bakgrundsväljaren och varje
  enum-alternativ bygger sin lista med `popMenu()`. Panelen hade tidigare två sorters
  "välj ett värde": den egenritade menyn och `<select class="osel">`, vars lista ritas av
  WINDOWS — annan typografi, annan radhöjd, annan markeringsfärg, plus en vit ruta i
  WebView2 om man glömmer färga `option`. Det är listan man LÄSER när man väljer, så det
  var den mest synliga inkonsekvensen som fanns.
  Menyn ligger i `<body>` och är `position:fixed`: enum-väljarna bor i `.controls`, som
  skrollar, och en absolut meny där klipptes av behållarens kant på de nedersta raderna
  (alltså färgerna, de som har flest). Priset är att den inte följer med vid skroll —
  därför stängs den vid skroll, vilket ändå är rätt beteende. Den öppnas UPPÅT när det
  inte finns plats nedåt, och den måste gå att styra med tangentbordet (piltangenter,
  Enter, Esc): utan det är den ett steg bakåt mot `<select>`, som kunde det.

- Panelen sätter `font-family:inherit` på `button,input,select,textarea` en gång
  globalt: formulärkontroller ärver inte typsnitt, så varje ny kontroll som glömmer sin
  egen `font:inherit` hade ritats i Segoe UI mitt bland Montserrat.
- **Layout-flikens skärmvy är samma material som förhandsvisningen** — en yta ett steg
  UNDER panelen (`--ui-stage`) med hårfin ljus kant, samma marginal, samma verktygsblock
  i hörnet (`.sbtn`). Skillnaden är höjden: 46 % i stället för previewns 38,2 %, för här
  BEDÖMER man inte, man arbetar. Fyra regler till:
  - **Boxarna är proportionella rutor, inte riktiga overlays.** En riktig overlay är ett
    eget dokument med egen renderloop och egen WebSocket, och fem sådana i panelen hade
    varit fem loopar som tickar medan man kör — previewn fick rivas ur av exakt det
    skälet (§8.5f), och den är EN. Boxarna är i gengäld exakta: `base × skala` mot
    skärmens logiska storlek, alltså samma tal som fönstret får.
  - **Rutnätets linjer är nästan osynliga; PUNKTERNA i korsningarna bär informationen.**
    Det är punkterna man snappar mot, och ett fullt synligt rutnät tävlar med det man
    flyttar. Tätheten anges i KOLUMNER och raderna räknas ut så att cellerna blir
    kvadratiska — ett fast radantal ger ett rutnät som betyder olika saker på 16:9 och
    21:9.
  - **Hjälplinjen vid snappning är amber**, samma signalfärg som fokusringen och den
    aktiva presetens markör. Grönt hade betytt "på", och en snappning är inget tillstånd.
  - **Kanten på skärmen är en `outline`, inte en `border`.** Se §8.4l — det är geometri,
    inte kosmetik.
  Inställningsraderna under vyn är samma `.grp`-mekanik som Overlays-flikens stack, men
  **stängda som standard**: fliken handlar om var något ligger, och fem öppna
  inställningslistor hade begravt skärmvyn. Därför `st[grp.id] === true` och inte
  `!== false` när läget läses ur localStorage.
## 5. Overlay-katalog & status
| # | Overlay | Status | Not |
|---|---------|--------|-----|
| 1 | **Delta + varvtidsrad** | KLAR (look+funktion+animation), kopplad på bussen | cirkel: 0=topp, grön medurs=snabbare, full båge 180°=1.0 s |
| 2 | Delta-graf + minisektorer + hörnkarta | **ej byggd** | hörnkarta/kurvnummer/graf är **banberoende, ritas live** — hårdkoda ALDRIG kurvform |
| 3 | Inputs-HUD (växel/fart/ratt/pedaler) | delvis (inputs-trace KLAR & kopplad) | ratt-vinkel + växel/fart-modul återstår |
| 4 | Inputs-trace (gas/broms + staplar) | KLAR, kopplad på bussen | ABS=gult trace, TC=blått; Canvas rullande; tidsfönster 2–10 s valbart; spökspår mot VALD delta-källa (§8.8f) |
| 5 | Laptime log | **ej byggd** | röd rail, rubriker i amber, delta grön/röd |

**Nästa naturliga bygge:** en overlay i taget, helt klar (funktion+look+animation) innan nästa.
Mät referensbilder pixel-exakt FÖRST; bekräfta struktur i EN avstämning innan kod.

## 6. Filkarta
```
src/shared/tokens.css      designtokens (enda källan)
src/shared/bus.js          WsBus (prenumerera på WS) + wireShell (config/edit/drag)
                           + fontsReady + startLoop (delad renderloop, §8.5)
src/shared/fonts/ Montserrat variabel woff2 (latin + latin-ext), SIL OFL 1.1
src/shared/preview-backgrounds/  inbyggda bakgrunder till panelens preview (§8.5d);
                           användarens egna ligger i app-config-mappen
src/overlays/registry.json KATALOG över overlays (kärnan läser denna)
src/overlays/<id>/index.html  overlay-moduler
src/control-panel/index.html  kontrollpanelen (live-preview i iframe + layout-flikens
                           skärmvy; layouterna bor i settings.json, se §2)
engine/acc_engine/         motorn: __main__, bus, http_static, frame, delta, laps,
                           sources/{mock,acc,acc_broadcast}
engine/acc_engine/laps.py  spelar in varv ur ramarna → förra/bästa varvet som
                           fullvärdiga referenser (delta + pedalkurva), §8.8f
engine/acc_test.py         delade minnet mot riktiga ACC (kör med spelet igång)
engine/broadcast_test.py   Broadcasting mot riktiga ACC (kör med spelet igång)
engine/build_sidecar.py    PyInstaller → src-tauri/binaries/acc-engine-<triple>.exe
engine/verify_sidecar.py kontrollerar att den byggda sidecarn innehåller allt (§8.6c)
engine/ldparser.py         GPL, gitignorerad, hämtas lokalt
src-tauri/src/lib.rs       fönstermanager, kommandon, sidecar+Job Object, hotkey, settings
src-tauri/tauri.conf.json  control-fönster, updater, externalBin, bundle.resources
tests/panel-layout.mjs     layout-flikens geometri, mätt i headless Chrome över CDP
tests/                     regressionstester — läs tests/README.md FÖRST, den
                           förklarar vad varje test bevakar och hur man visar att
                           ett test biter
.github/workflows/release.yml  CI: kör testerna, bygg installer + latest.json vid tagg
```

## 7. Status: verifierat vs kvar
### Verifierat genom att faktiskt köra
- **BÅDA ACC-källorna mot spelet igång** (hotlap): `acc_test.py` och `broadcast_test.py`
  anslöt och gav rimliga värden. **Nivån:** bekräftat i drift av en människa, inte en
  fält-för-fält-jämförelse mot kända sanningar — beter sig ett enskilt fält konstigt
  (särskilt i Broadcasting, §8.6d) är det där man tittar först.
- Motorn: 39 Hz, alla ramfält, inga NaN; WS + OBS-HTTP serverar; en andra instans
  avslutar snyggt med portmeddelande i stället för traceback.
- `pnpm tauri dev` och `pnpm tauri build`: fönster skapas ur registret, sidecarn startar
  och **dödas** vid stängd panel OCH vid `taskkill /F` (§8.1), previewn renderar,
  `bundle.resources` + `--root <resource_dir>/web` ger OBS-HTTP 200 i release.
- **MoTeC-deltan mot en riktig `.ld`** (Spa, Ferrari 296 GT3): `.ldx`-varvvalet ger
  136,250 s mot filnamnets 2:16.265 — 15 ms fel över ett helt varv (0,01 %).
- **Publicerade utgåvor verifierade ur ARTEFAKTEN, inte ur grön CI** (§8.6c): arkivet
  uppackat med 7-Zip, `python engine/verify_sidecar.py <exe>` körd, binären körd —
  referensen laddas, WS ger 30 fält utan NaN, Broadcasting registrerar, OBS-HTTP svarar
  200, `latest.json` signerad för alla plattformsnycklar. **Att kontrollera nya FÄLT i
  den publicerade ramen, inte bara att den startar, är vad som gör verifieringen värd
  något.** Två detaljer: `refTotalMs` är `None` utan ACC ansluten, så det är INLÄSNINGEN
  av referensen som verifieras och inte delta-vägen; och starta den frysta exen via
  `Start-Process`, för `&` + omdirigering i Git Bash ger tyst ingen output och ser ut
  som en trasig binär.
- **Montserrat i Chrome:** `document.fonts.check` sant för 500/600/700/800, båda
  `@font-face`-blocken `loaded`, Åäö + ŁŚČğ ur rätt block.
- **Motorns per-ram-kostnader MÄTTA** (§8.6f, 2000 iterationer per post på den här
  maskinen): `asdict()` 94,3 µs mot `dict(vars())` 1,1 µs för en ram med 20 bilar;
  `json.dumps` 60 µs; nio referensuppslagningar (tre källor × delta + två pedalkanaler)
  13,3 µs på en 8176-punkters kurva. Det är svaret på "MoTeC-referensen känns dyr":
  matematiken är mätbart gratis.
- **Panelens nya chrome mätt headless** (Chrome, Tauri-stub, `--force-prefers-reduced-motion`,
  1440×900 och golvet 960×600): statusen har `background: rgba(0,0,0,0)` och
  `border: 0px none`, ordbilden 14 px, `--ui-card` = rgb(14,16,15) mot `--app-bg`
  rgb(11,13,12), Data-sektionen renderar delta-källan med rätt fyra etiketter, och kort
  och preview ligger på samma x och bredd (344/1060 respektive 344/580) utan vågrät
  skroll. Att panelen inte kastar något fel under uppstart ingår i mätningen — den låg
  tidigare tyst nog att ett kastat undantag i titelraden inte syntes.

- **Layout-flikens geometri mätt i Chrome** (`tests/panel-layout.mjs`, 1440×900 mot en
  Tauri-stubb): skärmvyn har skärmens proportioner och fyller rutan, varje box ligger och
  mäter exakt som overlayns riktiga fönster (olika mått, skala och position per overlay i
  fixturen), snappningen väljer NÄRMASTE kandidat och skickar det snappade värdet vidare
  som `set_position`, med snappningen av ligger boxen kvar där pekaren släppte,
  inställningsgrupperna är hopfällda med rätt `aria-expanded` och radantal, skärmvyn och
  stacken ligger på samma x och bredd utan vågrät skroll, lägg till/ta bort går genom
  `set_enabled`, och layoutlistan markerar den aktiva. Panelen kastade inget fel.
  Fem medvetet trasiga varianter är körda och samtliga föll (se filens huvud).
- **Layoutkommandonas kärnlogik** (fyra Rust-tester): speglingen tar bara PÅSLAGNA
  overlays och rör aldrig en inaktiv layout, en tom `active_layout` skriver ingenstans,
  inläsningen städar dubbletter/tomma namn/borttagna overlays/orimliga tal och nollställer
  en `active_layout` som inte finns, och id:n blir unika. Två trasiga varianter körda,
  båda föll.

### Kvar att verifiera — läs detta först om du tar över
- **HELA layout-fliken i den riktiga appen.** Ingenting av den är sett utanför Chrome.
  Fyra saker stubben per definition inte kan bevisa, och alla fyra är av den sorten som
  bara syns i drift:
  - **Att dra en box FLYTTAR det riktiga fönstret.** Panelen skickar `set_position`
    strypt (120 ms) medan man drar; att fönstret följer med mjukt och hamnar rätt är
    otestat. Testa med ACC igång i bakgrunden och håll ögonen på FPS — en position är
    lika dyr för DWM som en storleksändring (§8.5e), och dragningen skickar fler anrop
    än ett reglage gör.
  - **Att `activate_layout` verkligen skriver ut layouten**: fönster som flyttar sig,
    ändrar storlek, tänds och släcks i ett svep. Prova särskilt en layout som INTE
    innehåller en overlay som är på just nu — den ska släckas, inte ligga kvar.
  - **Att skärmvyn stämmer med skärmen.** `get_screen` ger den skärm kontrollpanelen
    ligger på; har man overlays på en ANDRA skärm ligger de utanför vyn (negativa
    koordinater eller bortom bredden) och går inte att dra tillbaka. Det är en medveten
    begränsning i v1, men den är inte sedd med två skärmar inkopplade.
  - **Att den aktiva layouten följer med utan spara-steg.** Dra en overlay i edit-läge
    över spelet, gå tillbaka till panelen, byt till en annan layout och tillbaka — den
    dragna positionen ska vara kvar.
- **Att ACC känns igen som förgrundsprocess** (§8.5c). Detektionen fungerar åt båda
  hållen mot andra program och mot vårt eget fönster, men är **aldrig körd mot ACC** —
  spelet har inte funnits på maskinen. Slår igenkänningen fel göms overlays under HELA
  loppet, vilket är den största enskilda regressionsrisken. Testa: kör ut på banan med
  "Endast när ACC kör" på, se att overlays syns i bilen och försvinner vid alt-tab. Gör
  de inte det är `ACC_EXE_NAMES` / `ACC_PATH_HINT` fel.
- **FPS-arbetet i 0.5.0 är inte kört med ACC igång.** Det gäller alla fyra delarna:
  strypningen av reglage-IPC (§8.5e), att previewn laddas UR i stället för att pausas
  (§8.5f), att panelens statussocket stängs, och `apply_size`-hoppet. Rapporten var
  "justerade ett reglage, tappade 30–40 FPS resten av sessionen". Testa exakt så: kör en
  session, alt-tabba, dra skalreglaget fram och tillbaka i tio sekunder, gå tillbaka in
  och jämför FPS mot innan. Sitter tappet kvar är det INTE reglagestormen som var
  orsaken, och nästa misstänkta är att fönstren finns över spelet alls.
- **FPS-spikar efter en krasch i ACC** är rapporterade men ingen mekanism är hittad i
  appen. Grinden kan bara växla en gång per 1,5 s (`GATE_HOLD_MS`), alltså ingen
  visa/dölj-storm, och motorn gör inget extra vid en krasch. Nästa steg är att mäta med
  appen HELT stängd: går spikarna igen då är det ACC:s egen skadefysik/replay.
- **Delta-källan i drift** (§8.8f). Rustsidan, `refs`-kartan och varvinspelningen är
  täckta av tester (`tests/lap_recorder.py`, `tests/delta_source.py`,
  `tests/overlay-delta-bar.mjs`, `tests/overlay-inputs-trace.mjs`) men INGET av det har
  sett riktig ACC-data. Tre saker att titta på: att ett varv faktiskt blir inspelat när
  du passerar mållinjen (`[laps] varv inspelat: …` i motorloggen), att "förra varvet" och
  "sessionens bästa" ger olika delta när de ska, och att spökspåret i inputs-trace ligger
  i linje med ditt eget när källan är ett inspelat varv och inte filen.
- **Att fixarna för de tre in-game-buggarna från 0.3.0 faktiskt löste dem** (blinkande
  overlays var 3–4 s, hack i inputs-trace, MoTeC-delta ur depån och på fel bana).
  Orsakerna är hittade, förklarade (§8.6e, §8.8b) och täckta av tester som faller på den
  gamla koden — **men ingen har kört spelet efteråt**, och symptomen går inte att
  reproducera utan ACC. Fråga användaren innan du antar att de är borta.
- **Broadcasting under RIKTIGT lopp** — hittills bara hotlap, alltså i
  praktiken en bil. Entry list-flödet, omfrågan vid okänd bil och bortstädningen av
  bilar som lämnat sessionen (§8.6d) är testade mot en falsk server men aldrig mot ett
  fullt startfält. Kör `python engine/broadcast_test.py` i en multiplayer-session
  eller ett race mot AI.
- **Installation från installeraren** — den byggs och binärerna är körda ur den, men
  själva installationen (layouten på disk, `resource_dir` där) är inte gjord. Titta
  samtidigt efter en kvarlämnad `C:\Program Files\SimMatrix` från MSI-tiden och den
  föräldralösa "ACC Overlay 0.3.3" i `%LOCALAPPDATA%` (§8.8c).
- **Att updater-kedjan landar i RÄTT katalog** (§8.8e). Fixen — bara NSIS, `installMode:
  currentUser` — går inte att bevisa förrän en installerad version uppdaterar sig och
  startas om. Kontrollera att `Om`-fliken visar den nya versionen.
- **DPI-fixen** (§8.2) och **panelens startstorlek** (§8.2b). Användarens skärm kör
  1920×1080 @ 100 %, där logiska och fysiska pixlar är identiska och `set_size` i
  praktiken är en no-op — själva OMRÄKNINGEN är alltså aldrig körd skarpt. Kräver en
  skärm på 125/150 %, en 4K (200 % → ska bli 1440×900; 100 % → 2880×1800) och en
  1366×768-laptop (ska klampas till golvet 960×600, inte hamna utanför).
- **Panelens design i den RIKTIGA appen.** Hela panelen (ikonlist med tooltips,
  inställningsstacken med hopfällbara grupper, presetraden, statusen i mitten, hexfälten,
  gradientraderna, den delade menyn, kortkommando-inspelningen) är verifierad genom att
  renderas i Chrome headless mot en Tauri-stub i 1440×900 / 1100×900 / 960×600 och
  MÄTAS: preview och stack på exakt samma x och bredd i alla tre (1060/720/580 px), ingen
  vågrät skroll, 16 px mellan presetraden och stacken både i vila och mitt i en skroll,
  ETT etikettläge per kontrolltyp (alla hexfält och färgrutor i samma kolumn), statusens
  text `rgb(127,134,125)` i alla tre tillstånden medan pricken byter färg, grupperna
  fällda och återöppnade med rätt `aria-expanded`, menyn öppnad uppåt med samma bredd som
  väljaren, gradientläget på/av med två undergrupper och ett värde som Rust-testet
  godkänner, och en inspelad kombination (`Ctrl+Shift+E`) skickad till `set_hotkey` medan
  en bar tangent avvisas. Panelen kastade inget fel i någon körning.
  **Men ingenting är sett i den riktiga appen.** Tre saker stubben per definition inte kan
  bevisa: att titelraden fortfarande går att DRA i (§8.4i — statusgruppen ligger nu mitt i
  raden och täcker en del av dragytan), att `#bcRow`:s felmeddelande syns som tooltip, och
  att den mjuka skrollen känns rätt med ett riktigt hjul (den är driven för hand i
  mätningen, se §9). Kvar från förr: de fullbreda korten är trånga på golvet 960 px där
  kontrollkolumnen på 376 px tar en tredjedel av bredden.
- **Gradientbakgrunderna i en overlay.** Rustvalideringen och panelens serialisering är
  täckta av tester, och previewn visar värdet — men ingen har sett en gradient i ett
  riktigt overlay-FÖNSTER, där ytan dessutom är halvtransparent över spelet. Kontrollera
  särskilt pedalspalterna (`col-track` i inputs-trace): de var förut beroende av
  panelbakgrunden genom sin egen genomskinlighet, vilket var hela skälet att de fick
  egna alternativ.
- **Flimret i trace-spetsarna.** Rapporterat i spelet ("de spetsiga pikarna grafen ritar
  ut från gasen flimrar lite"), orsaken hittad och förklarad (miter-spetsar som passerar
  `miterLimit` plus heltalsavrundad x i ett rörligt spår, §8.5) och åtgärdad — men
  ingenting av det syns i ett test, och ingen har kört spelet efteråt. Titta på en
  hastig gaslättning i en kurva: spetsen ska stå still i formen, inte pulsera.
- **Kortkommandots ombindning.** `set_hotkey` registrerar om genvägen i drift och lägger
  tillbaka den gamla vid fel (§8.8g). Tre saker att prova: att en NY kombination faktiskt
  växlar edit-läge, att en kombination som ett annat program äger ger ett fel i panelen i
  stället för att tysta försvinna, och att valet finns kvar efter omstart.
- **Presetsystemet i drift.** Rustsidan är täckt av fyra enhetstester som var
  och en är körd mot en MEDVETET trasig variant och faller där (partiell preset som
  fyller i defaults, ingen optionsvalidering, ingen finite-kontroll på skala, ingen
  fallback på tomt slug). **Men ingen har klickat i den riktiga appen.** Tre saker som
  inte är bevisade:
  att `apply_preset` verkligen ändrar overlay-FÖNSTRETS storlek när presetten bär en
  skala (koden gör samma sak som `reset_overlay`, men det är otestat), att en sparad
  preset finns kvar efter omstart, och att `save_preset` skriver över i stället för
  att skapa en tvilling när man återanvänder ett namn.
- **Att Montserrat laddas i WebView2 och i OBS.** Verifierat i Chrome (se ovan).
  WebView2 är Chromium och bör bete sig likadant, men det är inte kört där, och
  OBS-vägen (`http_static.py` med `.woff2`-mappningen) är bara
  testad mot Pythons egen `http.server`, inte mot vår handler i drift.
- **Overlaysens utseende med ACC igång.** Design, preview och pedalsiffror är mätta i
  webbläsare mot mock-data. Pedalsiffran
  mättes dessutom på en egen provsida, inte i drift: se att "100" faktiskt ser rätt ut
  vid full gas på banan (§8.4g).
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
Detta gav två rapporterade buggar som såg helt olika ut men hade samma orsak.
Overlay-webviewarna anropade `get_config`/`get_globals` så fort de laddade. Två problem:
1. `app.manage()` kördes EFTER fönsterskapandet, så anropen kunde landa innan
   `Mutex<Settings>` fanns. Kommandot svarade med fel, `bus.js` svalde det
   (`.catch`) — och då kom svaret **aldrig**.
2. Även när anropet lyckas är det async, så det finns alltid ett fönster där
   overlayn ritar med CSS-defaulten.

Symptomen: overlayn ritas i CSS-defaultens skala i ett fönster skapat för den
**sparade** skalan → ser **avkapat** ut (och "löser sig" när man rör skalreglaget,
för det skickar ett `config`-event som faktiskt kommer fram). Och grinden "endast när
ACC kör" gäller aldrig → overlayn visas fast den ska vara dold.

Hur olika det kan se ut: delta-baren har `--ui-scale:0.9` hårdkodat i CSS och råkade se
rätt ut vid sparad skala 0,9; inputs-trace har `--H:150px` (skala 1.0) och ritade vid
sparad skala 0,6 sitt innehåll i ett fönster 40 % för litet — det som klipptes bort var
traces och
pedalstaplar, alltså **såg den ut att inte finnas alls**.

Fixen: `lib.rs` injicerar
`window.__OVERLAY_INIT__ = {id, scale, opacity, gate, hz, enabled, osHidden, options}`
med
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

(Upptäckt genom att `ConvertTo-Json` i PowerShell 5.1 skrev `0,6` med svensk locale.
**Redigera aldrig JSON med PowerShell här** —
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

**Bakåtkompatibilitet går åt BÅDA håll, och nedgraderingsriktningen är den som glöms.**
Att ny kod läser gamla filer är lätt att kontrollera. Men en ÄLDRE build som möter ett
fält den inte kan deserialisera (0.2.5:s `HashMap<String, bool>` mot `"window": 4.5`)
utlöser skyddet ovan — filen döps om och layout, skalor OCH `reference_ld` går tyst till
standardvärden. Det hände på riktigt under utvecklingen. Räddningen är att inget är
förlorat: `settings.corrupt.json` ÄR den gamla filen, intakt. Lägg alltså aldrig till
ett settings-fält utan att tänka igenom nedgraderingsvägen — och kolla efter en
`settings.corrupt.json` innan du tror att någon tappat sina inställningar.

### 8.4 `emit` och inte `emit_to` för config/option
Kontrollpanelens preview kör overlayn i en **iframe inuti "control"-fönstret**, så
`emit_to("delta-bar", …)` når den aldrig. Därför skickas `config`/`option` till alla
fönster och filtreras på payloadens `id` i `bus.js`. Previewen får sitt id via
`?id=<overlay>` i iframe-URL:en, eftersom fönstrets label där är `control`.

### 8.4b Förhandsvisningen får INTE Tauris event — men den KAN anropa invoke
§8.4 räcker inte:
previewn kör i en `<iframe>` inuti kontrollfönstret, och `emit` går via
`webview.eval()` — som bara kör i **huvudframen**. Previewn reagerade därför aldrig
på att man slog av/på ett alternativ; man fick se skillnaden först i spelet.

**Asymmetrin är hela poängen och den är lätt att gissa fel på.** Det är inte så att
`__TAURI__` saknas i iframen:
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
Rapporterat: att dra skalreglaget syntes inte i previewn (rätt, §8.4c) — men bytte man
till en annan overlay och **tillbaka** hoppade previewn plötsligt i storlek. Orsaken är
asymmetrin i §8.4b: previewn får inget `config`-event när man drar reglaget, men att
byta overlay sätter `pv.src` på nytt, och vid
laddningen kör `wireShell` sitt `get_config` — som **fungerar** från en iframe och
lämnar tillbaka den sparade skalan.
Fixen är en enda grind, `bus.js:applyConfigFor()`: **är `IN_PREVIEW` sant släpps
`scale` aldrig igenom, oavsett vilken av de fyra vägarna configen kom.** Opacitet och
alternativ går igenom som vanligt — en grind som slängt hela config-objektet hade
tystat opacitetsreglaget i previewn igen (§8.4c).

Panelen postar dessutom overlayns läge till iframen vid `onload` (`pushPreviewState`),
så previewn får sitt tillstånd från den som äger det i stället för att hämta det bakom
ryggen på panelen.

**En bugg som bara syns EFTER en orelaterad handling har oftast en omladdning i
  mitten.** Leta efter vad som körs vid init, inte efter vad som körs vid ändringen.
`tests/overlay-preview.mjs` mäter detta (och krävde två nya reglage i harnessen,
`preview` och `busFile` — se `tests/README.md`).
### 8.4e Ett färgreglage utan mottagare ser ut att fungera
Rapporterat: skuggreglaget på delta-baren gjorde ingenting. Reglaget fanns,
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

- **Ett `hidden`-attribut som en display-regel slår ut.** `.motor{display:flex}` vinner
  över webbläsarens inbyggda `[hidden]{display:none}`, så Broadcasting-raden (`<div
  class="motor" id="bcRow" hidden>`) låg framme hela tiden som en tom röd prick och
  `row.hidden = true` i JS gjorde ingenting. **Samma fel har slagit till tre gånger** —
  senast på presetradens sparaknapp (`.pb-btn{display:flex}` utan `[hidden]`-regel, så
  knappen låg kvar bakom textfältet som skulle ersätta den). Att felet var dokumenterat
  räckte alltså inte: regeln måste stå i CSS:en, inte i
  huvudet. **Skriv `.klass[hidden]{display:none}` i samma andetag som `display`**, varje
  gång, även när elementet "aldrig" ska döljas — nästa person som lägger till ett växlande
  tillstånd hittar den inte annars. JS:en är rätt, attributet
  sätts, ingenting händer.

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
Båda hittades genom att MÄTA panelen i en webbläsare, inte genom att titta på den.
Ingen av dem syns i CSS:en, i `cargo check` eller ens i panelen om man råkar ha fel
overlay vald — och det är precis det som gör dem dyra.

- **Skrollremsan åt av kortens bredd.** Korten ska ligga kant i kant med
  previewn (§4b). De gjorde det — tills listan blev lång nog att skrolla.
  En skrollbar tas ur INNEHÅLLSbredden, så `.cards` blev 12 px smalare medan
`#previewBox` (utanför skrollbehållaren) stod kvar: en overlay med sex färgrader låg i
  linje, en med sju gjorde det inte.
  Fixen är `scrollbar-gutter:stable` plus en högerpadding som drar av exakt samma
  tal, båda ur `--ui-scrollbar`. Att bara reservera remsan räcker inte — då är
  kortet konsekvent 12 px för smalt i stället för ibland.
- **`flex:0 0 <bredd>` låser ingenting utan `min-width:0`.** Ett flexbarn har
  `min-width:auto`, alltså ett golv vid sitt min-content. `.rail` växte 17 px i samma
  sekund som Broadcasting-raden
  dök upp — mitt under körning, med hela panelen till höger flyttad i sidled.
  Lägg till `min-width:0` på varje
  flexbarn vars bredd är ett designbeslut.
  **Tredje gången: `.aslot` i 0.5.1.** Ett `<input type=range>` har en INTRINSIC bredd på
  129 px i Chromium (mätt), och när gradientknappen (24 + 12 px) flyttade in i slotten
  blev min-content 221 px mot flex-basis 200. Slotten växte alltså 21 px på just de rader
  som har en gradient, etiketten slutade 21 px tidigare, och den lodräta linje hela
  högerkolumnen bygger på bröts på tre rader av tolv. Det syns inte i CSS:en och inte i
  panelen om man har fel overlay vald — bara i en mätning av varje rads etikettkant.
  Den bakomliggande orsaken var dock typografisk, och det är den viktiga lärdomen: versalt
  "BROADCASTING" är ~88 px vid 10 px och kan aldrig få plats i en list på 60–80 px.
`min-width:0` skyddar panelen från att FLYTTA sig, men gör bara felet snyggare — texten
  spiller fortfarande. Samma fälla slog till en andra gång med en FLIKETIKETT
  ("INSTÄLLNINGAR" är ~95 px vid 10 px med 0,9 px spärr), och då fick fliken byta namn
  efter pixelbredd i stället för efter betydelse. **Lösningen blev att ta bort etiketterna
  helt** (ikonlist + tooltip, §4b): när man två gånger har fått välja ord efter hur många
  pixlar de tar är det inte ordet som är fel, det är att etiketten står där. Statustexten
  är gemener medan flikarnas etiketter är versaler — ett medvetet undantag som bär
  information (etikett kontra live-status), inte en inkonsekvens att "rätta till".

### 8.4i `data-tauri-drag-region` gäller BARA direkta klick
Titelraden är egen (`decorations:false`), och `.titlebar` bär `data-tauri-drag-region`.
Det ser ut att göra hela raden dragbar. Det gör det inte: `tauri-2.11.5`:s
`src/window/scripts/drag.js:66` returnerar `el === composedPath[0]` för ett **bart**
attribut — alltså drar bara klick där titelraden SJÄLV är målet. Varje barn i raden
blir en död yta.

Det har återuppstått varje gång något nytt flyttat in i titelraden.
Två lösningar, och valet beror på om elementet behöver pekhändelser:
- `pointer-events:none` — enklast (det är vad `.tb-logo` har), men elementet kan då inte
  ha tooltip, hover eller klick.
- `data-tauri-drag-region="deep"` — hela subträdet drar, och pekhändelser fungerar
  som vanligt. `#bcRow` bär Broadcasting-felet i sitt `title`, som är enda stället
  felet syns, så där krävdes "deep".

Attributet tar också värdet `"false"` (blockerar dragning för elementet OCH dess
föräldrar), vilket är rätt om man någon gång lägger ett textfält i titelraden.
Knappar behöver inget: `isClickableElement()` låter `BUTTON`, `INPUT`, `A` m.fl.
blockera dragning av sig själva.

### 8.4j Ett värde som blir CSS måste valideras som CSS
Färgalternativens värden hamnar i `documentElement.style.setProperty('--token', v)` i
bus.js, alltså rakt in i en CSS-deklaration. Så länge de var `#rrggbb` räckte
`is_hex_color`. Gradienterna (0.5.1) öppnar samma väg för en sträng med kommatecken,
parenteser och funktionsanrop i sig, och då är `starts_with("linear-gradient(")` inte en
validering — `red;} html{display:none` och `linear-gradient(…) , url('x')` går rakt
igenom den.

`lib.rs:is_gradient()` matchar därför EXAKT den form panelen bygger och inget annat:
vinkel i grader inom 0–360, två till fyra stopp med validerad hex och procent, och
**inga** `(`, `)`, `;`, `{`, `}`, `/`, `\`, `"`, `'`, `@` någonstans i innehållet. Allt
som inte matchar faller tillbaka på registrets standardvärde.

Två saker som hör ihop med det:
- **Panelen och Rust måste vara överens om formen.** Panelen serialiserar alltid
  `linear-gradient(<deg>deg, <hex> 0%, <hex> 100%)` (gemener). Ändrar du den ena sidan
  tystas värdet av den andra — det ser ut som att inställningen inte sparas.
- **En generell CSS-parser är fel svar.** Den vore både större och farligare än
  mönstret; poängen är att mängden tillåtna strängar är LITEN och känd.

### 8.4k En rAF-loop som aldrig dör syns inte — men den håller i allt annat
Skrollen i inställningslistan jämnas ut för hand (`smoothWheel`): hjulet sätter ett
målvärde och en rAF-loop glider dit. Två saker fick loopen att leva vidare i evighet
efter att rörelsen tog slut, och SYMPTOMET var inte skroll:

- `scrollTop` snappar till heltal i den behållaren (mätt), så de sista pixlarna av en
  exponentiell utjämning avrundas bort: steget blir 0,4 px, `scrollTop` står kvar, och
  nästa frame räknar exakt samma sak igen. Loopen måste därför flytta **minst en pixel
  per frame** och ge upp när `scrollTop` inte ändrades trots det.
- Målet kan ligga utanför den verkliga maxskrollen (`scrollHeight - clientHeight` är
  inte exakt samma tal), så skillnaden mot målet nådde aldrig under tröskeln. Klampa
  målet mot maxvärdet i VARJE frame, inte bara när hjulet rullar.

Det som gjorde felet dyrt att förstå: en levande loop drar `scrollTop` tillbaka mot sitt
mål, så listan hoppade tillbaka när man drog i skrollisten, och dess `scroll`-event
stängde varje meny man öppnade (menyerna stänger vid skroll, §4b). Buggen såg alltså ut
som "menyerna går inte att öppna".

Och: **första framet har `dt ≈ 0`.** En "flyttade den sig?"-kontroll utan måttet med sig
dödade därför loopen direkt vid start — mätbart bara genom att driva loopen för hand
(§9).

### 8.4l En koordinatyta får inte ha en `border`
Layout-flikens skärmvy är en KOORDINATYTA: boxarna positioneras med `left:x*k` mot
elementets INNERkant, och `k` räknas ut mot skärmens fulla bredd. En `border:1px` gör då
innermåttet 2 px mindre än det man satte (panelen kör `box-sizing:border-box`), så varje
overlay hamnar en bråkdel fel — växande mot höger och nedåt, osynligt för ögat och fullt
mätbart. Kanten är därför en **`outline`**, som inte ligger i layouten alls. Då är
`clientWidth` exakt den skärmbredd vi räknade fram och `clientLeft` är 0.

Regeln generellt: **ritar du i ett eget koordinatsystem ska ytan inte ha kant, padding
eller `box-sizing`-beroende mått.** Behöver den se ut att ha en kant: `outline` eller
`box-shadow`, aldrig `border`.

Samma mätning avslöjade en andra sak värd att spara: `popMenu()` letade sin
`aria-haspopup`-knapp med `anchor.querySelector(...)`, alltså bara BLAND ankarets barn.
Bakgrundsväljaren och enum-raderna skickar en behållare, men skärmvyns verktygsknappar är
sina egna ankare — de fick därför aldrig `aria-expanded` satt och fokus kom inte tillbaka
när menyn stängdes. `popTrigger()` kollar nu ankaret självt först.

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
- **`lineJoin:'miter'` på ett canvas-trace flimrar i spetsarna.** Rapporterat om
  inputs-trace: de spetsiga pikarna gasspåret ritar "flimrade lite". En pedal som släpps
  och trycks igen inom två sampel ger en nästan 180-gradig vändning, och då växer
  spetsens miter-längd mot oändligheten — canvas byter till bevel så fort `miterLimit`
  passeras, alltså poppar spetsen mellan lång och avhuggen, olika för varje frame
  eftersom vinkeln ändras när spåret skrollar. **Runda hörn har ingen sådan gräns och
  kan därför inte växla.** `lineCap:'round'` hör ihop med det: färgbytena (ABS/TC) ritas
  som egna strokes och avhuggna ändar syntes som en hårfin skarv i varje övergång.
- **Att avrunda x till heltalspixlar i ett SKROLLANDE spår.** Spåret flyttar sig ett
  brutet antal pixlar per frame, så avrundningen slår om vid olika tidpunkter för olika
  sampel: en ensam spets vaggade mellan lodrät och lutande varje frame. Subpixel-x rör
  sig jämnt och kantutjämningen tar hand om skärpan. (Avrundning är rätt för STILLASTÅENDE
  gridlinjer — det är rörelsen som gör den fel.)

De två sista av loop-punkterna bodde i en kopia per overlay. De ligger nu i **`bus.js:startLoop(tick,
{hz, dtCap})`** — skriv ALDRIG en egen rAF-loop i en ny overlay, anropa den. Takten
kommer ur `hz` i `registry.json` via `__OVERLAY_INIT__` (§8.3), så en sällan-ändrad
widget kan köra 5 Hz utan att röra kärnan. `tick(dt, now)` får `dt` i sekunder;
använd det till all utjämning. `tests/overlay-loop.mjs` bevakar loopen och jämför
mot det trasiga mönstret för att bevisa att mätningen biter.

### 8.5b Dolda overlays kostade CPU ändå — `visibility:hidden` räcker inte
Synk-grinden dolde overlayn med `documentElement.style.visibility='hidden'`.
Sidan målade då ingenting — men **fönstret fanns kvar**, så Windows komponerade
fortfarande två transparenta always-on-top-fönster, och renderloopen tickade vidare
30 ggr/s och ritade canvas som ingen såg.

Mätt här (6 kärnor, båda overlays dolda av grinden, panelen öppen men ofokuserad):
**6,30 % → 2,46 %** av alla kärnor. Uppdelningen före visade var det satt —
GPU-processen 17,8 % av en kärna, tre renderare 8,4 + 4,8 + 4,5 % — alltså komposition
och renderloopar, inte JavaScript.
Tre ändringar, ingen med någon synlig effekt:
- **Stäng OS-fönstret**, inte bara innehållet (`getCurrentWindow().hide()`).
  CSS-dölningen ligger kvar som första försvar eftersom den verkar direkt medan anropet
  är async.
- **`startLoop` hoppar hela tick:en när grinden är på.** `lastT` flyttas ändå fram
  så `dt` inte hoppar vid återkomsten.
- **Panelens preview pausas när panelen inte syns** (`display:none` gör
  dokumentet orenderat, då kör webbläsaren inte dess rAF). Previewn är en FJÄRDE
  renderloop som annars gick medan man kör. Statusraden strypt till 4 Hz — den
  parsade 40 ramar/s för en prick som ändras någon gång per minut.

**En tredje sak som följde av OS-dölningen:** grindens fördröjning (`GATE_HOLD_MS`)
finns för att en tappad ram inte ska släcka overlayn, men den gällde även VID START, så
overlayn syntes i ~1,5 s vid varje appstart innan den försvann. Fördröjningen gäller nu
bara efter att ACC varit ansluten någon gång, och `lib.rs` skapar fönstret med
`.visible(false)` när grinden är på. Skalet skickar
då `osHidden:true` i `__OVERLAY_INIT__` — utan det hade bus.js trott sig aldrig ha
dolt fönstret och vägrat visa det när ACC ansluter, alltså en permanent osynlig
overlay.

**Två fällor på vägen:**
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

### 8.5e Ett reglagedrag ändrade fönsterstorlek 60 gånger i sekunden
Rapporterat: justera ett reglage i panelen medan ACC kör i bakgrunden, tabba tillbaka in
i spelet — och FPS ligger 30–40 lägre för HELA sessionen. Bara ny session eller omstart
av ACC tog bort det.

`input` kommer en gång per pixel man drar, alltså upp till 60 i sekunden, och varje
sådant event gick hela vägen: IPC till Rust, en fullständig omskrivning av
`settings.json` och — för skalan — `set_size` på overlay-FÖNSTRET. Det sista är det dyra.
Ett transparent always-on-top-fönster som ändrar storlek tvingar WebView2 att bygga om
sin renderyta och DWM att komponera om ytan över spelet, och en storm av det medan spelet
presenterar i flip/MPO-läge är precis vad som får presentationsvägen att falla tillbaka
på komposition. Den kommer inte tillbaka förrän spelet bygger om sin swapchain, vilket är
varför symptomet satt kvar hela sessionen och försvann vid omstart.

Tre lager, och de behövs alla tre:
- **Panelen stryper vägen till Rust** (`throttleIpc`, 120 ms) för skala, opacitet och
  varje genererat reglage. Första anropet går igenom direkt så det känns omedelbart,
  sista värdet skickas alltid, och `change` (musknappen släppt) flushar.
- **Panelen fortsätter uppdatera SIG SJÄLV vid varje input.** Strypningen får aldrig
  synas i reglagets siffra eller i previewn — då känns panelen trög i stället.
- **`apply_size` i Rust hoppar en storlek som redan gäller.** Den avslutande flushen
  skickar samma värde en gång till, och det gjorde tidigare ett fullt resize-varv för
  ingenting.

**Detta är INTE verifierat i spelet** (§7). Mekanismen är den mest sannolika förklaringen
till ett bestående tapp, men DWM:s beslut går inte att läsa ur vår process — mät med ACC
igång innan du tror att det är löst.

### 8.5f Att PAUSA previewn räckte inte — dokumentet måste rivas
§8.5b pausade panelens preview med `display:none` när fönstret tappar fokus, vilket
stoppar dess rAF. Men previewn är en riktig overlay i en iframe, och den har en EGEN
WebSocket: den fortsatte ta emot motorns 40 ramar i sekunden, parsa dem och köra sina
prenumeranter medan användaren körde. Rapporterat som "previewn visar live-data i ACC".

Fixen är att NAVIGERA iframen bort (`about:blank`) i stället för att dölja den — då rivs
dokumentet och socketen, loopen och observern följer med. `pv.dataset.src` måste nollas
samtidigt, annars tror `setPreview` att rätt sida redan är laddad och sätter aldrig
tillbaka den.

Panelens EGEN statussocket stängs av samma skäl (`statusSocket.stop()`). Den tog emot
40 ramar/s för att skriva två textrader som ändras någon gång per minut. Två fällor:
återanslutningen i `onclose` måste veta att vi själva stängde (annars är socketen tillbaka
1,5 s senare), och `start()` får inte ligga bakom `if (selectedId)` — statusraden hör till
fönstret, inte till en vald overlay.

### 8.5c Grinden ägde synligheten den inte hade rätt till
Rapporterat: mitt i en session dök overlays upp när man
tabbade ur ACC, och gick sedan **inte att stänga av** — ögonknappen såg ut att inte
göra någonting. Två symptom, två separata fel, och det ena dolde det andra.

**Fel 1: grinden återställde en AVSTÄNGD overlay.** Att tabba ur ACC stallar det
delade minnet → `connected:false` → grinden döljer fönstret → man tabbar in →
`connected:true` → grinden `show()`:ar det tillbaka, utan att bry sig om att användaren
stängt av overlayn. §8.5b:s regel *"grinden får BARA visa fönster den själv har dolt"*
såg ut att täcka detta men gjorde det inte: grinden **hade** dolt fönstret, den visste
bara inte att skalet höll det stängt av ett annat skäl. Regeln behöver alltså en andra
del:
**en avstängd overlay ägs helt av skalet, och grinden får varken dölja eller visa
den.** `lib.rs` skickar `enabled` i `__OVERLAY_INIT__` och ett `enabled`-event vid
varje ändring; `bus.js:_applyOsVisibility` returnerar direkt när den är av.

Eventet skickas **före** `show()`/`hide()` i `set_enabled`, så bus.js har släppt sitt
anspråk innan skalet rör fönstret.

**Fel 2: `connected` säger ingenting om fokus.** ACC fortsätter skriva sitt delade
minne utan fokus, så grinden hade ingen anledning att dölja något —
overlays låg kvar överst på skrivbordet. Det går bara att lösa genom att fråga
Windows: `lib.rs:foreground_is_foreign()` läser förgrundsfönstrets process var 400:e
ms och skickar `foreground`-eventet **vid ändring**.

Funktionen är medvetet **fail-safe**: den svarar `true` bara när den POSITIVT
identifierat en främmande process. Inget förgrundsfönster, `OpenProcess` nekas
(förhöjd process), namnet går inte att läsa → `false`, alltså dölj inte. Ett falskt
positivt hade släckt overlayn mitt i en kurva; ett falskt negativt betyder bara att
den ligger kvar som förut. Våra egna fönster räknas aldrig som främmande — man ska
kunna använda panelen medan man ser overlayn.
**Det enda verkligt farliga utfallet är att ACC inte känns igen** — då är ACC
"främmande" och overlays göms under hela loppet. Därför testas TVÅ oberoende
kännetecken och det räcker att ett slår till: binärnamnet
(`AC2-Win64-Shipping.exe`, Unreal-namnet) eller att sökvägen innehåller Steams
mappnamn `assetto corsa competizione`. Båda är stabila, men **ingen av dem är
verifierad mot spelet igång** (§7). Går overlays inte att få fram i ACC är detta första
stället att titta; användarens nödutgång är att slå av "Endast när ACC kör", som redan
betyder "visa bara overlays när ACC är relevant" — en
inspelningsrigg som vill ha overlays framme hela tiden slår av den som förut.

Två saker till:
- **Ingen hysteres på fokus.** `GATE_HOLD_MS` finns för tappade ramar; att tabba ut är
  ingen tappad ram. Dölj direkt, visa direkt.
- **Edit-läget måste vinna över hela grinden, inte bara över fönstret.** Förut
  tvingades bara OS-synligheten på i edit-läge medan `visibility:hidden` låg kvar —
  man fick ett synligt men **tomt** fönster att sikta på när overlayn skulle dras på
  plats. `_applyGate` nollställer nu `hidden` i edit-läge.
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

### 8.6f `dataclasses.asdict()` deep-copierade hela ramen 40 gånger i sekunden
`Frame.to_dict()` använde `asdict()`, som går igenom strukturen REKURSIVT och kopierar
allt den hittar — alltså hela `cars`-listan (20 dictar) och `entries` vid varje ram.
Mätt här: **94,3 µs mot 1,1 µs** för `dict(vars(self))`, per ram. Motorn är en egen
process men delar CPU med spelet, så det arbetet syns i FPS.

Platt kopia är säkert HÄR eftersom ramens fält är enkla typer eller dictar/listor vi
själva just byggt och inte muterar efter anropet. Lägger du till ett fält som är en
dataclass eller ett objekt måste `to_dict` göras om — då är `asdict` rätt igen, eller
en egen konvertering av just det fältet.

Samma mätning svarar på "MoTeC-referensen känns dyr": **9 uppslagningar (delta + två
pedalkanaler × tre källor) kostar 13,3 µs per ram** på en 8176-punkters kurva, alltså
0,05 % av en kärna. `json.dumps` på ramen är 60 µs. Referensmatematiken är mätbart
gratis; letar du FPS i motorn är det serialisering och antal klienter som betyder något.
Inläsningen av en `.ld` är däremot inte gratis (tiondelar av en sekund till ett par
sekunder) och körs därför i en tråd — annars stannar all telemetri mitt i sessionen,
vilket är precis när man laddar en referens.

### 8.6e "Ingen ny data" är INTE "ACC är borta" — mock-inblandningen
Rapporterat: overlays **blinkade** var tredje–fjärde sekund och inputs-trace fick **små
hack** i graferna. Två symptom som såg helt olika
ut, en enda orsak.

`accSharedMemory.read_shared_memory()` returnerar `None` så fort fysikpaketets id inte
hunnit ändras sedan förra läsningen (den jämför `packed_id` och hela structen). Vi
pollar 40 Hz och ACC skriver i sin egen takt, så det händer regelbundet. `acc.py`
tolkade `None` som `Frame(connected=False)`, och då föll `__main__` tillbaka på
**MOCK-källan för just det framet**:
mock-telemetri mitt i den riktiga (hacken) och `connected:false` (grinden dolde båda
overlays ett ögonblick). `AccSource` håller nu senaste giltiga ram i `STALE_S` (2 s)
innan frånkoppling rapporteras. **Motorn får aldrig blanda mock och riktig telemetri i
samma
ström** — en overlay har ingen chans att se skillnad.

Den cachade ramen lämnas ut som **kopia** (`dataclasses.replace`). Första
versionen delade objekt, och eftersom `__main__` MUTERAR ramen efter `read()`
(`apply_reference` skriver om `delta`/`refTotalMs`/`deltaSource`) skrevs de ändringarna
rakt in i cachen — nästa hållna ram kom tillbaka med ett MoTeC-delta märkt som ACC:s.
Den buggen låg i en publicerad utgåva och hittades vid en granskning, inte av testerna:
**lägg alltid till en kontroll av att cachen är orörd av vad anroparen gör.** Grinden i
`bus.js` fick samtidigt hysteres (`GATE_HOLD_MS`, 1,5 s): döljer först när
`connected:false` hållit i sig, visar igen omedelbart. En enstaka tappad ram ska aldrig
kunna släcka en overlay mitt i en kurva.
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
(hotlap) och anslöt och gav rimliga värden — men bara med en bil på banan.
`tests/broadcast_protocol.py` (falsk UDP-server) testar parsern mot vår förståelse;
`engine/broadcast_test.py` med spelet igång testar förståelsen mot verkligheten. Kör
den i ett riktigt race innan du litar på entry list-flödet. Se §7.

### 8.7 ACC:s MoTeC-export har INGEN distanskanal
55 kanaler, noll med "dist" i namnet. `delta.py` integrerar därför **farten** till
distans — det är **normalvägen** för ACC-filer, inte ett undantag (felet blev 15 ms
över ett varv). Kanalmatchningen provar exakt namn före delsträng, för både `SPEED`
och `WHEEL_SPEED_LF` innehåller "speed".

### 8.7b "Byt fart-integrationen mot banlängd × position" — nej, och varför
Ett återkommande förslag i externa arkitekturgenomgångar är att
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
Rapporterat: delta-overlayn visade ett referensdelta **direkt vid
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
Bytet från "ACC Overlay" är med flit **bara kosmetiskt** —
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
  ser då utgåvan som en **annan app**: två installationer sida vid sida
  i stället för en uppdatering. Koden ovan är den som gällde för "ACC Overlay".
  Kontrollera med `pnpm tauri inspect wix-upgrade-code` — den skriver ut både den
  härledda och den låsta, och de SKA skilja sig åt nu.

Fältet ligger kvar trots att MSI inte längre byggs (§8.8e); det är inert, men värdet är
omöjligt att räkna ut i efterhand. **NSIS gick inte att låsa på samma sätt.**
Avinstallationsnyckeln härleds ur `productName`, så bytet gav en ny nyckel och den gamla
installationen ("ACC Overlay 0.3.3" i `%LOCALAPPDATA%\ACC Overlay`) blev **kvar** som
föräldralös. Den kan avinstalleras för hand och tar inte med
sig inställningarna — de bor i `%APPDATA%\com.accoverlay.app\` och delas av båda,
eftersom `identifier` med flit inte byttes. Ofarligt att städa, men också ett skäl att
inte döpa om produkten igen i onödan.
### 8.8e "Uppdateringen fungerar men försvinner när jag stänger appen"
Rapporterat: användaren fick köra **Sök uppdatering vid varje start**. Uppdateringen
gick igenom, men nästa start var den
gamla versionen tillbaka. Det låter som att något inte sparas — det är det inte.

`bundle.targets` stod på `"all"`, vilket på Windows bygger **både MSI och NSIS**.
tauri-action lägger då in båda i `latest.json`, och den generiska nyckeln som
updateraren faktiskt slår upp — `windows-x86_64` — pekade på **MSI:n**.
Men den installerade appen kom från **NSIS**, som installerar per användare i
`%LOCALAPPDATA%\SimMatrix`; MSI:n
installerar per maskin i `C:\Program Files\`. Två olika installationstekniker på två
olika platser: MSI:n kan inte uppdatera NSIS-installationen, den lägger bara en ANNAN
kopia bredvid, och genvägen pekar kvar på den gamla — alltså "det återställs".
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
- **`process::exit(0)` i updateraren går förbi appens avslutsväg.**
  `tauri-plugin-updater`s `install_inner()` startar installeraren och avslutar
  processen direkt — varken `CloseRequested`-hanteraren eller `RunEvent::Exit` körs,
  så positioner som dragits under sessionen hade gått förlorade vid varje
  uppdatering. Panelen anropar därför `prepare_update` (sparar lägen + stoppar motorn)
  innan `downloadAndInstall()`. **Lägg till nya "spara vid avslut"-saker på BÅDA
  ställena.**
- Panelen visade tidigare samma text — *"Uppdateringar är inte konfigurerade än"* —
  för varje fel, inklusive riktiga installationsfel. Det var en direkt orsak till att
  buggen ovan var osynlig i två utgåvor. **Visa alltid `errMsg(err)`.**
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

### 8.8f Delta-källan är overlayns val — motorn levererar, den väljer inte
Rapporterat: inputs-trace visade inget spökspår alls utan en MoTeC-fil, fastän
delta-baren samtidigt visade ett delta mot session-bästa. Orsaken var att det bara fanns
EN kurvreferens i systemet — `.ld`-filen. ACC:s eget delta är en siffra utan kurva, så
det gick inte att rita spöke mot den.

Motorn spelar därför in varven själv (`laps.py`): förra varvet och sessionens bästa blir
fullvärdiga referenser med både delta och pedalkurva. Fyra beslut som hänger ihop:

- **Ramen bär ALLA källor, motorn väljer ingen.** `refs` är `{"last"|"best"|"motec":
  {delta, totalMs, throttle, brake, src}}`. Valet görs av reglaget `delta-source` i
  overlayn, för det är där det hör hemma: delta-baren kan visa sessionens bästa medan
  inputs-trace ritar spöket mot förra varvet, och motorn behöver inte veta något om
  panelens inställningar. En global inställning hade dessutom brutit mot §2 (motorn
  känner ingen overlay) och krävt en ny väg genom `engine.config.json`.
- **En källa som inte gäller SAKNAS i kartan** — ingen fil laddad, inget varv inspelat,
  ut-varv, fel bana, mållinjens spikskydd. En overlay som hittar sin nyckel ska kunna
  lita på den utan att kontrollera villkor den inte känner. `refs` är `None` (inte en tom
  dict) när ingen källa alls finns.
- **`best` faller tillbaka på ACC:s eget delta** tills vi hunnit spela in ett varv: samma
  jämförelse, och den finns direkt. Fallbacken har inga pedalkanaler, alltså siffra men
  inget spöke — det är rätt, vi HAR ingen kurva då. `src` i posten säger vilket det är.
- **De gamla fälten står kvar oförändrade** (`delta`, `deltaSource`, `refThrottle`,
  `refBrake`): MoTeC när filen gäller, annars ACC:s eget mått. Våra overlays läser dem
  inte längre, men de är ramens publika kontrakt mot OBS-källor och egna konsumenter.

Vilka varv som INTE får bli en referens är den viktiga halvan, för en dålig referens ser
lika trovärdig ut som en bra: depån berörd (ut- eller in-varv), täcker inte minst 90 % av
banan (inspelningen började mitt på varvet), orimlig varvtid, eller ramar som inte är
anslutna — **mock får aldrig hamna i en referens** (§8.6e). Varvtiden tas från ACC:s
`last_time` men bara om den ligger inom 2 s från vår egen mätning: vid mållinjen kan den
ligga ett par ramar efter och alltså vara FÖRRA varvets, vilket hade gjort ett medelvarv
till "sessionens bästa".

Positionssteget mellan sparade sampel är 1/2000 varv och inte ett sampel per ram. Det
håller minnet bundet (~2000 punkter per varv) och lägger punkterna tätast där bilen rör
sig långsammast, alltså i kurvorna där kurvan har mest form.

Spikskyddet (§8.8) delas av båda referenssorterna genom `delta.lap_delta()`. Det är den
sortens regel som blir fel i den andra kopian.

### 8.8g Kortkommandot går att byta — tre saker som då slutar hålla
Ctrl+Alt+Space registreras GLOBALT i Windows och kan vara upptagen av ett annat program.
Det var hela skälet att göra den utbytbar (Inställningar-fliken), och bytet drog med sig
tre fällor:

- **Handlern får inte jämföra mot en infångad kopia.** `Builder::with_handler` fick
  tidigare `move |app, sc, ev| if sc == &toggle_h`, alltså kombinationen som gällde vid
  uppstart. Efter ett byte matchar den aldrig — hotkeyen hade fungerat exakt en gång per
  appstart och sedan verkat död. Handlern läser nu `HOTKEY` (den REGISTRERADE
  kombinationen).
- **Registreringen måste göras om DIREKT, med återställning vid fel.** Det finns inget
  sätt att veta om en genväg är ledig utan att försöka ta den. Misslyckas den läggs den
  gamla tillbaka — annars lämnar ett felklick användaren helt utan kortkommando, och enda
  vägen in i edit-läge är panelens flytta-knapp.
- **Minst en modifierare, kontrollerat på BÅDA sidor.** Panelen kräver det, men IPC:n är
  inte panelens text: en bar tangent som globalt kortkommando fångas i alla program —
  trycker man "P" i en chat växlar overlayn läge.

Två detaljer värda att spara: panelen spelar in `event.code` och inte `event.key`
(`key` beror på tangentbordslayouten; ett globalt kortkommando bor i den FYSISKA
tangenten), och namnen `code` ger — "KeyE", "Space", "ArrowUp", "Numpad5" — är precis de
`global-hotkey` parsar, så strängen går hela vägen utan översättning. Undantaget är
Windows-tangenten: parsern vill ha `Super`, användaren läser `Win`, och bara VISNINGEN
översätts. Strängen får aldrig hårdkodas i en overlay eller i panelens HTML (delta-barens
edit-bricka och Om-fliken gjorde det) — den hämtas ur `get_globals`.

### 8.9 websockets-API:t
Installerat: **16.0**, där `websockets.serve` är den nya asyncio-implementationen.
`await websockets.serve(...)` ger ett `Server` med `close()`/`wait_closed()` — det
fungerar på både legacy (12–13) och nya (14–16), så `Bus.start()` är versionsneutral.
Handlern tar **ett** argument (`ws`), inte `(ws, path)`.

### 8.10 Öppna frågor / medvetna skulder
- **Fonten är vendorerad.** Montserrat ligger i
  `src/shared/fonts/` som **variabla** woff2 (latin + latin-ext), med `@font-face`
  i `tokens.css` — en enda fil per unicode-block för hela viktskalan 100–900, och
`wght`-raden är därför ett intervall och inte ett tal.
  Latin-ext ingår för att förarnamn ur Broadcasting-entry list är polska, tjeckiska
  och turkiska lika ofta som svenska. Licens: SIL OFL 1.1, fri att bunta i ett
  MIT-projekt. `http_static.py` mappar `.woff2` explicit — Pythons `mimetypes` känner
  den inte (kontrollerat: `guess_type` ger `None`), och en OBS-källa som ritar i fel
  font för att servern ljuger om innehållet är svår att hitta.
- `dist/` och `build/` (PyInstaller-output, ~140 MB) låg committade i historiken och är
  nu avspårade + gitignorerade. Blobbarna finns kvar i äldre
  commits; en `git filter-repo` + force-push krävs för att verkligen ta bort dem.

## 9. Så verifierar du utan att gissa
Testerna ligger i `tests/` — **`tests/README.md` är sanningskällan** för vad varje test
bevakar och hur man visar att det biter. `pnpm test` kör de sju
Node-testerna; de sex Python-testerna körs var för sig från repo-roten.
`tests/panel-layout.mjs` är det enda med ett yttre beroende (Chrome) — det FALLER med en
sökvägslista om Chrome saknas i stället för att hoppa över sig själv.
**CI kör alla utom `motec_reference.py`**, som kräver en `.ld` och därför alltid
hoppar över sig själv. Två regler som gäller allt testarbete här:
- **Ett test som inte kan falla bevisar ingenting.** Kör varje nytt test mot revisionen
  FÖRE fixen (`node tests/overlay-delta-bar.mjs <rev>`). Bevakar du en REFAKTORERING går
  det inte — bevisa tänderna på annat sätt: mot revisionen efter fixen men före
  flytten (ska passera identiskt) och mot en medvetet trasig variant inne i testet
  (`naivLoop` i `overlay-loop.mjs`, `UtanDepakoll`/`UtanTackningskrav` i
  `lap_recorder.py`).
- **Ett test som kan hoppa över sig själv skyddar ingenting i CI.** `Reference.delta()`
  bröts helt en gång — en hjälpfunktion hamnade mitt i klassen och gjorde metoden till
  död kod — och alla andra tester passerade ändå, eftersom `delta_source.py` använde en
  fejkreferens som skuggade metoden och `motec_reference.py` hoppade över sig själv utan
  en `.ld`. Täck kärnlogiken med ett test utan filberoende också. Två fällor i harnessen
  (`tests/lib/overlay-harness.mjs`), som kör overlayns riktiga modulskript med fejkad
  DOM och manuellt driven tid — enda sättet att mäta något som varar ett enda frame:
- `assertAlive()` först: kontrollera att overlayn faktiskt renderade innan du bedömer
  VAD den renderade, annars passerar testet på en död overlay.
- **En för slapp stubb ÄR ett tyst testfel.** `getComputedStyle` gav samma färg för alla
  tokens, så en kontroll av
  att ABS färgar bromstracet gult passerade även på en overlay som ritade allt i en
  färg. Ge stubbar värden som går att skilja åt.
  Övrigt, per lager:
- **Motorn:** starta som subprocess, anslut med `websockets.connect`, samla N ramar
  och kontrollera fält/takt/NaN. Starta en andra instans för att testa portkonflikt.
- **MoTeC:** `Reference().load(path)` mot en riktig `.ld`; skriv ut `lap_ms`, `t_at()`
  vid några distanser och `delta()` för både äkta värden och
  mållinje-artefakten (`pos=0.999, cur_lap≈0`).
- **Rust-API:er:** läs källan i `~/.cargo/registry/src/*/tauri-2.11.5/` i stället för
  att lita på minnet. Logisk/fysisk-buggen (§8.2) hittades så.
- **Panelen headless:** rendera `src/control-panel/index.html` i Chrome mot en
  Tauri-stub och MÄT pixlar (`getBoundingClientRect`, `getComputedStyle`) i flera
  fönsterbredder inklusive golvet 960×600. Kör med `--force-prefers-reduced-motion`:
  under `--virtual-time-budget` fryser CSS-transitioner halvvägs och ett avstängt
  tillstånd kan se påslaget ut.
  Tre saker som kostade tid i 0.5.1-mätningen och gäller varje gång:
  - **`--dump-dom` räcker inte** när mätningen behöver KLICKA och vänta in layouten
    mellan stegen. Driv sidan över CDP i stället (`--remote-debugging-port` +
    `Runtime.evaluate` med `awaitPromise`); Node har global `WebSocket` och `fetch`, så
    det behövs inget beroende.
  - **`getComputedStyle` ger FÖRRA värdet direkt efter en klassändring** när egenskapen
    har en `transition` — statusprickens färg lästes som röd i det frame den blev grön.
    Vänta ut övergången (eller läs efter ett par frames) innan du bedömer en färg.
  - **rAF är hårt strypt i headless** (mätt: 1 tick på 600 ms — kompositören producerar
    inga frames). En rAF-driven animation går alltså inte att mäta genom att vänta; byt
    ut `requestAnimationFrame` mot en kö och driv den med en egen klocka, precis som
    `tests/lib/overlay-harness.mjs` gör.
  En fjärde sak, från layout-flikens mätning: **en kontroll får aldrig hämta sin
  omräkningsfaktor ur koden den granskar.** Testet läste panelens egen `stageK` och
  jämförde boxarnas pixlar mot den — då stämmer allt mot sig självt, och en medvetet
  trasig variant med `stageK = 0.4` passerade. Förväntad geometri räknas nu fram ur
  BEHÅLLAREN, alltså ur samma indata som koden borde ha använt. Samma familj som den
  slappa stubben ovan: felet är inte i det som mäts, det är i måttstocken.
  Två småsaker som annars kostar tid: `/json/list` listar även bakgrundssidor och
  tjänstearbetare — filtrera på `type === 'page'`, annars ansluter man till en tom
  kontext som ser ut som en panel som aldrig laddade. Och headless-Chrome stryper timers
  i fönster den anser ligga i bakgrunden, vilket gör en uppstart bakom en timer flakig;
  `--disable-background-timer-throttling` (plus de två syskonflaggorna) tar bort det.
- **Appen:** skärmdump med `System.Drawing.Graphics.CopyFromScreen`, och stäng
  panelen med `WM_CLOSE` till rätt hwnd (appens `MainWindow` kan vara ett
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
sedan förra bygget. I CI gör det det: ett `cargo test`-steg som låg före sidecar-steget
fällde en hel release (bygget hoppades över, så ingenting publicerades). Lägg alltid nya
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
4. **Läsordning:** denna fil → `tests/README.md` → `src/shared/tokens.css`.
**Arbetssätt som gällt hittills och fungerat, behåll det:**
- **Mät, gissa inte.** Läs källan (Tauri i `~/.cargo/registry/`, pyaccsharedmemory i
  site-packages) i stället för att lita på minnet. Flera buggar i §8 hittades så.
- **Ett test som inte kan falla bevisar ingenting.** Kör varje nytt test mot koden
  FÖRE fixen; går det inte (refaktorering, ny funktion) bevisa tänderna på annat
  sätt, t.ex. en medvetet trasig variant inne i testet. Se §9.
- **Verifiera den publicerade artefakten**, inte att CI blev grön (§8.6c).
- **Fråga hellre än att anta om användarens data.** Inställningar, positioner och
  referenssökväg är användarens; ta säkerhetskopia innan test och återställ efteråt.
- **En overlay i taget**, helt klar (funktion + look + animation) innan nästa. Mät
  referensbilder pixel-exakt FÖRST, bekräfta struktur i EN avstämning innan kod.
- Rör inte kärnan (`lib.rs`, `bus.js`, registry-schemat) i onödan — men när den
  behöver ändras, gör det ordentligt och dokumentera varför i §8.

- **Håll denna fil fri från versionslogg.** När du fixar något: skriv in REGELN där den
  hör hemma och radera den berättelse den ersätter. En fälla som berättas tre gånger för
  tre versioner är en fälla som ingen läser.
