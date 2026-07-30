<p align="center">
  <img src="docs/simmatrix-logo.png" alt="SimMatrix" width="459">
</p>

<p align="center">Modulärt overlay-paket för Assetto Corsa Competizione.</p>

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

**1) Engångsuppsättning** (i `engine/`):
```
pip install -r requirements.txt
# hämta ldparser.py från https://github.com/gotzl/ldparser till engine/  (för MoTeC-delta)
python build_sidecar.py     # krävs även för dev, se nedan
```
`ldparser` är **en enda fil**, inget pip-paket: `pip install git+…` mot det repot kan
inte fungera (det har varken `setup.py` eller `pyproject.toml`) och misslyckas tyst i
CI. Hämta råfilen till `engine/` — den är gitignorerad (GPL-3.0).

**2) Appen**:
```
pnpm install
pnpm tauri dev
```
`pnpm tauri dev` **startar motorn automatiskt** som sidecar. Kör den därför inte
manuellt samtidigt — båda vill binda port 8777, och den som förlorar avslutar med ett
meddelande i loggen. Behöver du motorn ensam (OBS, felsökning) körs den med
`python -m acc_engine --root ../src` från `engine/`.

Utan ACC igång sänder motorn **mock-data** (så allt rör sig). Startar du ACC växlar
den automatiskt till riktig telemetri.
Kontrollpanelen öppnas; overlays läggs ut enligt registret. **Ctrl+Alt+Space**
växlar race ⇄ edit — i edit-läge drar du varje overlay på plats (sparas när panelen
stängs). Kombinationen kan bytas under **Inställningar** (den registreras globalt i
Windows och kan alltså vara upptagen av ett annat program). Opacitet/skala styrs per
overlay i panelen.

## Layouter
Fliken **Layout** visar hela skärmen som en yta med dina overlays som proportionella
rutor. Dra dem på plats — de snappar mot ett rutnät (täthet 8/12/16/24 kolumner, går att
stänga av), mot skärmens kanter och mitt, och mot varandras kanter och mitt. Piltangenter
finjusterar 1 px, Shift+piltangent 10 px. Vill man ha exakta tal finns X/Y-fält i varje
overlays rad. Skala, opacitet och overlayns egna alternativ sitter i samma rad, hopfälld
tills man öppnar den.

En **layout** är hela skärmen sparad under ett namn: vilka overlays som är på, var de
sitter, hur stora de är och hur de ser ut. Exakt en är aktiv i taget, och den aktiva
följer med automatiskt — allt du ändrar hamnar i den utan ett spara-steg, oavsett om du
ändrar det här, i Overlays-fliken eller genom att dra en overlay i edit-läge. Byt layout
så flyttar, storleksändrar, tänder och släcker appen fönstren i ett svep. Att ta bort en
layout släcker inga overlays; du tappar bara vägen tillbaka till det utseendet.

Lägg till eller ta bort en overlay ur layouten med **+** i skärmvyn respektive **×** på
raden — det är samma av/på som ögonknappen i Overlays-fliken.

## OBS
Motorns HTTP-server serverar overlays direkt. Lägg en **Browser Source** mot t.ex.
`http://127.0.0.1:8078/overlays/inputs-trace/index.html` (bredd/höjd enligt overlayn).
Samma WS-data driver både appen och OBS.

## Delta-källa
Varje overlay som kan visa ett delta har **ett** reglage för det, `Delta-källa`, med
fyra värden: **sessionens bästa varv**, **förra varvet**, **MoTeC-referensfil** och
**av**. Ingenting annat styr deltat.

Motorn spelar in varven själv, så "förra varvet" och "sessionens bästa" är fullvärdiga
referenser med både delta OCH pedalkurva — inputs-trace ritar alltså spökspår även utan
en MoTeC-fil. Ett varv blir INTE en referens om depån berörts under det (ut- eller
in-varv), om inspelningen inte täcker nästan hela banan eller om varvtiden är orimlig:
en dålig referens ser lika trovärdig ut som en bra.

Motorn skickar alla källor som gäller i samma ram och väljer inte åt overlayn, så två
overlays kan visa olika referens samtidigt. Har den valda källan inget att ge just nu
(ingen fil laddad, inget varv inspelat än, ut-varv) visas platshållaren.

## MoTeC-referens (delta)
Klicka **Ladda MoTeC .ld** i panelen. Motorn läser sido-`.ldx` för varvmarkörer och
väljer **snabbaste hela varvet** ur filen (ACC sparar hela sessioner), resamplar det
till ett jämnt distansrutnät (distans→tid) och beräknar
`delta = din_varvtid − t_ref(din_position)`, alltid jämfört i distans. Saknas `.ldx`
behandlas hela filen som ett varv. ACC:s export har ingen distanskanal, så farten
integreras till distans (mätt fel: 15 ms över ett varv på Spa).

## Bygga & paketera (Windows)
```
cd engine && python build_sidecar.py     # PyInstaller → src-tauri/binaries/acc-engine-<triple>.exe
pnpm tauri build                          # installer i src-tauri/target/release/bundle/
```
`externalBin` ligger kvar i `src-tauri/tauri.conf.json`, så sidecarn måste vara byggd
minst en gång även för `pnpm tauri dev`. **Bygg om den efter varje ändring i `engine/`**,
annars kör du gammal motorkod. Tester: `pnpm test` (overlays + panelens layout-flik,
den sista kräver Chrome) + `python tests/<namn>.py` från repo-roten — se
`tests/README.md`.

## Auto-update via GitHub
1. Publikt repo. Byt `OWNER/REPO` i `src-tauri/tauri.conf.json` → `plugins.updater.endpoints`.
2. `pnpm tauri signer generate` → klistra **public key** i `plugins.updater.pubkey`;
   lägg **private key** + lösenord som repo-secrets `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)`.
3. `git tag v0.2.0 && git push origin v0.2.0` → GitHub Actions bygger installer +
   `latest.json`. Appens **Sök uppdatering** hittar och installerar nya versioner.

**Bygg bara ETT installerformat.** `bundle.targets` är låst till `["nsis"]` med flit.
Med `"all"` byggs både MSI och NSIS, och den generiska nyckeln i `latest.json` —
`windows-x86_64`, den updateraren faktiskt slår upp — pekade då på **MSI:n** medan
appen var installerad med NSIS. MSI installerar per maskin i `Program Files`, NSIS per
användare i `%LOCALAPPDATA%`: uppdateringen "lyckades" men lade en andra kopia bredvid,
och genvägen fortsatte peka på den gamla. Symptomen var att man fick uppdatera vid
varje start. Se CLAUDE.md §8.8e.

OS-kodsignering (SmartScreen) är medvetet uppskjuten — updater-signaturen räcker för
integritet; utan Authenticode klickar man "kör ändå" första gången.

## Egna bakgrunder i förhandsvisningen
Kontrollpanelens preview kan visa overlayn mot en banbild. Ikonen uppe till vänster i
previewrutan bläddrar bland dem — hovra över ett namn för att se bilden direkt.

Egna bilder läggs i **`%APPDATA%\com.accoverlay.app\preview-backgrounds\`** (menyn har
en rad som öppnar mappen). `.webp`, `.jpg`, `.png` och `.avif` fungerar; filnamnet blir
etiketten i listan, och listan läses om varje gång menyn öppnas — ingen omstart behövs.
Den mappen överlever uppdateringar, till skillnad från de inbyggda bilderna som ligger
i installationskatalogen och skrivs över.

## Lägga till en ny overlay (utan att röra kärnan)
1. Skapa `src/overlays/<id>/index.html` som importerar `../../shared/tokens.css` och
   prenumererar på `WsBus` från `../../shared/bus.js`; deklarera vilka kanaler den läser.
2. Lägg en rad i `src/overlays/registry.json` (id, url, storlek, standardläge).
3. Klart — skalet skapar fönstret, panelen listar den, looken ärvs via tokens.

## Licens
MIT (se `LICENSE`). Vi använder **inte** Race Elements (GPL-3.0) kod — endast idéer
om arkitektur. ACC läses via det publika Kunos-delade-minnet (`pyaccsharedmemory`).
