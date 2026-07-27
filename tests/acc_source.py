"""ACC-källans beteende när delade minnet inte har något NYTT att ge.

Bakgrund (rapporterat från riktig körning, 0.3.0): overlays blinkade var tredje–
fjärde sekund och traces fick små hack. Båda hade SAMMA orsak.
`accSharedMemory.read_shared_memory()` returnerar `None` så fort fysikpaketets id
inte hunnit ändras sedan förra läsningen — vi pollar 40 Hz, ACC skriver i egen takt.
Källan tolkade det som "ACC är borta" och motorn föll då tillbaka på MOCK-data för
just det framet: synk-grinden dolde overlays ett ögonblick, och mock-värden hamnade
mitt i den riktiga telemetrin.

Kör mot revisionen före fixen för att se att det biter:
    python tests/acc_source.py --old

    python tests/acc_source.py
"""
from __future__ import annotations
import sys
import types
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))

failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failed
    print(f"{'OK  ' if ok else 'FEL '} {name}" + (f"  — {detail}" if detail else ""))
    if not ok:
        failed += 1


# ── Fejkat delat minne ──────────────────────────────────────────────────────
# Bygger bara de fält källan faktiskt läser. Poängen är att kunna styra EXAKT när
# read_shared_memory() ger None, vilket är omöjligt mot riktiga ACC.
class FakeSM:
    def __init__(self):
        self.gas = 0.0
        self.pit = False
        self.laps = 0
        self.status = 2                     # ACC_LIVE
        self.script = []                    # lista av True/False: ge data eller None?

    def read_shared_memory(self):
        if self.script and not self.script.pop(0):
            return None
        phys = types.SimpleNamespace(
            gas=self.gas, brake=0.0, clutch=1.0, abs=0.0, tc=0.0, gear=2,
            speed_kmh=180.0, rpm=7000, steer_angle=0.0)
        gfx = types.SimpleNamespace(
            status=self.status, best_time=138120, last_time=138500, current_time=42000,
            normalized_car_position=0.5, delta_lap_time=-250, is_delta_positive=False,
            completed_lap=self.laps, is_in_pit_lane=self.pit, is_in_pit=self.pit)
        stat = types.SimpleNamespace(player_name="Test\x00\x00", track="Spa")
        return types.SimpleNamespace(Physics=phys, Graphics=gfx, Static=stat)

    def close(self):
        pass


from acc_engine.sources import acc as accmod   # noqa: E402


def make_source():
    src = accmod.AccSource.__new__(accmod.AccSource)
    src._sm = FakeSM()
    src._last, src._last_t = None, 0.0
    src._out_lap, src._laps = True, None
    return src, src._sm


# --old återskapar EXAKT det gamla felet: "ingen ny data" tolkades som frånkoppling.
# Bara den grenen bytas ut — resten av read() är oförändrad — så kontroll 1–3 mäter
# just den regressionen och ingenting annat.
#
# Ut-varvskontrollerna (4–6) har ingen motsvarighet i den gamla koden; fältet fanns
# inte. Att de biter visades i stället under utvecklingen: de fällde en första,
# felaktig regel som knöt ut-varvet till FÖRRA varvet i stället för till om man är i
# depåfilen när linjen passeras.
OLD = "--old" in sys.argv
if OLD:
    print("(kör mot felet FÖRE fixen — kontroll 1–3 ska misslyckas)\n")
    _orig = accmod.AccSource.read

    def _old_read(self):
        if self._sm.script and not self._sm.script[0]:
            self._sm.script.pop(0)
            from acc_engine.frame import Frame
            return Frame(connected=False)
        return _orig(self)
    accmod.AccSource.read = _old_read

# ── 1. Ett "ingen ny data"-svar får inte se ut som frånkoppling ─────────────
src, sm = make_source()
sm.gas = 0.9
first = src.read()
check("normal läsning ger connected", first.connected, f"connected={first.connected}")

sm.script = [False]                       # ETT None-svar
held = src.read()
check("ett tappat frame behåller connected",
      held.connected, f"connected={held.connected}")
check("ett tappat frame behåller telemetrin (inga hack i traces)",
      abs(held.throttle - 0.9) < 1e-9, f"throttle={held.throttle}")

# ── 2. Många tappade frames i rad ska också hållas ─────────────────────────
sm.script = [False] * 40                  # 1 s vid 40 Hz
last = None
for _ in range(40):
    last = src.read()
check("40 tappade frames i rad (1 s) håller fortfarande connected",
      last.connected, f"connected={last.connected}")

# ── 3. Men en RIKTIG frånkoppling måste märkas ─────────────────────────────
import acc_engine.sources.acc as accsrc   # noqa: E402
src._last_t -= accsrc.STALE_S + 1.0
sm.script = [False]
gone = src.read()
check("efter STALE_S utan data rapporteras frånkoppling",
      not gone.connected, f"connected={gone.connected}")

# ── 4. Ut-varv: sessionen börjar i depån ───────────────────────────────────
src2, sm2 = make_source()
sm2.pit, sm2.laps = True, 0
f = src2.read()
check("i depån vid sessionsstart = ut-varv", f.outLap, f"outLap={f.outLap}")

sm2.pit = False                            # ute på banan, fortfarande varv 0
f = src2.read()
check("ut ur depån men före mållinjen = fortfarande ut-varv", f.outLap, f"outLap={f.outLap}")

sm2.laps = 1                               # mållinjen passerad
f = src2.read()
check("efter mållinjen är det inte längre ut-varv", not f.outLap, f"outLap={f.outLap}")

# ── 5. Depåstopp: avgörande är om man är i depåfilen när linjen passeras ───
# På de flesta banor ligger depåutfarten EFTER mållinjen, så varvräknaren tickar
# medan man fortfarande rullar i depån. Då är varvet som börjar ett ut-varv.
sm2.pit = True                             # kör in i depån under varv 1
f = src2.read()
check("depån berörd mitt i varvet gör varvet förbrukat", f.outLap, f"outLap={f.outLap}")

sm2.laps = 2                               # linjen passeras medan vi ÄR i depån
f = src2.read()
check("linjen passerad i depåfilen → nästa varv är ett ut-varv", f.outLap, f"outLap={f.outLap}")

sm2.pit = False                            # ute på banan igen
sm2.laps = 3                               # linjen passeras i full fart
f = src2.read()
check("linjen passerad på banan → normalt varv igen", not f.outLap, f"outLap={f.outLap}")

# Och det motsatta fallet: depåutfart FÖRE linjen ger ett riktigt flygande varv.
src3, sm3 = make_source()
sm3.pit, sm3.laps = True, 5
src3.read()
sm3.pit = False                            # ute på banan innan linjen
src3.read()
sm3.laps = 6
f = src3.read()
check("depåutfart före linjen ger ett riktigt flygande varv", not f.outLap, f"outLap={f.outLap}")

# ── 6. Bannamnet följer med (referensen måste kunna matchas) ───────────────
check("bannamnet skickas med i ramen", f.trackId == "Spa", f"trackId={f.trackId!r}")

print(f"\n{failed} kontroll(er) misslyckades" if failed else "\nAllt OK")
sys.exit(1 if failed else 0)
