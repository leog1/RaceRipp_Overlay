"""Telemetriramens schema — en gemensam dict alla overlays läser."""
from __future__ import annotations
from dataclasses import dataclass
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
    # Varvtiden i den VALDA MoTeC-filen, satt så fort en fil är laddad — oberoende av
    # om den GÄLLER just nu (rätt bana, inte ut-varv). Skild från `refs["motec"]`
    # med flit: den nyckeln säger "den här referensen går att jämföra mot i det här
    # varvet", medan det här bara säger "så här snabb är filen du valt". Delta-baren
    # visar den i en egen spalt, och spalten ska inte försvinna för att man råkar
    # rulla ut ur depån. None = ingen fil vald.
    motecMs: Optional[int] = None
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

    # ── ALLA referenskällor samtidigt, en per nyckel ────────────────────────────
    # {"last"|"best"|"motec": {"delta": s|None, "totalMs": int|None,
    #                          "throttle": 0..1|None, "brake": 0..1|None,
    #                          "src": "motec"|"lap"|"acc"}}
    #
    # Varför alla på en gång i stället för att motorn väljer: VALET hör till
    # overlayn. Reglaget "Delta source" är per overlay (registry.json), så delta-baren
    # kan visa session-bästa medan inputs-trace ritar spöket mot förra varvet — och
    # motorn behöver inte veta något om panelens inställningar. Kostnaden är några
    # tal per ram.
    # En källa som inte GÄLLER just nu saknas helt i kartan (ingen fil laddad, inget
    # varv inspelat, ut-varv, mållinjens spikskydd) — nyckeln finns alltså bara när
    # det finns något att visa, och en overlay som inte hittar sin källa visar
    # ingenting, precis som när deltat är null.
    # `refs` är None när ingen källa alls gäller. Fälten `delta`/`deltaSource`/
    # `refThrottle`/`refBrake` ovan står kvar oförändrade för bakåtkompatibilitet
    # (OBS-källor och äldre overlays läser dem).
    refs: Optional[dict] = None

    # ── Varvhistorik (varvtidsloggen) ───────────────────────────────────────────
    # [{"n": varvnummer, "ms": varvtid, "pit": depån berörd}, …] — äldst först.
    #
    # KONTRAKTET ÄR SAMMA SOM `entries`, MED EN SKILLNAD SOM ÄR LÄTT ATT MISSA:
    #   None  = OFÖRÄNDRAD. Listan skickas bara när den ändrats, plus en omsändning
    #           med jämna mellanrum (LAPS_RESEND_S i __main__) så en OBS-flik som
    #           öppnas mitt i loppet också får historiken. En konsument måste latcha
    #           senaste värdet, precis som HOLD_MS-mönstret i §8.5.
    #   []    = TÖMD. Ny session, ny bana, eller byte mellan mock och riktig körning.
    #           Behandlas den som "oförändrad" ligger FÖRRA sessionens varv kvar på
    #           skärmen — ett fel som inte syns förrän någon kör två sessioner i rad.
    #
    # Vad som INTE ligger här: bästa varvet och deltat mellan raderna. Båda räknas ut
    # ur listan, och de hör till overlayn — reglaget "jämför mot" väljer mellan
    # sessionens bästa och föregående varv, och motorn ska inte behöva veta något om
    # panelens inställningar (samma regel som `refs` ovan).
    #
    # Historiken byggs av `state.SessionState` och inte av `laps.LapRecorder`: den
    # senare KASTAR varv som inte duger som referenskurva (depå berörd, för dålig
    # täckning), medan ett in-varv har en riktig varvtid och hör hemma i loggen.
    laps: Optional[list] = None

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
        """Ramen som en dict för json.dumps.

        `dict(vars(self))` och inte `dataclasses.asdict()`: asdict går igenom
        strukturen REKURSIVT och deep-copierar allt den hittar, alltså hela
        `cars`-listan (20 dictar) och `entries` vid varje ram, 40 gånger i sekunden.
        Motorn är en egen process men delar CPU med spelet, så det arbetet syns i
        FPS. Ramens fält är alla enkla typer eller dictar/listor vi själva just byggt
        och inte muterar efter det här anropet, så en platt kopia räcker.
        """
        return dict(vars(self))

# KONTRAKT för `entries`: den är statisk och skickas bara när den ÄNDRATS, plus var
# 5:e sekund så en sent ansluten klient (OBS-flik som öppnas mitt i loppet) får den.
# `None` betyder alltså OFÖRÄNDRAD, inte BORTA — konsumenten måste latcha senaste
# värdet, precis som HOLD_MS-mönstret i CLAUDE.md §8.5. `cars` skickas varje ram
# (~1,4 kB för 20 bilar, oproblematiskt på loopback).

