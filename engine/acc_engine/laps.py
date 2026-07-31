"""Motorns EGNA varvinspelningar: FÖRRA varvet och sessionens BÄSTA.

Varför de finns: en MoTeC-fil är inte det normala fallet. Man sätter sig i bilen och
vill se hur man ligger mot varvet innan, eller mot sitt bästa — och tills nu kunde
delta-baren bara visa ACC:s eget mått mot session-bästa (en SIFFRA, utan kurva) och
inputs-trace kunde bara rita spökspår ur en .ld-fil. Alltså: ingen MoTeC-fil = inget
spöke, vilket rapporterades som en bugg. Motorn spelar därför in varven själv, och då
finns samma två saker för alla tre källorna — delta OCH pedalkurva.

Inspelningen ligger i MOTORN och inte i overlayn av samma skäl som spökkanalerna i
CLAUDE.md §8.8d: overlayns x-axel är TID (rullande fönster) medan en referens måste
vara indexerad på POSITION. Motorn slår upp värdet för nuvarande position varje ram,
overlayn sparar det i samma sampel som sina egna värden, och då ligger spöket i linje
per konstruktion. Dessutom delas inspelningen av ALLA overlays och OBS-klienter i
stället för att göras om en gång per fönster.

Varvet lagras position-indexerat, inte tid-indexerat: det är positionen man frågar på.
"""
from __future__ import annotations
from typing import Optional
import numpy as np

from .frame import Frame
from .delta import lap_delta
# Varvgränsen och den auktoritativa varvtiden bor i state.py och delas med
# varvhistoriken. Reglerna fanns i två kopior, och det är precis den sortens regel
# som blir fel i den andra kopian (samma skäl som lap_delta ovan delas av båda
# referenssorterna). Importen går ÅT DETTA HÅLL: state.py känner inte till laps.py.
from .state import lap_transition, resolve_lap_ms, MIN_LAP_S, MAX_LAP_S, LAP_MS_TOLERANCE  # noqa: F401

# Minsta positionssteg mellan två sparade sampel: 1/2000 varv. Vid 40 Hz och en
# varvtid på 2 minuter kommer det ~4800 ramar per varv, och de flesta ligger så nära
# varandra att de inte bär någon information. Taket blir alltså ~2000 punkter per
# varv (≈64 kB per varv, två varv sparas) och uppslagningen förblir billig.
# Steget är i POSITION och inte i tid med flit: då blir punkterna tätast där bilen
# rör sig långsammast, alltså i kurvorna där kurvan har mest form.
POS_STEP = 1.0 / 2000.0

# Ett varv duger som referens bara om det täcker nästan hela banan. Mindre än så
# betyder att inspelningen startade mitt på varvet (motorn startades under körning,
# ACC tappade det delade minnet en stund) och en referens med hål i ger ett delta som
# ser rimligt ut men jämför mot fel ställe.
MIN_COVERAGE = 0.90
# Minsta antal punkter. Ett varv med under 200 sampel är inte ett varv.
MIN_SAMPLES = 200
# MIN_LAP_S / MAX_LAP_S / LAP_MS_TOLERANCE importeras från state.py (se toppen) och
# ligger kvar i den här modulens namnrymd — de har flyttat, inte försvunnit.


class LapCurve:
    """Ett färdigt varv: tid och pedaler indexerade på normaliserad position 0..1.

    Samma gränssnitt som delta.Reference i de tre delar som används per ram
    (`delta`, `channels_at`, `total_ms`), så __main__ kan behandla alla tre
    referenssorterna likadant.
    """

    def __init__(self, pos, t, chans: dict, lap_ms: int):
        self._pos = np.asarray(pos, dtype=float)
        self._t = np.asarray(t, dtype=float)
        self._chan = {k: np.asarray(v, dtype=float) for k, v in chans.items()}
        self.lap_ms = int(lap_ms)

    def __len__(self):
        return int(self._pos.size)

    def t_at(self, norm_pos: float) -> float:
        return float(np.interp(norm_pos % 1.0, self._pos, self._t))

    def total_ms(self) -> int:
        return self.lap_ms

    def delta(self, norm_pos: float, cur_lap_ms: Optional[int]) -> Optional[float]:
        return lap_delta(self._pos, self._t, self.lap_ms, norm_pos, cur_lap_ms)

    def channels_at(self, norm_pos: float) -> dict:
        if not self._chan:
            return {}
        p = norm_pos % 1.0
        return {k: float(np.interp(p, self._pos, v)) for k, v in self._chan.items()}


class LapRecorder:
    """Matas med varje ram och håller `last` + `best` som färdiga LapCurve.

    Reglerna för vad som INTE blir ett varv är hela poängen — en dålig referens är
    värre än ingen, eftersom siffran ser lika trovärdig ut:
      • depån berörd (ut-varv eller in-varv) → varvet är inte jämförbart
      • täcker inte nästan hela banan → inspelningen började mitt på varvet
      • orimlig varvtid → ACC:s sentinelvärden eller en paus i delade minnet
    """

    def __init__(self):
        self.last: Optional[LapCurve] = None
        self.best: Optional[LapCurve] = None
        self._track: Optional[str] = None
        self._laps: Optional[int] = None
        self._reset_buffer()

    def _reset_buffer(self) -> None:
        self._pos: list = []
        self._t: list = []
        self._th: list = []
        self._br: list = []
        self._valid = True
        self._prev_pos = -1.0

    def reset(self) -> None:
        """Ny session eller ny bana: allt inspelat är oanvändbart."""
        self.last = None
        self.best = None
        self._laps = None
        self._reset_buffer()

    def update(self, f: Frame) -> None:
        if not f.connected:
            return
        # Banbyte. Ett varv från Spa som referens på Monza är exakt det fel som
        # matches_track skyddar MoTeC-filen mot (§8.8b) — samma sak gäller här, med
        # skillnaden att vi kan slänga inspelningen i stället för att jämföra namn.
        if f.trackId:
            if self._track is not None and f.trackId != self._track:
                self.reset()
            self._track = f.trackId

        laps = int(f.completedLaps or 0)
        tr = lap_transition(self._laps, laps)
        if tr == "reset":
            # Varvräknaren gick BAKÅT: ny session, omstart, eller tillbaka till boxen
            # i en ny session. Sessionens bästa är då inte längre sessionens bästa.
            self.reset()
        elif tr == "completed":
            self._finish(f)             # mållinjen passerad: bufferten är ett varv
            self._reset_buffer()
        self._laps = laps

        # Depåkontakt förbrukar varvet som referens. Samma regel som ut-varvet i
        # acc.py: har depån berörts under varvet som körs NU är det inte jämförbart.
        if f.outLap or f.inPitLane:
            self._valid = False

        if f.curLapMs is None:
            return
        p = float(f.position or 0.0)
        if not (0.0 <= p <= 1.0):
            return
        # Positionen hoppade bakåt utan att varvräknaren tickade. Det är inte ett
        # varvslut (det hanteras ovan) utan ett hopp — sessionsbyte, teleport till
        # boxen, ett omstartat delat minne. Bufferten är inte längre ett varv.
        if self._pos and p + 0.5 < self._prev_pos:
            self._reset_buffer()
        if self._pos and (p - self._prev_pos) < POS_STEP:
            return                      # för nära förra samplet, bär ingen information
        self._prev_pos = p
        self._pos.append(p)
        self._t.append(f.curLapMs / 1000.0)
        self._th.append(_c01(f.throttle))
        self._br.append(_c01(f.brake))

    def _finish(self, f: Frame) -> None:
        """Mållinjen passerad: gör bufferten till ett varv om det duger som referens."""
        if not self._valid or len(self._pos) < MIN_SAMPLES:
            return
        pos = np.asarray(self._pos, dtype=float)
        t = np.asarray(self._t, dtype=float)
        if float(pos[-1] - pos[0]) < MIN_COVERAGE:
            return

        # Auktoritativ varvtid: ACC:s `last_time` när den ser ut att gälla DET varv
        # vi just spelade in, annars vår egen mätning. Regeln delas med
        # varvhistoriken (state.resolve_lap_ms) — den var en av två kopior.
        lap_ms = resolve_lap_ms(int(round(float(t[-1] - t[0]) * 1000)), f.lastLapMs)
        if lap_ms is None:
            return

        # Monotont och unikt i position, precis som Reference.load gör med .ld-datan:
        # np.interp kräver stigande x, och två sampel på samma position ger en
        # lodrät kant i kurvan.
        order = np.argsort(pos)
        pos, t = pos[order], t[order]
        keep = np.concatenate(([True], np.diff(pos) > 1e-9))
        chans = {
            "throttle": np.clip(np.asarray(self._th, dtype=float)[order][keep], 0.0, 1.0),
            "brake": np.clip(np.asarray(self._br, dtype=float)[order][keep], 0.0, 1.0),
        }
        curve = LapCurve(pos[keep], t[keep] - t[keep][0], chans, lap_ms)

        self.last = curve
        if self.best is None or curve.lap_ms < self.best.lap_ms:
            self.best = curve
        print(f"[laps] varv inspelat: {lap_ms/1000:.3f}s  ({len(curve)} punkter)"
              + ("  ← sessionens bästa" if self.best is curve else ""))


def _c01(v) -> float:
    try:
        v = float(v)
    except (TypeError, ValueError):
        return 0.0
    if not np.isfinite(v):
        return 0.0
    return 0.0 if v < 0.0 else 1.0 if v > 1.0 else v
