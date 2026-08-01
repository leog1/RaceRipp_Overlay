"""ACC-källa via pyaccsharedmemory. Fältnamn verifierade mot paketets doc (v1.0.0).
Om biblioteket saknas eller ACC ej är live → connected=False (motorn kör då mock)."""
from __future__ import annotations
import time
from dataclasses import replace
from typing import Optional
from .base import Source
from ..frame import Frame

# Hur länge senaste giltiga ram får återanvändas när delade minnet inte har något
# NYTT att ge. Vid 40 Hz är det 80 ramar — långt mer än de enstaka som normalt
# hoppas över, men kort nog att en riktig frånkoppling (alt-F4) märks snabbt.
STALE_S = 2.0

# Hur ofta STATIC-blocket läses om. Det är per definition statiskt (bana, bil,
# förarnamn, sm-version) och ändras bara vid sessionsbyte — men biblioteket läser om
# det vid varje anrop. En sekunds fördröjning på ett banbyte märks ingenstans.
STATIC_S = 1.0

try:
    from pyaccsharedmemory import accSharedMemory  # type: ignore
    _AVAILABLE = True
except Exception:
    _AVAILABLE = False

# ── Snabbvägen förbi accSharedMemory.read_shared_memory() ────────────────────
# Biblioteket gör tre saker per anrop som vi inte har råd med 40 ggr/s i en process
# som delar CPU med simulatorn. Mätt på den här maskinen, µs per anrop:
#
#   read_physic_map      69,8      behövs
#   read_graphics_map   108,7      behövs
#   read_static_map      22,1      statiskt block — läses nu var STATIC_S
#   copy.deepcopy        206,7     ren förlust, se nedan
#
# Deepcopyn finns bara för att NÄSTA anrop ska kunna jämföra `suspension_travel`
# (`PhysicsMap.is_equal`) — en jämförelse som kostar 0,2 µs. Att spara hela
# physics-strukturen för det är 200 µs för fyra flyttal. Vi behåller alltså bara
# fjädringsvärdet, och dedupen blir exakt densamma.
#
# Detta rör bibliotekets INRE (modulnivåfunktionerna och `physicSM`-handtagen), så
# det är versionskänsligt. Går de inte att importera faller källan tillbaka på
# `read_shared_memory()` och beter sig precis som förut — långsammare, men rätt.
try:
    from pyaccsharedmemory import (  # type: ignore
        read_physic_map, read_graphics_map, read_static_map,
    )
    _FAST_READ = _AVAILABLE
except Exception:
    _FAST_READ = False


class AccSource(Source):
    name = "acc"
    available = _AVAILABLE

    def __init__(self):
        self._sm = accSharedMemory() if _AVAILABLE else None
        self._last: Optional[Frame] = None
        self._last_t = 0.0
        # Sessionen börjar i depån, så första varvet är alltid ett ut-varv.
        self._out_lap = True
        self._laps: Optional[int] = None
        # Snabbvägens tillstånd (se _FAST_READ ovan).
        self._fast = bool(_FAST_READ and self._sm is not None
                          and hasattr(self._sm, "physicSM"))
        self._prev_susp = None
        self._static = None
        self._static_t = 0.0

    def _read_maps(self):
        """(physics, graphics, static) — eller None när inget NYTT finns att läsa.

        Samma kontrakt som `accSharedMemory.read_shared_memory()`: `None` betyder
        "ingen ny data", inte "ACC är borta" (§8.6e). Dedupen är också densamma —
        biblioteket jämför `suspension_travel` via `PhysicsMap.is_equal`, och det är
        exakt vad som jämförs här; skillnaden är bara att vi sparar fjädringsvärdet
        i stället för en deep-kopia av hela strukturen.
        """
        if not self._fast:
            sm = self._sm.read_shared_memory()
            return None if sm is None else (sm.Physics, sm.Graphics, sm.Static)

        p = read_physic_map(self._sm.physicSM)
        # packed_id 0 = ACC skriver inte. Biblioteket har samma kontroll (dess
        # `last_physicsID` sätts till 0 och uppdateras aldrig).
        if getattr(p, "packed_id", 0) == 0:
            return None
        susp = p.suspension_travel
        if susp == self._prev_susp:
            return None
        self._prev_susp = susp

        g = read_graphics_map(self._sm.graphicSM)
        now = time.monotonic()
        if self._static is None or (now - self._static_t) >= STATIC_S:
            self._static = read_static_map(self._sm.staticSM)
            self._static_t = now
        return p, g, self._static

    def read(self) -> Frame:
        if not self._sm:
            return Frame(connected=False)
        maps = self._read_maps()
        if maps is None:
            # `None` betyder "INGEN NY DATA", inte "ACC är borta": pyaccsharedmemory
            # returnerar None så fort fysikpaketets id inte hunnit ändras sedan förra
            # läsningen, och vi pollar snabbare än ACC alltid hinner skriva.
            #
            # Att returnera Frame(connected=False) här var en riktig bugg i drift:
            # __main__ föll då tillbaka på MOCK-data för just det framet. Följden var
            # två symptom som såg helt olika ut men var samma sak — overlays BLINKADE
            # (synk-grinden "endast när ACC kör" dolde dem ett frame) och traces fick
            # HACK av främmande mock-värden mitt i riktig telemetri.
            #
            # Håll senaste giltiga ram i stället. Först när det varit tyst i STALE_S
            # är ACC faktiskt borta.
            if self._last is not None and (time.monotonic() - self._last_t) < STALE_S:
                return replace(self._last)
            return Frame(connected=False)
        p, g, s = maps

        # ACC_STATUS: ACC_LIVE == 2 (status kan vara enum eller int)
        st = getattr(g, "status", None)
        st_val = getattr(st, "value", st)
        connected = (st_val == 2)

        best = _ms(getattr(g, "best_time", None))
        # ACC:s egen delta mot session-bästa — bara giltig när ett bästa varv finns
        delta = _delta(getattr(g, "delta_lap_time", None),
                       getattr(g, "is_delta_positive", None)) if best is not None else None

        throttle = float(getattr(p, "gas", 0.0))
        speed = float(getattr(p, "speed_kmh", 0.0))
        # ACC:s clutch-fält = kopplingens ingrepp (1 = ilagd, 0 = urkopplad). Stapeln
        # visar pedalvägen = 1 - ingrepp. Troget verkliga kopplingen i alla lägen
        # (vid stillastående ~95% eftersom kopplingen då faktiskt är urkopplad).
        clutch = 1.0 - float(getattr(p, "clutch", 1.0))

        # Ut-varv: varvet som körs NU startade från depån (eller från sessionsstart).
        # Ett referensdelta mot ett flygande varv är meningslöst då — man startade
        # inte på mållinjen. Det var exakt vad användaren såg direkt ut ur depån.
        # Regeln är "har depån berörts under det varv som körs NU" — inte under det
        # förra. Vid mållinjen avgör alltså om vi är i depåfilen just då: på de flesta
        # banor ligger depåutfarten EFTER linjen, så varvräknaren tickar medan man
        # fortfarande rullar i depån, och varvet som börjar är ett ut-varv. Kommer man
        # ut före linjen är nästa varv ett riktigt flygande varv.
        laps = int(getattr(g, "completed_lap", 0) or 0)
        in_pit = bool(getattr(g, "is_in_pit_lane", False)) or bool(getattr(g, "is_in_pit", False))
        if self._laps is None:
            self._laps = laps
        elif laps != self._laps:                 # mållinjen passerad
            self._laps = laps
            self._out_lap = in_pit
        if in_pit:
            self._out_lap = True                 # depån berörd → varvet är förbrukat
        out_lap = self._out_lap or laps < 1

        frame = Frame(
            connected=connected,
            throttle=throttle,
            brake=float(getattr(p, "brake", 0.0)),
            clutch=clutch,
            abs=float(getattr(p, "abs", 0.0)) > 0.0,
            tc=float(getattr(p, "tc", 0.0)) > 0.0,
            gear=int(getattr(p, "gear", 1)) - 1,          # ACC: 0=R, 1=N, 2=1a → -1
            speedKph=speed,
            rpm=int(getattr(p, "rpm", 0)),
            maxRpm=int(getattr(s, "max_rpm", 0) or 0),
            steer=float(getattr(p, "steer_angle", 0.0)),
            sessionBestMs=best,
            lastLapMs=_ms(getattr(g, "last_time", None)),
            curLapMs=_ms(getattr(g, "current_time", None)),
            driverName=_name(getattr(s, "player_name", "")),
            position=float(getattr(g, "normalized_car_position", 0.0)),
            delta=delta,  # ACC:s eget delta mot session-bästa (kan bytas mot MoTeC)
            trackId=_name(getattr(s, "track", "")),
            outLap=out_lap,
            inPitLane=in_pit,
            completedLaps=laps,
        )
        if frame.connected:
            # KOPIA, inte samma objekt. __main__ muterar ramen efter read()
            # (apply_reference skriver om delta/refTotalMs/deltaSource), och delade de
            # objekt skrevs de ändringarna rakt in i cachen — nästa hållna ram kom då
            # tillbaka med ett MoTeC-delta märkt som ACC:s. Cachen ska vara orörd av
            # vad anroparen gör, och den utlämnade ramen orörd av cachen.
            self._last = replace(frame)
            self._last_t = time.monotonic()
        return frame

    def close(self):
        if self._sm:
            try: self._sm.close()
            except Exception: pass


def _delta(raw, is_pos):
    """ACC delta_lap_time (ms). Magnitud + tecken (is_delta_positive: True=långsammare)."""
    if raw is None:
        return None
    try:
        mag = abs(int(raw)) / 1000.0
        if mag > 300:            # sentinel/orimligt → ingen giltig delta
            return None
        return mag if is_pos else -mag
    except Exception:
        return None


def _name(v):
    """ACC null-fyller strängar — klipp vid första nullbyte."""
    try:
        return str(v).split("\x00")[0].strip()
    except Exception:
        return ""


def _ms(v):
    """ACC använder stora sentinelvärden (≈2^31-1) när tiden är ogiltig."""
    if v is None:
        return None
    try:
        v = int(v)
        return v if 0 < v < 2_147_483_647 else None
    except Exception:
        return None
