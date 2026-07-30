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
    # FakeSM saknar bibliotekets mmap-handtag, alltså långsamma vägen (read_shared_memory).
    src._fast = False
    src._prev_susp, src._static, src._static_t = None, None, 0.0
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

# ── 2b. Den hållna ramen får inte bära med sig anroparens ändringar ────────
# __main__ MUTERAR ramen efter read(): apply_reference skriver om delta,
# refTotalMs och deltaSource. Sparade källan samma objekt som den lämnade ut skrev
# de ändringarna rakt in i cachen, och nästa hållna ram kom tillbaka med ett
# MoTeC-delta märkt som ACC:s. Cachen ska vara orörd av vad anroparen gör.
src_b, sm_b = make_source()
sm_b.gas = 0.7
live = src_b.read()
acc_delta = live.delta
live.delta = -9.99                        # som apply_reference gör
live.deltaSource = "motec"
live.refTotalMs = 136250
sm_b.script = [False]
held = src_b.read()
check("hållen ram bär inte anroparens muterade delta",
      held.delta == acc_delta, f"höll {held.delta}, ACC gav {acc_delta}")
check("hållen ram bär inte anroparens deltaSource/refTotalMs",
      held.deltaSource is None and held.refTotalMs is None,
      f"källa={held.deltaSource} refTotalMs={held.refTotalMs}")
held.delta = -1.23                        # mutera ÄVEN den hållna ramen
sm_b.script = [False]
held2 = src_b.read()
check("nästa hållna ram är inte heller smittad",
      held2.delta == acc_delta, f"höll {held2.delta}, ACC gav {acc_delta}")

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

# ── 7. Snabbvägen förbi read_shared_memory() ───────────────────────────────
# `accSharedMemory.read_shared_memory()` gör två saker per anrop som kostar mätbart
# mer än allt annat i motorn tillsammans: den läser om STATIC-blocket (statiskt) och
# den `copy.deepcopy`:ar hela physics-strukturen (206,7 µs mätt) bara för att nästa
# anrop ska kunna jämföra `suspension_travel` (0,2 µs). AccSource läser därför
# blocken själv. Kontrollerna nedan bevakar att den gör det UTAN att ändra kontrakt:
# dedupen måste ge exakt samma None-svar som förut (§8.6e), annars är blinket och
# hacken tillbaka.
class FastSM:
    """Bibliotekets mmap-handtag, fejkade. Räknar hur ofta varje block läses."""

    def __init__(self):
        self.physicSM, self.graphicSM, self.staticSM = "p", "g", "s"
        self.susp = (1.0, 1.0, 1.0, 1.0)
        self.packed = 1
        self.track = "Spa"
        self.n_phys = self.n_gfx = self.n_stat = 0

    def close(self):
        pass


fast = FastSM()


def _fake_phys(_h):
    fast.n_phys += 1
    return types.SimpleNamespace(
        gas=0.5, brake=0.0, clutch=1.0, abs=0.0, tc=0.0, gear=2, speed_kmh=180.0,
        rpm=7000, steer_angle=0.0, packed_id=fast.packed, suspension_travel=fast.susp)


def _fake_gfx(_h):
    fast.n_gfx += 1
    return types.SimpleNamespace(
        status=2, best_time=138120, last_time=138500, current_time=42000,
        normalized_car_position=0.5, delta_lap_time=-250, is_delta_positive=False,
        completed_lap=3, is_in_pit_lane=False, is_in_pit=False)


def _fake_stat(_h):
    fast.n_stat += 1
    return types.SimpleNamespace(player_name="Test\x00", track=fast.track)


accmod.read_physic_map, accmod.read_graphics_map, accmod.read_static_map = (
    _fake_phys, _fake_gfx, _fake_stat)

srcf = accmod.AccSource.__new__(accmod.AccSource)
srcf._sm = fast
srcf._last, srcf._last_t = None, 0.0
srcf._out_lap, srcf._laps = False, 3
srcf._fast = True
srcf._prev_susp, srcf._static, srcf._static_t = None, None, 0.0

f1 = srcf.read()
check("snabbvägen ger en ansluten ram", f1.connected and f1.trackId == "Spa",
      f"connected={f1.connected} trackId={f1.trackId!r}")

# Oförändrad fjädring = ingen ny fysikram. Samma dedup som PhysicsMap.is_equal.
before = srcf._last.throttle
sm_frames = [srcf.read() for _ in range(5)]
check("oförändrad suspension_travel räknas som 'ingen ny data', inte frånkoppling",
      all(x.connected for x in sm_frames) and all(abs(x.throttle - before) < 1e-9
                                                  for x in sm_frames),
      f"connected={[x.connected for x in sm_frames]}")
check("och GRAPHICS läses inte alls för en ram som ändå kastas",
      fast.n_gfx == 1, f"{fast.n_gfx} graphics-läsningar på {fast.n_phys} physics")

# Ny fjädring = ny ram.
fast.susp = (1.1, 1.0, 1.0, 1.0)
f2 = srcf.read()
check("ändrad suspension_travel ger en ny ram", fast.n_gfx == 2, f"{fast.n_gfx} graphics")

# STATIC är statiskt: läses en gång, inte per ram.
stat_before = fast.n_stat
for i in range(20):
    fast.susp = (1.1 + i * 0.01, 1.0, 1.0, 1.0)
    srcf.read()
check("STATIC läses inte om för varje ram", fast.n_stat == stat_before,
      f"{fast.n_stat - stat_before} extra läsningar på 20 ramar")

# ...men det får inte frysa: ett banbyte måste synas inom STATIC_S.
fast.track = "Monza"
srcf._static_t -= accmod.STATIC_S + 0.1
fast.susp = (2.0, 1.0, 1.0, 1.0)
check("men läses om efter STATIC_S så ett banbyte syns", srcf.read().trackId == "Monza",
      f"trackId={srcf.read().trackId!r}")

# packed_id 0 = ACC skriver inte. Samma kontroll som biblioteket gör.
fast.packed = 0
fast.susp = (3.0, 1.0, 1.0, 1.0)
gfx_before = fast.n_gfx
srcf.read()
check("packed_id 0 läser inte vidare (ACC skriver inte)", fast.n_gfx == gfx_before,
      f"{fast.n_gfx - gfx_before} graphics-läsningar")

print(f"\n{failed} kontroll(er) misslyckades" if failed else "\nAllt OK")
sys.exit(1 if failed else 0)
