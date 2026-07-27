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

from .bus import Bus
from . import http_static
from .frame import Frame
from .delta import Reference
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


def apply_reference(f: Frame, ref: Reference) -> None:
    """Väljer vilken referens deltat ska komma från och märker ramen med källan.

    Ordningen är hela poängen. MoTeC-referensen skrev tidigare ALLTID över ACC:s eget
    delta så fort en fil var laddad — även på fel bana och även på ut-varvet direkt ur
    depån, där siffran är rent nonsens. Den kommer nu bara till användning när den
    faktiskt är giltig; annars behålls ACC:s eget delta mot session-bästa, vilket är
    precis vad man vill se när ingen fil är vald.
    """
    if ref.loaded and not ref.matches_track(f.trackId):
        key = ("track", ref.venue, f.trackId)
        if key not in _ref_notice:
            _ref_notice.add(key)
            print(f"[delta] referensen är inspelad på {ref.venue!r} men banan är "
                  f"{f.trackId!r} — använder ACC:s eget delta mot session-bästa i stället.")
    elif ref.loaded and f.outLap:
        if "outlap" not in _ref_notice:
            _ref_notice.add("outlap")
            print("[delta] ut-varv (startade i depån) — referensdelta hoppas över "
                  "tills du passerat mållinjen.")
    elif ref.loaded:
        # Giltig referens: den vinner över ACC:s. `delta()` kan ge None vid mållinjen
        # (spikskyddet, §8.8) — då ska INGET delta visas, inte ACC:s. Att växla mellan
        # två olika referenser mellan ramar hade fått siffran att hoppa.
        f.delta = ref.delta(f.position, f.curLapMs)
        f.refTotalMs = ref.total_ms()
        f.deltaSource = "motec" if f.delta is not None else None
        return
    f.deltaSource = "acc" if f.delta is not None else None


async def run():
    args = parse_args()
    bus = Bus()
    ref = Reference()

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
                            print(f"[engine] ny referens: {rp} → {'OK' if ref.load(rp) else 'MISSLYCKADES'}")
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
                        apply_reference(f, ref)
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
