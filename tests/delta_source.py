"""Vilken referens deltat kommer från — och när det inte ska komma från MoTeC alls.

Bakgrund (rapporterat från riktig körning, 0.3.0): delta-overlayn visade ett
MoTeC-delta direkt vid utfart ur depån, innan första varvet ens påbörjats, och mot en
fil som inte hörde till banan som kördes. MoTeC-referensen skrev nämligen ALLTID över
ACC:s eget delta så fort en fil var laddad.

Önskat beteende: utan giltig MoTeC-referens ska deltat komma från ACC:s eget mått mot
session-bästa. MoTeC-filen tar över bara när den faktiskt är tillämplig.

    python tests/delta_source.py
"""
from __future__ import annotations
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))

from acc_engine.frame import Frame                      # noqa: E402
from acc_engine.delta import Reference                  # noqa: E402
from acc_engine.__main__ import apply_reference, _ref_notice   # noqa: E402

failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failed
    print(f"{'OK  ' if ok else 'FEL '} {name}" + (f"  — {detail}" if detail else ""))
    if not ok:
        failed += 1


class FakeRef(Reference):
    """Referens utan .ld-fil: vi testar VALET av referens, inte matematiken.
    Den delen täcks av tests/motec_reference.py mot en riktig fil."""
    def __init__(self, venue="Spa", value=-0.42):
        super().__init__()
        self.loaded = True
        self.venue = venue
        self.lap_ms = 136250
        self.path = "fejk.ld"
        self._value = value

    def delta(self, pos, cur_lap_ms):
        return self._value


def acc_frame(**kw):
    """Ram som ACC-källan hade gett: ACC:s eget delta mot session-bästa ligger i
    `delta` innan referensen får säga sitt."""
    f = Frame(connected=True, trackId="Spa", position=0.5, curLapMs=42000,
              delta=-0.25, sessionBestMs=138120)
    for k, v in kw.items():
        setattr(f, k, v)
    return f


# ── 1. Ingen fil laddad → ACC:s eget delta ska visas ────────────────────────
_ref_notice.clear()
f = acc_frame()
apply_reference(f, Reference())
check("utan MoTeC-fil kommer deltat från ACC",
      f.deltaSource == "acc" and abs(f.delta + 0.25) < 1e-9,
      f"källa={f.deltaSource} delta={f.delta}")

# ── 2. Giltig fil på rätt bana, flygande varv → MoTeC vinner ───────────────
_ref_notice.clear()
f = acc_frame()
apply_reference(f, FakeRef(venue="Spa"))
check("giltig referens på rätt bana tar över",
      f.deltaSource == "motec" and abs(f.delta + 0.42) < 1e-9,
      f"källa={f.deltaSource} delta={f.delta}")
check("referensvarvets totaltid följer med", f.refTotalMs == 136250, f"refTotalMs={f.refTotalMs}")

# ── 3. UT-VARV → MoTeC får inte användas ───────────────────────────────────
# Detta var halva den rapporterade buggen: siffran dök upp direkt ur depån.
_ref_notice.clear()
f = acc_frame(outLap=True)
apply_reference(f, FakeRef(venue="Spa"))
check("på ut-varvet används INTE MoTeC-referensen",
      f.deltaSource == "acc" and abs(f.delta + 0.25) < 1e-9,
      f"källa={f.deltaSource} delta={f.delta}")

# ── 4. FEL BANA → MoTeC får inte användas ──────────────────────────────────
# Andra halvan: en Spa-fil gav ett "rimligt" delta på en helt annan bana.
_ref_notice.clear()
f = acc_frame(trackId="monza")
apply_reference(f, FakeRef(venue="Spa"))
check("på fel bana används INTE MoTeC-referensen",
      f.deltaSource == "acc", f"källa={f.deltaSource} delta={f.delta}")

# ── 5. Slapp namnmatchning ska inte ge falska negativ ──────────────────────
for venue, track in [("Spa", "spa"), ("Spa", "Spa-Francorchamps"),
                     ("nurburgring", "Nurburgring"), ("Spa", "SPA")]:
    _ref_notice.clear()
    f = acc_frame(trackId=track)
    apply_reference(f, FakeRef(venue=venue))
    check(f"{venue!r} matchar {track!r}", f.deltaSource == "motec", f"källa={f.deltaSource}")

# ── 6. Okänt bannamn ska INTE blockera ─────────────────────────────────────
# En matchning som ger falskt negativt stänger tyst av en referens som fungerar.
for venue, track in [("", "Spa"), ("Spa", "")]:
    _ref_notice.clear()
    f = acc_frame(trackId=track)
    apply_reference(f, FakeRef(venue=venue))
    check(f"okänd bana ({venue!r} / {track!r}) blockerar inte", f.deltaSource == "motec",
          f"källa={f.deltaSource}")

# ── 7. Mållinjens spikskydd ska ge INGET delta, inte ACC:s ────────────────
# Att växla mellan två olika referenser mellan ramar hade fått siffran att hoppa.
_ref_notice.clear()
f = acc_frame()
apply_reference(f, FakeRef(venue="Spa", value=None))
check("spikskyddet ger inget delta alls (inte ACC:s)",
      f.delta is None and f.deltaSource is None,
      f"källa={f.deltaSource} delta={f.delta}")

# ── 8. Inget ACC-delta heller → inget att visa ────────────────────────────
_ref_notice.clear()
f = acc_frame(delta=None)
apply_reference(f, Reference())
check("utan både fil och ACC-delta visas ingenting",
      f.delta is None and f.deltaSource is None, f"källa={f.deltaSource}")

# ── 9. Reference.delta() måste faktiskt fungera — utan att kräva en .ld ───
# motec_reference.py täcker matematiken, men den HOPPAR ÖVER sig själv när ingen
# .ld finns, alltså alltid i CI. Under utvecklingen av just den här ändringen bröts
# Reference.delta() helt (en hjälpfunktion hamnade mitt i klassen och gjorde metoden
# till död kod) och ALLA andra tester passerade ändå — delta_source.py använder en
# FakeRef som skuggar metoden. Därför en syntetisk referens här, utan filberoende.
import numpy as np                                       # noqa: E402
synth = Reference()
synth._pos = np.linspace(0.0, 1.0, 1001)
synth._t = synth._pos * 100.0                            # 100 s varv, jämn fart
synth.loaded, synth.lap_ms, synth.venue = True, 100000, "Spa"

check("Reference.delta finns och är en metod på instansen",
      callable(getattr(synth, "delta", None)) and "delta" in Reference.__dict__,
      f"typ={type(getattr(synth, 'delta', None)).__name__}")
check("delta = 0 exakt på referensen", abs(synth.delta(0.5, 50000)) < 1e-6,
      f"{synth.delta(0.5, 50000)}")
check("delta = +2 s när man ligger efter", abs(synth.delta(0.5, 52000) - 2.0) < 1e-6,
      f"{synth.delta(0.5, 52000)}")
check("delta = -2 s när man ligger före", abs(synth.delta(0.5, 48000) + 2.0) < 1e-6,
      f"{synth.delta(0.5, 48000)}")
check("mållinjeartefakten avvisas", synth.delta(0.999, 50) is None, f"{synth.delta(0.999, 50)}")
check("ingen varvtid ger None", synth.delta(0.5, None) is None)

# Och att den syntetiska referensen tar sig hela vägen genom apply_reference.
_ref_notice.clear()
f = acc_frame(curLapMs=52000)
apply_reference(f, synth)
check("syntetisk referens går genom apply_reference",
      f.deltaSource == "motec" and abs(f.delta - 2.0) < 1e-6,
      f"källa={f.deltaSource} delta={f.delta}")

# ── 9b. Bortvald referens ska sluta gälla direkt ──────────────────────────
# Panelen kunde tidigare bara LÄGGA TILL en referens, aldrig ta bort den. Nu finns
# knappen, och då måste motorn faktiskt släppa filen.
synth.unload()
check("unload() släpper referensen", not synth.loaded and synth.venue == "",
      f"loaded={synth.loaded} venue={synth.venue!r}")
_ref_notice.clear()
f = acc_frame()
apply_reference(f, synth)
check("efter unload kommer deltat från ACC igen",
      f.deltaSource == "acc" and f.refTotalMs is None,
      f"källa={f.deltaSource} refTotalMs={f.refTotalMs}")

# ── 10. Banmatchningen mot en RIKTIG .ld ──────────────────────────────────
real = Reference()
ld = Path(r"C:\Users\leo\Downloads\2.16.265_Spa_296_MoTeC-1"
          r"\Spa-ferrari_296_gt3-3-2024.09.02-18.31.22.ld")
if ld.exists() and (ROOT / "engine" / "ldparser.py").exists() and real.load(str(ld)):
    check("banan läses ur .ld-huvudet", real.venue.lower().startswith("spa"),
          f"venue={real.venue!r}")
    check("riktig Spa-fil matchar ACC:s Spa", real.matches_track("Spa"))
    check("riktig Spa-fil matchar INTE Monza", not real.matches_track("monza"))
else:
    print("     (hoppar över .ld-kontrollerna: ingen fil eller ingen ldparser)")

print(f"\n{failed} kontroll(er) misslyckades" if failed else "\nAllt OK")
sys.exit(1 if failed else 0)
