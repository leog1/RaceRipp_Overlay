"""Kontrollerar att en byggd sidecar innehåller de moduler motorn behöver.

Finns för att 0.2.4 släpptes med en sidecar UTAN ldparser, alltså tyst trasig
MoTeC-delta. Orsaken var att CI körde `pip install git+https://github.com/gotzl/ldparser`
— vilket inte kan fungera, för repot är en enda fil och inget pip-paket — och att
`shell: pwsh` svalde felet eftersom bara sista kommandots exitkod räknas. PyInstaller
varnar bara för ett `--hidden-import` som inte hittas, så bygget "lyckades".

Körs av build_sidecar.py och som eget steg i CI, så det inte kan hända igen.

    python engine/verify_sidecar.py [sokvag-till-exe]
"""
from __future__ import annotations
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT = HERE.parent / "src-tauri" / "binaries" / "acc-engine-x86_64-pc-windows-msvc.exe"

# Moduler som MÅSTE ligga i arkivet. ldparser = MoTeC-referens (delta),
# pyaccsharedmemory = ACC-telemetri, numpy = resampling i delta.py,
# acc_broadcast = Broadcasting-UDP (andra bilar; egen modul, egen chans att tappas).
REQUIRED = ["acc_engine", "acc_broadcast", "ldparser", "pyaccsharedmemory",
            "numpy", "websockets"]


def verify(exe: Path) -> int:
    if not exe.exists():
        print(f"FEL: hittar ingen sidecar på {exe}")
        return 1
    blob = exe.read_bytes()
    print(f"sidecar: {exe.name}  ({len(blob) / 1e6:.1f} MB)")
    missing = [m for m in REQUIRED if m.encode() not in blob]
    for m in REQUIRED:
        print(f"  {'OK  ' if m not in missing else 'SAKNAS'}  {m}")
    if missing:
        print(f"\nFEL: {', '.join(missing)} finns inte i sidecarn.")
        if "ldparser" in missing:
            print("     ldparser är EN fil, inte ett pip-paket: lägg")
            print("     https://raw.githubusercontent.com/gotzl/ldparser/master/ldparser.py")
            print("     i engine/ innan du bygger (PyInstaller hittar den via --paths).")
        return 1
    print("\nAlla nödvändiga moduler finns.")
    return 0


if __name__ == "__main__":
    raise SystemExit(verify(Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT))
