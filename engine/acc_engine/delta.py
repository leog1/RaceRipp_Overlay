"""MoTeC-referens + live-delta.

Princip (enligt spec): resampla referensvarvet EN gång till ett jämnt distansrutnät
(distans → tid via numpy.interp), jämför sedan alltid i DISTANS:
    delta = din_varvtid - t_ref(din_position)
Positionen från ACC är normalizedCarPosition (0..1); vi normaliserar därför även
referensens distans till 0..1 så de matchar.

.ldx-varvmarkörer hanteras EJ av parsern — anta att .ld-filen är ETT referensvarv
(varvgränser hanteras separat om/när vi lägger till det).

NOTE: ldparser-API och kanalnamn verifieras mot en riktig .ld på Windows; koden är
defensiv och lämnar referensen "oladdad" (delta=None) om något inte stämmer.
"""
from __future__ import annotations
from typing import Optional
import numpy as np


class Reference:
    def __init__(self):
        self._pos = None     # normaliserad distans 0..1 (stigande)
        self._t = None       # tid (s) från varvstart vid varje pos
        self.loaded = False
        self.path = ""

    def load(self, path: str) -> bool:
        try:
            from ldparser import ldData  # gotzl/ldparser
            ld = ldData.fromfile(path)
            chans = {c.name.lower(): c for c in ld.channels}

            def get(*names):
                for n in names:
                    for k, c in chans.items():
                        if n in k:
                            return np.asarray(c.data, dtype=float), float(getattr(c, "freq", 0) or 0)
                return None, 0.0

            dist, _ = get("distance", "dist")
            if dist is None:
                # ingen distanskanal → integrera hastighet över tid
                spd, freq = get("ground speed", "speed", "gspeed")
                if spd is None or freq <= 0:
                    return False
                dt = 1.0 / freq
                dist = np.cumsum(spd * dt)  # m (skalning spelar ingen roll, vi normaliserar)
                t = np.arange(len(spd)) * dt
            else:
                # härled tid ur samplingsfrekvensen på distanskanalen
                _, freq = get("distance", "dist")
                if freq <= 0:
                    return False
                t = np.arange(len(dist)) / freq

            # rensa & normalisera distans till 0..1, se till att den är monotont stigande
            d = np.asarray(dist, float)
            d = d - d.min()
            if d.max() <= 0:
                return False
            d = d / d.max()
            order = np.argsort(d)
            d, t = d[order], np.asarray(t, float)[order]
            keep = np.concatenate(([True], np.diff(d) > 1e-9))
            self._pos, self._t = d[keep], t[keep]
            self.loaded = True
            self.path = path
            return True
        except Exception:
            self.loaded = False
            return False

    def t_at(self, norm_pos: float) -> Optional[float]:
        if not self.loaded:
            return None
        return float(np.interp(norm_pos % 1.0, self._pos, self._t))

    def delta(self, norm_pos: float, cur_lap_ms: Optional[int]) -> Optional[float]:
        """delta = din_varvtid - t_ref(position). Negativ = snabbare."""
        if not self.loaded or cur_lap_ms is None:
            return None
        tref = self.t_at(norm_pos)
        if tref is None:
            return None
        return cur_lap_ms / 1000.0 - tref
