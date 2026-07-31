"""Motorns sessionstillstånd: hamnar rätt varv i loggen, och töms den när den ska?

Bakgrund: alla fält i ramen beskriver NUET. En varvtidslogg behöver HISTORIK, och en
lista går inte att skicka 40 gånger i sekunden. `acc_engine/state.py` bokför varven och
skickar listan enligt samma kontrakt som `entries` — vid ändring, plus en omsändning
med jämna mellanrum.

Två saker gör testet värt något, och båda är baksidor:

  • **Tömningen.** `None` betyder OFÖRÄNDRAD och `[]` betyder TÖMD. Blandas de ihop
    ligger förra sessionens varv kvar på skärmen, och det syns inte förrän någon kör
    två sessioner i rad.
  • **Vad som INTE ska in.** Ett sentinelvärde, ett varv från mock-källan mitt i en
    riktig session. Ett felaktigt varv i loggen ser precis lika trovärdigt ut som ett
    riktigt.

Koden är ny och har ingen revision "före fixen" att köra mot. Tänderna bevisas därför
mot MEDVETET TRASIGA varianter (klasserna nedan): varje regel testas också utan sig
själv, så kontrollen mäter regeln och inte bara att koden gör som koden gör (§9).

    python tests/session_state.py
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

from acc_engine.frame import Frame                                       # noqa: E402
from acc_engine.state import (                                           # noqa: E402
    SessionState, lap_transition, resolve_lap_ms, MAX_HISTORY,
)

failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failed
    print(f"{'OK  ' if ok else 'FEL '} {name}" + (f"  — {detail}" if detail else ""))
    if not ok:
        failed += 1


def drive(st, lap_s: float, laps_done: int, *, pit: bool = False, out_lap: bool = False,
          track: str = "Spa", connected: bool = True, last_ms=..., cur: bool = True) -> None:
    """Kör ett varv genom tillståndet och passera mållinjen.

    `cur=False` simulerar att `curLapMs` saknas hela varvet (ACC:s sentinelvärden) —
    då finns ingen egen mätning att falla tillbaka på.
    """
    n = 20
    for i in range(n):
        p = i / n
        st.update(Frame(connected=connected, trackId=track, completedLaps=laps_done,
                        position=p, curLapMs=int(p * lap_s * 1000) if cur else None,
                        inPitLane=pit and p < 0.08, outLap=out_lap))
    # Sista ramen före linjen: vår egen mätning av varvet.
    st.update(Frame(connected=connected, trackId=track, completedLaps=laps_done,
                    position=0.999, curLapMs=int(lap_s * 1000) if cur else None,
                    outLap=out_lap))
    # Mållinjen: varvräknaren tickar och ACC har varvtiden.
    st.update(Frame(connected=connected, trackId=track, completedLaps=laps_done + 1,
                    position=0.001, curLapMs=40 if cur else None,
                    lastLapMs=int(lap_s * 1000) if last_ms is ... else last_ms))


# ── 1. Varvgränsen (regeln som delas med laps.py) ───────────────────────────
check("första ramen adopterar räknaren utan att räkna det som ett varv",
      lap_transition(None, 7) == "none")
check("räknaren tickar upp = varv avslutat", lap_transition(3, 4) == "completed")
check("räknaren går bakåt = ny session", lap_transition(9, 0) == "reset")
check("oförändrad räknare händer ingenting", lap_transition(4, 4) == "none")

# ── 2. Auktoritativ varvtid ─────────────────────────────────────────────────
check("ACC:s tid vinner när den ligger nära vår egen mätning",
      resolve_lap_ms(100_120, 100_000) == 100_000)
check("vår egen mätning vinner när ACC:s ligger för långt bort (förra varvets tid)",
      resolve_lap_ms(100_000, 138_000) == 100_000)
check("orimligt kort varv avvisas", resolve_lap_ms(5_000, 5_000) is None)
check("orimligt långt varv avvisas", resolve_lap_ms(3_600_000, None) is None)
check("utan någon tid alls blir det inget varv", resolve_lap_ms(None, None) is None)

# ── 3. Ett rent varv hamnar i loggen ────────────────────────────────────────
st = SessionState()
check("tom logg från start", st.history() == [] and not st.laps_dirty)
drive(st, 100.0, 0)
h = st.history()
check("ett avslutat varv bokförs", len(h) == 1, f"{h}")
check("med rätt varvnummer och tid", h and h[0]["n"] == 1 and h[0]["ms"] == 100_000, f"{h}")
check("och flaggas som ändrad så det skickas", st.laps_dirty)
st.mark_laps_sent()
check("mark_laps_sent släcker flaggan", not st.laps_dirty)

st.update(Frame(connected=True, trackId="Spa", completedLaps=1, position=0.3, curLapMs=30_000))
check("en vanlig ram mitt i varvet flaggar INTE för omsändning", not st.laps_dirty)

drive(st, 98.5, 1)
h = st.history()
check("varv nummer två läggs till efter det första",
      len(h) == 2 and h[1]["n"] == 2 and h[1]["ms"] == 98_500, f"{h}")

check("history() ger en KOPIA (en konsument kan inte ändra motorns lista)",
      (h.append({"n": 99, "ms": 1}) or len(st.history()) == 2), f"{len(st.history())}")

# ── 4. Depåvarv märks men KASTAS INTE ───────────────────────────────────────
# Skillnaden mot laps.py är hela skälet till att den här modulen finns: ett in-varv
# duger inte som referenskurva, men det kördes och hör hemma i loggen.
st = SessionState()
drive(st, 100.0, 0)
drive(st, 140.0, 1, pit=True)
h = st.history()
check("ett depåvarv hamnar ändå i loggen", len(h) == 2, f"{h}")
check("och märks som depåvarv", h and h[1]["pit"] is True, f"{h}")
check("medan varvet före inte gör det", h and h[0]["pit"] is False, f"{h}")

st = SessionState()
drive(st, 100.0, 0, out_lap=True)
check("ett ut-varv märks likadant", st.history() and st.history()[0]["pit"] is True,
      f"{st.history()}")


class UtanDepakoll(SessionState):
    """Trasig variant: bokför aldrig att depån berörts."""
    def update(self, f):
        super().update(Frame(**{**vars(f), "inPitLane": False, "outLap": False}))


broken = UtanDepakoll()
drive(broken, 140.0, 0, pit=True)
check("  (varianten utan depåkollen märker det inte → kollen är det som gör det)",
      broken.history() and broken.history()[0]["pit"] is False, f"{broken.history()}")

# ── 5. Sessionsbyte TÖMMER, och tomheten måste nå fram ──────────────────────
st = SessionState()
drive(st, 100.0, 0)
drive(st, 99.0, 1)
st.mark_laps_sent()
st.update(Frame(connected=True, trackId="Spa", completedLaps=0, position=0.1, curLapMs=1000))
check("varvräknare som går bakåt tömmer loggen", st.history() == [], f"{st.history()}")
check("  och flaggar för sändning — [] måste NÅ overlayn, annars ligger förra "
      "sessionens varv kvar", st.laps_dirty)

st = SessionState()
drive(st, 100.0, 0)
st.mark_laps_sent()
drive(st, 100.0, 0, track="Monza")
h = st.history()
check("banbyte tömmer och börjar om", len(h) == 1 and h[0]["ms"] == 100_000, f"{h}")

st = SessionState()
st.mark_laps_sent()
st.update(Frame(connected=True, trackId="Spa", completedLaps=0, position=0.1))
st.update(Frame(connected=True, trackId="Monza", completedLaps=0, position=0.1))
check("men ett banbyte med TOM logg flaggar inget (inget ändrades)", not st.laps_dirty)


class UtanNollstallning(SessionState):
    """Trasig variant: nollställer bokföringen men behåller historiken."""
    def _clear_history(self):
        pass


broken = UtanNollstallning()
drive(broken, 100.0, 0)
broken.update(Frame(connected=True, trackId="Spa", completedLaps=0, position=0.1, curLapMs=1000))
check("  (varianten utan tömning behåller förra sessionens varv)",
      len(broken.history()) == 1, f"{broken.history()}")

# ── 6. Mock och riktig körning får aldrig stå i samma lista ─────────────────
# Samma familj som §8.6e, men ett annat svar: en KURVA från mock förgiftar deltat
# tyst, en mock-TID i loggen gör bara listan omöjlig att lita på. Det räcker att tömma.
st = SessionState()
drive(st, 100.0, 0, connected=False)
drive(st, 99.0, 1, connected=False)
check("mock-varv bokförs (annars går loggen inte att designa utan spelet)",
      len(st.history()) == 2, f"{st.history()}")
drive(st, 98.0, 2, connected=True)
h = st.history()
check("men första riktiga varvet tömmer mock-listan",
      len(h) == 1 and h[0]["ms"] == 98_000, f"{h}")

st = SessionState()
drive(st, 100.0, 0, connected=True)
st.update(Frame(connected=False, trackId="Spa", completedLaps=1, position=0.2, curLapMs=20_000))
st.update(Frame(connected=True, trackId="Spa", completedLaps=1, position=0.3, curLapMs=30_000))
check("en kort ACC-tapp mitt i ett varv tömmer INGENTING",
      len(st.history()) == 1, f"{st.history()}")

# ── 7. Orimliga tider hamnar aldrig i loggen ────────────────────────────────
st = SessionState()
drive(st, 100.0, 0, cur=False, last_ms=2_147_483_647)
check("ett sentinelvärde utan egen mätning ger inget varv", st.history() == [],
      f"{st.history()}")

st = SessionState()
drive(st, 5.0, 0)
check("ett orimligt kort varv avvisas", st.history() == [], f"{st.history()}")


class UtanRimlighetskontroll(SessionState):
    """Trasig variant: tar varvtiden rakt av."""
    def _record(self, f):
        ms = self._prev_cur_ms if self._prev_cur_ms is not None else f.lastLapMs
        self._pit_touched = False
        if ms is None:
            return
        self._laps.append({"n": int(f.completedLaps or 0), "ms": int(ms), "pit": False})
        self.laps_dirty = True


broken = UtanRimlighetskontroll()
drive(broken, 5.0, 0)
check("  (varianten utan rimlighetskontroll släpper in det)",
      len(broken.history()) == 1, f"{broken.history()}")

# ── 8. Taket på historiken ──────────────────────────────────────────────────
st = SessionState()
for i in range(MAX_HISTORY + 12):
    drive(st, 100.0 + i * 0.001, i)
h = st.history()
check(f"historiken kapas vid {MAX_HISTORY} varv", len(h) == MAX_HISTORY, f"{len(h)}")
check("och det är de ÄLDSTA som faller av",
      h[-1]["n"] == MAX_HISTORY + 12 and h[0]["n"] == 13, f"{h[0]['n']}..{h[-1]['n']}")

print(f"\n{failed} kontroll(er) misslyckades" if failed else "\nAllt OK")
sys.exit(1 if failed else 0)
