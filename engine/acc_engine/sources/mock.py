"""Mock-källa: trovärdig rullande input + sinus-delta. Låter hela stacken
demonstreras utan spelet (och ger OBS/utveckling något att visa)."""
from __future__ import annotations
import math, time
from .base import Source
from ..frame import Frame

LOOP = 13.0
TC_WIN = [(6.0, 6.9), (10.3, 11.15)]
ABS_TH, TC_TH = 0.80, 0.60

def _ease(kind, a):
    if kind == "fast":  return (1 - 2 ** (-10 * a)) / (1 - 2 ** -10)
    if kind == "rise":  return (1 - math.exp(-3.5 * a)) / (1 - math.exp(-3.5))
    if kind == "trail": return 1 - (1 - a) ** 1.6
    return a

THROTTLE = [
    (0.00,2.60,1.00,1.00,"lin"),(2.60,2.70,1.00,0.00,"fast"),(2.70,5.55,0.00,0.00,"lin"),
    (5.55,5.80,0.00,0.18,"rise"),(5.80,6.00,0.18,0.18,"lin"),(6.00,6.22,0.18,0.85,"rise"),
    (6.22,6.55,0.85,1.00,"rise"),(6.55,8.70,1.00,1.00,"lin"),(8.70,8.80,1.00,0.00,"fast"),
    (8.80,10.30,0.00,0.00,"lin"),(10.30,10.52,0.00,0.70,"rise"),(10.52,10.95,0.70,1.00,"rise"),
    (10.95,13.00,1.00,1.00,"lin"),
]
BRAKE = [
    (0.00,2.62,0.00,0.00,"lin"),(2.62,2.74,0.00,1.00,"fast"),(2.74,4.90,1.00,0.25,"trail"),
    (4.90,5.00,0.25,0.00,"fast"),(5.00,8.72,0.00,0.00,"lin"),(8.72,8.84,0.00,0.62,"fast"),
    (8.84,9.85,0.62,0.20,"trail"),(9.85,9.95,0.20,0.00,"fast"),(9.95,13.00,0.00,0.00,"lin"),
]

def _seg_at(lst, t):
    t = t % LOOP
    for t0, t1, v0, v1, e in lst:
        if t0 <= t < t1:
            return v0 + (v1 - v0) * _ease(e, (t - t0) / (t1 - t0))
    return lst[-1][3]

def _clamp01(v): return 0.0 if v < 0 else 1.0 if v > 1 else v


class MockSource(Source):
    name = "mock"
    def __init__(self):
        self._t0 = time.perf_counter()

    def read(self) -> Frame:
        now = time.perf_counter() - self._t0
        lt = now % LOOP
        throttle = _seg_at(THROTTLE, now); brake = _seg_at(BRAKE, now)
        base_th, base_br = throttle, brake
        jit = 0.010 * (math.sin(now*47) + 0.7*math.sin(now*83) + 0.5*math.sin(now*127)) / 2.2
        throttle = _clamp01(throttle + jit * _clamp01(base_th*6))
        brake    = _clamp01(brake + jit*0.8 * _clamp01(base_br*6))
        clutch = _clamp01(0.72*math.exp(-((lt-2.95)/0.09)**2) + 0.66*math.exp(-((lt-3.35)/0.09)**2)
                        + 0.55*math.exp(-((lt-3.75)/0.09)**2) + 0.55*math.exp(-((lt-8.95)/0.09)**2)
                        + 0.50*math.exp(-((lt-9.30)/0.09)**2))
        abs_ = base_br > ABS_TH
        if abs_: brake = _clamp01(brake - 0.030*(int(now*16) % 2))
        tc = any(a <= lt <= b for a, b in TC_WIN) and base_th > TC_TH
        if tc: throttle = _clamp01(throttle - 0.040*(int(now*13) % 2))
        # mjuk sinus-delta (samma karaktär som overlay-previewn)
        delta = max(-1.1, min(1.1, 0.62*math.sin(now*0.21) + 0.30*math.sin(now*0.53+1.1) + 0.16*math.sin(now*1.03+0.4)))
        gear = 1 + int(throttle*5)
        # Spökspår: samma kurva som du kör, fasförskjuten ett par tiondelar. Ger ett
        # trovärdigt "referensvarv" så att funktionen går att SE i panelens preview
        # och i OBS utan att ACC körs — precis samma skäl som mocken finns för alls.
        ref_th = _clamp01(_seg_at(THROTTLE, now - 0.35))
        ref_br = _clamp01(_seg_at(BRAKE, now - 0.35))
        # ALLA tre referenskällorna, av samma skäl som spökspåret ovan: reglaget
        # "Delta source" ska gå att prova i panelens preview och i OBS utan att ACC
        # kör. Faserna och deltana skiljer sig lite mellan källorna så att man ser
        # ATT valet gör något — annars ser tre likadana kurvor ut som en bugg.
        refs = {
            "last": _ref_entry(now, 0.55, delta + 0.18, 138322, "lap"),
            "best": _ref_entry(now, 0.35, delta, 138120, "lap"),
            "motec": _ref_entry(now, 0.20, delta - 0.22, 136250, "motec"),
        }
        return Frame(connected=False, throttle=throttle, brake=brake, clutch=clutch, abs=abs_, tc=tc,
                     gear=gear, speedKph=80+throttle*180, rpm=int(3000+throttle*4500), steer=0.35*math.sin(now*0.6),
                     delta=delta, sessionBestMs=138120, lastLapMs=138322, driverName="John Smith",
                     position=(now % LOOP)/LOOP,
                     deltaSource="motec", refThrottle=ref_th, refBrake=ref_br, refs=refs)


def _ref_entry(now: float, shift: float, delta: float, total_ms: int, src: str) -> dict:
    """En post i ramens `refs` (se frame.py) byggd ur mockens egen kurva."""
    return {"delta": max(-1.5, min(1.5, delta)), "totalMs": total_ms, "src": src,
            "throttle": _clamp01(_seg_at(THROTTLE, now - shift)),
            "brake": _clamp01(_seg_at(BRAKE, now - shift))}
