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

# ── 9a. Spökkanaler: referensens pedaler vid en position ──────────────────
# Kanalerna har OLIKA samplingstakt i .ld-filen (60 Hz för gas/broms, 20 Hz för
# växel). Att bara slice:a med samma index som huvudkanalen hade tyst gett fel data
# för varje kanal med annan frekvens — därför interpoleras de till en gemensam tidsbas.
synth._chan = {
    "throttle": np.where(synth._pos < 0.5, 1.0, 0.0),   # full gas första halvan
    "brake":    np.where(synth._pos < 0.5, 0.0, 1.0),   # broms andra halvan
}
ch = synth.channels_at(0.25)
check("spökkanaler samplas vid rätt position",
      abs(ch["throttle"] - 1.0) < 1e-6 and abs(ch["brake"]) < 1e-6, ch)
ch = synth.channels_at(0.75)
check("och följer med runt varvet", abs(ch["throttle"]) < 1e-6 and abs(ch["brake"] - 1.0) < 1e-6, ch)
check("position wrappar (1.25 = 0.25)",
      abs(synth.channels_at(1.25)["throttle"] - 1.0) < 1e-6, synth.channels_at(1.25))

# Går de hela vägen ut i ramen — och BARA när referensen faktiskt gäller?
_ref_notice.clear()
f = acc_frame(curLapMs=52000, position=0.25)
apply_reference(f, synth)
check("spökvärden når ramen när referensen gäller",
      f.deltaSource == "motec" and f.refThrottle == 1.0 and f.refBrake == 0.0,
      f"gas={f.refThrottle} broms={f.refBrake}")

_ref_notice.clear()
f = acc_frame(outLap=True, position=0.25)
apply_reference(f, synth)
check("inga spökvärden på ut-varv", f.refThrottle is None and f.refBrake is None,
      f"gas={f.refThrottle} broms={f.refBrake}")

_ref_notice.clear()
f = acc_frame(trackId="monza", position=0.25)
apply_reference(f, synth)
check("inga spökvärden på fel bana", f.refThrottle is None and f.refBrake is None,
      f"gas={f.refThrottle} broms={f.refBrake}")

# En referens UTAN spökkanaler (äldre fil, saknad kanal) får inte krascha.
bare = Reference()
bare._pos, bare._t = synth._pos, synth._t
bare.loaded, bare.lap_ms, bare.venue = True, 100000, "Spa"
check("referens utan spökkanaler ger tom dict", bare.channels_at(0.5) == {}, bare.channels_at(0.5))
_ref_notice.clear()
f = acc_frame(position=0.5)
apply_reference(f, bare)
check("och ramen får då inga spökvärden, men deltat funkar",
      f.deltaSource == "motec" and f.refThrottle is None, f"källa={f.deltaSource}")

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

# ── 9c. refs-kartan: ALLA källor som gäller, samtidigt ────────────────────
# Motorn väljer inte längre åt overlayn — reglaget "Delta source" gör det, och då
# måste ramen innehålla varje källa som gäller. En källa som INTE gäller ska saknas
# helt: en overlay som får en nyckel litar på den.
class FakeCurve:
    """Ett inspelat varv, utan att behöva mata in ett helt varv (det gör
    tests/lap_recorder.py). Samma tre metoder som __main__ använder per ram."""
    def __init__(self, lap_ms, value, throttle=0.75, brake=0.10):
        self.lap_ms = lap_ms
        self._value, self._th, self._br = value, throttle, brake

    def delta(self, pos, cur_lap_ms):
        return self._value

    def total_ms(self):
        return self.lap_ms

    def channels_at(self, pos):
        return {"throttle": self._th, "brake": self._br}


class FakeLaps:
    def __init__(self, last=None, best=None):
        self.last, self.best = last, best


_ref_notice.clear()
f = acc_frame()
apply_reference(f, FakeRef(venue="Spa"),
                FakeLaps(last=FakeCurve(140000, 1.5), best=FakeCurve(138120, -0.5)))
check("alla tre källorna ligger i refs", sorted(f.refs or {}) == ["best", "last", "motec"],
      f"refs={sorted(f.refs or {})}")
check("varje källa bär sitt eget delta",
      abs(f.refs["last"]["delta"] - 1.5) < 1e-9 and abs(f.refs["best"]["delta"] + 0.5) < 1e-9
      and abs(f.refs["motec"]["delta"] + 0.42) < 1e-9, f.refs)
check("varvtiden följer med per källa",
      f.refs["last"]["totalMs"] == 140000 and f.refs["best"]["totalMs"] == 138120
      and f.refs["motec"]["totalMs"] == 136250, f.refs)
check("inspelade varv bär spökkanaler",
      f.refs["best"]["throttle"] == 0.75 and f.refs["best"]["brake"] == 0.10, f.refs["best"])

# Utan egen inspelning ska "best" ändå finnas — ACC:s eget mått mot session-bästa är
# samma jämförelse och finns direkt. Men utan kurva, alltså utan spökspår.
_ref_notice.clear()
f = acc_frame()
apply_reference(f, Reference(), FakeLaps())
check("utan inspelat varv faller best tillbaka på ACC:s eget delta",
      f.refs and f.refs["best"]["src"] == "acc" and abs(f.refs["best"]["delta"] + 0.25) < 1e-9,
      f.refs)
check("och den fallbacken har inga spökkanaler",
      f.refs["best"]["throttle"] is None and f.refs["best"]["brake"] is None, f.refs["best"])
check("last finns inte när inget varv är inspelat", "last" not in (f.refs or {}), f.refs)

# Ut-varv: de egna inspelningarna är inte jämförbara (man startade inte på mållinjen).
# ACC:s eget mått får stå kvar — ACC svarar för sin egen giltighet.
_ref_notice.clear()
f = acc_frame(outLap=True)
apply_reference(f, FakeRef(venue="Spa"),
                FakeLaps(last=FakeCurve(140000, 1.5), best=FakeCurve(138120, -0.5)))
check("på ut-varv finns varken last eller motec i refs",
      "last" not in (f.refs or {}) and "motec" not in (f.refs or {}), f.refs)
check("men ACC:s eget mått finns kvar som best",
      f.refs and f.refs["best"]["src"] == "acc", f.refs)

# Ingen källa alls → refs är None, inte en tom dict. En overlay ska inte behöva skilja
# på "tom" och "saknas".
_ref_notice.clear()
f = acc_frame(delta=None)
apply_reference(f, Reference(), FakeLaps())
check("utan någon källa är refs None", f.refs is None, f"refs={f.refs}")

# Spikskyddet gäller per källa: ger kurvan inget delta ska den saknas i kartan, så att
# varken siffra eller spökspår visas för just den källan.
_ref_notice.clear()
f = acc_frame()
apply_reference(f, Reference(), FakeLaps(best=FakeCurve(138120, None)))
check("en källa utan giltigt delta finns inte i refs",
      f.refs and f.refs["best"]["src"] == "acc", f.refs)

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
