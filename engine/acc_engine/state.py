"""Motorns SESSIONSTILLSTÅND: vilken session vi kör, och vilka varv som körts.

Varför det finns: alla fält i `Frame` beskriver NUET. En varvtidslogg behöver
HISTORIK, och en lista går inte att skicka 40 gånger i sekunden. Det som byggs här
är alltså två saker som ingen befintlig overlay behövt — var historiken bor, och hur
den tar sig över bussen utan att kosta något.

Skilt från `laps.py` med flit, trots att båda handlar om varv:

  laps.py    spelar in KURVOR (position → tid/pedaler) som overlays jämför sin
             körning mot. Ett varv som inte duger som referens KASTAS där — depån
             berörd, täckningen för dålig, orimlig tid.
  state.py   bokför att varvet KÖRDES. Ett in-varv har en riktig varvtid och hör
             hemma i loggen, märkt som depåvarv. Historiken kan därför inte vara en
             biprodukt av laps.py:s inspelning; det var det som gjorde en egen
             bokföring nödvändig.

Modulen HÄRLEDER bara — den läser ingen källa själv och muterar inga ramar. Den
matas med färdiga ramar från __main__ och svarar på frågor om dem.

`lap_transition` och `resolve_lap_ms` bor här och importeras av `laps.py`. Regeln för
vad som är ett varvslut fanns i två kopior, och det är precis den sortens regel som
blir fel i den andra kopian (samma skäl som `delta.lap_delta()` delas av båda
referenssorterna, CLAUDE.md §8.8f).
"""
from __future__ import annotations
from typing import List, Optional

from .frame import Frame

# Rimlighetsintervall för en varvtid (s). Skyddar mot ACC:s sentinelvärden och mot
# att en paus i det delade minnet räknas som ett långsamt varv.
MIN_LAP_S, MAX_LAP_S = 20.0, 1200.0

# Hur mycket ACC:s egen varvtid får skilja sig från vår egen mätning innan vi
# misstror den. Vid mållinjen kan `last_time` ligga ett par ramar efter och alltså
# vara FÖRRA varvets tid.
LAP_MS_TOLERANCE = 2000

# Tak för historiken. Ett 24-timmarslopp är hundratals varv, och loggen visar sex.
# Det äldsta faller av; det nyaste är alltid kvar.
MAX_HISTORY = 200


def lap_transition(prev: Optional[int], cur: int) -> str:
    """Vad hände med varvräknaren? "none" | "completed" | "reset".

    "reset" betyder att räknaren gick BAKÅT: ny session, omstart, eller tillbaka
    till boxen i en ny session. Allt inspelat är då oanvändbart.
    """
    if prev is None:
        return "none"
    if cur < prev:
        return "reset"
    if cur > prev:
        return "completed"
    return "none"


def resolve_lap_ms(own_ms: Optional[int], reported_ms: Optional[int]) -> Optional[int]:
    """Auktoritativ varvtid, eller None när den inte är rimlig.

    ACC:s egen varvtid (`last_time`) vinner — men bara om den ser ut att gälla DET
    varv vi just mätte. Vid mållinjen kan den ligga ett par ramar efter och alltså
    vara förra varvets, vilket hade gjort ett medelvarv till "sessionens bästa" på
    fel grunder.
    """
    if own_ms is None and reported_ms is None:
        return None
    ms = own_ms
    if ms is None:
        ms = int(reported_ms)
    elif reported_ms and abs(int(reported_ms) - int(ms)) <= LAP_MS_TOLERANCE:
        ms = int(reported_ms)
    ms = int(ms)
    if not (MIN_LAP_S <= ms / 1000.0 <= MAX_LAP_S):
        return None
    return ms


class SessionState:
    """Sessionens identitet + varvhistoriken.

    Historiken skickas som ramens `laps` enligt samma kontrakt som `entries`
    (frame.py): vid ÄNDRING, plus en omsändning med jämna mellanrum så en klient som
    ansluter mitt i loppet också får den. `laps_dirty` säger när den ändrats.
    """

    def __init__(self) -> None:
        self._laps: List[dict] = []
        self._prev_completed: Optional[int] = None
        self._prev_cur_ms: Optional[int] = None
        self._track: Optional[str] = None
        # Depån berörd under det varv som körs NU. Bokförs löpande och läses av när
        # mållinjen passeras — vid gränsframen beskriver ramens egna `outLap` redan
        # det NYA varvet (acc.py sätter om den där), så den går inte att använda.
        self._pit_touched = False
        # "acc" eller "mock". Ett varv från mock-källan får aldrig stå i samma lista
        # som ett riktigt: tiderna ser likadana ut och listan blir omöjlig att lita
        # på. Samma familj som regeln att mock aldrig får bli en referens (§8.6e),
        # men lösningen är en annan — här räcker det att TÖMMA vid byte.
        self._src: Optional[str] = None
        self.laps_dirty = False

    # ── Läsning ────────────────────────────────────────────────────────────────
    def history(self) -> List[dict]:
        """Varvhistoriken som den ser ut i ramens `laps`: [{n, ms, pit}, …].

        KOPIA av listan. Ramen serialiseras direkt efter det här anropet, men
        `Frame.to_dict()` är en platt kopia — delade vi listan hade en senare
        inspelning kunnat ändra ett objekt någon annan redan tittar på. Samma
        lärdom som den delade ramcachen i acc.py (§8.6e).

        Vad som INTE ligger här: bästa varvet och deltat mellan raderna. Båda
        räknas ut ur listan, och de hör till overlayn — reglaget "jämför mot"
        väljer mellan sessionens bästa och föregående varv, och motorn ska inte
        behöva veta något om panelens inställningar (§2, §8.8f).
        """
        return list(self._laps)

    # ── Skrivning ──────────────────────────────────────────────────────────────
    def mark_laps_sent(self) -> None:
        self.laps_dirty = False

    def reset(self) -> None:
        """Ny session, ny bana eller omstart: allt bokfört är oanvändbart."""
        self._clear_history()
        self._prev_completed = None
        self._prev_cur_ms = None
        self._pit_touched = False
        self._src = None

    def _clear_history(self) -> None:
        # Tomt är inte samma sak som oförändrat: en TOM lista måste nå fram till
        # overlays, annars ligger förra sessionens varv kvar på skärmen. Se
        # kontraktet för `laps` i frame.py — None = oförändrad, [] = tömd.
        # Var listan redan tom har ingenting ändrats, och då ska ingen sändning
        # utlösas: `reset()` körs vid varje banbyte och skulle annars smutsa ner
        # flaggan på varenda ny session.
        if self._laps:
            self._laps = []
            self.laps_dirty = True

    def update(self, f: Frame) -> None:
        """Mata in en ram. Körs på VARJE ram, även mock.

        Till skillnad från `laps.update()`, som bara får riktiga ACC-ramar: regeln
        "mock får aldrig hamna i en referens" gäller KURVOR som äkta körning jämförs
        mot. En logg full av mock-tider medan mock-läget är på är ärlig — och det är
        enda sättet overlayn går att designa och demonstrera utan spelet.
        """
        # Banbyte. Ett varv från Spa hör inte hemma i en Monza-logg.
        track = f.trackId or ""
        if track:
            if self._track is not None and track != self._track:
                self.reset()
            self._track = track

        laps = int(f.completedLaps or 0)
        tr = lap_transition(self._prev_completed, laps)
        if tr == "reset":
            self.reset()
        elif tr == "completed":
            self._record(f)
        self._prev_completed = laps

        # Bokföringen nedan gäller det varv som körs NU — alltså efter en eventuell
        # mållinjepassage ovan.
        if f.outLap or f.inPitLane:
            self._pit_touched = True
        self._prev_cur_ms = f.curLapMs

    def _record(self, f: Frame) -> None:
        """Mållinjen passerad: bokför varvet som just avslutades."""
        pit = self._pit_touched
        own_ms = self._prev_cur_ms
        self._pit_touched = False

        ms = resolve_lap_ms(own_ms, f.lastLapMs)
        if ms is None:
            return

        # Källbyte (mock ↔ ACC) töms FÖRE inskrivningen, så listan aldrig innehåller
        # båda sorterna. Att bara nollställa vid varje connected-ändring hade varit
        # för trubbigt: ACC:s delade minne kan tappas några sekunder mitt i en
        # session, och då ska loggen inte försvinna.
        src = "acc" if f.connected else "mock"
        if self._src is not None and src != self._src:
            self._clear_history()
        self._src = src

        n = int(f.completedLaps or 0)
        self._laps.append({"n": n, "ms": ms, "pit": bool(pit)})
        if len(self._laps) > MAX_HISTORY:
            del self._laps[: len(self._laps) - MAX_HISTORY]
        self.laps_dirty = True
