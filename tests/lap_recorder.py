"""Motorns egna varvinspelningar: blir ett varv en referens, och blir fel varv INTE en?

Bakgrund: utan en MoTeC-fil kunde inputs-trace inte rita något spökspår alls och
delta-baren hade bara ACC:s eget mått mot session-bästa (en siffra, ingen kurva). Det
rapporterades som en bugg — och lösningen är att motorn spelar in varven själv
(acc_engine/laps.py), så att "förra varvet" och "sessionens bästa" är fullvärdiga
referenser med både delta och pedalkurva.

Det som gör testet värt något är BAKSIDAN: ett varv som inte duger som referens ska
inte bli en. En dålig referens är värre än ingen, för siffran ser precis lika
trovärdig ut. Varje sådan regel testas därför mot en MEDVETET trasig variant av
inspelaren (klasserna nedan) — annars bevisar kontrollen bara att koden gör det den
gör, inte att regeln behövs.

    python tests/lap_recorder.py
"""
from __future__ import annotations
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))

from acc_engine.frame import Frame                                   # noqa: E402
from acc_engine.laps import LapRecorder, POS_STEP                    # noqa: E402

failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failed
    print(f"{'OK  ' if ok else 'FEL '} {name}" + (f"  — {detail}" if detail else ""))
    if not ok:
        failed += 1


def drive(rec, lap_s: float, laps_done: int, *, hz: int = 40, pit: bool = False,
          out_lap: bool = False, track: str = "Spa", start: float = 0.0) -> None:
    """Kör ett varv genom inspelaren och passera mållinjen.

    Gas full första halvan, broms full andra — så går det att se ATT kurvan hamnade
    på rätt position och inte bara att den finns.
    """
    n = int(lap_s * hz)
    for i in range(n):
        p = start + (1.0 - start) * (i / n)
        rec.update(Frame(
            connected=True, trackId=track, completedLaps=laps_done,
            position=p, curLapMs=int(p * lap_s * 1000),
            throttle=1.0 if p < 0.5 else 0.0,
            brake=0.0 if p < 0.5 else 1.0,
            inPitLane=pit and p < 0.08, outLap=out_lap,
        ))
    # Ramen som passerar mållinjen: varvräknaren tickar och ACC har varvtiden.
    rec.update(Frame(connected=True, trackId=track, completedLaps=laps_done + 1,
                     position=0.001, curLapMs=40, lastLapMs=int(lap_s * 1000),
                     throttle=1.0, outLap=out_lap))


# ── 1. Ett rent varv blir både "förra" och "bästa" ──────────────────────────
rec = LapRecorder()
drive(rec, 100.0, 1)
check("ett rent varv spelas in", rec.last is not None and rec.best is not None,
      f"last={rec.last} best={rec.best}")
check("varvtiden kommer från ACC:s last_time", rec.last and rec.last.lap_ms == 100000,
      f"lap_ms={rec.last.lap_ms if rec.last else None}")
check("första varvet är också sessionens bästa", rec.best is rec.last)
check("punktantalet är begränsat (positionssteg, inte en punkt per ram)",
      rec.last and 900 <= len(rec.last) <= int(1.0 / POS_STEP) + 2,
      f"{len(rec.last) if rec.last else 0} punkter")

# ── 2. Delta och spökkanaler mot det inspelade varvet ───────────────────────
d = rec.last.delta(0.5, 52000)
check("delta = +2 s när man är 2 s efter halvvägs", d is not None and abs(d - 2.0) < 0.15, f"{d}")
d = rec.last.delta(0.5, 48000)
check("delta = -2 s när man är 2 s före", d is not None and abs(d + 2.0) < 0.15, f"{d}")
check("mållinjeartefakten avvisas (samma spikskydd som .ld-referensen)",
      rec.last.delta(0.999, 50) is None, f"{rec.last.delta(0.999, 50)}")
ch = rec.last.channels_at(0.25)
check("spökkanalen ligger på rätt position (gas i första halvan)",
      abs(ch["throttle"] - 1.0) < 1e-6 and abs(ch["brake"]) < 1e-6, ch)
ch = rec.last.channels_at(0.75)
check("och följer med runt varvet (broms i andra halvan)",
      abs(ch["throttle"]) < 1e-6 and abs(ch["brake"] - 1.0) < 1e-6, ch)

# ── 3. "Bästa" är bästa, "förra" är förra ───────────────────────────────────
best_before = rec.best
drive(rec, 110.0, 2)                                    # långsammare varv
check("ett långsammare varv blir förra varvet", rec.last.lap_ms == 110000,
      f"lap_ms={rec.last.lap_ms}")
check("men rör inte sessionens bästa", rec.best is best_before and rec.best.lap_ms == 100000,
      f"best={rec.best.lap_ms}")
drive(rec, 95.0, 3)                                     # snabbare varv
check("ett snabbare varv tar över som bästa",
      rec.best is rec.last and rec.best.lap_ms == 95000, f"best={rec.best.lap_ms}")

# ── 4. Varv som INTE får bli referens ───────────────────────────────────────
# Varje regel testas mot en variant där just den regeln är borta. Utan det bevisar
# kontrollen bara att koden gör som koden gör.
class UtanDepakoll(LapRecorder):
    """Trasig variant: struntar i att depån berörts."""
    def update(self, f):
        f = Frame(**{**vars(f), "inPitLane": False, "outLap": False})
        super().update(f)


class UtanTackningskrav(LapRecorder):
    """Trasig variant: tar emot ett varv som bara täcker en bit av banan."""
    def _finish(self, f):
        from acc_engine import laps as L
        keep, L.MIN_COVERAGE = L.MIN_COVERAGE, 0.0
        try:
            super()._finish(f)
        finally:
            L.MIN_COVERAGE = keep


pit = LapRecorder()
drive(pit, 100.0, 1, pit=True)
check("ett varv med depåkontakt blir INTE en referens", pit.last is None and pit.best is None,
      f"last={pit.last}")
broken = UtanDepakoll()
drive(broken, 100.0, 1, pit=True)
check("  (och varianten utan depåkollen spelar in det → kollen är det som stoppar det)",
      broken.last is not None, f"last={broken.last}")

out = LapRecorder()
drive(out, 100.0, 1, out_lap=True)
check("ett ut-varv blir INTE en referens", out.last is None, f"last={out.last}")

partial = LapRecorder()
drive(partial, 100.0, 1, start=0.60)                    # motorn startade mitt på varvet
check("ett varv som bara täcker slutet blir INTE en referens", partial.last is None,
      f"last={partial.last}")
broken = UtanTackningskrav()
drive(broken, 100.0, 1, start=0.60)
check("  (och varianten utan täckningskravet spelar in det)", broken.last is not None,
      f"last={broken.last}")

# ── 5. Sessionen och banan nollställer ──────────────────────────────────────
# En referens från fel bana ger ett delta som ser rimligt ut men är nonsens — samma
# fel som matches_track skyddar .ld-filen mot (§8.8b).
rec2 = LapRecorder()
drive(rec2, 100.0, 1)
drive(rec2, 100.0, 2, track="Monza")
check("banbyte kastar det inspelade", rec2.last is not None and rec2.best is rec2.last
      and rec2.best.lap_ms == 100000 and rec2._track == "Monza",
      f"bana={rec2._track}")

rec3 = LapRecorder()
drive(rec3, 100.0, 5)
before = rec3.best
rec3.update(Frame(connected=True, trackId="Spa", completedLaps=0, position=0.1, curLapMs=1000))
check("varvräknare som går bakåt (ny session) kastar sessionens bästa",
      rec3.best is None and rec3.last is None, f"best={rec3.best} (var {before})")

# ── 6. Mock/ej ansluten får aldrig hamna i en referens ──────────────────────
# Motorn får inte blanda mock och riktig telemetri (§8.6e); en inspelning som tagit
# in mock-ramar hade varit exakt det, en ram i taget.
rec4 = LapRecorder()
for i in range(500):
    rec4.update(Frame(connected=False, trackId="Spa", completedLaps=1,
                      position=i / 500, curLapMs=i * 100, throttle=1.0))
rec4.update(Frame(connected=False, trackId="Spa", completedLaps=2, position=0.0,
                  curLapMs=0, lastLapMs=50000))
check("ramar med connected=False spelas inte in", rec4.last is None, f"last={rec4.last}")

# ── 7. Orimlig varvtid avvisas ──────────────────────────────────────────────
short = LapRecorder()
drive(short, 5.0, 1, hz=400)          # 5 s "varv": tät sampling, orimlig tid
check("ett orimligt kort varv avvisas", short.last is None, f"last={short.last}")

print(f"\n{failed} kontroll(er) misslyckades" if failed else "\nAllt OK")
sys.exit(1 if failed else 0)
