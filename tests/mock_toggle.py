"""Mock-data går att stänga av i drift — och sätta på igen.

Reglaget bor i kontrollpanelens driftblock, men motorn är en egen PROCESS och kan
inte nås med ett Tauri-event. Vägen är därför densamma som referensvarvets:
kontrollpanelen skriver `engine.config.json`, motorn pollar den en gång i sekunden.
Två saker som kan gå sönder tyst i den kedjan, och som testet mäter:

  1. Motorn läser `mock` ur filen ÖVERHUVUDTAGET. Utan det fortsätter den skicka
     demotelemetri och panelen ser ut att ha ett reglage som inte gör något.
  2. Motorn läser om filen NÄR den ändras. Konfigpollningen jämför mtime, så en
     flagga som bara lästes vid start hade krävt omstart av appen för att gälla —
     och en omstart av motorn är inte något användaren kan göra ur panelen.

Med mock av ska ramen fortfarande KOMMA (bussen lever, overlays håller sin
anslutning) men vara tom: `connected: false` och ingen telemetri. Det är skillnaden
mellan "ingen data" och "död motor", och overlays behandlar dem olika.

    python tests/mock_toggle.py
"""
from __future__ import annotations
import asyncio
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

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


def write_cfg(path: Path, mock: bool) -> None:
    # Samma form som lib.rs:write_engine_config skriver. HELA tillståndet varje gång:
    # filen är inte en ström av ändringar, och ett fält som utelämnas nollställer det
    # andra i motorn.
    path.write_text(json.dumps({"reference_ld": "", "mock": mock}), encoding="utf-8")
    # Konfigpollningen jämför mtime. Två skrivningar inom samma klocktick kan få
    # identisk stämpel på Windows, och då hade testet mätt att motorn "inte läser om"
    # när det i själva verket är filsystemet som inte sa till.
    t = time.time() + 2
    import os
    os.utime(path, (t, t))


async def frames_until(pred, timeout=8.0):
    """Samla ramar tills en uppfyller pred (eller ge upp). Returnerar sista ramen.

    Pollningen är EN gång i sekunden, så ett svar kan dröja över en sekund — en
    mätning som läser tre ramar direkt efter skrivningen hade mätt tiden till nästa
    poll och inget annat."""
    t0 = time.monotonic()
    last = None
    while time.monotonic() - t0 < timeout:
        for f in await collect(5):
            last = f
            if pred(f):
                return f
        await asyncio.sleep(0.2)
    return last


async def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="simmatrix-mock-"))
    cfg = tmp / "engine.config.json"
    write_cfg(cfg, True)
    engine = subprocess.Popen(
        [sys.executable, "-m", "acc_engine", "--root", str(SRC), "--broadcast", "off",
         "--source", "mock", "--config", str(cfg)],
        cwd=str(ENGINE_DIR), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace",
    )
    try:
        first = None
        for _ in range(60):
            try:
                first = (await collect(3))[-1]
                break
            except Exception:
                await asyncio.sleep(0.25)
        if first is None:
            check("motorn svarar på WS", False, "ingen anslutning inom 15 s")
            return 1
        # `speedKph` och inte `connected`: mock-källan rapporterar med flit
        # connected=False (den är inte ACC), så det enda som skiljer en mock-ram från
        # en tom ram är att det FINNS telemetri i den.
        check("mock på: telemetri kommer", (first.get("speedKph") or 0) > 0,
              f"speedKph={first.get('speedKph')}")

        write_cfg(cfg, False)
        tom = await frames_until(lambda f: not (f.get("speedKph") or 0))
        check("mock av: ramen kommer men är tom",
              tom is not None and not (tom.get("speedKph") or 0) and tom.get("connected") is False,
              f"connected={tom.get('connected')} speedKph={tom.get('speedKph')}")
        # Bussen ska INTE dö. En overlay som tappar anslutningen ritar sin
        # frånkopplade bild av ett annat skäl än "ingen data", och grinden i bus.js
        # räknar tappade ramar — en död buss hade sett ut som att ACC kraschat.
        check("mock av: bussen lever vidare", tom is not None and "connected" in tom)

        write_cfg(cfg, True)
        ater = await frames_until(lambda f: (f.get("speedKph") or 0) > 0)
        check("mock på igen: telemetrin kommer tillbaka utan omstart",
              ater is not None and (ater.get("speedKph") or 0) > 0,
              f"speedKph={ater.get('speedKph') if ater else None}")
    finally:
        engine.terminate()
        try:
            engine.wait(timeout=5)
        except subprocess.TimeoutExpired:
            engine.kill()
    return 1 if failed else 0


if __name__ == "__main__":
    code = asyncio.run(main())
    print("\n" + ("Allt OK" if code == 0 else "MISSLYCKADES"))
    sys.exit(code)
