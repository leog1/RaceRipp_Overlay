"""Bygg Python-motorn till en fristående .exe och placera den där Tauri hittar
den (src-tauri/binaries/acc-engine-<target-triple>.exe).

Kör på din Windows-maskin innan `pnpm tauri build`:
    pip install pyinstaller -r requirements.txt
    pip install git+https://github.com/gotzl/ldparser
    python build_sidecar.py
"""
import shutil, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
TRIPLE = "x86_64-pc-windows-msvc"  # Windows x64. Byt om du bygger för annan target.

def main():
    subprocess.check_call([sys.executable, "-m", "PyInstaller", "--onefile",
                           "--name", "acc-engine", str(HERE / "acc_engine" / "__main__.py")])
    out = ROOT / "src-tauri" / "binaries"
    out.mkdir(parents=True, exist_ok=True)
    exe = HERE / "dist" / ("acc-engine.exe" if sys.platform == "win32" else "acc-engine")
    dst = out / (f"acc-engine-{TRIPLE}.exe" if sys.platform == "win32" else f"acc-engine-{TRIPLE}")
    shutil.copy2(exe, dst)
    print("Sidecar klar:", dst)

if __name__ == "__main__":
    main()
