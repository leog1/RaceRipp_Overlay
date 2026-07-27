"""ACC Overlay-motor.

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
    return ap.parse_args()


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

    try:
        print(f"[engine] WebSocket → ws://{args.host}:{args.ws_port}  (källa: {args.source})")
        period = 1.0 / args.hz
        last_cfg_check = 0.0
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
                            print(f"[engine] ny referens: {rp} → {'OK' if ref.load(rp) else 'MISSLYCKADES'}")
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
                        if ref.loaded:
                            f.delta = ref.delta(f.position, f.curLapMs)
                            f.refTotalMs = ref.total_ms()
                        frame = f
                    acc_errs = 0
                except Exception as e:
                    acc_errs += 1
                    if acc_errs == 1 or acc_errs % 400 == 0:   # ~var 10:e sekund
                        print(f"[engine] ACC-läsfel ({acc_errs}): {e} — kör mock tills det går igen")
            if frame is None:
                frame = mock.read() if mock else Frame(connected=False)

            await bus.broadcast(frame.to_dict())

            # Minst en riktig yield: annars kan loopen spinna på 100 % av en kärna
            # om ett tick spiller över perioden.
            await asyncio.sleep(max(0.001, period - (time.perf_counter() - t)))
    finally:
        server.close()
        await server.wait_closed()
        if acc:
            acc.close()          # stäng ACC:s delade minne-handtag


def main():
    # Som sidecar är stdout en pipe, inte en terminal, och då blockbuffrar Python.
    # Följden är att ingenting av loggningen når fram medan motorn lever — vilket gör
    # hela diagnostiken värdelös just när man behöver den. Tvinga radbuffring.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(line_buffering=True)
        except Exception:
            pass
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
