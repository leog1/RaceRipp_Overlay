"""Testar MoTeC-referensen mot en riktig .ld-fil.

Kräver `engine/ldparser.py` (GPL, gitignorerad — hämtas från gotzl/ldparser) och en
.ld att peka på. Utan argument används referensen ur appens settings.json om den finns.

    python tests/motec_reference.py [sokvag.ld]

Kontrollerar särskilt spikskyddet: mållinje-artefakten (position wrappar innan
varvtiden nollställs) ska avvisas, medan äkta stora deltan ska visas — tröskeln är
proportionell mot varvlängden just för att fungera på både Spa och Nordschleife.
"""
from __future__ import annotations
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))

failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failed
    print(f"{'OK  ' if ok else 'FEL '} {name}" + (f"  — {detail}" if detail else ""))
    if not ok:
        failed += 1


def find_ld() -> str | None:
    if len(sys.argv) > 1:
        return sys.argv[1]
    cfg = Path(os.environ.get("APPDATA", "")) / "com.accoverlay.app" / "settings.json"
    if cfg.exists():
        try:
            p = json.loads(cfg.read_text(encoding="utf-8-sig")).get("reference_ld", "")
            if p and Path(p).exists():
                return p
        except Exception:
            pass
    return None


def main() -> int:
    ld = find_ld()
    if not ld or not Path(ld).exists():
        print("HOPPAR ÖVER: ingen .ld angiven och ingen referens i settings.json")
        print("            kör: python tests/motec_reference.py <fil.ld>")
        return 0
    try:
        import ldparser  # noqa: F401
    except Exception as e:
        print(f"HOPPAR ÖVER: ldparser.py saknas i engine/ ({e})")
        return 0

    from acc_engine.delta import Reference

    print(f"fil: {Path(ld).name}\n")
    r = Reference()
    check("load() lyckas", r.load(ld))
    if not r.loaded:
        return 1

    lap = r.lap_ms / 1000.0
    check("rimlig varvtid", 30 <= lap <= 900, f"{lap:.3f}s")
    check("distans normaliserad 0..1", 0 <= r._pos.min() and r._pos.max() <= 1.0 + 1e-9,
          f"{r._pos.min():.4f}..{r._pos.max():.4f}")
    check("distans monotont stigande", bool((r._pos[1:] > r._pos[:-1]).all()))
    check("tid börjar på noll", abs(float(r._t[0])) < 1e-6)

    mid = r.t_at(0.5)
    check("delta = 0 exakt på referensen", abs(r.delta(0.5, int(mid * 1000))) < 0.01)
    check("delta = +1.2 s efter referensen", abs(r.delta(0.5, int((mid + 1.2) * 1000)) - 1.2) < 0.01)
    check("ingen varvtid ger None", r.delta(0.5, None) is None)

    # Mållinje-artefakten: magnitud ≈ hela varvet, ska avvisas.
    check("artefakt (timer nollad först) avvisas", r.delta(0.999, 50) is None)
    check("artefakt (position wrappar först) avvisas",
          r.delta(0.001, int(lap * 1000) - 50) is None)

    # Äkta stora deltan ska INTE avvisas — viktigt på långa banor.
    big = r.delta(0.5, int((mid + 0.3 * lap) * 1000))
    check("äkta delta på 30 % av varvet visas", big is not None,
          f"{big:+.1f}s" if big is not None else "avvisad")

    # Samma kurva skalad till ett Nordschleife-varv: tröskeln ska följa med.
    import numpy as np  # noqa: F401
    n = Reference()
    n._pos, n._t = r._pos.copy(), r._t * (485.0 / lap)
    n.lap_ms, n.loaded = int(n._t[-1] * 1000), True
    nmid = n.t_at(0.5)
    check("Nordschleife: äkta delta på 120 s visas",
          n.delta(0.5, int((nmid + 120) * 1000)) is not None)
    check("Nordschleife: artefakten avvisas ändå", n.delta(0.999, 50) is None)

    print("\nAllt OK" if not failed else f"\n{failed} kontroll(er) misslyckades")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
