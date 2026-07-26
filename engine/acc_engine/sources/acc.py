"""ACC-källa via pyaccsharedmemory. Fältnamn verifierade mot paketets doc (v1.0.0).
Om biblioteket saknas eller ACC ej är live → connected=False (motorn kör då mock)."""
from __future__ import annotations
from .base import Source
from ..frame import Frame

try:
    from pyaccsharedmemory import accSharedMemory  # type: ignore
    _AVAILABLE = True
except Exception:
    _AVAILABLE = False


class AccSource(Source):
    name = "acc"
    available = _AVAILABLE

    def __init__(self):
        self._sm = accSharedMemory() if _AVAILABLE else None

    def read(self) -> Frame:
        if not self._sm:
            return Frame(connected=False)
        sm = self._sm.read_shared_memory()
        if sm is None:
            return Frame(connected=False)
        p, g, s = sm.Physics, sm.Graphics, sm.Static

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

        return Frame(
            connected=connected,
            throttle=throttle,
            brake=float(getattr(p, "brake", 0.0)),
            clutch=clutch,
            abs=float(getattr(p, "abs", 0.0)) > 0.0,
            tc=float(getattr(p, "tc", 0.0)) > 0.0,
            gear=int(getattr(p, "gear", 1)) - 1,          # ACC: 0=R, 1=N, 2=1a → -1
            speedKph=speed,
            rpm=int(getattr(p, "rpm", 0)),
            steer=float(getattr(p, "steer_angle", 0.0)),
            sessionBestMs=best,
            lastLapMs=_ms(getattr(g, "last_time", None)),
            curLapMs=_ms(getattr(g, "current_time", None)),
            driverName=_name(getattr(s, "player_name", "")),
            position=float(getattr(g, "normalized_car_position", 0.0)),
            delta=delta,  # ACC-delta; skrivs över av MoTeC-referens om laddad
        )

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
