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
    refTotalMs: Optional[int] = None # referensvarvets totaltid (om MoTeC laddad)
    driverName: str = ""
    position: float = 0.0            # normalizedCarPosition 0..1
    trackId: str = ""                # ACC:s bannamn — MoTeC-referensen måste matcha
    outLap: bool = False             # varvet startade i depån → referensdelta ogiltigt
    inPitLane: bool = False
    completedLaps: int = 0
    # Vilken referens deltat faktiskt kommer från. None = inget delta att visa.
    deltaSource: Optional[str] = None   # "motec" | "acc" | None
    # Referensvarvets pedaler vid NUVARANDE position (0..1) — spökspåren i
    # inputs-trace. Satta bara när deltaSource == "motec", alltså när referensen
    # verkligen gäller; annars None så spöket försvinner rent.
    refThrottle: Optional[float] = None
    refBrake: Optional[float] = None

    # ── Broadcasting (andra bilar). Alla None när Broadcasting är av, så inga
    # befintliga overlays påverkas — de läser bara de fält de deklarerat.
    cars: Optional[list] = None      # per bil: {i, spline, pos, laps, loc, kmh, …}
    entries: Optional[dict] = None   # carIndex → {num, name, team, cls}. SE NEDAN.
    sessionPhase: Optional[str] = None
    focusedCarIndex: Optional[int] = None
    trackName: Optional[str] = None
    trackMeters: Optional[int] = None
    broadcast: Optional[str] = None      # off | connecting | live | error
    broadcastError: Optional[str] = None

    def to_dict(self) -> dict:
        return asdict(self)

# KONTRAKT för `entries`: den är statisk och skickas bara när den ÄNDRATS, plus var
# 5:e sekund så en sent ansluten klient (OBS-flik som öppnas mitt i loppet) får den.
# `None` betyder alltså OFÖRÄNDRAD, inte BORTA — konsumenten måste latcha senaste
# värdet, precis som HOLD_MS-mönstret i CLAUDE.md §8.5. `cars` skickas varje ram
# (~1,4 kB för 20 bilar, oproblematiskt på loopback).

