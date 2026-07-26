"""Telemetriramens schema — en gemensam dict alla overlays läser."""
from __future__ import annotations
from dataclasses import dataclass, asdict
from typing import Optional


@dataclass
class Frame:
    connected: bool = False          # ACC igång? annars mock
    throttle: float = 0.0            # 0..1
    brake: float = 0.0
    clutch: float = 0.0
    abs: bool = False
    tc: bool = False
    gear: int = 0
    speedKph: float = 0.0
    rpm: int = 0
    steer: float = 0.0               # -1..1
    delta: Optional[float] = None    # sekunder mot referens (None = ingen referens)
    sessionBestMs: Optional[int] = None
    lastLapMs: Optional[int] = None
    curLapMs: Optional[int] = None   # internt: aktuell varvtid för delta
    driverName: str = ""
    position: float = 0.0            # normalizedCarPosition 0..1

    def to_dict(self) -> dict:
        return asdict(self)
