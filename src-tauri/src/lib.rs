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

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OverlayDef {
    id: String,
    title: String,
    url: String,
    base_width: f64,
    base_height: f64,
    default_x: i32,
    default_y: i32,
    default_scale: f64,
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
#[derive(Serialize, Deserialize, Clone)]
struct OverlayState {
    enabled: bool,
    x: i32,
    y: i32,
    scale: f64,
    opacity: f64,
}
#[derive(Serialize, Deserialize, Default)]
struct Settings {
    overlays: HashMap<String, OverlayState>,
    reference_ld: String,
}

fn default_settings() -> Settings {
    let mut s = Settings::default();
    for d in registry() {
        s.overlays.insert(
            d.id.clone(),
            OverlayState { enabled: true, x: d.default_x, y: d.default_y, scale: d.default_scale, opacity: 1.0 },
        );
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
                s.overlays.entry(d.id.clone()).or_insert(OverlayState {
                    enabled: true, x: d.default_x, y: d.default_y, scale: d.default_scale, opacity: 1.0,
                });
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
        .always_on_top(true)
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
struct OverlayInfo { id: String, title: String, enabled: bool, scale: f64, opacity: f64 }

#[tauri::command]
fn get_overlays(state: State<Mutex<Settings>>) -> Vec<OverlayInfo> {
    let s = state.lock().unwrap();
    registry().iter().map(|d| {
        let st = s.overlays.get(&d.id).unwrap();
        OverlayInfo { id: d.id.clone(), title: d.title.clone(), enabled: st.enabled, scale: st.scale, opacity: st.opacity }
    }).collect()
}

#[derive(Serialize, Clone)]
struct ConfigPayload { id: String, scale: f64, opacity: f64 }

// Overlayn hämtar sin config vid start (undviker race mot event-lyssnaren).
#[tauri::command]
fn get_config(id: String, state: State<Mutex<Settings>>) -> ConfigPayload {
    let s = state.lock().unwrap();
    let st = s.overlays.get(&id).cloned()
        .unwrap_or(OverlayState { enabled: true, x: 0, y: 0, scale: 1.0, opacity: 1.0 });
    ConfigPayload { id, scale: st.scale, opacity: st.opacity }
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
            get_overlays, get_config, set_enabled, set_scale, set_opacity, set_reference
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let settings = load_settings(&handle);

            start_engine(&handle);

            for def in registry() {
                let st = settings.overlays.get(&def.id).cloned().unwrap_or(OverlayState {
                    enabled: true, x: def.default_x, y: def.default_y, scale: def.default_scale, opacity: 1.0,
                });
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
