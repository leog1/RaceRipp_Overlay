// Undviker en extra konsol-ruta på Windows i release. TA INTE BORT.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    acc_overlay_lib::run();
}
