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
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

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
    match std::fs::read_to_string(settings_path(app)) {
        Ok(txt) => {
            let mut s: Settings = serde_json::from_str(&txt).unwrap_or_else(|_| default_settings());
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
fn create_overlay(app: &AppHandle, def: &OverlayDef, st: &OverlayState) -> tauri::Result<()> {
    let w = def.base_width * st.scale;
    let h = def.base_height * st.scale;
    let win = WebviewWindowBuilder::new(app, &def.id, WebviewUrl::App(def.url.clone().into()))
        .title(&def.title)
        .inner_size(w, h)
        .position(st.x as f64, st.y as f64)
        .decorations(false)
        .transparent(true)
        .always_on_top(st.always_on_top)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .focused(false)
        .visible(true)
        .build()?;
    win.set_ignore_cursor_events(CLICK_THROUGH.load(Ordering::Relaxed))?;
    Ok(())
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
        let st = { state.lock().unwrap().overlays.get(&id).cloned() };
        if let (Some(def), Some(st)) = (def_of(&id), st) { let _ = create_overlay(&app, def, &st); }
    }
}

#[tauri::command]
fn set_scale(app: AppHandle, state: State<Mutex<Settings>>, id: String, scale: f64) {
    let opacity;
    {
        let mut s = state.lock().unwrap();
        if let Some(st) = s.overlays.get_mut(&id) { st.scale = scale; }
        opacity = s.overlays.get(&id).map(|s| s.opacity).unwrap_or(1.0);
        save_settings(&app, &s);
    }
    apply_size(&app, &id, scale);
    let _ = app.emit_to(id.as_str(), "config", ConfigPayload { id: id.clone(), scale, opacity });
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
    let _ = app.emit_to(id.as_str(), "config", ConfigPayload { id: id.clone(), scale, opacity });
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
    let _ = app.emit_to(id.as_str(), "option", OptionPayload { id: id.clone(), option, value });
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
    let _ = app.emit_to(id.as_str(), "config", ConfigPayload { id: id.clone(), scale, opacity });
    for (opt, val) in options {
        let _ = app.emit_to(id.as_str(), "option", OptionPayload { id: id.clone(), option: opt, value: val });
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

            start_engine(&handle);

            for def in registry() {
                let st = settings
                    .overlays
                    .get(&def.id)
                    .cloned()
                    .unwrap_or_else(|| default_state_for(def));
                if let Err(e) = create_overlay(&handle, def, &st) {
                    eprintln!("[shell] kunde ej skapa overlay {}: {e}", def.id);
                }
                if !st.enabled {
                    if let Some(w) = handle.get_webview_window(&def.id) { let _ = w.hide(); }
                }
            }

            app.manage(Mutex::new(settings));
            app.global_shortcut().register(toggle.clone())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "control" {
                if let WindowEvent::CloseRequested { .. } = event {
                    let app = window.app_handle().clone();
                    if let Some(state) = app.try_state::<Mutex<Settings>>() {
                        let mut s = state.lock().unwrap();
                        for id in overlay_ids() {
                            if let Some(w) = app.get_webview_window(id) {
                                if let Ok(pos) = w.outer_position() {
                                    if let Some(st) = s.overlays.get_mut(id) { st.x = pos.x; st.y = pos.y; }
                                }
                            }
                        }
                        save_settings(&app, &s);
                    }
                    app.exit(0);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("fel vid start av ACC Overlay");
}

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
            if let Err(e) = cmd.spawn() {
                eprintln!("[shell] sidecar 'acc-engine' startade ej: {e} (kör motorn manuellt i dev)");
            }
        }
        Err(e) => eprintln!("[shell] hittar ej sidecar 'acc-engine': {e} (dev: kör motorn manuellt)"),
    }
}
