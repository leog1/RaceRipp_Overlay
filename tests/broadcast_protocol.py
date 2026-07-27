"""Broadcasting-parsern mot en FALSK ACC-server.

Vad detta bevisar: att `sources/acc_broadcast.py` tolkar paketen som vi TROR att
protokollet ser ut, att okänd bil utlöser en omfrågan av entry list, att omfrågan är
rate-limitad, och att skräppaket inte fäller motorn.

Vad det INTE bevisar: att vår tolkning stämmer med riktiga ACC. Byte-layouten är
skriven mot Kunos publika dokumentation men aldrig sedd i drift — samma öppna punkt
som fältmappningen i sources/acc.py (CLAUDE.md §7). Kör `engine/broadcast_test.py`
med ACC igång för den delen.

    python tests/broadcast_protocol.py
"""
from __future__ import annotations
import asyncio, os, struct, sys, socket
from pathlib import Path

# Utskrifterna innehåller tecken som inte finns i cp1252 ("→", "≈"). Mot en pipe
# väljer Python locale-kodning, så på ett Windows utan UTF-8-läge (t.ex. en
# GitHub-runner) dör testet på sin egen utskrift i stället för att rapportera.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine"))
from acc_engine.sources import acc_broadcast as B   # noqa: E402

failed = 0


def check(name, ok, detail=""):
    global failed
    print(f"{'OK  ' if ok else 'FEL '} {name}{('  — ' + str(detail)) if detail else ''}")
    if not ok:
        failed += 1


# ── paketbyggare (spegelbild av parsern — medvetet handskriven) ─────────────
def s(x: str) -> bytes:
    e = x.encode("utf-8")
    return struct.pack("<H", len(e)) + e


def lap(ms=None, car=0, drv=0, splits=(), invalid=0, vfb=1, out=0, inl=0):
    raw = 2_147_483_647 if ms is None else ms
    b = struct.pack("<i", raw) + struct.pack("<HH", car, drv)
    b += bytes([len(splits)]) + b"".join(struct.pack("<i", x) for x in splits)
    return b + bytes([invalid, vfb, out, inl])


def registration_result(cid=7, ok=1, msg=""):
    return bytes([B.REGISTRATION_RESULT]) + struct.pack("<i", cid) + bytes([ok, 0]) + s(msg)


def realtime_update(phase=5, focused=3):
    return (bytes([B.REALTIME_UPDATE]) + struct.pack("<HH", 1, 0) + bytes([2, phase])
            + struct.pack("<ff", 1234.0, 5678.0) + struct.pack("<i", focused)
            + s("set1") + s("Onboard0") + s("Basic") + bytes([0])
            + struct.pack("<f", 43200.0) + bytes([20, 28, 3, 0, 0]) + lap(ms=98765))


def realtime_car_update(car=3, gear=4, kmh=210, pos=2, spline=0.42, laps=5, delta=-350):
    return (bytes([B.REALTIME_CAR_UPDATE]) + struct.pack("<HH", car, 0) + bytes([1])
            + struct.pack("<b", gear + 2)
            + struct.pack("<fff", 100.0, 200.0, 1.5)
            + bytes([1]) + struct.pack("<H", kmh)
            + struct.pack("<HHH", pos, pos, pos)
            + struct.pack("<f", spline) + struct.pack("<H", laps)
            + struct.pack("<i", delta)
            + lap(ms=136250) + lap(ms=137000) + lap(ms=None))


def entry_list(cars=(3,)):
    return (bytes([B.ENTRY_LIST]) + struct.pack("<i", 7)
            + struct.pack("<H", len(cars)) + b"".join(struct.pack("<H", c) for c in cars))


def entry_list_car(car=3, num=63, first="Leo", last="Gustafsson", team="RaceRipp"):
    return (bytes([B.ENTRY_LIST_CAR]) + struct.pack("<H", car) + bytes([12]) + s(team)
            + struct.pack("<i", num) + bytes([0]) + struct.pack("<b", 0)
            + struct.pack("<H", 40) + bytes([1])
            + s(first) + s(last) + s("GUS") + bytes([2]) + struct.pack("<H", 40))


def track_data(name="Spa", meters=7004):
    return (bytes([B.TRACK_DATA]) + struct.pack("<i", 7) + s(name)
            + struct.pack("<i", 15) + struct.pack("<i", meters))


# ── falsk ACC: lyssnar på UDP och loggar vad vi skickar ────────────────────
class FakeAcc(asyncio.DatagramProtocol):
    def __init__(self):
        self.requests = []          # (typ, tidpunkt)
        self.peer = None
        self.transport = None
        self.loop = asyncio.get_event_loop()

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, addr):
        self.peer = addr
        self.requests.append((data[0], self.loop.time()))

    def send(self, payload):
        if self.peer:
            self.transport.sendto(payload, self.peer)


async def main():
    # Skriv en broadcasting.json i UTF-16 utan BOM — precis som ACC gör. Att den
    # kodningen hanteras är i sig värt att testa: utf-8 "lyckas" men ger nullbytes.
    tmp = Path(os.environ.get("TEMP", "/tmp")) / "acc-overlay-test-broadcasting.json"

    loop = asyncio.get_running_loop()
    fake = FakeAcc()
    transport, _ = await loop.create_datagram_endpoint(lambda: fake, local_addr=("127.0.0.1", 0))
    port = transport.get_extra_info("socket").getsockname()[1]

    tmp.write_bytes(('{\n "updListenerPort": %d,\n "connectionPassword": "hemligt",\n'
                     ' "commandPassword": ""\n}' % port).encode("utf-16-le"))

    cfg = B.read_config(tmp)
    check("broadcasting.json i UTF-16 utan BOM läses",
          cfg is not None and cfg.get("updListenerPort") == port,
          f"port {cfg.get('updListenerPort') if cfg else None}")

    bc = B.AccBroadcast(update_ms=100, config_path=str(tmp))
    started = await bc.start()
    check("källan startar och registrerar", started and bc.status == "connecting", bc.status)

    await asyncio.sleep(0.3)
    check("registreringspaket skickat", any(k == B.REGISTER_COMMAND_APPLICATION for k, _ in fake.requests),
          f"{[k for k, _ in fake.requests]}")

    # ── handskakning ────────────────────────────────────────────────────────
    fake.send(registration_result(cid=7, ok=1))
    await asyncio.sleep(0.3)
    check("registreringssvar ger live-status", bc.status == "live" and bc.connection_id == 7,
          f"status={bc.status} cid={bc.connection_id}")
    check("entry list och track data begärs vid anslutning",
          any(k == B.REQUEST_ENTRY_LIST for k, _ in fake.requests)
          and any(k == B.REQUEST_TRACK_DATA for k, _ in fake.requests))

    # ── data ────────────────────────────────────────────────────────────────
    fake.send(entry_list(cars=(3,)))
    fake.send(entry_list_car(car=3, num=63, first="Leo", last="Gustafsson", team="RaceRipp"))
    fake.send(track_data("Spa", 7004))
    fake.send(realtime_update(phase=5, focused=3))
    fake.send(realtime_car_update(car=3, gear=4, kmh=210, pos=2, spline=0.42, laps=5, delta=-350))
    await asyncio.sleep(0.4)

    snap = bc.snapshot()
    e = snap["entries"].get("3", {})
    check("entry list ger förarnamn, nummer och team",
          e.get("name") == "Leo Gustafsson" and e.get("num") == 63 and e.get("team") == "RaceRipp",
          e)

    car = next((c for c in snap["cars"] if c["i"] == 3), None)
    ok = car and (abs(car["spline"] - 0.42) < 1e-6 and car["laps"] == 5 and car["kmh"] == 210
                  and car["pos"] == 2 and car["gear"] == 4 and car["deltaMs"] == -350
                  and car["loc"] == "track" and car["bestMs"] == 136250 and car["curMs"] is None)
    check("realtidsuppdateringen tolkas fält för fält", bool(ok), car)

    check("session och bana tolkas",
          snap["session"].get("phase") == "session" and snap["session"].get("focusedCarIndex") == 3
          and snap["track"].get("name") == "Spa" and snap["track"].get("meters") == 7004,
          f"{snap['session'].get('phase')} / {snap['track']}")

    # ── ogiltig varvtid ska bli None, inte ett sentinelvärde ───────────────
    check("ogiltig varvtid blir None (inte 2147483647)", car and car["curMs"] is None, car and car["curMs"])

    # ── okänd bil → omfrågan, men rate-limitad ────────────────────────────
    before = len([1 for k, _ in fake.requests if k == B.REQUEST_ENTRY_LIST])
    for _ in range(20):
        fake.send(realtime_car_update(car=99))
    await asyncio.sleep(0.5)
    after = len([1 for k, _ in fake.requests if k == B.REQUEST_ENTRY_LIST])
    check("okänd bil utlöser omfrågan av entry list", after > before, f"{before} → {after}")
    check("omfrågan är rate-limitad (max ~1/s)", after - before <= 2,
          f"{after - before} förfrågningar på 20 okända paket")

    # ── bil som lämnat sessionen städas bort ──────────────────────────────
    fake.send(entry_list(cars=(3,)))
    await asyncio.sleep(0.3)
    check("bil som inte längre står i entry list städas bort",
          99 not in {c["i"] for c in bc.snapshot()["cars"]},
          sorted(c["i"] for c in bc.snapshot()["cars"]))

    # ── skräp får inte fälla motorn ───────────────────────────────────────
    for junk in (b"", b"\x03", bytes([B.REALTIME_CAR_UPDATE]) + b"\x01\x02",
                 bytes([200]) + b"x" * 40, os.urandom(64)):
        fake.send(junk)
    await asyncio.sleep(0.4)
    check("trasiga paket fäller inte källan", bc.status == "live" and bc.transport is not None,
          bc.status)

    # ── felloggen måste vara strypt ───────────────────────────────────────
    # Stämmer inte byte-layouten mot riktiga ACC misslyckas VARJE paket, och spelet
    # skickar ~200/s med fullt startfält. En rad per paket hade dränkt all annan
    # diagnostik i en pipe (§8.6b). Detta är det mest sannolika felläget för kod som
    # aldrig körts mot spelet, så det ska mätas.
    import io, contextlib
    bc._parse_errs, bc._last_err_log = 0, 0.0
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        for _ in range(200):
            fake.send(bytes([B.REALTIME_CAR_UPDATE]) + b"\x01\x02")
        await asyncio.sleep(0.6)
    lines = [l for l in buf.getvalue().splitlines() if "kunde ej tolka" in l]
    check("felloggen är strypt vid ihållande parse-fel",
          bc._parse_errs > 50 and len(lines) <= 2,
          f"{bc._parse_errs} fel gav {len(lines)} loggrader")

    # ── entries-dirty-flaggan styr omsändning ─────────────────────────────
    bc.mark_entries_sent()
    check("entries markeras som skickad", bc.snapshot()["entriesDirty"] is False)
    fake.send(entry_list_car(car=4, num=7, first="Ny", last="Förare", team="X"))
    await asyncio.sleep(0.3)
    check("ny bil gör entries smutsig igen", bc.snapshot()["entriesDirty"] is True)

    # ── avregistrering vid stängning ──────────────────────────────────────
    bc.close()
    await asyncio.sleep(0.2)
    check("avregistrering skickas vid stängning",
          any(k == B.UNREGISTER_COMMAND_APPLICATION for k, _ in fake.requests))

    transport.close()
    try: tmp.unlink()
    except OSError: pass


asyncio.run(main())
print(f"\n{failed} kontroll(er) misslyckades" if failed else "\nAllt OK")
sys.exit(1 if failed else 0)
