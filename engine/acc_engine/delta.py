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

    def load(self, path: str) -> bool:
        try:
            from ldparser import ldData
            ld = ldData.fromfile(path)
            chans = {c.name.lower(): c for c in ld.channs}   # ld.channs = lista av kanaler

            def find(*keys):
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
            self.lap_ms = int((self._t[-1]) * 1000)
            self.loaded = True
            self.path = path
            print(f"[delta] referens laddad: {os.path.basename(path)}  varvtid≈{self.lap_ms/1000:.3f}s  "
                  f"({'distans' if is_dist else 'fart-integrerad'}, {len(self._pos)} punkter)")
            return True
        except Exception as e:
            print("[delta] load-fel:", e)
            self.loaded = False
            return False

    def t_at(self, norm_pos: float) -> Optional[float]:
        if not self.loaded:
            return None
        return float(np.interp(norm_pos % 1.0, self._pos, self._t))

    def total_ms(self) -> Optional[int]:
        return self.lap_ms if self.loaded else None

    def delta(self, norm_pos: float, cur_lap_ms: Optional[int]) -> Optional[float]:
        """delta = din_varvtid − t_ref(position). Negativ = snabbare."""
        if not self.loaded or cur_lap_ms is None:
            return None
        tref = self.t_at(norm_pos)
        if tref is None:
            return None
        d = cur_lap_ms / 1000.0 - tref
        # Vid mållinjen kan position (wrappar till 0) och varvtid (nollställs strax
        # efter) vara ur synk EN frame → falsk spik ≈ hela varvtiden. Avvisa den:
        # en äkta delta är sekunder, aldrig ~ett halvt varv.
        if self.lap_ms and abs(d) > 0.5 * (self.lap_ms / 1000.0):
            return None
        return d


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
