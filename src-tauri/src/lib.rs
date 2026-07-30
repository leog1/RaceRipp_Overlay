// ACC Overlay — Tauri-skal.
// Ansvar: skapa overlay-fönster ur registret (ingen hårdkodad layout), köra
// kontrollpanelen, starta Python-motorn (sidecar), toggla race/edit (hotkey) och
// spara/ladda per-overlay-inställningar. Overlays hämtar DATA från motorns
// WebSocket; kontrollpanelen styr fönstren via kommandona nedan.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
// Code/Modifiers behövs inte längre: kombinationen byggs inte i kod utan PARSAS ur
// en sträng (settings.json / panelen), vilket global-hotkey gör via FromStr.
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_shell::process::CommandChild;

// ── Registret (kompileras in; katalog över overlays) ────────────────────────
const REGISTRY_JSON: &str = include_str!("../../src/overlays/registry.json");

// Ett val i en enum-option: värdet som sparas + etiketten panelen visar.
#[derive(Deserialize, Serialize, Clone)]
struct OverlayOptionValue {
    value: serde_json::Value,
    label: String,
}

// Deklarativt schema för en overlays inställning. Kontrollpanelen bygger kontrollen
// generiskt ur `kind` — en ny overlay lägger till en rad i registry.json och får sin
// slider/väljare utan att panelen (kärnan) ändras.
#[derive(Deserialize, Serialize, Clone)]
struct OverlayOption {
    id: String,
    label: String,
    // "bool" (standard), "int", "float", "enum", "color". Utelämnad = "bool", så
    // options som skrevs innan schemat typades fungerar oförändrat.
    #[serde(rename = "type", default = "default_kind")]
    kind: String,
    #[serde(default)]
    default: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    max: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    step: Option<f64>,
    // Enhet som klistras efter värdet i panelen ("1.00×", "100%", "4.5 s"). Hör hit
    // och inte i etiketten: etikettkolumnen är smal och "(s)" bröt till egen rad.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    unit: Option<String>,
    // color: har fargen ett justerbart alfa? Panelen visar da ett extra reglage.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    alpha: bool,
    // color: får värdet vara en GRADIENT i stället för en färg? Bara för alternativ
    // vars token används som en YTA (`background`). Sätt den aldrig på en token som
    // sitter på `stroke`, `fill`, `border-color` eller `background-color` — en
    // gradient är ogiltig där, och overlayn slutar då rita elementet i stället för
    // att falla tillbaka på något. Kontrollera var tokenen används först.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    gradient: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    values: Vec<OverlayOptionValue>,
}

fn default_kind() -> String {
    "bool".into()
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OverlayDef {
    id: String,
    title: String,
    #[serde(default)]
    desc: String,
    url: String,
    base_width: f64,
    base_height: f64,
    default_x: i32,
    default_y: i32,
    default_scale: f64,
    // Renderloopens takt. Utelämnad = bus.js:s standard (30). Sätts per overlay så
    // en sällan-ändrad widget (varvtidslogg) inte behöver samma takt som ett
    // rullande canvas-trace.
    #[serde(default)]
    hz: Option<f64>,
    #[serde(default)]
    options: Vec<OverlayOption>,
    // Presets som FÖLJER MED appen. De ligger i registry.json och inte i settings,
    // eftersom de ska finnas på en ny installation — en användarpreset bor i
    // app-config-mappen och följer per definition inte med en nedladdning.
    // Att lägga till en preset är därmed samma sorts ändring som att lägga till en
    // option: en rad i registret, noll kod i kärnan.
    #[serde(default)]
    presets: Vec<Preset>,
}

// ── Presets ─────────────────────────────────────────────────────────────────
// Ett sparat UTSEENDE för en overlay: skala, opacitet och alternativen. INTE
// position (det är layout, inte utseende) och INTE av/på — en preset ska aldrig
// kunna släcka en overlay man just tänt.
//
// `scale` och `opacity` är Option med flit. En INBYGGD preset bör oftast utelämna
// skalan: den är monitorberoende, och en färgpreset som samtidigt tvingar 1,2× på
// någon som kört in sin layout är påträngande. En preset man sparar SJÄLV fångar
// däremot allt, för då är det just den kombinationen man vill tillbaka till.
// Fält som är None lämnas orörda när presetten appliceras.
#[derive(Deserialize, Serialize, Clone)]
struct Preset {
    id: String,
    label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    scale: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    opacity: Option<f64>,
    #[serde(default)]
    options: HashMap<String, serde_json::Value>,
}

// Panelens reglage går 0,6–1,6 respektive 0,2–1. En preset ur registry.json eller ur
// en handredigerad settings.json kan säga vad som helst, och samma resonemang gäller
// som för options (§8.3b): klampa här, inte i overlayn.
const SCALE_MIN: f64 = 0.6;
const SCALE_MAX: f64 = 1.6;
const OPACITY_MIN: f64 = 0.2;
const OPACITY_MAX: f64 = 1.0;
// Tak på antalet egna presets per overlay. Inte för att någon skulle spara 200 för
// hand, utan för att en fastnad panel-loop annars kan blåsa upp settings.json.
const MAX_USER_PRESETS: usize = 40;

fn clamp_opt(v: Option<f64>, lo: f64, hi: f64) -> Option<f64> {
    v.filter(|n| n.is_finite()).map(|n| n.clamp(lo, hi))
}

// Samma behandling som sanitize_options: okända nycklar bort, resten mot schemat.
// Skillnaden är att en preset får vara PARTIELL — den behöver inte nämna varje
// option, och de den inte nämner ska lämnas som de är i stället för att fyllas med
// registrets standardvärde (vilket sanitize_options gör).
// Ett helt overlay-läge (live eller ur en layout). Skalan klampades tidigare bara
// när den kom från en preset, alltså inte alls för ett handredigerat eller åldrat
// värde i settings.json — och ett fönster byggt på `base_width * 99` är inte något
// användaren kan klicka sig ur.
// Positionen klampas mot ett grovt skärmintervall snarare än mot den faktiska
// skärmen: monitoruppsättningen kan skilja sig från den som sparade filen, och att
// dra in en overlay från en frånkopplad andraskärm är panelens jobb (skärmvyn), inte
// inläsningens. Gränsen finns bara för att stoppa orimliga tal.
const POS_LIMIT: i32 = 32_000;

fn sanitize_state(d: &OverlayDef, st: &mut OverlayState) {
    st.scale = if st.scale.is_finite() { st.scale.clamp(SCALE_MIN, SCALE_MAX) } else { d.default_scale };
    st.opacity = if st.opacity.is_finite() { st.opacity.clamp(OPACITY_MIN, OPACITY_MAX) } else { 1.0 };
    st.x = st.x.clamp(-POS_LIMIT, POS_LIMIT);
    st.y = st.y.clamp(-POS_LIMIT, POS_LIMIT);
    sanitize_options(d, &mut st.options);
}

fn sanitize_preset(d: &OverlayDef, p: &mut Preset) {
    p.scale = clamp_opt(p.scale, SCALE_MIN, SCALE_MAX);
    p.opacity = clamp_opt(p.opacity, OPACITY_MIN, OPACITY_MAX);
    p.options.retain(|k, _| d.options.iter().any(|o| &o.id == k));
    for o in &d.options {
        if let Some(cur) = p.options.get(&o.id).cloned() {
            p.options.insert(o.id.clone(), sanitize_option(o, &cur));
        }
    }
}

// ── Layouter ────────────────────────────────────────────────────────────────
// En layout är en namngiven ögonblicksbild av HELA overlay-uppsättningen: vilka
// som är på, var de sitter, hur stora de är och hur de ser ut. En preset är
// utseendet på EN overlay; en layout är arbetsläget för skärmen.
//
// Bara overlays som INGÅR ligger i kartan — medlemskap är alltså detsamma som
// "påslagen", och panelens "lägg till / ta bort ur layouten" är samma väg som
// av/på-knappen i Overlays-fliken. Två sätt att slå på samma overlay hade
// oundvikligen glidit isär.
//
// EXAKT EN layout kan vara aktiv (`active_layout`). Den aktiva är LIVE-BUNDEN:
// `sync_active_layout` kopierar in det gällande läget vid varje sparning, så
// allt man ändrar — i skärmvyn, i Overlays-fliken, genom att dra en overlay i
// edit-läge — hamnar i den utan ett spara-steg. Det är därför det inte finns två
// sanningar: `settings.overlays` ÄR läget, layouten är en spegel av det.
#[derive(Deserialize, Serialize, Clone)]
struct Layout {
    id: String,
    name: String,
    #[serde(default)]
    overlays: HashMap<String, OverlayState>,
}

// Samma skäl som MAX_USER_PRESETS: taket finns för att en fastnad panel-loop inte
// ska kunna blåsa upp settings.json, inte för att någon skulle skapa 60 för hand.
const MAX_LAYOUTS: usize = 40;

#[derive(Deserialize)]
struct Registry {
    overlays: Vec<OverlayDef>,
}

fn registry() -> &'static Vec<OverlayDef> {
    static R: OnceLock<Vec<OverlayDef>> = OnceLock::new();
    R.get_or_init(|| {
        serde_json::from_str::<Registry>(REGISTRY_JSON)
            .expect("registry.json ogiltig")
            .overlays
    })
}
fn def_of(id: &str) -> Option<&'static OverlayDef> {
    registry().iter().find(|d| d.id == id)
}

// ── Validering av optionsvärden ─────────────────────────────────────────────
// Inget värde når en overlay orört. settings.json redigeras för hand (§8.3b visade
// att det är ett verkligt felläge) och panelen kan skicka vad som helst över IPC:n,
// så typfel och värden utanför sitt intervall rättas här i stället för att bli
// `scaleY(NaN)` eller en tom tabell långt inne i en overlay.
fn sanitize_option(o: &OverlayOption, v: &serde_json::Value) -> serde_json::Value {
    use serde_json::Value as V;
    match o.kind.as_str() {
        "int" | "float" => {
            let Some(mut n) = v.as_f64() else { return o.default.clone() };
            if !n.is_finite() {
                return o.default.clone();
            }
            if let Some(min) = o.min { n = n.max(min); }
            if let Some(max) = o.max { n = n.min(max); }
            if o.kind == "int" {
                V::from(n.round() as i64)
            } else {
                serde_json::Number::from_f64(n).map(V::Number).unwrap_or_else(|| o.default.clone())
            }
        }
        // Enum: bara värden som faktiskt står i registret släpps igenom.
        "enum" => {
            if o.values.iter().any(|c| c.value == *v) { v.clone() } else { o.default.clone() }
        }
        // Färg: #rgb eller #rrggbb — och för ett alternativ märkt `gradient` även en
        // tvåstoppsgradient i EXAKT den form panelen skickar. Overlays sätter värdet
        // som CSS-variabel, och en ovaliderad sträng där hade varit ett sätt att
        // injicera CSS: `red;} html{display:none` i ett färgfält räcker.
        "color" => {
            let ok = v
                .as_str()
                .map(|s| is_hex_color(s) || (o.gradient && is_gradient(s)))
                .unwrap_or(false);
            if ok { v.clone() } else { o.default.clone() }
        }
        _ => V::Bool(v.as_bool().unwrap_or_else(|| o.default.as_bool().unwrap_or(false))),
    }
}

// En gradient, och BARA i den form kontrollpanelen bygger:
//   linear-gradient(<0..360>deg, <hex> <0..100>%, <hex> <0..100>%)
// Två till fyra stopp tillåts (panelen skickar två; taket finns så en handredigerad
// settings.json med tre stopp inte tvättas bort i onödan).
//
// Formen är låst med FLIT och det är inte en begränsning av bekvämlighetsskäl:
// värdet hamnar i `document.documentElement.style.setProperty('--token', v)` i
// bus.js, alltså rakt in i CSS. En generell CSS-parser här hade varit både större
// och farligare — allt som inte matchar mönstret nedan faller tillbaka på registrets
// standardvärde. Parentes, klammer, semikolon och citattecken kan därför inte
// förekomma alls, vilket är det som gör injektion omöjlig.
fn is_gradient(s: &str) -> bool {
    let s = s.trim();
    let Some(inner) = s
        .strip_prefix("linear-gradient(")
        .and_then(|r| r.strip_suffix(')'))
    else {
        return false;
    };
    // Inget av detta får finnas i en giltig gradient — och vart och ett av dem är
    // vägen ut ur deklarationen (eller in i url(), var(), calc()).
    if inner.contains(['(', ')', ';', '{', '}', '/', '\\', '"', '\'', '@']) {
        return false;
    }
    let mut parts = inner.split(',');
    // Vinkeln
    let Some(angle) = parts.next().and_then(|a| a.trim().strip_suffix("deg").map(str::to_owned)) else {
        return false;
    };
    match angle.trim().parse::<f64>() {
        Ok(a) if a.is_finite() && (0.0..=360.0).contains(&a) => {}
        _ => return false,
    }
    // Stoppen: "<hex> <procent>%"
    let stops: Vec<&str> = parts.collect();
    if !(2..=4).contains(&stops.len()) {
        return false;
    }
    for st in stops {
        let mut it = st.split_whitespace();
        let (Some(color), Some(pos)) = (it.next(), it.next()) else { return false };
        if it.next().is_some() || !is_hex_color(color) {
            return false;
        }
        let Some(p) = pos.strip_suffix('%') else { return false };
        match p.parse::<f64>() {
            Ok(v) if v.is_finite() && (0.0..=100.0).contains(&v) => {}
            _ => return false,
        }
    }
    true
}

fn is_hex_color(s: &str) -> bool {
    // #rgb, #rgba, #rrggbb och #rrggbbaa. Alfaformerna behovs for ytor och skuggor:
    // <input type="color"> kan bara ge ogenomskinlig hex, sa panelen kombinerar
    // den med ett alfa-reglage och skickar 8-siffrigt varde hit.
    let b = s.as_bytes();
    matches!(b.len(), 4 | 5 | 7 | 9) && b[0] == b'#' && b[1..].iter().all(u8::is_ascii_hexdigit)
}

// Städar en hel optionskarta mot registret: okända nycklar (en option som tagits
// bort ur registry.json) försvinner, saknade fylls med standardvärdet.
fn sanitize_options(d: &OverlayDef, opts: &mut HashMap<String, serde_json::Value>) {
    opts.retain(|k, _| d.options.iter().any(|o| &o.id == k));
    for o in &d.options {
        let cur = opts.get(&o.id).cloned().unwrap_or_else(|| o.default.clone());
        opts.insert(o.id.clone(), sanitize_option(o, &cur));
    }
}

// ── Inställningar (runtime; sparas i app-config-mappen) ─────────────────────
fn default_true() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone)]
struct OverlayState {
    enabled: bool,
    x: i32,
    y: i32,
    scale: f64,
    opacity: f64,
    #[serde(default = "default_true")]
    always_on_top: bool,
    #[serde(default)]
    options: HashMap<String, serde_json::Value>,
}

// Färskt standardläge för en overlay (position/skala/alternativ ur registret).
fn default_state_for(d: &OverlayDef) -> OverlayState {
    let mut options = HashMap::new();
    for o in &d.options {
        options.insert(o.id.clone(), o.default.clone());
    }
    OverlayState {
        enabled: true,
        x: d.default_x,
        y: d.default_y,
        scale: d.default_scale,
        opacity: 1.0,
        always_on_top: true,
        options,
    }
}

#[derive(Serialize, Deserialize, Default)]
struct Settings {
    overlays: HashMap<String, OverlayState>,
    // Egna presets, per overlay-id. Ligger utanför OverlayState med flit: en preset
    // överlever `reset_overlay` (som ersätter hela staten), och det är precis vad
    // man vill — "nollställ utseendet" ska inte kasta de utseenden man sparat.
    //
    // Nytt fält i 0.4.8. Nedgraderingsvägen är kontrollerad (§8.3b): serde ignorerar
    // OKÄNDA fält vid inläsning, så en äldre build läser den här filen utan att
    // kvävas — den tappar bara presetsen tyst. Det är alltså inte samma fälla som
    // 0.3.0:s typbyte på ett BEFINTLIGT fält, som gjorde hela filen oläsbar.
    #[serde(default)]
    presets: HashMap<String, Vec<Preset>>,
    // Layouter, i den ordning användaren skapat dem — den enda ordning man själv
    // kan förutsäga. Samma nedgraderingsväg som `presets`: serde ignorerar okända
    // fält, så en äldre build läser filen utan att kvävas och tappar bara
    // layouterna tyst (§8.3b).
    #[serde(default)]
    layouts: Vec<Layout>,
    // Id på den aktiva layouten, tom sträng = ingen. Ett id och inte ett index:
    // ett index pekar på fel layout så fort en tidigare tas bort.
    #[serde(default)]
    active_layout: String,
    reference_ld: String,
    // global: visa overlays först när motorn är synkad mot ACC (connected==true)
    #[serde(default)]
    hide_until_connected: bool,
    // Filnamnet på förhandsvisningens bakgrund. Tom sträng = ingen bild, alltså den
    // gamla gråa rutan — men det är ett AKTIVT val och inte utgångsläget: saknas
    // fältet (ny installation, äldre settings.json) gäller default_preview_bg().
    // Bara ett namn, ingen sökväg — se get_background.
    #[serde(default = "default_preview_bg")]
    preview_background: String,
    // Kortkommandot som växlar race/edit. Lagras som TEXT och inte som ett
    // strukturerat värde: global-hotkey parsar exakt den här formen
    // ("Ctrl+Alt+Space", "Ctrl+Shift+F7"), och panelen bygger samma sträng ur
    // `event.code`, så texten går hela vägen utan översättning i mitten.
    // Nedgraderingsvägen (§8.3b): en äldre build ignorerar fältet som okänt och
    // tappar bara valet — filen blir inte oläsbar.
    #[serde(default = "default_hotkey")]
    hotkey: String,
}

// Ctrl+Alt+Space har varit kombinationen sedan 0.1 och står i dokumentationen, så
// standardvärdet ändras inte. Den KAN vara upptagen av ett annat program, och det är
// precis varför den går att byta — inte ett skäl att byta standard.
fn default_hotkey() -> String {
    "Ctrl+Alt+Space".into()
}

// Förhandsvisningen visar en bana som standard: poängen med rutan är att se hur
// overlayn läser sig MOT något, och en tom grå yta säger inget om det. Finns filen
// inte (borttagen ur mappen) nollställer panelen valet tyst vid start.
fn default_preview_bg() -> String {
    "spa.webp".into()
}

fn default_settings() -> Settings {
    let mut s = Settings::default();
    // `#[serde(default = …)]` gäller bara vid INLÄSNING av en fil. En helt ny
    // installation har ingen fil alls och går den här vägen, så bakgrunden måste
    // sättas här också — annars fick bara uppgraderande användare den.
    s.preview_background = default_preview_bg();
    s.hotkey = default_hotkey();
    for d in registry() {
        s.overlays.insert(d.id.clone(), default_state_for(d));
    }
    s
}
fn settings_path(app: &AppHandle) -> std::path::PathBuf {
    let dir = app.path().app_config_dir().expect("app_config_dir");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("settings.json")
}
fn load_settings(app: &AppHandle) -> Settings {
    let path = settings_path(app);
    match std::fs::read_to_string(&path) {
        Ok(txt) => {
            let mut s: Settings = match serde_json::from_str(&txt) {
                Ok(s) => s,
                Err(e) => {
                    // Tyst fallback till standardvärden skrev över hela layouten vid
                    // minsta parse-fel (avbrutet skrivpass, manuell redigering med fel
                    // decimaltecken). Lägg den trasiga filen åt sidan i stället, så
                    // positioner och skalor går att rädda för hand.
                    let keep = path.with_extension("corrupt.json");
                    eprintln!("[shell] settings.json kunde ej läsas ({e}). Sparar den som {} och använder standardvärden.",
                              keep.display());
                    let _ = std::fs::rename(&path, &keep);
                    default_settings()
                }
            };
            for d in registry() {
                let st = s.overlays.entry(d.id.clone()).or_insert_with(|| default_state_for(d));
                sanitize_state(d, st);
                // Samma skäl som för options: en handredigerad eller åldrad preset
                // (en option som tagits bort ur registret, ett tal utanför reglagets
                // intervall) ska rättas HÄR och inte nå en overlay.
                if let Some(list) = s.presets.get_mut(&d.id) {
                    for p in list.iter_mut() {
                        sanitize_preset(d, p);
                    }
                    list.truncate(MAX_USER_PRESETS);
                }
            }
            // Presets för overlays som inte längre finns i registret städas bort —
            // annars ligger de kvar för alltid och växer med varje borttagen modul.
            s.presets.retain(|k, _| def_of(k).is_some());
            sanitize_layouts(&mut s);
            s
        }
        Err(_) => default_settings(),
    }
}

// Samma behandling som för presets: en layout kan vara handredigerad, komma från en
// nyare version eller nämna en overlay som tagits bort ur registret. Rättas HÄR, en
// gång, i stället för att slå igenom som ett fönster med orimlig storlek.
fn sanitize_layouts(s: &mut Settings) {
    s.layouts.truncate(MAX_LAYOUTS);
    let mut seen: Vec<String> = Vec::new();
    s.layouts.retain(|l| {
        let ok = !l.id.is_empty() && !seen.contains(&l.id);
        if ok {
            seen.push(l.id.clone());
        }
        ok
    });
    for l in s.layouts.iter_mut() {
        l.name = l.name.trim().chars().take(32).collect();
        if l.name.is_empty() {
            l.name = "Layout".into();
        }
        l.overlays.retain(|k, _| def_of(k).is_some());
        for (id, st) in l.overlays.iter_mut() {
            if let Some(d) = def_of(id) {
                sanitize_state(d, st);
            }
            // Medlemskap ÄR "påslagen". Ett false här hade gett en layout som
            // innehåller en overlay den samtidigt släcker.
            st.enabled = true;
        }
    }
    // En aktiv layout som inte finns är samma sak som ingen aktiv: annars hade
    // sync_active_layout skrivit ut i tomma intet vid varje sparning.
    if !s.layouts.iter().any(|l| l.id == s.active_layout) {
        s.active_layout = String::new();
    }
}

// Speglar det GÄLLANDE läget in i den aktiva layouten. Körs från save_settings, alltså
// vid varje ändring som sparas — det är det som gör den aktiva layouten live-bunden
// utan ett spara-steg, och det som gör att det bara finns EN sanning: layouten är en
// kopia av `overlays`, aldrig en konkurrerande uppsättning värden.
//
// Bara påslagna overlays följer med (medlemskap = påslagen). En avslagen overlay
// behåller sitt läge i `overlays` och kommer tillbaka som den var om man lägger in
// den i layouten igen.
fn sync_active_layout(s: &mut Settings) {
    if s.active_layout.is_empty() {
        return;
    }
    let snapshot: HashMap<String, OverlayState> = s
        .overlays
        .iter()
        .filter(|(id, st)| st.enabled && def_of(id).is_some())
        .map(|(id, st)| (id.clone(), st.clone()))
        .collect();
    let want = s.active_layout.clone();
    if let Some(l) = s.layouts.iter_mut().find(|l| l.id == want) {
        l.overlays = snapshot;
    }
}

fn save_settings(app: &AppHandle, s: &mut Settings) {
    sync_active_layout(s);
    if let Ok(txt) = serde_json::to_string_pretty(s) {
        let _ = std::fs::write(settings_path(app), txt);
    }
}

// true = klick-igenom (race), false = interaktiv (edit)
static CLICK_THROUGH: AtomicBool = AtomicBool::new(true);
fn overlay_ids() -> &'static Vec<String> {
    static V: OnceLock<Vec<String>> = OnceLock::new();
    V.get_or_init(|| registry().iter().map(|d| d.id.clone()).collect())
}

// ── Fönsterhantering ────────────────────────────────────────────────────────
fn create_overlay(
    app: &AppHandle,
    def: &OverlayDef,
    st: &OverlayState,
    hide_until_connected: bool,
) -> tauri::Result<()> {
    let w = def.base_width * st.scale;
    let h = def.base_height * st.scale;
    // Skala, opacitet, grinden, takten OCH alternativen injiceras FÖRE sidan parsas.
    // Overlayn hämtade dem tidigare med get_config/get_globals (async) och ritade med
    // CSS-defaulten tills svaret kom — vilket såg AVKAPAT ut när sparad skala var något
    // annat än defaulten, och gjorde att grinden "endast när ACC kör" inte hann gälla.
    // Landade anropet dessutom före app.manage() kom svaret aldrig och overlayn satt
    // kvar i fel skala tills man rörde reglaget.
    // Alternativen hör hit av samma skäl: ett alternativ som påverkar LAYOUT (antal
    // rader, dolda kolumner) ritar annars ett frame i fel utseende innan svaret kommer.
    let init = format!(
        "window.__OVERLAY_INIT__={};",
        serde_json::json!({
            "id": def.id,
            "scale": st.scale,
            "opacity": st.opacity,
            "gate": hide_until_connected,
            // Grinden måste veta om overlayn är AVSTÄNGD, annars "återställer" den
            // fönstret vid varje återanslutning och en avstängd overlay tänds igen
            // så fort man tabbar in i ACC (§8.5c).
            "enabled": st.enabled,
            // Skalet har redan dolt fönstret om grinden är på. bus.js måste veta det,
            // annars vägrar den visa fönstret igen när ACC ansluter — den visar med
            // flit bara fönster den själv dolt (§8.5b).
            "osHidden": hide_until_connected && st.enabled,
            "hz": def.hz,
            "options": st.options,
        })
    );
    let win = WebviewWindowBuilder::new(app, &def.id, WebviewUrl::App(def.url.clone().into()))
        .title(&def.title)
        .initialization_script(&init)
        .inner_size(w, h)
        .position(st.x as f64, st.y as f64)
        .decorations(false)
        .transparent(true)
        .always_on_top(st.always_on_top)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .focused(false)
        // Skapa avstängda overlays dolda direkt — annars blinkar de synligt vid start
        // innan hide() hinner köras. Samma sak när synk-grinden är på: overlayn ska
        // ändå döljas så fort sidan laddat, och att skapa den synlig gav ett tydligt
        // blink på cirka en sekund vid varje appstart.
        .visible(st.enabled && !hide_until_connected)
        .build()?;
    win.set_ignore_cursor_events(CLICK_THROUGH.load(Ordering::Relaxed))?;
    Ok(())
}

// Spara lägen NU (används när edit-läget lämnas och vid avslut) — annars ligger
// dragna positioner bara i fönstren och försvinner om appen tar en annan väg ut
// än "stäng kontrollpanelen".
fn persist_positions(app: &AppHandle) {
    if let Some(state) = app.try_state::<Mutex<Settings>>() {
        if let Ok(mut s) = state.lock() {
            save_positions(app, &mut s);
            save_settings(app, &mut s);
        }
    }
}

// Positioner sparas i LOGISKA pixlar (samma enhet som WebviewWindowBuilder::position
// och set_position tar). outer_position() ger FYSISKA pixlar, så utan omvandlingen
// vandrar fönstren med skalfaktorn vid varje omstart på skärmar som inte kör 100 %.
fn save_positions(app: &AppHandle, s: &mut Settings) {
    for id in overlay_ids() {
        let Some(w) = app.get_webview_window(id) else { continue };
        let (Ok(pos), Ok(sf)) = (w.outer_position(), w.scale_factor()) else { continue };
        let lp = pos.to_logical::<f64>(sf);
        if let Some(st) = s.overlays.get_mut(id) {
            st.x = lp.x.round() as i32;
            st.y = lp.y.round() as i32;
        }
    }
}

// En storleksändring av ett transparent always-on-top-fönster är INTE gratis: WebView2
// bygger om sin renderyta och DWM måste komponera om ytan över spelet. Panelen stryper
// därför sina anrop medan man drar (throttleIpc i kontrollpanelen), och här sorteras
// resten bort — den avslutande, redan gällande storleken skickas alltid en extra gång
// när reglaget släpps, och tidigare gjorde den ett fullt resize-varv för ingenting.
fn apply_size(app: &AppHandle, id: &str, scale: f64) {
    if let (Some(def), Some(win)) = (def_of(id), app.get_webview_window(id)) {
        let (w, h) = (def.base_width * scale, def.base_height * scale);
        if let (Ok(cur), Ok(sf)) = (win.inner_size(), win.scale_factor()) {
            let l = cur.to_logical::<f64>(sf);
            // Halv logisk pixel: storleken går genom fysiska pixlar och tillbaka, så
            // exakt likhet är inte att räkna med.
            if (l.width - w).abs() < 0.5 && (l.height - h).abs() < 0.5 {
                return;
            }
        }
        let _ = win.set_size(tauri::LogicalSize::new(w, h));
    }
}

// ── Kontrollpanelens startstorlek ───────────────────────────────────────────
// Referensen är 1440×900 på en 1920×1080-skärm. Ett fast pixelmått hade gett en
// panel som täcker halva skärmen på en 1366-laptop och sitter som en frimärke mitt
// på en 4K-skärm som körs utan skalning, så vi håller ANDELEN av skärmen i stället:
// 75 % av bredden och 83,3 % av höjden.
//
// Måtten räknas mot skärmens LOGISKA storlek (§8.2): `Monitor::size()` är fysiska
// pixlar, medan `set_size(LogicalSize)` tar logiska. På en 4K-skärm i Windows
// standardläge (200 %) är den logiska storleken 1920×1080 och panelen blir alltså
// exakt 1440×900 — samma synliga storlek som på en 1080p-skärm, vilket är poängen.
// Körs samma skärm utan skalning blir den 2880×1800, dvs. samma ANDEL av ytan.
//
// `width`/`height` i tauri.conf.json är fallbacken om skärmen inte går att fråga.
const PANEL_REF: (f64, f64) = (1440.0, 900.0);
const PANEL_SCREEN_REF: (f64, f64) = (1920.0, 1080.0);
// Samma golv som minWidth/minHeight i tauri.conf.json — panelens layout (78 px rail
// + 268 px lista + detaljvy) blir trång under detta.
const PANEL_MIN: (f64, f64) = (960.0, 600.0);

fn size_control_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("control") else { return };
    // current_monitor() ger skärmen fönstret ligger på — det är redan centrerat av
    // Tauri, alltså primärskärmen i praktiken, men följer med om användaren har en
    // annan primär.
    let Ok(Some(mon)) = win.current_monitor() else { return };
    let screen = mon.size().to_logical::<f64>(mon.scale_factor());
    if screen.width < 1.0 || screen.height < 1.0 {
        return;
    }

    // Golvet klampas mot skärmen först: på en skärm smalare än golvet ska fönstret
    // fylla skärmen, inte hamna utanför den.
    let min_w = PANEL_MIN.0.min(screen.width);
    let min_h = PANEL_MIN.1.min(screen.height);
    let w = (screen.width * PANEL_REF.0 / PANEL_SCREEN_REF.0).clamp(min_w, screen.width);
    let h = (screen.height * PANEL_REF.1 / PANEL_SCREEN_REF.1).clamp(min_h, screen.height);

    let _ = win.set_size(tauri::LogicalSize::new(w.round(), h.round()));
    // Storleksändringen sker efter Tauris `center: true`, så fönstret måste
    // centreras om — annars ligger det kvar med sitt gamla vänsterhörn.
    let _ = win.center();
}

// ── Kommandon som kontrollpanelen anropar ───────────────────────────────────
#[derive(Serialize)]
struct OverlayInfo {
    id: String,
    title: String,
    desc: String,
    url: String,
    base_width: f64,
    base_height: f64,
    // Positionen i LOGISKA pixlar — samma enhet som set_position tar (§8.2).
    // Layout-flikens skärmvy ritar overlays ur den här och skickar tillbaka nya
    // värden när man drar; utan den hade panelen inte vetat var något ligger.
    x: i32,
    y: i32,
    enabled: bool,
    scale: f64,
    opacity: f64,
    always_on_top: bool,
    options: HashMap<String, serde_json::Value>,
    option_defs: Vec<OverlayOption>,
}

#[tauri::command]
fn get_overlays(state: State<Mutex<Settings>>) -> Vec<OverlayInfo> {
    let s = state.lock().unwrap();
    registry()
        .iter()
        .map(|d| {
            let st = s.overlays.get(&d.id).cloned().unwrap_or_else(|| default_state_for(d));
            let mut options = st.options.clone();
            sanitize_options(d, &mut options);
            OverlayInfo {
                id: d.id.clone(),
                title: d.title.clone(),
                desc: d.desc.clone(),
                url: d.url.clone(),
                base_width: d.base_width,
                base_height: d.base_height,
                x: st.x,
                y: st.y,
                enabled: st.enabled,
                scale: st.scale,
                opacity: st.opacity,
                always_on_top: st.always_on_top,
                options,
                option_defs: d.options.clone(),
            }
        })
        .collect()
}

// config/option skickas till ALLA fönster (app.emit) och filtreras på payload-id i
// bus.js — inte med emit_to(label). Skälet: kontrollpanelens förhandsvisning kör
// overlayn i en iframe inuti "control"-fönstret, och emit_to hade aldrig nått den.
#[derive(Serialize, Clone)]
struct ConfigPayload {
    id: String,
    scale: f64,
    opacity: f64,
}

// Av/på. Skalet visar/döljer fönstret själv — detta är så bus.js VET om det och kan
// låta bli att återställa en avstängd overlay när ACC ansluter igen (§8.5c).
#[derive(Serialize, Clone)]
struct EnabledPayload {
    id: String,
    enabled: bool,
}

#[derive(Serialize, Clone)]
struct OptionPayload {
    id: String,
    option: String,
    value: serde_json::Value,
}

#[derive(Serialize)]
struct ConfigInit {
    scale: f64,
    opacity: f64,
    options: HashMap<String, serde_json::Value>,
}

// Overlayn hämtar sin config vid start (undviker race mot event-lyssnaren).
#[tauri::command]
fn get_config(id: String, state: State<Mutex<Settings>>) -> ConfigInit {
    let s = state.lock().unwrap();
    let (scale, opacity, mut options) = s
        .overlays
        .get(&id)
        .map(|st| (st.scale, st.opacity, st.options.clone()))
        .unwrap_or((1.0, 1.0, HashMap::new()));
    if let Some(d) = def_of(&id) {
        sanitize_options(d, &mut options);
    }
    ConfigInit { scale, opacity, options }
}

#[tauri::command]
fn set_enabled(app: AppHandle, state: State<Mutex<Settings>>, id: String, enabled: bool) {
    {
        let mut s = state.lock().unwrap();
        if let Some(st) = s.overlays.get_mut(&id) { st.enabled = enabled; }
        save_settings(&app, &mut s);
    }
    // Skicka FÖRE show/hide: bus.js ska ha släppt sitt anspråk på fönstret innan
    // skalet rör det, annars kan grinden hinna dölja det vi just visat.
    let _ = app.emit("enabled", EnabledPayload { id: id.clone(), enabled });
    if let Some(win) = app.get_webview_window(&id) {
        if enabled { let _ = win.show(); } else { let _ = win.hide(); }
    } else if enabled {
        let (st, gate) = {
            let s = state.lock().unwrap();
            (s.overlays.get(&id).cloned(), s.hide_until_connected)
        };
        if let (Some(def), Some(st)) = (def_of(&id), st) {
            let _ = create_overlay(&app, def, &st, gate);
        }
    }
}

#[tauri::command]
fn set_scale(app: AppHandle, state: State<Mutex<Settings>>, id: String, scale: f64) {
    let (opacity, prev);
    {
        let mut s = state.lock().unwrap();
        prev = s.overlays.get(&id).map(|st| st.scale).unwrap_or(scale);
        if let Some(st) = s.overlays.get_mut(&id) { st.scale = scale; }
        opacity = s.overlays.get(&id).map(|s| s.opacity).unwrap_or(1.0);
        save_settings(&app, &mut s);
    }
    // Fönsterstorlek och CSS-skala ändras i två steg; gör det större steget först
    // så innehållet aldrig klipps av ett för litet fönster däremellan.
    let cfg = ConfigPayload { id: id.clone(), scale, opacity };
    if scale > prev {
        apply_size(&app, &id, scale);
        let _ = app.emit("config", cfg);
    } else {
        let _ = app.emit("config", cfg);
        apply_size(&app, &id, scale);
    }
}

#[tauri::command]
fn set_opacity(app: AppHandle, state: State<Mutex<Settings>>, id: String, opacity: f64) {
    let scale;
    {
        let mut s = state.lock().unwrap();
        if let Some(st) = s.overlays.get_mut(&id) { st.opacity = opacity; }
        scale = s.overlays.get(&id).map(|s| s.scale).unwrap_or(1.0);
        save_settings(&app, &mut s);
    }
    let _ = app.emit("config", ConfigPayload { id: id.clone(), scale, opacity });
}

// Per-overlay always-on-top (era overlays skapas redan överst; detta togglar det).
#[tauri::command]
fn set_always_on_top(app: AppHandle, state: State<Mutex<Settings>>, id: String, value: bool) {
    {
        let mut s = state.lock().unwrap();
        if let Some(st) = s.overlays.get_mut(&id) { st.always_on_top = value; }
        save_settings(&app, &mut s);
    }
    if let Some(win) = app.get_webview_window(&id) { let _ = win.set_always_on_top(value); }
}

// Per-overlay alternativ. Typen står i registry.json; värdet valideras mot den innan
// det sparas och skickas ut, så en overlay aldrig får ett värde den inte kan hantera.
// Overlayn läser detta via wireShell (och vid start ur __OVERLAY_INIT__).
#[tauri::command]
fn set_option(
    app: AppHandle,
    state: State<Mutex<Settings>>,
    id: String,
    option: String,
    value: serde_json::Value,
) {
    let Some(def) = def_of(&id) else { return };
    let Some(opt) = def.options.iter().find(|o| o.id == option) else { return };
    let value = sanitize_option(opt, &value);
    {
        let mut s = state.lock().unwrap();
        if let Some(st) = s.overlays.get_mut(&id) { st.options.insert(option.clone(), value.clone()); }
        save_settings(&app, &mut s);
    }
    let _ = app.emit("option", OptionPayload { id: id.clone(), option, value });
}

// Nollställ läge/utseende/alternativ till registrets standard (behåller på/av).
#[tauri::command]
fn reset_overlay(app: AppHandle, state: State<Mutex<Settings>>, id: String) {
    let def = match def_of(&id) { Some(d) => d, None => return };
    let (scale, opacity, options) = {
        let mut s = state.lock().unwrap();
        if let Some(cur) = s.overlays.get_mut(&id) {
            let enabled = cur.enabled;
            *cur = OverlayState { enabled, ..default_state_for(def) };
        }
        save_settings(&app, &mut s);
        let st = s.overlays.get(&id).cloned().unwrap_or_else(|| default_state_for(def));
        (st.scale, st.opacity, st.options.clone())
    };
    if let Some(win) = app.get_webview_window(&id) {
        let _ = win.set_size(tauri::LogicalSize::new(def.base_width * scale, def.base_height * scale));
        let _ = win.set_position(tauri::LogicalPosition::new(def.default_x as f64, def.default_y as f64));
        let _ = win.set_always_on_top(true);
    }
    let _ = app.emit("config", ConfigPayload { id: id.clone(), scale, opacity });
    for (opt, val) in options {
        let _ = app.emit("option", OptionPayload { id: id.clone(), option: opt, value: val });
    }
}

// Flytta en overlay från panelen (layout-flikens skärmvy). Samma väg som när man
// drar fönstret i edit-läge, bara med panelen som avsändare — därför LOGISKA pixlar
// hela vägen (§8.2), och därför sparas värdet även när fönstret inte finns
// (avstängd overlay): create_overlay läser st.x/st.y när den tänds igen.
//
// Att flytta ett transparent always-on-top-fönster kostar samma DWM-arbete som att
// ändra dess storlek, så panelen stryper anropen medan man drar (§8.5e). Här sorteras
// resten bort: en position som redan gäller görs inte om.
#[tauri::command]
fn set_position(app: AppHandle, state: State<Mutex<Settings>>, id: String, x: i32, y: i32) {
    if def_of(&id).is_none() {
        return;
    }
    let (x, y) = (x.clamp(-POS_LIMIT, POS_LIMIT), y.clamp(-POS_LIMIT, POS_LIMIT));
    {
        let mut s = state.lock().unwrap();
        match s.overlays.get_mut(&id) {
            Some(st) if st.x == x && st.y == y => return,
            Some(st) => {
                st.x = x;
                st.y = y;
            }
            None => return,
        }
        save_settings(&app, &mut s);
    }
    if let Some(win) = app.get_webview_window(&id) {
        let _ = win.set_position(tauri::LogicalPosition::new(x as f64, y as f64));
    }
}

#[derive(Serialize)]
struct ScreenInfo {
    width: f64,
    height: f64,
}

// Skärmvyn måste ha samma proportioner som skärmen overlays faktiskt hamnar på,
// annars ljuger den om var något ligger. LOGISKA pixlar av samma skäl som
// size_control_window (§8.2b): overlay-positioner är logiska, `Monitor::size()` är
// fysiska. Faller frågan (ingen skärm att fråga) får panelen 0 och ritar sitt
// fallback-format i stället för att räkna på ett nolltal.
#[tauri::command]
fn get_screen(app: AppHandle) -> ScreenInfo {
    let size = app
        .get_webview_window("control")
        .and_then(|w| w.current_monitor().ok().flatten())
        .map(|m| m.size().to_logical::<f64>(m.scale_factor()));
    match size {
        Some(s) if s.width >= 1.0 && s.height >= 1.0 => ScreenInfo { width: s.width, height: s.height },
        _ => ScreenInfo { width: 0.0, height: 0.0 },
    }
}

// ── Layouter ────────────────────────────────────────────────────────────────
#[derive(Serialize)]
struct LayoutSlotInfo {
    id: String,
    title: String,
    x: i32,
    y: i32,
    // Färdigräknad fönsterstorlek (base × skala) så panelen slipper slå upp defen
    // för varje slot i varje miniatyr.
    w: f64,
    h: f64,
}

#[derive(Serialize)]
struct LayoutInfo {
    id: String,
    name: String,
    active: bool,
    slots: Vec<LayoutSlotInfo>,
}

fn layout_info(l: &Layout, active: &str) -> LayoutInfo {
    // Registrets ordning och inte kartans: en HashMap itereras i godtycklig ordning,
    // och en miniatyr där overlays byter ritordning mellan två anrop ser trasig ut.
    let slots = registry()
        .iter()
        .filter_map(|d| {
            let st = l.overlays.get(&d.id)?;
            Some(LayoutSlotInfo {
                id: d.id.clone(),
                title: d.title.clone(),
                x: st.x,
                y: st.y,
                w: d.base_width * st.scale,
                h: d.base_height * st.scale,
            })
        })
        .collect();
    LayoutInfo { id: l.id.clone(), name: l.name.clone(), active: l.id == active, slots }
}

#[tauri::command]
fn list_layouts(state: State<Mutex<Settings>>) -> Vec<LayoutInfo> {
    let mut s = state.lock().unwrap();
    // Spegla först: den aktiva layoutens miniatyr ska visa läget som det ÄR just nu,
    // inte som det var när något sist sparades.
    sync_active_layout(&mut s);
    let active = s.active_layout.clone();
    s.layouts.iter().map(|l| layout_info(l, &active)).collect()
}

fn unique_layout_id(s: &Settings, name: &str) -> String {
    let base = slug(name);
    let mut id = base.clone();
    let mut n = 2;
    while s.layouts.iter().any(|l| l.id == id) {
        id = format!("{base}-{n}");
        n += 1;
    }
    id
}

// Skapar en layout ur DET GÄLLANDE läget. Alternativet — en tom layout — hade tvingat
// fram ett läge där skärmvyn är tom och man inte ser vad man håller på med förrän man
// lagt tillbaka overlays en och en. Vill man tomt tar man bort dem, vilket är ett
// klick per overlay och syns direkt.
#[tauri::command]
fn create_layout(app: AppHandle, state: State<Mutex<Settings>>, name: String) -> Result<String, String> {
    let label: String = name.trim().chars().take(32).collect();
    if label.is_empty() {
        return Err("Ge layouten ett namn.".into());
    }
    let mut s = state.lock().unwrap();
    if s.layouts.len() >= MAX_LAYOUTS {
        return Err(format!("Max {MAX_LAYOUTS} layouter."));
    }
    // Spegla ut i den gamla aktiva innan bytet, annars tappas allt som ändrats sedan
    // förra sparningen när den nya tar över som aktiv.
    sync_active_layout(&mut s);
    let id = unique_layout_id(&s, &label);
    let overlays = s
        .overlays
        .iter()
        .filter(|(oid, st)| st.enabled && def_of(oid).is_some())
        .map(|(oid, st)| (oid.clone(), st.clone()))
        .collect();
    s.layouts.push(Layout { id: id.clone(), name: label, overlays });
    s.active_layout = id.clone();
    save_settings(&app, &mut s);
    Ok(id)
}

#[tauri::command]
fn rename_layout(app: AppHandle, state: State<Mutex<Settings>>, id: String, name: String) -> Result<(), String> {
    let label: String = name.trim().chars().take(32).collect();
    if label.is_empty() {
        return Err("Ge layouten ett namn.".into());
    }
    let mut s = state.lock().unwrap();
    let l = s.layouts.iter_mut().find(|l| l.id == id).ok_or("okänd layout")?;
    l.name = label;
    save_settings(&app, &mut s);
    Ok(())
}

// Kopian blir INTE aktiv. Man duplicerar för att prova något utan att röra originalet,
// och att kastas över i kopian hade betytt att nästa ändring landade i fel layout.
#[tauri::command]
fn duplicate_layout(app: AppHandle, state: State<Mutex<Settings>>, id: String) -> Result<String, String> {
    let mut s = state.lock().unwrap();
    if s.layouts.len() >= MAX_LAYOUTS {
        return Err(format!("Max {MAX_LAYOUTS} layouter."));
    }
    sync_active_layout(&mut s);
    let src = s.layouts.iter().find(|l| l.id == id).cloned().ok_or("okänd layout")?;
    let name: String = format!("{} (kopia)", src.name).chars().take(32).collect();
    let new_id = unique_layout_id(&s, &name);
    s.layouts.push(Layout { id: new_id.clone(), name, overlays: src.overlays });
    save_settings(&app, &mut s);
    Ok(new_id)
}

// Att ta bort den AKTIVA layouten släcker inga overlays: läget ligger i
// `settings.overlays` och står kvar precis som det är. Man tappar namnet och vägen
// tillbaka till det, inte skärmen man just satt och tittade på.
#[tauri::command]
fn delete_layout(app: AppHandle, state: State<Mutex<Settings>>, id: String) -> Result<(), String> {
    let mut s = state.lock().unwrap();
    let before = s.layouts.len();
    s.layouts.retain(|l| l.id != id);
    if s.layouts.len() == before {
        return Err("okänd layout".into());
    }
    if s.active_layout == id {
        s.active_layout = String::new();
    }
    save_settings(&app, &mut s);
    Ok(())
}

// Aktiverar en layout (tom sträng = ingen aktiv) och SKRIVER UT den: varje overlay som
// ingår får sitt läge tillbaka, varje overlay som inte ingår stängs av.
//
// Vägen är medvetet densamma som apply_preset/reset_overlay tar, med ett tillägg:
// positionen. Missar man storleken ritas overlayn i ny skala i ett fönster med gammal
// (§8.3), och missar man positionen står den kvar där förra layouten lade den —
// vilket är precis det man bytte layout för att slippa.
#[tauri::command]
fn activate_layout(app: AppHandle, state: State<Mutex<Settings>>, id: String) -> Result<(), String> {
    // Fönsterarbetet görs UTANFÖR låset: create_overlay och show/hide går via
    // fönstertråden, och att hålla Mutex<Settings> under tiden låser panelens övriga
    // anrop i onödan.
    let plan: Vec<(&'static OverlayDef, OverlayState)>;
    let gate;
    {
        let mut s = state.lock().unwrap();
        // Spegla den gamla aktiva innan vi skriver över det gällande läget — annars
        // förlorar man allt som ändrats sedan förra sparningen i den man lämnar.
        sync_active_layout(&mut s);
        if id.is_empty() {
            s.active_layout = String::new();
            save_settings(&app, &mut s);
            return Ok(());
        }
        let l = s.layouts.iter().find(|l| l.id == id).cloned().ok_or("okänd layout")?;
        for d in registry() {
            match l.overlays.get(&d.id) {
                Some(want) => {
                    let mut st = want.clone();
                    st.enabled = true;
                    sanitize_state(d, &mut st);
                    s.overlays.insert(d.id.clone(), st);
                }
                // Bara av/på ändras för den som inte ingår: dess läge ska finnas kvar
                // om man lägger tillbaka den senare.
                None => {
                    if let Some(st) = s.overlays.get_mut(&d.id) {
                        st.enabled = false;
                    }
                }
            }
        }
        s.active_layout = id.clone();
        save_settings(&app, &mut s);
        gate = s.hide_until_connected;
        plan = registry()
            .iter()
            .map(|d| {
                let st = s.overlays.get(&d.id).cloned().unwrap_or_else(|| default_state_for(d));
                (d, st)
            })
            .collect();
    }

    for (def, st) in plan {
        // Eventet FÖRE show/hide, av samma skäl som i set_enabled: bus.js måste ha
        // släppt sitt anspråk på fönstret innan skalet rör det (§8.5c).
        let _ = app.emit("enabled", EnabledPayload { id: def.id.clone(), enabled: st.enabled });
        match app.get_webview_window(&def.id) {
            Some(win) => {
                if st.enabled {
                    let _ = win.set_size(tauri::LogicalSize::new(
                        def.base_width * st.scale,
                        def.base_height * st.scale,
                    ));
                    let _ = win.set_position(tauri::LogicalPosition::new(st.x as f64, st.y as f64));
                    let _ = win.set_always_on_top(st.always_on_top);
                    let _ = win.show();
                } else {
                    let _ = win.hide();
                }
            }
            None if st.enabled => {
                if let Err(e) = create_overlay(&app, def, &st, gate) {
                    eprintln!("[shell] kunde ej skapa overlay {}: {e}", def.id);
                }
            }
            None => {}
        }
        if st.enabled {
            let _ = app.emit(
                "config",
                ConfigPayload { id: def.id.clone(), scale: st.scale, opacity: st.opacity },
            );
            for (option, value) in st.options {
                let _ = app.emit("option", OptionPayload { id: def.id.clone(), option, value });
            }
        }
    }
    Ok(())
}

// ── Presets ─────────────────────────────────────────────────────────────────
#[derive(Serialize)]
struct PresetInfo {
    id: String,
    label: String,
    // Panelen behöver skilja dem åt: en inbyggd går inte att ta bort eller döpa om,
    // och en TOM inbyggd (platshållare utan värden) ska visas dämpad i stället för
    // att se ut som en preset som inte gör något när man klickar.
    builtin: bool,
    empty: bool,
    // Hela värdet med, så panelen kan markera vilken preset som är aktiv utan en
    // extra rundtur — och så en egen preset går att kopiera som JSON in i
    // registry.json när man vill befordra den till inbyggd.
    scale: Option<f64>,
    opacity: Option<f64>,
    options: HashMap<String, serde_json::Value>,
}

fn preset_infos(s: &Settings, d: &OverlayDef) -> Vec<PresetInfo> {
    let mk = |p: &Preset, builtin: bool| {
        let mut q = p.clone();
        sanitize_preset(d, &mut q);
        PresetInfo {
            empty: q.scale.is_none() && q.opacity.is_none() && q.options.is_empty(),
            id: q.id,
            label: q.label,
            builtin,
            scale: q.scale,
            opacity: q.opacity,
            options: q.options,
        }
    };
    // Inbyggda först, egna sedan. Ordningen är listans ordning i respektive källa —
    // egna presets ligger i sparad ordning, vilket är den enda ordning användaren
    // själv kan förutsäga.
    let mut out: Vec<PresetInfo> = d.presets.iter().map(|p| mk(p, true)).collect();
    if let Some(list) = s.presets.get(&d.id) {
        out.extend(list.iter().map(|p| mk(p, false)));
    }
    out
}

// Skriver ett helt utseende till en overlay: skala, opacitet och de alternativ
// presetten nämner. Vägen är MEDVETET identisk med reset_overlay:s — fönstret får
// ny storlek, och config/option-eventen skickas ut så både overlayn och panelens
// förhandsvisning följer med. Missar man fönsterstorleken ritas overlayn i ny skala
// i ett fönster med gammal storlek, alltså avkapad (§8.3).
#[tauri::command]
fn apply_preset(
    app: AppHandle,
    state: State<Mutex<Settings>>,
    id: String,
    preset: String,
) -> Result<(), String> {
    let def = def_of(&id).ok_or("okänd overlay")?;
    let (scale, opacity, changed) = {
        let mut s = state.lock().unwrap();
        let mut p = preset_infos(&s, def)
            .into_iter()
            .find(|p| p.id == preset)
            .ok_or("okänd preset")?;
        let st = s.overlays.entry(id.clone()).or_insert_with(|| default_state_for(def));
        if let Some(v) = p.scale { st.scale = v; }
        if let Some(v) = p.opacity { st.opacity = v; }
        let mut changed = HashMap::new();
        for (k, v) in p.options.drain() {
            st.options.insert(k.clone(), v.clone());
            changed.insert(k, v);
        }
        let (scale, opacity) = (st.scale, st.opacity);
        save_settings(&app, &mut s);
        (scale, opacity, changed)
    };
    if let Some(win) = app.get_webview_window(&id) {
        let _ = win.set_size(tauri::LogicalSize::new(def.base_width * scale, def.base_height * scale));
    }
    let _ = app.emit("config", ConfigPayload { id: id.clone(), scale, opacity });
    for (option, value) in changed {
        let _ = app.emit("option", OptionPayload { id: id.clone(), option, value });
    }
    Ok(())
}

// Gör ett id av namnet så settings.json går att läsa för hand — "u1730214000123"
// säger ingenting om vad presetten är. Kollisioner får ett löpnummer.
fn slug(name: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in name.chars().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() {
            out.push(c);
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
    }
    let s = out.trim_end_matches('-');
    if s.is_empty() { "preset".into() } else { s.chars().take(40).collect() }
}

// Sparar overlayens NUVARANDE utseende under ett namn. Fångar allt (skala, opacitet,
// samtliga alternativ) — till skillnad från en inbyggd preset, som gärna utelämnar
// skalan. Skälet står vid Preset-structen.
#[tauri::command]
fn save_preset(
    app: AppHandle,
    state: State<Mutex<Settings>>,
    id: String,
    name: String,
) -> Result<String, String> {
    let def = def_of(&id).ok_or("okänd overlay")?;
    let label: String = name.trim().chars().take(32).collect();
    if label.is_empty() {
        return Err("Ge presetten ett namn.".into());
    }
    let mut s = state.lock().unwrap();
    // Läs staten FÖRE den muterbara lånet på presets — annars lånas `s` både
    // muterbart och omuterbart samtidigt.
    let st = s.overlays.get(&id).cloned().unwrap_or_else(|| default_state_for(def));
    let list = s.presets.entry(id.clone()).or_default();
    // Samma namn igen = skriv ÖVER den, inte skapa en tvilling. Att spara om en
    // preset man just justerat är det vanligaste man vill göra, och två rader med
    // identisk etikett hade varit omöjliga att skilja åt i listan.
    let existing = list.iter().position(|p| p.label.eq_ignore_ascii_case(&label));
    if existing.is_none() && list.len() >= MAX_USER_PRESETS {
        return Err(format!("Max {MAX_USER_PRESETS} egna presets per overlay."));
    }
    let pid = match existing {
        // Behåll id:t vid överskrivning: panelen kan ha det som "aktiv preset".
        Some(i) => list[i].id.clone(),
        None => {
            let base = slug(&label);
            let mut pid = base.clone();
            let mut n = 2;
            while list.iter().any(|p| p.id == pid) {
                pid = format!("{base}-{n}");
                n += 1;
            }
            pid
        }
    };
    let mut p = Preset {
        id: pid.clone(),
        label,
        scale: Some(st.scale),
        opacity: Some(st.opacity),
        options: st.options.clone(),
    };
    sanitize_preset(def, &mut p);
    match existing {
        Some(i) => list[i] = p,
        None => list.push(p),
    }
    save_settings(&app, &mut s);
    Ok(pid)
}

// Bara EGNA presets går att ta bort. En inbyggd ligger i registry.json och kan inte
// raderas ur settings — hade kommandot låtsats lyckas vore listan osynkad med disken
// vid nästa start.
#[tauri::command]
fn delete_preset(
    app: AppHandle,
    state: State<Mutex<Settings>>,
    id: String,
    preset: String,
) -> Result<(), String> {
    let mut s = state.lock().unwrap();
    let list = s.presets.get_mut(&id).ok_or("inga egna presets")?;
    let before = list.len();
    list.retain(|p| p.id != preset);
    if list.len() == before {
        return Err("Bara egna presets går att ta bort.".into());
    }
    save_settings(&app, &mut s);
    Ok(())
}

#[tauri::command]
fn list_presets(state: State<Mutex<Settings>>, id: String) -> Vec<PresetInfo> {
    let s = state.lock().unwrap();
    def_of(&id).map(|d| preset_infos(&s, d)).unwrap_or_default()
}

// Slå på/av edit-läge från panelen (samma effekt som hotkey Ctrl+Alt+Space).
// I edit-läge blir overlay-fönstren interaktiva så de kan dras på plats.
#[tauri::command]
fn set_edit_mode(app: AppHandle, edit: bool) {
    let click_through = !edit;
    CLICK_THROUGH.store(click_through, Ordering::Relaxed);
    for id in overlay_ids() {
        if let Some(w) = app.get_webview_window(id) {
            let _ = w.set_ignore_cursor_events(click_through);
        }
    }
    // Lämnar vi edit-läget är dragningen klar → spara direkt.
    if !edit {
        persist_positions(&app);
    }
    let _ = app.emit("edit-mode", edit);
}

// ── Kortkommandot ───────────────────────────────────────────────────────────
// Den REGISTRERADE kombinationen, så att både plugin-handlern (som får varje
// genväg appen äger) och set_hotkey (som måste avregistrera den gamla) vet vilken
// som gäller. Ett OnceLock och inte en konstant: den kan bytas i drift.
static HOTKEY: OnceLock<Mutex<Option<Shortcut>>> = OnceLock::new();
fn hotkey_slot() -> &'static Mutex<Option<Shortcut>> {
    HOTKEY.get_or_init(|| Mutex::new(None))
}
fn current_hotkey() -> Option<Shortcut> {
    hotkey_slot().lock().ok().and_then(|g| *g)
}

// Växla klick-igenom (race) ↔ interaktivt (edit). Samma väg som panelens
// set_edit_mode, men startad från tangentbordet. Låg tidigare inne i
// plugin-handlerns closure; den behövde flyttas ut när handlern slutade äga
// kombinationen (den jämför nu mot HOTKEY i stället för mot en infångad kopia).
fn toggle_edit_from_hotkey(app: &AppHandle) {
    let next = !CLICK_THROUGH.load(Ordering::Relaxed);
    CLICK_THROUGH.store(next, Ordering::Relaxed);
    for id in overlay_ids() {
        if let Some(w) = app.get_webview_window(id) {
            let _ = w.set_ignore_cursor_events(next);
        }
    }
    // next == true betyder klick-igenom, dvs. edit-läget lämnas.
    if next {
        persist_positions(app);
    }
    let _ = app.emit("edit-mode", !next);
}

// Byt kortkommando. Registreringen görs OM direkt, för det är enda sättet att veta
// om kombinationen går att få: en global genväg kan vara upptagen av ett annat
// program, och det syns inte förrän man försöker. Misslyckas den läggs den GAMLA
// tillbaka — annars hade ett felklick lämnat användaren helt utan kortkommando, och
// det enda sättet in i edit-läge vore panelens flytta-knapp.
#[tauri::command]
fn set_hotkey(app: AppHandle, state: State<Mutex<Settings>>, value: String) -> Result<String, String> {
    let text = value.trim().to_string();
    let want: Shortcut = text
        .parse()
        .map_err(|e| format!("«{text}» går inte att tolka som en tangentkombination ({e})"))?;
    // Minst en modifierare. Panelen kräver samma sak, men regeln måste finnas HÄR
    // också: IPC:n är inte panelens text, och ett globalt kortkommando på en bar
    // tangent fångar den i alla program — man kan inte skriva bokstaven längre.
    if want.mods.is_empty() {
        return Err("kombinationen måste innehålla Ctrl, Alt, Shift eller Win".into());
    }
    let prev = current_hotkey();
    if prev != Some(want) {
        let gs = app.global_shortcut();
        if let Some(p) = prev {
            let _ = gs.unregister(p);
        }
        if let Err(e) = gs.register(want) {
            if let Some(p) = prev {
                let _ = gs.register(p);
            }
            return Err(format!("{e}"));
        }
        if let Ok(mut g) = hotkey_slot().lock() {
            *g = Some(want);
        }
    }
    {
        let mut s = state.lock().unwrap();
        s.hotkey = text.clone();
        save_settings(&app, &mut s);
    }
    Ok(text)
}

// Skriv referens-path till motorns config-fil (motorn pollar den och laddar .ld).
#[tauri::command]
fn set_reference(app: AppHandle, state: State<Mutex<Settings>>, path: String) {
    {
        let mut s = state.lock().unwrap();
        s.reference_ld = path.clone();
        save_settings(&app, &mut s);
    }
    if let Ok(dir) = app.path().app_config_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join("engine.config.json"),
            serde_json::json!({ "reference_ld": path }).to_string());
    }
}

// Anropas av panelen strax innan updateraren installerar. Updateraren startar
// installeraren och gör sedan `std::process::exit(0)` inifrån plugin:et — det går
// FÖRBI både CloseRequested-hanteraren och RunEvent::Exit, så positioner som dragits
// under sessionen hade annars gått förlorade vid varje uppdatering, och motorn hade
// levt kvar precis så länge det tar för OS:et att stänga Job Object-handtaget medan
// installeraren redan vill skriva över acc-engine.exe.
#[tauri::command]
fn prepare_update(app: AppHandle) {
    persist_positions(&app);
    stop_engine();
}

// ── Bakgrunder till förhandsvisningen ───────────────────────────────────────
// Två kataloger, och skillnaden mellan dem spelar roll:
//
//   1. INBYGGDA  — följer med utgåvan. Ligger i `resource_dir()/web/shared/
//      preview-backgrounds` (i dev: repots `src/shared/preview-backgrounds`).
//      Skrivs över vid varje uppdatering.
//   2. EGNA      — `app_config_dir()/preview-backgrounds`. Överlever uppdateringar.
//      Det är HIT man lägger sina egna bilder; katalogen skapas vid start så den
//      alltid finns att öppna.
//
// Bilderna lämnas ut som data-URL och INTE som en vanlig sökväg. Skälet är att den
// paketerade appen läser sitt webbinnehåll ur ett inbäddat arkiv i exe:n, inte från
// disk: en fil som användaren lägger i katalogen finns alltså inte på någon URL som
// webviewen kan hämta. Data-URL fungerar likadant för båda katalogerna, i dev som i
// release, utan att öppna asset-protokollet.
const BG_EXTS: [&str; 5] = ["webp", "jpg", "jpeg", "png", "avif"];
// Taket finns för att en data-URL går genom IPC:n som text. En bakgrund på 24 MB är
// ändå fel verktyg — previewrutan är någon tusendel av det.
const BG_MAX_BYTES: u64 = 24 * 1024 * 1024;

#[derive(Serialize)]
struct BackgroundInfo {
    id: String,
    label: String,
    custom: bool,
}

fn bundled_bg_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    if let Ok(d) = app.path().resource_dir() {
        let p = d.join("web/shared/preview-backgrounds");
        if p.is_dir() {
            return Some(p);
        }
    }
    // Dev: resource_dir pekar på target/debug, där web/ inte finns.
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../src/shared/preview-backgrounds");
    if p.is_dir() { Some(p) } else { None }
}

fn custom_bg_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    let d = app.path().app_config_dir().ok()?.join("preview-backgrounds");
    let _ = std::fs::create_dir_all(&d);
    Some(d)
}

// Bara ett rent filnamn får passera. Utan detta hade `../../../` i id:t läst vilken
// fil som helst på disken och lämnat ut den som data-URL till webviewen — id:t kommer
// från IPC:n och är alltså inte vår text.
fn is_safe_bg_name(id: &str) -> bool {
    !id.is_empty()
        && !id.contains(['/', '\\', ':'])
        && id != "."
        && id != ".."
        && std::path::Path::new(id).components().count() == 1
}

fn is_bg_file(p: &std::path::Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| BG_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

// "spa-francorchamps.webp" → "Spa francorchamps". Filnamnet ÄR etiketten, så att
// användaren kan styra vad som står i listan genom att döpa om filen.
fn bg_label(stem: &str) -> String {
    let s = stem.replace(['-', '_'], " ");
    let s = s.trim();
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

#[tauri::command]
fn list_backgrounds(app: AppHandle) -> Vec<BackgroundInfo> {
    let mut out: Vec<BackgroundInfo> = Vec::new();
    for (dir, custom) in [(bundled_bg_dir(&app), false), (custom_bg_dir(&app), true)] {
        let Some(dir) = dir else { continue };
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_file() || !is_bg_file(&p) {
                continue;
            }
            let Some(id) = p.file_name().and_then(|s| s.to_str()) else { continue };
            // En egen fil med samma namn ersätter den inbyggda i stället för att ge
            // två rader med samma etikett.
            if let Some(prev) = out.iter_mut().find(|b| b.id.eq_ignore_ascii_case(id)) {
                prev.custom = custom;
                continue;
            }
            let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or(id);
            out.push(BackgroundInfo { id: id.to_string(), label: bg_label(stem), custom });
        }
    }
    out.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
    out
}

#[tauri::command]
fn get_background(app: AppHandle, id: String) -> Result<String, String> {
    if !is_safe_bg_name(&id) {
        return Err("ogiltigt filnamn".into());
    }
    let name = std::path::Path::new(&id);
    // Egna filer först, så att en egen bild med samma namn vinner (som i listan).
    for dir in [custom_bg_dir(&app), bundled_bg_dir(&app)].into_iter().flatten() {
        let p = dir.join(name);
        if !p.is_file() || !is_bg_file(&p) {
            continue;
        }
        match std::fs::metadata(&p) {
            Ok(m) if m.len() > BG_MAX_BYTES => {
                return Err(format!("bilden är {} MB — max är {} MB",
                                   m.len() / 1024 / 1024, BG_MAX_BYTES / 1024 / 1024));
            }
            Ok(_) => {}
            Err(e) => return Err(e.to_string()),
        }
        let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        let mime = match ext.as_str() {
            "jpg" | "jpeg" => "image/jpeg",
            "png" => "image/png",
            "avif" => "image/avif",
            _ => "image/webp",
        };
        return Ok(format!("data:{};base64,{}", mime, b64(&bytes)));
    }
    Err("hittar inte bakgrunden".into())
}

// Öppnar katalogen för egna bakgrunder i Utforskaren. Utan den måste man leta upp
// %APPDATA%\com.accoverlay.app\ för hand, och då används funktionen inte.
#[tauri::command]
fn open_background_dir(app: AppHandle) -> Result<(), String> {
    let dir = custom_bg_dir(&app).ok_or("hittar ingen katalog")?;
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// Base64 utan extra beroende — det är ett dussin rader och alternativet är en crate
// till i trädet för en funktion som körs när man byter bakgrund.
fn b64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity((data.len() + 2) / 3 * 4);
    for c in data.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        s.push(T[(n >> 18) as usize & 63] as char);
        s.push(T[(n >> 12) as usize & 63] as char);
        s.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        s.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    s
}

// ── Globala inställningar (gäller alla overlays) ─────────────────────────────
#[derive(Serialize, Clone)]
struct GlobalsPayload {
    hide_until_connected: bool,
    // Panelen visade "ingen referens laddad" även när en låg sparad, så ett oväntat
    // MoTeC-delta kunde dyka upp utan att man kunde se varför — eller ta bort det.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    reference_ld: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    preview_background: String,
    // Panelen visar kombinationen på två ställen (Inställningar och Om) och får den
    // härifrån — en hårdkodad text i HTML:en hade ljugit så fort någon bytt den.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    hotkey: String,
}

#[tauri::command]
fn get_globals(state: State<Mutex<Settings>>) -> GlobalsPayload {
    let s = state.lock().unwrap();
    GlobalsPayload {
        hide_until_connected: s.hide_until_connected,
        reference_ld: s.reference_ld.clone(),
        preview_background: s.preview_background.clone(),
        hotkey: s.hotkey.clone(),
    }
}

// Bakgrunden gäller bara kontrollpanelens förhandsvisning och skickas därför inte som
// event till overlays — de vet ingenting om den.
#[tauri::command]
fn set_preview_background(app: AppHandle, state: State<Mutex<Settings>>, id: String) {
    let mut s = state.lock().unwrap();
    s.preview_background = id;
    save_settings(&app, &mut s);
}

// Visa overlays först när motorn är ansluten till ACC. Skickas till alla fönster;
// overlays döljer sig själva (via bus.js) tills connected==true.
#[tauri::command]
fn set_hide_until_connected(app: AppHandle, state: State<Mutex<Settings>>, value: bool) {
    {
        let mut s = state.lock().unwrap();
        s.hide_until_connected = value;
        save_settings(&app, &mut s);
    }
    // reference_ld är tom här med flit: eventet gäller grinden. bus.js läser bara
    // hide_until_connected, och panelen hämtar sökvägen med get_globals.
    let _ = app.emit("globals", GlobalsPayload {
        hide_until_connected: value,
        reference_ld: String::new(),
        preview_background: String::new(),
        hotkey: String::new(),
    });
}

// ── App-uppstart ────────────────────────────────────────────────────────────
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                // Jämför mot den REGISTRERADE kombinationen (HOTKEY) och inte mot en
                // kopia som fångats in här: den går att byta i drift sedan 0.5.1, och
                // en infångad `toggle` hade slutat matcha i samma sekund — hotkeyen
                // hade fungerat exakt en gång per appstart och sedan verkat död.
                .with_handler(move |app, sc, ev| {
                    if ev.state == ShortcutState::Pressed && current_hotkey() == Some(*sc) {
                        toggle_edit_from_hotkey(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            get_overlays,
            get_config,
            set_enabled,
            set_scale,
            set_opacity,
            set_always_on_top,
            set_option,
            set_position,
            reset_overlay,
            get_screen,
            list_layouts,
            create_layout,
            rename_layout,
            duplicate_layout,
            delete_layout,
            activate_layout,
            list_presets,
            apply_preset,
            save_preset,
            delete_preset,
            set_edit_mode,
            set_hotkey,
            set_reference,
            get_globals,
            set_hide_until_connected,
            prepare_update,
            list_backgrounds,
            get_background,
            open_background_dir,
            set_preview_background
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let before = std::fs::read_to_string(settings_path(&handle)).unwrap_or_default();
            let mut settings = load_settings(&handle);
            // Spegla FÖRE jämförelsen nedan: save_settings gör det ändå, och utan det
            // här räknas "rättades något?" på en text som inte är den som skrivs.
            sync_active_layout(&mut settings);
            // Skriv tillbaka om inläsningen rättade något (klampat tal, fel typ, en
            // option som tagits bort ur registret). Utan detta blir overlayn rätt men
            // filen ligger kvar med skräpet, så panelen och disken säger olika saker
            // och felet återuppstår varje start. Skriver bara vid faktisk skillnad.
            if let Ok(after) = serde_json::to_string_pretty(&settings) {
                if before.trim() != after.trim() && !before.is_empty() {
                    println!("[shell] settings.json innehöll värden som rättades — sparar den städade versionen.");
                    save_settings(&handle, &mut settings);
                }
            }

            // Läget för varje overlay plockas ut FÖRE app.manage, och fönstren skapas
            // EFTER — annars hinner en overlay-webview anropa get_config innan
            // Mutex<Settings> är managed, kommandot svarar med fel (som bus.js sväljer)
            // och overlayn ritas med standardskala i stället för sparad.
            let plan: Vec<(&'static OverlayDef, OverlayState)> = registry()
                .iter()
                .map(|d| {
                    let st = settings
                        .overlays
                        .get(&d.id)
                        .cloned()
                        .unwrap_or_else(|| default_state_for(d));
                    (d, st)
                })
                .collect();
            let gate = settings.hide_until_connected;
            let hotkey = settings.hotkey.clone();

            app.manage(Mutex::new(settings));
            size_control_window(&handle);
            start_engine(&handle);
            watch_foreground(handle.clone());

            for (def, st) in plan {
                if let Err(e) = create_overlay(&handle, def, &st, gate) {
                    eprintln!("[shell] kunde ej skapa overlay {}: {e}", def.id);
                }
            }

            // Registrera hotkeyen, men låt inte appen krascha om genvägen redan
            // ägs av något annat program — panelens "flytta"-knapp (set_edit_mode)
            // fungerar ändå, så edit-läget går att nå utan hotkeyen.
            // Kombinationen kommer ur settings.json och kan alltså vara handredigerad
            // till något som inte går att tolka; då gäller standardvärdet i stället
            // för ingen hotkey alls (samma resonemang som §8.3b).
            let want: Shortcut = hotkey.parse().unwrap_or_else(|e| {
                eprintln!("[shell] kortkommandot «{hotkey}» går inte att tolka ({e}) — använder {}.",
                          default_hotkey());
                default_hotkey().parse().expect("standardkortkommandot måste gå att tolka")
            });
            match app.global_shortcut().register(want) {
                Ok(()) => {
                    if let Ok(mut g) = hotkey_slot().lock() {
                        *g = Some(want);
                    }
                }
                Err(e) => eprintln!("[shell] kunde ej registrera {hotkey} ({e}). \
                           Genvägen är troligen upptagen av ett annat program. \
                           Byt den under Inställningar, eller använd panelens \
                           flytta-knapp för att växla edit-läge."),
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "control" {
                if let WindowEvent::CloseRequested { .. } = event {
                    let app = window.app_handle().clone();
                    if let Some(state) = app.try_state::<Mutex<Settings>>() {
                        let mut s = state.lock().unwrap();
                        save_positions(&app, &mut s);
                        save_settings(&app, &mut s);
                    }
                    stop_engine();
                    app.exit(0);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("fel vid start av ACC Overlay")
        // Nät under CloseRequested: fångar alla andra avslutsvägar (exit(), sista
        // fönstret stängt) så motorn aldrig lämnas kvar som zombie-process.
        .run(|_app, event| {
            if let RunEvent::Exit = event {
                stop_engine();
            }
        });
}

// ── Vilket program ligger överst? ───────────────────────────────────────────
// Rapporterat: overlays låg kvar över skrivbordet när man tabbade ur ACC. Grinden
// kunde inte se det — ACC fortsätter skriva sitt delade minne utan fokus, så
// `connected` förblir true. Vi måste alltså fråga Windows vem som har förgrunden.
//
// Regeln är medvetet FAIL-SAFE: vi rapporterar "ett annat program är överst" bara när
// vi POSITIVT kunnat identifiera en främmande process. Går något fel — inget
// förgrundsfönster, processen går inte att öppna (rättigheter), namnet går inte att
// läsa — svarar vi false, dvs. dölj inte. Ett falskt positivt hade släckt overlayn
// mitt i en kurva; ett falskt negativt betyder bara att den ligger kvar som förut.
// ACC:s binär heter AC2-Win64-Shipping.exe (Unreal-namnet). Sökvägen kontrolleras
// OCKSÅ, mot Steams mappnamn, eftersom ett felaktigt "det här är inte ACC" är det
// enda riktigt dåliga utfallet: då göms overlays MITT I ETT LOPP. Två oberoende
// kännetecken gör det osannolikt, och båda är stabila.
#[cfg(windows)]
const ACC_EXE_NAMES: [&str; 2] = ["ac2-win64-shipping.exe", "acc.exe"];
#[cfg(windows)]
const ACC_PATH_HINT: &str = "assetto corsa competizione";

#[cfg(windows)]
fn foreground_is_foreign() -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, MAX_PATH};
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowThreadProcessId,
    };

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            return false; // t.ex. under låsskärm — vet inte, alltså dölj inte
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        // Våra egna fönster räknas aldrig som främmande: kontrollpanelen ska gå att
        // använda medan man ser overlayn, och overlay-fönstren kan ta fokus i edit-läge.
        if pid == 0 || pid == GetCurrentProcessId() {
            return false;
        }
        let proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if proc.is_null() {
            return false; // förhöjd process (t.ex. Aktivitetshanteraren) — vet inte
        }
        let mut buf = [0u16; MAX_PATH as usize];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(proc, 0, buf.as_mut_ptr(), &mut len) != 0;
        CloseHandle(proc);
        if !ok || len == 0 {
            return false;
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]).to_ascii_lowercase();
        let exe = path.rsplit(['\\', '/']).next().unwrap_or("");
        !(ACC_EXE_NAMES.contains(&exe) || path.contains(ACC_PATH_HINT))
    }
}

#[cfg(not(windows))]
fn foreground_is_foreign() -> bool {
    false
}

// Skickar bara vid ÄNDRING. Overlays reagerar direkt (ingen hysteres — att tabba ut
// är inte samma sak som en tappad ram), så takten behöver bara vara snabbare än ögat
// hinner irritera sig.
fn watch_foreground(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last: Option<bool> = None;
        loop {
            let foreign = foreground_is_foreign();
            if last != Some(foreign) {
                last = Some(foreign);
                let _ = app.emit("foreground", serde_json::json!({ "foreign": foreign }));
            }
            std::thread::sleep(std::time::Duration::from_millis(400));
        }
    });
}

// ── Motorn (Python-sidecar) ─────────────────────────────────────────────────
// Handtaget till barnprocessen måste sparas — utan det kan vi inte döda motorn
// när appen stängs, och acc-engine.exe lever vidare och håller port 8777/8078
// (vilket gör att NÄSTA start får en sidecar som inte kan binda och dör tyst).
static ENGINE: OnceLock<Mutex<Option<CommandChild>>> = OnceLock::new();
fn engine_slot() -> &'static Mutex<Option<CommandChild>> {
    ENGINE.get_or_init(|| Mutex::new(None))
}

fn stop_engine() {
    // take() → idempotent, så det är ofarligt att anropa från flera avslutsvägar.
    let child = engine_slot().lock().ok().and_then(|mut g| g.take());
    if let Some(child) = child {
        if let Err(e) = child.kill() {
            eprintln!("[shell] kunde ej avsluta motorn: {e}");
        }
    }
    // ...och sedan hela trädet under den. Se confine_engine().
    close_engine_job();
}

// ── Windows: håll motorn i ett Job Object ───────────────────────────────────
// child.kill() gör TerminateProcess på BARA den direkta barnprocessen, och Windows
// dödar inte efterkommande. PyInstaller --onefile kör en bootloader som packar upp
// och startar den riktiga motorn som ett eget barn — uppmätt process­kedja:
//   acc-overlay.exe → acc-engine.exe (bootloader) → acc-engine.exe (motorn, äger
//   port 8777/8078). Bara bootloadern dog, motorn låg kvar som zombie.
// Ett Job Object med KILL_ON_JOB_CLOSE dödar alla i jobbet när handtaget stängs —
// vilket OS:et gör åt oss även om appen kraschar eller blir taskkill:ad.
#[cfg(windows)]
static ENGINE_JOB: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[cfg(windows)]
fn confine_engine(pid: u32) {
    use std::sync::atomic::Ordering;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            eprintln!("[shell] kunde ej skapa Job Object för motorn");
            return;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let sized = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            sized,
        ) == 0
        {
            CloseHandle(job);
            return;
        }
        // Barn som processen startar EFTER detta ärver jobbet automatiskt.
        let proc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
        if proc.is_null() {
            CloseHandle(job);
            return;
        }
        let ok = AssignProcessToJobObject(job, proc) != 0;
        CloseHandle(proc);
        if ok {
            // Handtaget läcks medvetet: det ska leva exakt så länge appen gör.
            ENGINE_JOB.store(job as usize, Ordering::Relaxed);
        } else {
            eprintln!("[shell] kunde ej lägga motorn i Job Object");
            CloseHandle(job);
        }
    }
}

#[cfg(windows)]
fn close_engine_job() {
    use std::sync::atomic::Ordering;
    let h = ENGINE_JOB.swap(0, Ordering::Relaxed);
    if h != 0 {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(h as *mut _) };
    }
}

#[cfg(not(windows))]
fn confine_engine(_pid: u32) {}
#[cfg(not(windows))]
fn close_engine_job() {}

// Starta motorn (sidecar). --config → app-config/engine.config.json så
// referensval från kontrollpanelen når motorn. Misslyckas tyst i dev.
fn start_engine(app: &AppHandle) {
    use tauri_plugin_shell::ShellExt;
    let cfg = app.path().app_config_dir()
        .map(|d| d.join("engine.config.json").to_string_lossy().to_string())
        .unwrap_or_default();
    match app.shell().sidecar("acc-engine") {
        Ok(cmd) => {
            let cmd = if cfg.is_empty() { cmd } else { cmd.args(["--config", &cfg]) };
            // Overlay-filerna på disk (bundle.resources) så motorns OBS-HTTP-server
            // kan servera dem även i den paketerade appen. Finns de inte (dev) hoppar
            // motorn över HTTP-servern och loggar det.
            let cmd = match app.path().resource_dir().map(|d| d.join("web")) {
                Ok(root) if root.exists() => cmd.args(["--root", &root.to_string_lossy()]),
                _ => cmd,
            };
            match cmd.spawn() {
                Ok((_rx, child)) => {
                    // Direkt efter spawn, innan bootloadern hunnit starta sitt barn.
                    confine_engine(child.pid());
                    if let Ok(mut slot) = engine_slot().lock() { *slot = Some(child); }
                }
                Err(e) => eprintln!("[shell] sidecar 'acc-engine' startade ej: {e} (kör motorn manuellt i dev)"),
            }
        }
        Err(e) => eprintln!("[shell] hittar ej sidecar 'acc-engine': {e} (dev: kör motorn manuellt)"),
    }
}

// ── Enhetstester ────────────────────────────────────────────────────────────
// De flesta funktioner här behöver en levande AppHandle och testas i stället genom
// appen. Undantagen nedan är ren logik — och den ena av dem är en säkerhetsgräns,
// vilket är precis den sortens kod som ska ha ett test som går att köra i CI.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bg_namn_utanfor_katalogen_avvisas() {
        // id:t kommer från IPC:n. Släpps en sökväg igenom kan vilken fil som helst
        // på disken läsas ut som data-URL till webviewen.
        for bad in [
            "../settings.json",
            r"..\settings.json",
            "sub/dir.webp",
            r"sub\dir.webp",
            r"C:\Windows\win.ini",
            "..",
            ".",
            "",
        ] {
            assert!(!is_safe_bg_name(bad), "borde ha avvisats: {bad:?}");
        }
        for ok in ["spa.webp", "min bana.jpg", "egen-testbild.webp", "a.b.png"] {
            assert!(is_safe_bg_name(ok), "borde ha släppts igenom: {ok:?}");
        }
    }

    #[test]
    fn bara_bildandelser_listas() {
        use std::path::Path;
        for ok in ["a.webp", "a.WEBP", "a.jpg", "a.jpeg", "a.png", "a.avif"] {
            assert!(is_bg_file(Path::new(ok)), "{ok}");
        }
        for no in ["a.txt", "a.exe", "a", "a.webp.exe"] {
            assert!(!is_bg_file(Path::new(no)), "{no}");
        }
    }

    #[test]
    fn filnamnet_blir_etiketten() {
        assert_eq!(bg_label("spa"), "Spa");
        assert_eq!(bg_label("egen-testbild"), "Egen testbild");
        assert_eq!(bg_label("min_egen_bana"), "Min egen bana");
        assert_eq!(bg_label(""), "");
    }

    // Standardbakgrunden pekar på en fil som faktiskt följer med utgåvan. Skrivfel
    // här ger ingen kompileringsvarning — bara en preview utan bakgrund.
    #[test]
    fn standardbakgrunden_finns_i_repot() {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/shared/preview-backgrounds")
            .join(default_preview_bg());
        assert!(p.is_file(), "saknas: {}", p.display());
    }

    // ── Gradienter ──────────────────────────────────────────────────────────
    // Värdet hamnar rakt i CSS (bus.js sätter det som CSS-variabel), så det här är
    // en SÄKERHETSGRÄNS och inte formatpolis. Testet är därför skrivet som en lista
    // av försök att komma ut ur deklarationen.
    #[test]
    fn gradient_slapper_bara_igenom_exakt_var_form() {
        for ok in [
            "linear-gradient(180deg, #121416 0%, #060708 100%)",
            "linear-gradient(0deg, #121416db 0%, #060708 100%)",
            "linear-gradient(360deg, #abc 0%, #abcd 50%, #001122 100%)",
            "  linear-gradient(45deg, #000 0%, #fff 100%)  ",
        ] {
            assert!(is_gradient(ok), "borde ha släppts igenom: {ok:?}");
        }
        for bad in [
            // Injektion: ut ur värdet och in i en egen regel.
            "red;} html{display:none",
            "linear-gradient(180deg, #000 0%, #fff 100%); background:url(x)",
            "linear-gradient(180deg, var(--panel) 0%, #fff 100%)",
            "linear-gradient(180deg, #000 0%, #fff 100%) , url('x')",
            // Fel form, alltså inte något panelen kan ha skickat.
            "linear-gradient(180deg, #000, #fff)",         // procent saknas
            "linear-gradient(180, #000 0%, #fff 100%)",    // deg saknas
            "linear-gradient(400deg, #000 0%, #fff 100%)", // vinkel utanför 0..360
            "linear-gradient(180deg, #000 0%, #fff 140%)", // stopp utanför 0..100
            "linear-gradient(180deg, rgb(0,0,0) 0%, #fff 100%)",
            "linear-gradient(180deg, #000 0%)",            // ett enda stopp
            "radial-gradient(180deg, #000 0%, #fff 100%)",
            "linear-gradient(180deg, #000 0%, #fff 100%",  // oavslutad
            "",
        ] {
            assert!(!is_gradient(bad), "borde ha avvisats: {bad:?}");
        }

        // TÄNDERNA. Den uppenbara implementationen — "börjar det med linear-gradient(
        // så är det en gradient" — släpper igenom injektionerna ovan. Att den gör det
        // är vad som visar att listan mäter något (samma grepp som `naivLoop` i
        // tests/overlay-loop.mjs och `UtanDepakoll` i tests/lap_recorder.py).
        fn naiv(s: &str) -> bool {
            s.trim_start().starts_with("linear-gradient(")
        }
        let sluppit_igenom = [
            "linear-gradient(180deg, #000 0%, #fff 100%); background:url(x)",
            "linear-gradient(180deg, var(--panel) 0%, #fff 100%)",
        ];
        assert!(sluppit_igenom.iter().all(|s| naiv(s)),
                "den naiva varianten skulle ha släppt igenom dem — annars mäter listan inget");
    }

    // En gradient får bara sparas på ett alternativ som är MÄRKT för det. Utan den
    // grinden kunde en handredigerad settings.json lägga en gradient på en token som
    // sitter på `stroke` (delta-barens --track), och då slutar elementet ritas.
    #[test]
    fn gradient_kraver_att_alternativet_tillater_det() {
        let d = testdef();
        let grad = serde_json::json!("linear-gradient(180deg, #000000 0%, #ffffff 100%)");
        let solid = d.options.iter().find(|o| o.id == "farg").unwrap();
        assert_eq!(sanitize_option(solid, &grad), solid.default,
                   "gradient utan gradient:true skulle fallit tillbaka på standardvärdet");

        let mut yta = solid.clone();
        yta.gradient = true;
        assert_eq!(sanitize_option(&yta, &grad), grad);
    }

    // ── Kortkommandot ───────────────────────────────────────────────────────
    // Panelen bygger strängen ur `event.code`. Att de namnen faktiskt går att tolka
    // är inget vi kan se i panelen — där syns bara ett felmeddelande — så det
    // kontrolleras här, mot samma parser som registreringen använder.
    #[test]
    fn panelens_kortkommandostrangar_gar_att_tolka() {
        for s in [
            "Ctrl+Alt+Space", "Ctrl+Shift+E", "Alt+F7", "Ctrl+Alt+Numpad5",
            "Ctrl+Alt+ArrowUp", "Super+Shift+D", "Ctrl+Alt+1", "Ctrl+Alt+Minus",
        ] {
            let sc: Result<Shortcut, _> = s.parse();
            assert!(sc.is_ok(), "gick inte att tolka: {s} ({:?})", sc.err());
            assert!(!sc.unwrap().mods.is_empty(), "{s} borde ha modifierare");
        }
        // Standardvärdet MÅSTE gå att tolka: uppstarten faller tillbaka på det med
        // expect() när settings.json innehåller skräp.
        let def: Result<Shortcut, _> = default_hotkey().parse();
        assert!(def.is_ok(), "standardkortkommandot går inte att tolka");
        // En bar tangent avvisas av set_hotkey — den fångas i alla program.
        let bare: Shortcut = "Space".parse().unwrap();
        assert!(bare.mods.is_empty());
    }

    // ── Presets ─────────────────────────────────────────────────────────────
    // Hjälpare: bygg ett schema som täcker alla fyra optionstyperna, så testerna
    // nedan går på samma väg som en riktig overlay.
    fn testdef() -> OverlayDef {
        fn opt(id: &str, kind: &str, default: serde_json::Value) -> OverlayOption {
            OverlayOption {
                id: id.into(),
                kind: kind.into(),
                label: id.into(),
                default,
                min: None,
                max: None,
                step: None,
                unit: None,
                alpha: false,
                gradient: false,
                values: vec![],
            }
        }
        let mut num = opt("fonster", "float", serde_json::json!(4.5));
        num.min = Some(1.0);
        num.max = Some(10.0);
        let mut val = opt("stil", "enum", serde_json::json!("kompakt"));
        val.values = vec![
            OverlayOptionValue { value: serde_json::json!("kompakt"), label: "Kompakt".into() },
            OverlayOptionValue { value: serde_json::json!("full"), label: "Full".into() },
        ];
        OverlayDef {
            id: "t".into(),
            title: "T".into(),
            desc: String::new(),
            url: "t.html".into(),
            base_width: 100.0,
            base_height: 50.0,
            default_x: 0,
            default_y: 0,
            default_scale: 1.0,
            hz: None,
            options: vec![
                opt("visa", "bool", serde_json::json!(true)),
                opt("farg", "color", serde_json::json!("#0DE622")),
                num,
                val,
            ],
            presets: vec![],
        }
    }

    fn p(options: serde_json::Value) -> Preset {
        Preset {
            id: "x".into(),
            label: "X".into(),
            scale: None,
            opacity: None,
            options: serde_json::from_value(options).unwrap(),
        }
    }

    // En preset är PARTIELL: den ska bara skriva de alternativ den nämner. Fyllde
    // sanitize_preset i registrets standardvärden (som sanitize_options gör) skulle
    // en färgpreset tysta nollställa varje annat alternativ i samma overlay.
    #[test]
    fn preset_lamnar_onamnda_alternativ_ifred() {
        let d = testdef();
        let mut q = p(serde_json::json!({"farg": "#FF0000"}));
        sanitize_preset(&d, &mut q);
        assert_eq!(q.options.len(), 1, "bara det nämnda alternativet: {:?}", q.options);
        assert_eq!(q.options["farg"], serde_json::json!("#FF0000"));
    }

    // Samma skydd som §8.3b ger options: en handredigerad eller åldrad preset får
    // aldrig nå en overlay med skräp i.
    #[test]
    fn preset_stadar_skrap() {
        let d = testdef();
        let mut q = p(serde_json::json!({
            "farg":    "rgb(1,2,3)",   // inte hex  → standardvärdet
            "fonster": 999.0,          // över max  → klampas till 10
            "stil":    "finns-inte",   // okänd enum→ standardvärdet
            "visa":    "ja",           // inte bool → standardvärdet
            "borttagen": 1,            // finns ej i schemat → bort
        }));
        sanitize_preset(&d, &mut q);
        assert_eq!(q.options["farg"], serde_json::json!("#0DE622"));
        assert_eq!(q.options["fonster"], serde_json::json!(10.0));
        assert_eq!(q.options["stil"], serde_json::json!("kompakt"));
        assert_eq!(q.options["visa"], serde_json::json!(true));
        assert!(!q.options.contains_key("borttagen"), "okänd nyckel skulle städats bort");
    }

    // Skala och opacitet klampas till panelens reglageintervall. En preset med
    // scale:0 hade gett ett fönster på 0×0 px, alltså en overlay som ser borta ut.
    #[test]
    fn preset_klampar_skala_och_opacitet() {
        let d = testdef();
        let mut q = Preset { scale: Some(9.0), opacity: Some(-1.0), ..p(serde_json::json!({})) };
        sanitize_preset(&d, &mut q);
        assert_eq!(q.scale, Some(SCALE_MAX));
        assert_eq!(q.opacity, Some(OPACITY_MIN));

        // NaN/oändligt är inte "utanför intervallet" utan ogiltigt: fältet ska bli
        // None (= lämna värdet orört) i stället för att klampas till en gräns.
        let mut bad = Preset { scale: Some(f64::NAN), opacity: Some(f64::INFINITY), ..p(serde_json::json!({})) };
        sanitize_preset(&d, &mut bad);
        assert_eq!(bad.scale, None);
        assert_eq!(bad.opacity, None);
    }

    // Id:t hamnar i settings.json och läses av människor. Det ska gå att känna igen
    // presetten på det, inte bara på etiketten.
    #[test]
    fn slug_ger_lasbara_id() {
        assert_eq!(slug("Natt"), "natt");
        assert_eq!(slug("Stream-läge 2"), "stream-läge-2");
        assert_eq!(slug("  mycket   luft  "), "mycket-luft");
        assert_eq!(slug("!!!"), "preset");        // inget kvar → fallback
        assert_eq!(slug(""), "preset");
        assert!(slug(&"a".repeat(80)).chars().count() <= 40);
    }

    // ── Layouter ────────────────────────────────────────────────────────────
    // Ett riktigt overlay-id ur registret: layoutkoden filtrerar på def_of, så en
    // påhittad sträng hade tystat bort sig själv och gjort testerna gröna på
    // ingenting.
    fn nagot_id() -> String {
        registry()[0].id.clone()
    }

    fn stat(x: i32, enabled: bool) -> OverlayState {
        OverlayState { enabled, x, y: 0, scale: 1.0, opacity: 1.0, always_on_top: true,
                       options: HashMap::new() }
    }

    fn med_layout(active: &str) -> Settings {
        let mut s = Settings::default();
        s.layouts.push(Layout { id: "a".into(), name: "A".into(), overlays: HashMap::new() });
        s.layouts.push(Layout { id: "b".into(), name: "B".into(), overlays: HashMap::new() });
        s.active_layout = active.into();
        s
    }

    // Den aktiva layouten är LIVE-BUNDEN: läget speglas in vid varje sparning, och
    // bara PÅSLAGNA overlays ingår (medlemskap = påslagen). Speglade den även
    // avslagna hade "ta bort ur layouten" inte gjort något alls.
    #[test]
    fn synk_speglar_bara_paslagna_till_den_aktiva() {
        let id = nagot_id();
        let mut s = med_layout("a");
        s.overlays.insert(id.clone(), stat(120, true));
        s.overlays.insert("finns-inte-i-registret".into(), stat(7, true));
        sync_active_layout(&mut s);

        let a = s.layouts.iter().find(|l| l.id == "a").unwrap();
        assert_eq!(a.overlays.len(), 1, "bara den registrerade overlayn: {:?}", a.overlays.keys());
        assert_eq!(a.overlays[&id].x, 120);
        assert!(s.layouts.iter().find(|l| l.id == "b").unwrap().overlays.is_empty(),
                "en INAKTIV layout får aldrig skrivas över");

        // Slås overlayn av försvinner den ur layouten vid nästa spegling — det är
        // exakt vad "ta bort ur layouten" är.
        s.overlays.get_mut(&id).unwrap().enabled = false;
        sync_active_layout(&mut s);
        assert!(s.layouts[0].overlays.is_empty());
    }

    // Utan aktiv layout ska ingenting röras. En spegling som skrev till "första
    // layouten" när fältet var tomt hade tyst skrivit över en layout man inte valt.
    #[test]
    fn synk_utan_aktiv_layout_rör_ingenting() {
        let id = nagot_id();
        let mut s = med_layout("");
        s.overlays.insert(id, stat(120, true));
        sync_active_layout(&mut s);
        assert!(s.layouts.iter().all(|l| l.overlays.is_empty()));
    }

    // Samma skydd som §8.3b ger options och presets. Två fall som är lätta att missa:
    // ett `active_layout` som pekar på en borttagen layout (då hade speglingen skrivit
    // ut i tomma intet vid varje sparning) och en medlem med enabled:false (en layout
    // som innehåller en overlay den samtidigt släcker).
    #[test]
    fn layouter_stadas_vid_inlasning() {
        let id = nagot_id();
        let mut s = Settings::default();
        let mut ov = HashMap::new();
        ov.insert(id.clone(), OverlayState { scale: 99.0, opacity: -5.0, ..stat(9_000_000, false) });
        ov.insert("borttagen-overlay".into(), stat(0, true));
        s.layouts.push(Layout { id: "a".into(), name: "   ".into(), overlays: ov });
        s.layouts.push(Layout { id: "a".into(), name: "dubblett".into(), overlays: HashMap::new() });
        s.active_layout = "finns-inte".into();
        sanitize_layouts(&mut s);

        assert_eq!(s.layouts.len(), 1, "samma id två gånger ska inte överleva");
        let l = &s.layouts[0];
        assert_eq!(l.name, "Layout", "tomt namn ska få en fallback");
        assert!(!l.overlays.contains_key("borttagen-overlay"));
        let st = &l.overlays[&id];
        assert!(st.enabled, "medlemskap ÄR påslagen");
        assert_eq!(st.scale, SCALE_MAX);
        assert_eq!(st.opacity, OPACITY_MIN);
        assert_eq!(st.x, POS_LIMIT);
        assert!(s.active_layout.is_empty(), "en aktiv layout som inte finns = ingen aktiv");
    }

    // Två layouter med samma namn får olika id — annars pekar `active_layout` på
    // båda och `delete_layout` tar bort fel.
    #[test]
    fn layout_id_ar_unika() {
        let mut s = Settings::default();
        for _ in 0..3 {
            let id = unique_layout_id(&s, "Natt");
            s.layouts.push(Layout { id, name: "Natt".into(), overlays: HashMap::new() });
        }
        let ids: Vec<&str> = s.layouts.iter().map(|l| l.id.as_str()).collect();
        assert_eq!(ids, vec!["natt", "natt-2", "natt-3"]);
    }

    // Base64 är handskriven (§ i lib.rs) — den ska ge exakt samma sträng som en
    // riktig implementation, inklusive utfyllnaden vid 1 och 2 kvarvarande bytes.
    #[test]
    fn base64_matchar_kanda_varden() {
        assert_eq!(b64(b""), "");
        assert_eq!(b64(b"f"), "Zg==");
        assert_eq!(b64(b"fo"), "Zm8=");
        assert_eq!(b64(b"foo"), "Zm9v");
        assert_eq!(b64(b"foob"), "Zm9vYg==");
        assert_eq!(b64(b"fooba"), "Zm9vYmE=");
        assert_eq!(b64(b"foobar"), "Zm9vYmFy");
        assert_eq!(b64(&[0u8, 255, 128]), "AP+A");
    }
}
