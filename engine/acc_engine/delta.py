"""MoTeC-referens + live-delta.

Flöde:
  1. Läs .ld (kanaler via ldparser: ld.channs, varje kanal har .name/.freq/.data).
  2. Läs sido-.ldx (XML) för varvgränser → välj SNABBASTE hela varvet (ACC sparar
     hela sessioner; utan detta jämför vi mot fel data).
  3. Resampla det varvet till ett jämnt distansrutnät (distans → tid) EN gång.
  4. Live:  delta = din_varvtid − t_ref(din_position),  alltid jämfört i DISTANS.

Position från ACC är normalizedCarPosition (0..1); vi normaliserar referensens
distans till 0..1 så de matchar.
"""
from __future__ import annotations
from typing import Optional
import os
import xml.etree.ElementTree as ET
import numpy as np


class Reference:
    def __init__(self):
        self._pos = None          # normaliserad distans 0..1 (stigande)
        self._t = None            # tid (s) från varvstart
        self.loaded = False
        self.path = ""
        self.lap_ms = None        # referensvarvets totaltid (ms)
        self.venue = ""           # banan filen spelades in på (ur .ld-huvudet)
        self._chan = {}           # spökkanaler: namn → värden på _pos-rutnätet (0..1)

    def _clear(self):
        """Nollar allt referensläge. Utan detta låg gamla varvets distans/tid-kurva
        kvar i minnet efter ett misslyckat load()."""
        self._pos = None
        self._t = None
        self.loaded = False
        self.path = ""
        self.lap_ms = None
        self.venue = ""
        self._chan = {}

    def unload(self) -> None:
        """Släpp referensen (användaren tog bort den i panelen). Publik motsvarighet
        till _clear() så anroparen inte behöver peta i privata delar."""
        self._clear()

    def load(self, path: str) -> bool:
        self._clear()
        try:
            from ldparser import ldData
            ld = ldData.fromfile(path)
            # Banan står i .ld-huvudet ("Spa"). Utan den kan en referens från en annan
            # bana användas rakt av och ge ett delta som ser rimligt ut men är rent
            # nonsens — det hände i drift.
            try:
                self.venue = str(getattr(ld.head, "venue", "") or "").strip()
            except Exception:
                self.venue = ""
            chans = {c.name.lower(): c for c in ld.channs}   # ld.channs = lista av kanaler

            def find(*keys):
                # Exakt namn FÖRST, delsträng sedan: ACC-exporten har både SPEED och
                # WHEEL_SPEED_LF, och en ren delsträngssökning tog den som råkade ligga
                # först i filen.
                for k, c in chans.items():
                    if k in keys:
                        return c
                for k, c in chans.items():
                    if any(key in k for key in keys):
                        return c
                return None

            dist_ch = find("distance", "dist")
            speed_ch = find("ground speed", "speed", "gspeed")

            if dist_ch is not None:
                data = np.asarray(dist_ch.data, dtype=float); freq = float(dist_ch.freq or 0); is_dist = True
            elif speed_ch is not None:
                data = np.asarray(speed_ch.data, dtype=float); freq = float(speed_ch.freq or 0); is_dist = False
            else:
                print("[delta] hittade varken distans- eller hastighetskanal. Kanaler:",
                      list(chans.keys())[:25])
                return False
            if freq <= 0 or len(data) < 10:
                return False

            # snabbaste hela varvet ur .ldx (annars hela filen)
            start, end = _fastest_lap(path, freq, len(data))
            data = data[start:end]
            if len(data) < 10:
                return False

            t = np.arange(len(data)) / freq
            if is_dist:
                d = data - data[0]
            else:
                d = np.cumsum(np.clip(data, 0, None) * (1.0 / freq))   # integrera fart → distans

            if d.max() <= 0:
                return False
            d = d / d.max()                                            # normalisera 0..1

            order = np.argsort(d)
            d, t = d[order], t[order]
            keep = np.concatenate(([True], np.diff(d) > 1e-9))         # monotont & unikt
            self._pos, self._t = d[keep], t[keep] - t[keep][0]

            # Spökkanaler: referensens gas/broms på SAMMA positionsrutnät som tiden.
            # Kanalerna har olika samplingstakt i .ld-filen (60 Hz för gas/broms,
            # 20 Hz för växel), så de måste interpoleras till huvudkanalens tidsbas
            # innan samma sortering/filtrering läggs på. Att bara slice:a med samma
            # index hade tyst gett fel data för varje kanal med annan frekvens.
            t_abs = np.arange(start, end) / freq
            for name, keys in (("throttle", ("throttle",)), ("brake", ("brake",))):
                ch = find(*keys)
                if ch is None:
                    continue
                cd = np.asarray(ch.data, dtype=float)
                cfreq = float(ch.freq or 0)
                if cfreq <= 0 or len(cd) < 2:
                    continue
                v = np.interp(t_abs, np.arange(len(cd)) / cfreq, cd)
                v = v[order][keep]
                # MoTeC anger dem i procent (mätt: 0–100). Ramen använder 0..1.
                if np.nanmax(v) > 1.5:
                    v = v / 100.0
                self._chan[name] = np.clip(v, 0.0, 1.0)
            self.lap_ms = int((self._t[-1]) * 1000)
            self.loaded = True
            self.path = path
            print(f"[delta] referens laddad: {os.path.basename(path)}  varvtid≈{self.lap_ms/1000:.3f}s  "
                  f"({'distans' if is_dist else 'fart-integrerad'}, {len(self._pos)} punkter, "
                  f"bana {self.venue or 'okänd'})")
            return True
        except Exception as e:
            print("[delta] load-fel:", e)
            self._clear()
            return False

    def t_at(self, norm_pos: float) -> Optional[float]:
        if not self.loaded:
            return None
        return float(np.interp(norm_pos % 1.0, self._pos, self._t))

    def total_ms(self) -> Optional[int]:
        return self.lap_ms if self.loaded else None

    def channels_at(self, norm_pos: float) -> dict:
        """Referensens gas/broms (0..1) vid en position på varvet.

        Används till spökspåren i inputs-trace. Overlayn behöver inte hålla reda på
        någon position: motorn skickar värdet för NUVARANDE position varje ram, och
        overlayn sparar det i samma sampel som sina egna värden. Då ligger spöket
        exakt i linje med det aktiva spåret, trots att trace-axeln är TID och
        referensen är indexerad på POSITION.
        """
        if not self.loaded or not self._chan:
            return {}
        p = norm_pos % 1.0
        return {k: float(np.interp(p, self._pos, v)) for k, v in self._chan.items()}

    def matches_track(self, track_id: str) -> bool:
        """Är referensen inspelad på den bana som körs nu?

        Ett Spa-varv använt på Monza ger ett delta som ser rimligt ut men är rent
        nonsens — position 0..1 matchar ju alltid något. Det inträffade i drift.

        Medvetet SLAPP jämförelse: ACC:s `Static.track` och MoTeC-huvudets `venue`
        stavar inte likadant ("spa" mot "Spa", ibland med suffix). Vet vi inte
        (någotdera tomt) SLÄPPER vi igenom — en matchning som ger falskt negativt
        skulle tyst stänga av en referens som fungerar, vilket är värre.
        """
        a, b = _norm_track(self.venue), _norm_track(track_id)
        if not a or not b:
            return True
        return a in b or b in a

    def delta(self, norm_pos: float, cur_lap_ms: Optional[int]) -> Optional[float]:
        """delta = din_varvtid − t_ref(position). Negativ = snabbare."""
        if not self.loaded or cur_lap_ms is None:
            return None
        tref = self.t_at(norm_pos)
        if tref is None:
            return None
        d = cur_lap_ms / 1000.0 - tref
        # Vid mållinjen kan position (wrappar till 0) och varvtid (nollställs strax
        # efter) vara ur synk EN frame → falsk spik. Den spiken har alltid magnitud
        # ≈ HELA varvtiden (mätt: 0,99 × varvet), så tröskeln ligger proportionellt
        # mot varvlängden och skalar därmed av sig själv mellan Spa (~2:16) och
        # Nordschleife (~8 min).
        # 0,8 och inte 0,5: på långa banor är en äkta delta på tiotals sekunder både
        # möjlig och intressant (t.ex. 24h Nordschleife) och ska visas, inte kastas.
        # Med 0,5 avvisades allt över 68 s på Spa fastän det var giltig data.
        if self.lap_ms and abs(d) > 0.8 * (self.lap_ms / 1000.0):
            return None
        return d


def _norm_track(s: str) -> str:
    """Bannamn utan skiljetecken och skiftläge, för den slappa jämförelsen ovan."""
    return "".join(c for c in str(s or "").lower() if c.isalnum())


def _fastest_lap(ld_path, freq, n):
    """(start,end)-index för snabbaste hela varvet ur .ldx-varvmarkörer.
    Saknas .ldx → hela filen som ett varv."""
    ldx = os.path.splitext(ld_path)[0] + ".ldx"
    if not os.path.exists(ldx):
        return 0, n
    try:
        root = ET.parse(ldx).getroot()
        times = []
        for el in root.iter():                       # kumulativa varvtider (mikrosekunder)
            tv = el.attrib.get("Time")
            if tv is not None:
                try: times.append(float(tv) * 1e-6)
                except ValueError: pass
        times = sorted(t for t in times if t > 0)
        # Hela varv ligger MELLAN markörerna (första biten = ut-varv, sista = in-varv).
        marks = sorted(set(min(int(round(t * freq)), n) for t in times))
        if len(marks) < 2:
            return 0, n            # för få markörer → behandla hela filen som ett varv
        best = None
        for a, b in zip(marks[:-1], marks[1:]):
            dur = (b - a) / freq
            if 30 <= dur <= 600 and (best is None or dur < best[2]):
                best = (a, b, dur)
        return (best[0], best[1]) if best else (0, n)
    except Exception as e:
        print("[delta] .ldx-fel:", e)
        return 0, n
