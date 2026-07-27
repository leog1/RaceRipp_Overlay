"""ACC Broadcasting Network — andra datakällan, vid sidan av delat minne.

Delat minne ger bara DIN bil. Broadcasting-API:t (Kunos officiella UDP-protokoll)
ger de andra: entry list med förarnamn/startnummer/team, per-bil spline-position
(0..1 runt varvet) och varvräkning — alltså det som krävs för gap i sekunder.

Skiljer sig från `sources/base.py:Source` med flit: den här källan är PUSH-baserad.
ACC skickar paket i sin egen takt (msRealtimeUpdateInterval), och 40 Hz-loopen läser
en ögonblicksbild med `snapshot()` i stället för att polla. Att pressa in det i
`read() -> Frame` hade betytt att blockera loopen på en socket.

Ingen portkonflikt av §8.1-typ: vi BINDER inte 9000, vi skickar TILL den från en
efemär lokal port. Flera klienter (vi, Race Element, SimHub) kan vara registrerade
samtidigt — ACC ger var och en sitt eget connectionId.

Protokollet är dokumenterat av Kunos men vår tolkning av byte-layouten är INTE
verifierad mot spelet ännu (se CLAUDE.md §7). `tests/broadcast_protocol.py` testar
parsern mot vår förståelse; `engine/broadcast_test.py` testar förståelsen mot ACC.
"""
from __future__ import annotations
import asyncio, json, os, struct, time
from pathlib import Path
from typing import Optional

PROTOCOL_VERSION = 4

# utgående
REGISTER_COMMAND_APPLICATION = 1
UNREGISTER_COMMAND_APPLICATION = 9
REQUEST_ENTRY_LIST = 10
REQUEST_TRACK_DATA = 11

# inkommande
REGISTRATION_RESULT = 1
REALTIME_UPDATE = 2
REALTIME_CAR_UPDATE = 3
ENTRY_LIST = 4
TRACK_DATA = 5
ENTRY_LIST_CAR = 6
BROADCASTING_EVENT = 7

# CarLocationEnum
_LOC = {0: "none", 1: "track", 2: "pitlane", 3: "pitentry", 4: "pitexit"}

# SessionPhase
_PHASE = {0: "none", 1: "starting", 2: "preformation", 3: "formationlap",
          4: "preseason", 5: "session", 6: "sessionover", 7: "postsession",
          8: "resultui"}

# ACC:s "ogiltig varvtid" — samma idé som sentinelvärdena i sources/acc.py
_INVALID_LAP = 2_147_483_647


def find_config(path: str = "") -> Optional[Path]:
    """broadcasting.json i ACC:s Config-mapp (eller en explicit sökväg)."""
    if path:
        p = Path(path)
        return p if p.exists() else None
    p = Path.home() / "Documents" / "Assetto Corsa Competizione" / "Config" / "broadcasting.json"
    return p if p.exists() else None


def read_config(path: Path) -> Optional[dict]:
    """ACC skriver sina config-JSON:er i UTF-16 LE **utan BOM**.

    Det gör att `utf-8-sig` "lyckas" men ger en sträng full av nullbytes — en tyst
    felkälla. Vi provar därför kodningar tills en faktiskt PARSAR som JSON, i stället
    för att lita på att avkodningen inte kastade.
    """
    try:
        raw = path.read_bytes()
    except OSError as e:
        print(f"[broadcast] kan ej läsa {path}: {e}")
        return None
    for enc in ("utf-8-sig", "utf-16", "utf-16-le", "utf-16-be"):
        try:
            return json.loads(raw.decode(enc))
        except Exception:
            continue
    print(f"[broadcast] {path} gick inte att tolka som JSON i någon känd kodning")
    return None


# ── binär (de)serialisering ──────────────────────────────────────────────────
# Allt är little-endian. Strängar är uint16-längd + UTF-8.
class _Reader:
    def __init__(self, buf: bytes):
        self.b = buf
        self.i = 0

    def _take(self, n: int) -> bytes:
        if self.i + n > len(self.b):
            raise ValueError("paketet slut mitt i ett fält")
        out = self.b[self.i:self.i + n]
        self.i += n
        return out

    def u8(self):  return self._take(1)[0]
    def i8(self):  return struct.unpack("<b", self._take(1))[0]
    def u16(self): return struct.unpack("<H", self._take(2))[0]
    def i32(self): return struct.unpack("<i", self._take(4))[0]
    def f32(self): return struct.unpack("<f", self._take(4))[0]

    def string(self) -> str:
        n = self.u16()
        return self._take(n).decode("utf-8", errors="replace")

    def lap(self) -> dict:
        ms = self.i32()
        car, drv = self.u16(), self.u16()
        splits = [self.i32() for _ in range(self.u8())]
        invalid, valid_for_best = self.u8(), self.u8()
        out_lap, in_lap = self.u8(), self.u8()
        return {
            "ms": None if ms >= _INVALID_LAP or ms <= 0 else ms,
            "carIndex": car, "driverIndex": drv,
            "splits": [None if s >= _INVALID_LAP or s <= 0 else s for s in splits],
            "invalid": bool(invalid), "validForBest": bool(valid_for_best),
            "outLap": bool(out_lap), "inLap": bool(in_lap),
        }


def _wstr(s: str) -> bytes:
    e = (s or "").encode("utf-8")
    return struct.pack("<H", len(e)) + e


class AccBroadcast(asyncio.DatagramProtocol):
    name = "acc-broadcast"

    def __init__(self, display_name="SimMatrix", update_ms=100, config_path=""):
        self.display_name = display_name
        self.update_ms = update_ms
        self.config_path = config_path
        self.transport = None
        self.connection_id: Optional[int] = None
        self.status = "off"            # off | connecting | live | error
        self.error = ""
        self._entries: dict[int, dict] = {}     # carIndex -> statisk info
        self._cars: dict[int, dict] = {}        # carIndex -> dynamiskt läge
        self._session: dict = {}
        self._track: dict = {}
        self._last_entry_req = 0.0
        self._last_packet = 0.0
        self._parse_errs = 0
        self._last_err_log = 0.0
        self._entries_dirty = True
        self._register_task = None
        self._addr = None
        self._password = ""
        self._cmd_password = ""

    # ── livscykel ───────────────────────────────────────────────────────────
    async def start(self) -> bool:
        cfg_path = find_config(self.config_path)
        if cfg_path is None:
            self.status = "off"
            self.error = "broadcasting.json saknas"
            print("[broadcast] broadcasting.json hittades inte — Broadcasting av. "
                  "(Den skapas av ACC i Documents\\Assetto Corsa Competizione\\Config.)")
            return False
        cfg = read_config(cfg_path)
        if cfg is None:
            self.status = "error"
            self.error = "broadcasting.json gick inte att tolka"
            return False

        port = int(cfg.get("updListenerPort") or 9000)
        self._password = cfg.get("connectionPassword") or ""
        self._cmd_password = cfg.get("commandPassword") or ""
        self._addr = ("127.0.0.1", port)

        loop = asyncio.get_running_loop()
        try:
            # Egen efemär lokal port; vi skickar TILL ACC:s lyssnarport. Alltså ingen
            # risk att krocka med en annan broadcasting-klient.
            self.transport, _ = await loop.create_datagram_endpoint(
                lambda: self, remote_addr=self._addr)
        except OSError as e:
            self.status = "error"
            self.error = f"kunde ej öppna UDP-socket: {e}"
            print(f"[broadcast] {self.error}")
            return False

        self.status = "connecting"
        print(f"[broadcast] registrerar mot ACC på {self._addr[0]}:{port} "
              f"(lösenord {'satt' if self._password else 'tomt'}, {self.update_ms} ms)")
        self._register_task = asyncio.create_task(self._register_loop())
        return True

    async def _register_loop(self):
        """Registreringen skickas om tills ACC svarar. Spelet behöver inte vara igång
        när vi startar — motorn startar före ACC lika ofta som efter."""
        try:
            while self.connection_id is None:
                self._send(bytes([REGISTER_COMMAND_APPLICATION, PROTOCOL_VERSION])
                           + _wstr(self.display_name)
                           + _wstr(self._password)
                           + struct.pack("<I", self.update_ms)
                           + _wstr(self._cmd_password))
                await asyncio.sleep(2.0)
        except asyncio.CancelledError:
            pass

    def close(self):
        if self._register_task:
            self._register_task.cancel()
        if self.transport and self.connection_id is not None:
            try:
                self._send(bytes([UNREGISTER_COMMAND_APPLICATION])
                           + struct.pack("<i", self.connection_id))
            except Exception:
                pass
        if self.transport:
            try: self.transport.close()
            except Exception: pass
        self.transport = None

    def _send(self, payload: bytes):
        if self.transport:
            try: self.transport.sendto(payload)
            except Exception as e: print("[broadcast] send-fel:", e)

    # ── asyncio.DatagramProtocol ────────────────────────────────────────────
    def datagram_received(self, data: bytes, addr):
        # Ett trasigt paket får ALDRIG fälla motorn (§8.6). Vi har dessutom aldrig
        # sett riktig ACC-trafik, så här är det extra sannolikt att något förvånar.
        try:
            self._handle(data)
        except Exception as e:
            # Loggen MÅSTE vara strypt. Stämmer inte vår byte-layout misslyckas
            # VARJE paket, och ACC skickar ~10 Hz × antal bilar ≈ 200 paket/s — 200
            # rader/s till en pipe (§8.6b gjorde stdout radbuffrad) hade dränkt all
            # annan diagnostik och kostat mätbart. Första felet syns direkt, sedan
            # högst ett var 10:e sekund med räknaren.
            self._parse_errs += 1
            now = time.monotonic()
            if self._parse_errs == 1 or now - self._last_err_log > 10.0:
                self._last_err_log = now
                print(f"[broadcast] kunde ej tolka paket ({len(data)} B): {e} "
                      f"[{self._parse_errs} totalt]")

    def error_received(self, exc):
        # Vanligt på Windows: ICMP "port unreachable" när ACC inte lyssnar än.
        # Inte fatalt — registreringsloopen fortsätter försöka.
        pass

    def connection_lost(self, exc):
        self.transport = None

    def _handle(self, data: bytes):
        r = _Reader(data)
        kind = r.u8()
        self._last_packet = time.monotonic()

        if kind == REGISTRATION_RESULT:
            cid = r.i32()
            ok, _read_only = r.u8(), r.u8()
            msg = r.string()
            if ok:
                self.connection_id = cid
                self.status = "live"
                self.error = ""
                print(f"[broadcast] ansluten (connectionId={cid})")
                self._request(REQUEST_ENTRY_LIST)
                self._request(REQUEST_TRACK_DATA)
            else:
                # Nästan alltid fel connectionPassword. Utan detta meddelande är det
                # helt osynligt varför inga bilar dyker upp.
                self.status = "error"
                self.error = msg or "ACC avvisade registreringen"
                print(f"[broadcast] ACC avvisade registreringen: {self.error}")
                if self._register_task:
                    self._register_task.cancel()

        elif kind == REALTIME_UPDATE:
            r.u16(); r.u16()                       # eventIndex, sessionIndex
            session_type = r.u8()
            phase = r.u8()
            session_time = r.f32(); session_end = r.f32()
            focused = r.i32()
            r.string(); r.string(); r.string()     # kameraset, kamera, hud-sida
            if r.u8():                             # isReplayPlaying
                r.f32(); r.f32()
            self._session = {
                "type": session_type,
                "phase": _PHASE.get(phase, str(phase)),
                "timeMs": int(session_time),
                "remainingMs": int(session_end),
                "focusedCarIndex": focused,
            }

        elif kind == REALTIME_CAR_UPDATE:
            car = r.u16()
            driver = r.u16()
            r.u8()                                  # driverCount
            gear = r.i8() - 2                       # ACC: -2 = R, -1 = N
            r.f32(); r.f32(); r.f32()               # worldX, worldY, yaw
            loc = r.u8()
            kmh = r.u16()
            pos = r.u16(); cup_pos = r.u16(); track_pos = r.u16()
            spline = r.f32()
            laps = r.u16()
            delta = r.i32()
            best = r.lap(); last = r.lap(); cur = r.lap()
            self._cars[car] = {
                "i": car, "driver": driver, "gear": gear,
                "loc": _LOC.get(loc, str(loc)), "kmh": kmh,
                "pos": pos, "cupPos": cup_pos, "trackPos": track_pos,
                "spline": spline, "laps": laps, "deltaMs": delta,
                "bestMs": best["ms"], "lastMs": last["ms"], "curMs": cur["ms"],
            }
            # Okänd bil = vi missade entry list (den skickas bara på begäran, och ACC
            # slänger listan vid sessionsbyte). Fråga om — men HÖGST en gång per
            # sekund, annars stormar det när hela startfältet är okänt.
            if car not in self._entries:
                self._request_entry_list()

        elif kind == ENTRY_LIST:
            r.i32()                                 # connectionId
            n = r.u16()
            known = {r.u16() for _ in range(n)}
            # Bilar som lämnat sessionen ska inte ligga kvar i standings.
            # _cars måste städas för sig: en bil vi sett en REALTIME_CAR_UPDATE för men
            # aldrig fått en ENTRY_LIST_CAR till finns bara där, och blev annars kvar
            # för evigt — den drev dessutom en omfrågan varje sekund.
            for gone in [c for c in self._cars if c not in known]:
                self._cars.pop(gone, None)
            for gone in [c for c in self._entries if c not in known]:
                self._entries.pop(gone, None)
                self._entries_dirty = True

        elif kind == ENTRY_LIST_CAR:
            car = r.u16()
            model = r.u8()
            team = r.string()
            race_number = r.i32()
            cup = r.u8()
            r.i8()                                  # currentDriverIndex
            nationality = r.u16()
            drivers = []
            for _ in range(r.u8()):
                first, last, short = r.string(), r.string(), r.string()
                r.u8(); r.u16()                     # kategori, nationalitet
                drivers.append({"first": first, "last": last, "short": short})
            name = ""
            if drivers:
                d = drivers[0]
                name = (f"{d['first']} {d['last']}").strip() or d["short"]
            self._entries[car] = {
                "num": race_number, "name": name, "short": drivers[0]["short"] if drivers else "",
                "team": team, "cls": cup, "model": model, "nationality": nationality,
            }
            self._entries_dirty = True

        elif kind == TRACK_DATA:
            r.i32()                                 # connectionId
            name = r.string()
            track_id = r.i32()
            meters = r.i32()
            self._track = {"name": name, "id": track_id, "meters": meters}

        elif kind == BROADCASTING_EVENT:
            # Gulflagg, avåkning, varvavslut m.m. Inget vi visar ännu — men den måste
            # LÄSAS, annars ser den ut som ett trasigt paket i loggen.
            pass

    def _request(self, kind: int):
        if self.connection_id is not None:
            self._send(bytes([kind]) + struct.pack("<i", self.connection_id))

    def _request_entry_list(self):
        now = time.monotonic()
        if now - self._last_entry_req < 1.0:
            return
        self._last_entry_req = now
        self._request(REQUEST_ENTRY_LIST)

    # ── läsning från 40 Hz-loopen ───────────────────────────────────────────
    def snapshot(self) -> dict:
        """Aktuellt läge. `entries` returneras bara när den ändrats — anroparen
        avgör när den ska skickas om (se __main__)."""
        return {
            "cars": sorted(self._cars.values(), key=lambda c: c["i"]),
            "entries": {str(k): v for k, v in self._entries.items()},
            "session": dict(self._session),
            "track": dict(self._track),
            "status": self.status,
            "error": self.error,
            "entriesDirty": self._entries_dirty,
        }

    def mark_entries_sent(self):
        self._entries_dirty = False
