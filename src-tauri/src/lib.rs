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
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_shell::process::CommandChild;

// ── Registret (kompileras in; katalog över overlays) ────────────────────────
const REGISTRY_JSON: &str = include_str!("../../src/overlays/registry.json");

#[derive(Deserialize, Serialize, Clone)]
struct OverlayOption {
    id: String,
    label: String,
    #[serde(default)]
    default: bool,
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
    #[serde(default)]
    options: Vec<OverlayOption>,
}

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
    options: HashMap<String, bool>,
}

// Färskt standardläge för en overlay (position/skala/alternativ ur registret).
fn default_state_for(d: &OverlayDef) -> OverlayState {
    let mut options = HashMap::new();
    for o in &d.options {
        options.insert(o.id.clone(), o.default);
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
    reference_ld: String,
    // global: visa overlays först när motorn är synkad mot ACC (connected==true)
    #[serde(default)]
    hide_until_connected: bool,
}

fn default_settings() -> Settings {
    let mut s = Settings::default();
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
                s.overlays.entry(d.id.clone()).or_insert_with(|| default_state_for(d));
            }
            s
        }
        Err(_) => default_settings(),
    }
}
fn save_settings(app: &AppHandle, s: &Settings) {
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
    // Skala, opacitet och synk-grinden injiceras FÖRE sidan parsas. Overlayn hämtade
    // dem tidigare med get_config/get_globals (async) och ritade med CSS-defaulten
    // tills svaret kom — vilket såg AVKAPAT ut när sparad skala var något annat än
    // defaulten, och gjorde att grinden "endast när ACC kör" inte hann gälla. Landade
    // anropet dessutom före app.manage() kom svaret aldrig och overlayn satt kvar i
    // fel skala tills man rörde reglaget.
    let init = format!(
        "window.__OVERLAY_INIT__={};",
        serde_json::json!({
            "id": def.id,
            "scale": st.scale,
            "opacity": st.opacity,
            "gate": hide_until_connected,
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
        // innan hide() hinner köras.
        .visible(st.enabled)
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
            save_settings(app, &s);
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

fn apply_size(app: &AppHandle, id: &str, scale: f64) {
    if let (Some(def), Some(win)) = (def_of(id), app.get_webview_window(id)) {
        let _ = win.set_size(tauri::LogicalSize::new(def.base_width * scale, def.base_height * scale));
    }
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
    enabled: bool,
    scale: f64,
    opacity: f64,
    always_on_top: bool,
    options: HashMap<String, bool>,
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
            for o in &d.options {
                options.entry(o.id.clone()).or_insert(o.default);
            }
            OverlayInfo {
                id: d.id.clone(),
                title: d.title.clone(),
                desc: d.desc.clone(),
                url: d.url.clone(),
                base_width: d.base_width,
                base_height: d.base_height,
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

#[derive(Serialize, Clone)]
struct OptionPayload {
    id: String,
    option: String,
    value: bool,
}

#[derive(Serialize)]
struct ConfigInit {
    scale: f64,
    opacity: f64,
    options: HashMap<String, bool>,
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
        for o in &d.options {
            options.entry(o.id.clone()).or_insert(o.default);
        }
    }
    ConfigInit { scale, opacity, options }
}

#[tauri::command]
fn set_enabled(app: AppHandle, state: State<Mutex<Settings>>, id: String, enabled: bool) {
    {
        let mut s = state.lock().unwrap();
        if let Some(st) = s.overlays.get_mut(&id) { st.enabled = enabled; }
        save_settings(&app, &s);
    }
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
        save_settings(&app, &s);
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
        save_settings(&app, &s);
    }
    let _ = app.emit("config", ConfigPayload { id: id.clone(), scale, opacity });
}

// Per-overlay always-on-top (era overlays skapas redan överst; detta togglar det).
#[tauri::command]
fn set_always_on_top(app: AppHandle, state: State<Mutex<Settings>>, id: String, value: bool) {
    {
        let mut s = state.lock().unwrap();
        if let Some(st) = s.overlays.get_mut(&id) { st.always_on_top = value; }
        save_settings(&app, &s);
    }
    if let Some(win) = app.get_webview_window(&id) { let _ = win.set_always_on_top(value); }
}

// Per-overlay alternativ (visa/dölj delelement). Overlayn läser detta via wireShell.
#[tauri::command]
fn set_option(app: AppHandle, state: State<Mutex<Settings>>, id: String, option: String, value: bool) {
    {
        let mut s = state.lock().unwrap();
        if let Some(st) = s.overlays.get_mut(&id) { st.options.insert(option.clone(), value); }
        save_settings(&app, &s);
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
        save_settings(&app, &s);
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

// Skriv referens-path till motorns config-fil (motorn pollar den och laddar .ld).
#[tauri::command]
fn set_reference(app: AppHandle, state: State<Mutex<Settings>>, path: String) {
    {
        let mut s = state.lock().unwrap();
        s.reference_ld = path.clone();
        save_settings(&app, &s);
    }
    if let Ok(dir) = app.path().app_config_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join("engine.config.json"),
            serde_json::json!({ "reference_ld": path }).to_string());
    }
}

// ── Globala inställningar (gäller alla overlays) ─────────────────────────────
#[derive(Serialize, Clone)]
struct GlobalsPayload {
    hide_until_connected: bool,
}

#[tauri::command]
fn get_globals(state: State<Mutex<Settings>>) -> GlobalsPayload {
    let s = state.lock().unwrap();
    GlobalsPayload { hide_until_connected: s.hide_until_connected }
}

// Visa overlays först när motorn är ansluten till ACC. Skickas till alla fönster;
// overlays döljer sig själva (via bus.js) tills connected==true.
#[tauri::command]
fn set_hide_until_connected(app: AppHandle, state: State<Mutex<Settings>>, value: bool) {
    {
        let mut s = state.lock().unwrap();
        s.hide_until_connected = value;
        save_settings(&app, &s);
    }
    let _ = app.emit("globals", GlobalsPayload { hide_until_connected: value });
}

// ── App-uppstart ────────────────────────────────────────────────────────────
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let toggle = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space);
    let toggle_h = toggle.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, sc, ev| {
                    if sc == &toggle_h && ev.state == ShortcutState::Pressed {
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
            reset_overlay,
            set_edit_mode,
            set_reference,
            get_globals,
            set_hide_until_connected
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let settings = load_settings(&handle);

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

            app.manage(Mutex::new(settings));
            start_engine(&handle);

            for (def, st) in plan {
                if let Err(e) = create_overlay(&handle, def, &st, gate) {
                    eprintln!("[shell] kunde ej skapa overlay {}: {e}", def.id);
                }
            }

            // Registrera hotkeyen, men låt inte appen krascha om genvägen redan
            // ägs av något annat program — panelens "flytta"-knapp (set_edit_mode)
            // fungerar ändå, så edit-läget går att nå utan hotkeyen.
            if let Err(e) = app.global_shortcut().register(toggle.clone()) {
                eprintln!("[shell] kunde ej registrera Ctrl+Alt+Space ({e}). \
                           Genvägen är troligen upptagen av ett annat program. \
                           Använd panelens flytta-knapp för att växla edit-läge.");
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
                        save_settings(&app, &s);
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
