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
import argparse, asyncio, json, time
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
        http_static.start(root, args.host, args.http_port)
        print(f"[engine] HTTP (OBS) → http://{args.host}:{args.http_port}/overlays/")
    else:
        print(f"[engine] varning: --root finns ej: {root} (OBS-servern hoppas över)")

    # källor
    acc = AccSource() if args.source in ("auto", "acc") else None
    mock = MockSource() if args.source in ("auto", "mock") else None
    if args.source == "acc" and not (acc and acc.available):
        print("[engine] pyaccsharedmemory saknas — inga ACC-data (kör --source mock för demo)")

    if args.ref:
        print(f"[engine] laddar referens: {args.ref} → {'OK' if ref.load(args.ref) else 'MISSLYCKADES'}")

    cfg_path = Path(args.config) if args.config else None
    cfg_mtime = 0.0

    async with bus.serve(args.host, args.ws_port):
        print(f"[engine] WebSocket → ws://{args.host}:{args.ws_port}  (källa: {args.source})")
        period = 1.0 / args.hz
        last_cfg_check = 0.0
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

            # välj ram
            frame = None
            if acc and acc.available:
                f = acc.read()
                if f.connected:
                    if ref.loaded:
                        f.delta = ref.delta(f.position, f.curLapMs)
                    frame = f
            if frame is None:
                frame = mock.read() if mock else Frame(connected=False)

            await bus.broadcast(frame.to_dict())

            await asyncio.sleep(max(0.0, period - (time.perf_counter() - t)))


def main():
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
