"""Röktest av motorn: startar den som subprocess och kontrollerar bussen.

Täcker att ramschemat är komplett, att takten stämmer, att inga fält är NaN, och
att en andra instans avslutar snyggt i stället för med traceback när porten är tagen
(vilket händer så fort en tidigare motor lever kvar).

    python tests/engine_smoke.py
"""
from __future__ import annotations
import asyncio
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENGINE_DIR = ROOT / "engine"
SRC = ROOT / "src"
WS = "ws://127.0.0.1:8777"

failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failed
    print(f"{'OK  ' if ok else 'FEL '} {name}" + (f"  — {detail}" if detail else ""))
    if not ok:
        failed += 1


async def collect(n: int) -> list[dict]:
    import websockets
    async with websockets.connect(WS) as ws:
        return [json.loads(await asyncio.wait_for(ws.recv(), timeout=5)) for _ in range(n)]


async def main() -> int:
    # --broadcast off: röktestet ska mäta baskällan. Med "auto" hade resultatet
    # berott på om maskinen råkar ha en broadcasting.json, vilket gör testet olika
    # på utvecklarmaskinen och i CI.
    engine = subprocess.Popen(
        [sys.executable, "-m", "acc_engine", "--root", str(SRC), "--broadcast", "off"],
        cwd=str(ENGINE_DIR), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace",
    )
    try:
        frames = None
        for _ in range(60):
            try:
                frames = await collect(25)
                break
            except Exception:
                await asyncio.sleep(0.25)
        if frames is None:
            check("motorn svarar på WS", False, "ingen anslutning inom 15 s")
            return 1
        check("motorn svarar på WS", True, f"{len(frames)} ramar")

        # Ramschemat: overlays läser dessa och tål inte att fält försvinner.
        expected = {
            "connected", "throttle", "brake", "clutch", "abs", "tc", "gear", "speedKph",
            "rpm", "steer", "delta", "sessionBestMs", "lastLapMs", "curLapMs",
            "refTotalMs", "driverName", "position",
        }
        missing = expected - set(frames[0])
        check("ramschemat komplett", not missing, f"saknar {sorted(missing)}" if missing else f"{len(frames[0])} fält")

        # Broadcasting-fälten ska finnas men vara None när den är av — annars kan ett
        # tillägg där tyst ändra vad befintliga overlays ser.
        bc_fields = {"cars", "entries", "sessionPhase", "focusedCarIndex",
                     "trackName", "trackMeters", "broadcast", "broadcastError"}
        bc_missing = bc_fields - set(frames[0])
        bc_set = {k for f in frames for k in bc_fields if f.get(k) is not None}
        check("Broadcasting-fälten finns och är tomma med --broadcast off",
              not bc_missing and not bc_set,
              f"saknar {sorted(bc_missing)}" if bc_missing else
              (f"oväntat satta: {sorted(bc_set)}" if bc_set else "alla None"))

        # NaN är klistrigt i overlays (scaleY(NaN) fastnar för alltid).
        nan = [k for f in frames for k, v in f.items()
               if isinstance(v, float) and v != v]
        check("inga NaN-värden", not nan, f"{sorted(set(nan))}" if nan else "")

        moving = len({f["throttle"] for f in frames}) > 1
        check("telemetrin rör sig", moving)

        t0 = time.perf_counter()
        await collect(40)
        hz = 40 / (time.perf_counter() - t0)
        check("takt nära 40 Hz", 30 <= hz <= 50, f"{hz:.0f} Hz")

        # Andra instans: ska logga tydligt och avsluta, inte krascha.
        second = subprocess.run(
            [sys.executable, "-m", "acc_engine", "--root", str(SRC), "--broadcast", "off"],
            cwd=str(ENGINE_DIR), capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=60,
        )
        out = second.stdout + second.stderr
        check("andra instansen avslutar utan traceback", "Traceback" not in out)
        check("andra instansen förklarar portkonflikten",
              "kan ej binda" in out, out.strip().splitlines()[-1][:80] if out.strip() else "ingen output")
    finally:
        engine.terminate()
        try:
            engine.communicate(timeout=10)
        except Exception:
            engine.kill()

    print("\nAllt OK" if not failed else f"\n{failed} kontroll(er) misslyckades")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
