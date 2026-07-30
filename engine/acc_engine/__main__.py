"""SimMatrix-motor.

Startar:
  • WebSocket-buss (data) på --ws-port
  • statisk HTTP (OBS) på --http-port som serverar overlay-mappen
  • en läsloop ~40 Hz som väljer källa och broadcastar ramar

Källa (--source auto): använd ACC om spelet kör, annars mock (så stacken alltid
visar något). Referensvarv för delta laddas via --ref PATH eller genom en config-fil
som kontrollpanelen skriver (--config).

Kör fristående (utan appen):
  pip install -r requirements.txt
  python -m acc_engine --root ../src
"""
from __future__ import annotations
import argparse, asyncio, json, sys, time
from pathlib import Path
from typing import Optional

from .bus import Bus
from . import http_static
from .frame import Frame
from .delta import Reference
from .laps import LapRecorder
from .sources.mock import MockSource
from .sources.acc import AccSource
from .sources.acc_broadcast import AccBroadcast, find_config


def parse_args():
    ap = argparse.ArgumentParser("acc-engine")
    ap.add_argument("--ws-port", type=int, default=8777)
    ap.add_argument("--http-port", type=int, default=8078)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--hz", type=float, default=40.0)
    ap.add_argument("--source", choices=["auto", "acc", "mock"], default="auto")
    ap.add_argument("--root", default=str(Path(__file__).resolve().parents[2] / "src"),
                    help="mapp som HTTP-servern serverar (overlay-filerna)")
    ap.add_argument("--ref", default="", help="MoTeC .ld referensvarv")
    ap.add_argument("--config", default="", help="JSON som kontrollpanelen skriver (t.ex. ref-path)")
    ap.add_argument("--broadcast", choices=["auto", "on", "off"], default="auto",
                    help="ACC Broadcasting-UDP (andra bilars data). auto = på när "
                         "broadcasting.json finns och källan inte är mock")
    ap.add_argument("--broadcast-config", default="",
                    help="explicit sökväg till broadcasting.json (annars ACC:s Config-mapp)")
    ap.add_argument("--broadcast-ms", type=int, default=100,
                    help="ACC:s uppdateringsintervall för Broadcasting (ms)")
    return ap.parse_args()


# entries är statisk; skicka om den så här ofta även när den inte ändrats, så en
# klient som ansluter mitt i loppet (ny OBS-flik) inte blir utan förarnamn.
ENTRIES_RESEND_S = 5.0

# Varför en referens inte används loggas EN gång per skäl. Utan det är det osynligt
# varför deltat plötsligt kommer från ACC i stället för filen man valt.
_ref_notice: set = set()


def _curve_entry(curve, f: Frame, src: str) -> Optional[dict]:
    """En referenskälla som den ser ut i ramens `refs` — eller None om den inte gäller.

    Samma grind för alla sorter: ger kurvan inget delta här (mållinjens spikskydd,
    §8.8) ska varken siffra eller spökspår visas. Att låta spöket ligga kvar när
    deltat försvann hade visat en referens motorn samtidigt sagt sig inte lita på.
    """
    d = curve.delta(f.position, f.curLapMs)
    if d is None:
        return None
    ch = curve.channels_at(f.position)
    return {"delta": d, "totalMs": curve.total_ms(),
            "throttle": ch.get("throttle"), "brake": ch.get("brake"), "src": src}


def _motec_applies(f: Frame, ref: Reference) -> bool:
    """Gäller MoTeC-filen för det varv som körs NU? Loggar skälet en gång per skäl.

    Utan de här två villkoren skrev filen ALLTID över deltat så fort den var laddad —
    även på fel bana och även på ut-varvet direkt ur depån, där siffran är rent
    nonsens. Båda felen var rapporterade från riktig körning (§8.8b).
    """
    if not ref.loaded:
        return False
    if not ref.matches_track(f.trackId):
        key = ("track", ref.venue, f.trackId)
        if key not in _ref_notice:
            _ref_notice.add(key)
            print(f"[delta] referensen är inspelad på {ref.venue!r} men banan är "
                  f"{f.trackId!r} — MoTeC-källan hoppas över.")
        return False
    if f.outLap:
        if "outlap" not in _ref_notice:
            _ref_notice.add("outlap")
            print("[delta] ut-varv (startade i depån) — referensdelta hoppas över "
                  "tills du passerat mållinjen.")
        return False
    return True


def apply_reference(f: Frame, ref: Reference, laps=None) -> None:
    """Fyller ramens `refs` med ALLA referenskällor som gäller, och sätter de gamla
    fälten (`delta`/`deltaSource`/`refThrottle`/`refBrake`) som förut.

    Motorn VÄLJER inte längre åt overlayn — den levererar de källor som finns och
    låter reglaget "Delta source" i varje overlay bestämma. Se frame.py för kartans
    form och för varför valet hör hemma där.

    De gamla fälten står kvar oförändrade: en OBS-källa eller en äldre overlay som
    läser `delta` ska fortsätta se MoTeC-filen när den gäller och annars ACC:s eget
    mått mot session-bästa.
    """
    acc_delta = f.delta                  # ACC:s eget mått mot session-bästa
    refs: dict = {}

    # Egna inspelningar: förra varvet och sessionens bästa. Samma ut-varvsregel som
    # för filen — ett varv som börjat i depån går inte att jämföra med ett flygande.
    if laps is not None and not f.outLap:
        for key, curve in (("last", laps.last), ("best", laps.best)):
            if curve is None:
                continue
            entry = _curve_entry(curve, f, "lap")
            if entry:
                refs[key] = entry

    # ACC:s eget delta är fallback för "best" tills vi hunnit spela in ett eget varv:
    # det är samma jämförelse (mot sessionens bästa) och det finns direkt. Ingen kurva
    # följer med, så spökspåret uteblir — men siffran gör inte det.
    if "best" not in refs and acc_delta is not None:
        refs["best"] = {"delta": acc_delta, "totalMs": f.sessionBestMs,
                        "throttle": None, "brake": None, "src": "acc"}

    motec_ok = _motec_applies(f, ref)
    motec = _curve_entry(ref, f, "motec") if motec_ok else None
    if motec:
        refs["motec"] = motec

    f.refs = refs or None

    # ── Gamla fälten (bakåtkompatibilitet) ─────────────────────────────────────
    if motec_ok:
        # Giltig fil: den vinner. `delta()` kan ge None vid mållinjen (spikskyddet)
        # — då ska INGET delta visas, inte ACC:s. Att växla mellan två olika
        # referenser mellan ramar hade fått siffran att hoppa.
        if motec:
            f.delta = motec["delta"]
            f.refTotalMs = motec["totalMs"]
            f.deltaSource = "motec"
            f.refThrottle = motec["throttle"]
            f.refBrake = motec["brake"]
        else:
            f.delta = None
            f.deltaSource = None
        return
    f.deltaSource = "acc" if f.delta is not None else None


async def run():
    args = parse_args()
    bus = Bus()
    ref = Reference()
    # Motorns egna varvinspelningar (förra varvet + sessionens bästa). Matas bara med
    # RIKTIGA ACC-ramar: mock-telemetri får aldrig blandas in i en referens som
    # overlays sedan jämför äkta körning mot (samma regel som §8.6e).
    laps = LapRecorder()

    root = Path(args.root)
    if root.exists():
        try:
            http_static.start(root, args.host, args.http_port)
            print(f"[engine] HTTP (OBS) → http://{args.host}:{args.http_port}/overlays/")
        except OSError as e:
            # Icke-fatalt: OBS-servern är valfri, WS-bussen är huvudsaken.
            print(f"[engine] HTTP-porten {args.http_port} kunde ej bindas ({e}) — "
                  f"OBS-servern hoppas över. Kör redan en acc-engine?")
    else:
        print(f"[engine] varning: --root finns ej: {root} (OBS-servern hoppas över)")

    # källor. AccSource öppnar delat minne redan i konstruktorn — får den inte det
    # ska vi falla tillbaka på mock, inte dö innan bussen ens startat.
    acc = None
    if args.source in ("auto", "acc"):
        try:
            acc = AccSource()
        except Exception as e:
            print(f"[engine] kunde ej öppna ACC:s delade minne: {e} (kör mock)")
    mock = MockSource() if args.source in ("auto", "mock") else None
    if args.source == "acc" and not (acc and acc.available):
        print("[engine] pyaccsharedmemory saknas — inga ACC-data (kör --source mock för demo)")

    if args.ref:
        print(f"[engine] laddar referens: {args.ref} → {'OK' if ref.load(args.ref) else 'MISSLYCKADES'}")

    cfg_path = Path(args.config) if args.config else None
    cfg_mtime = 0.0

    try:
        server = await bus.start(args.host, args.ws_port)
    except OSError as e:
        print(f"[engine] kan ej binda ws://{args.host}:{args.ws_port} ({e}).\n"
              f"[engine] En acc-engine kör troligen redan (kolla efter en kvarlämnad "
              f"acc-engine.exe i Aktivitetshanteraren). Avslutar.")
        return

    # Broadcasting-UDP: andra bilars data. Startas EFTER att bussen bundit — den är
    # ett tillägg, inte en förutsättning, och får aldrig hindra motorn från att köra.
    bc = None
    want_bc = args.broadcast == "on" or (
        args.broadcast == "auto" and args.source != "mock" and find_config(args.broadcast_config))
    if want_bc:
        try:
            bc = AccBroadcast(update_ms=args.broadcast_ms, config_path=args.broadcast_config)
            if not await bc.start():
                bc = None if bc.status == "off" else bc   # "off" = ej konfigurerat, inget fel
        except Exception as e:
            print(f"[engine] Broadcasting kunde ej startas: {e} (fortsätter utan)")
            bc = None
    elif args.broadcast == "auto":
        print("[engine] Broadcasting av (broadcasting.json saknas eller källan är mock)")

    try:
        print(f"[engine] WebSocket → ws://{args.host}:{args.ws_port}  (källa: {args.source})")
        period = 1.0 / args.hz
        last_cfg_check = 0.0
        last_entries_sent = 0.0
        acc_errs = 0
        while True:
            t = time.perf_counter()

            # pollra kontrollpanelens config (ref-path) någon gång per sekund
            if cfg_path and t - last_cfg_check > 1.0:
                last_cfg_check = t
                try:
                    m = cfg_path.stat().st_mtime
                    if m != cfg_mtime:
                        cfg_mtime = m
                        data = json.loads(cfg_path.read_text(encoding="utf-8"))
                        rp = data.get("reference_ld", "")
                        if rp and rp != ref.path:
                            _ref_notice.clear()   # ny fil → nya skäl får loggas igen
                            # Inläsningen körs i en TRÅD. En ACC-export är 55 kanaler
                            # och tiotusentals sampel; ldparser + numpy tar tiondelar
                            # av en sekund till ett par sekunder, och gjordes det här
                            # i loopen stannade ALL telemetri så länge — mitt i en
                            # session, vilket är precis när man laddar en referens.
                            # Racet är ofarligt: load() nollar `loaded` först och
                            # sätter den sist, så en ram under inläsningen ser en
                            # oladdad referens och använder ACC:s eget delta.
                            ok = await asyncio.to_thread(ref.load, rp)
                            print(f"[engine] ny referens: {rp} → {'OK' if ok else 'MISSLYCKADES'}")
                        elif not rp and ref.loaded:
                            # Referensen bortvald i panelen: sluta använda den. Utan
                            # detta låg den kvar tills motorn startades om.
                            _ref_notice.clear()
                            ref.unload()
                            print("[engine] referensen bortvald — delta kommer nu från ACC:s session-bästa")
                except FileNotFoundError:
                    pass
                except Exception as e:
                    print("[engine] config-fel:", e)

            # Välj ram. ALLT kring källäsningen är inkapslat: ACC:s delade minne
            # kan försvinna mitt i en session (alt-F4) och kasta — utan detta dog
            # hela motorprocessen och varje overlay frös på sista ramen.
            frame = None
            if acc and acc.available:
                try:
                    f = acc.read()
                    if f.connected:
                        # Spela in FÖRE apply_reference: ramen som just passerade
                        # mållinjen är den som gör bufferten till ett varv, och det
                        # varvet ska kunna vara referens redan i samma ram.
                        laps.update(f)
                        apply_reference(f, ref, laps)
                        frame = f
                    acc_errs = 0
                except Exception as e:
                    acc_errs += 1
                    if acc_errs == 1 or acc_errs % 400 == 0:   # ~var 10:e sekund
                        print(f"[engine] ACC-läsfel ({acc_errs}): {e} — kör mock tills det går igen")
            if frame is None:
                frame = mock.read() if mock else Frame(connected=False)

            # Broadcasting läggs PÅ ramen, den ersätter inget. Samma inkapsling som
            # ACC-läsningen: en bugg här får inte ta ner motorn (§8.6).
            if bc is not None:
                try:
                    snap = bc.snapshot()
                    frame.broadcast = snap["status"]
                    frame.broadcastError = snap["error"] or None
                    frame.cars = snap["cars"] or None
                    frame.sessionPhase = snap["session"].get("phase")
                    frame.focusedCarIndex = snap["session"].get("focusedCarIndex")
                    frame.trackName = snap["track"].get("name")
                    frame.trackMeters = snap["track"].get("meters")
                    # entries är statisk: skicka vid ändring, annars var 5:e sekund så
                    # en sent ansluten klient också får den. None = OFÖRÄNDRAD (frame.py).
                    if snap["entriesDirty"] or t - last_entries_sent > ENTRIES_RESEND_S:
                        frame.entries = snap["entries"] or None
                        last_entries_sent = t
                        bc.mark_entries_sent()
                except Exception as e:
                    print("[engine] Broadcasting-fel:", e)

            await bus.broadcast(frame.to_dict())

            # Minst en riktig yield: annars kan loopen spinna på 100 % av en kärna
            # om ett tick spiller över perioden.
            await asyncio.sleep(max(0.001, period - (time.perf_counter() - t)))
    finally:
        server.close()
        await server.wait_closed()
        if bc:
            bc.close()           # avregistrera hos ACC + stäng UDP-socketen
        if acc:
            acc.close()          # stäng ACC:s delade minne-handtag


def main():
    # Som sidecar är stdout en pipe, inte en terminal. Två följder, båda åtgärdade här:
    #
    # 1. Python BLOCKBUFFRAR mot en pipe, så ingenting av loggningen når fram medan
    #    motorn lever — diagnostiken blir värdelös just när man behöver den (§8.6b).
    # 2. Python väljer LOCALE-kodning mot en pipe, inte UTF-8. Loggen innehåller "→"
    #    och "≈", som inte finns i cp1252 — på ett Windows utan UTF-8-läge dör motorn
    #    då på sin FÖRSTA utskrift, innan bussen ens startat. Den frysta sidecarn
    #    slipper det (PyInstaller kör UTF-8-läge), men `python -m acc_engine` gör inte
    #    det, vilket är exakt hur utvecklare och CI kör motorn.
    #    errors="replace" i stället för att kasta: en logg med frågetecken är alltid
    #    bättre än en död motor.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
        except Exception:
            pass
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
