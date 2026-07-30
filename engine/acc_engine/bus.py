"""WebSocket-buss: broadcastar telemetriramar (JSON) till alla anslutna klienter
(overlays + OBS). Läser INTE spelet — det gör källorna."""
from __future__ import annotations
import asyncio, json
import websockets


class _Client:
    """En ansluten klient med EN långlivad skrivtråd och en enda ram i kö.

    Slotten `pending` är hela flödeskontrollen: broadcast lägger den färskaste ramen
    där och väcker skrivaren. Hinner skrivaren inte med skrivs slotten bara över, och
    klienten hoppar de mellanliggande ramarna — färsk telemetri är ändå det enda som
    är värt något för en overlay.
    """

    __slots__ = ("ws", "pending", "wake", "task")

    def __init__(self, ws):
        self.ws = ws
        self.pending = None
        self.wake = asyncio.Event()
        self.task = None


class Bus:
    def __init__(self):
        self._clients: dict = {}          # ws → _Client

    async def handler(self, ws):
        c = _Client(ws)
        self._clients[ws] = c
        c.task = asyncio.create_task(self._writer(c))
        try:
            await ws.wait_closed()
        finally:
            self._clients.pop(ws, None)
            c.task.cancel()

    async def broadcast(self, frame: dict):
        """Skickar utan att blockera läsloopen.

        Två saker som var för sig har kostat prestanda och som båda ligger i den här
        metoden:

        • Awaita ALDRIG klienterna i tur och ordning. En trög klient (minimerad OBS,
          strypt browserflik) stallade då hela 40 Hz-loopen och alla overlays hackade.

        • Skapa inte en task per klient och ram heller. Det var lösningen på det
          förra, men en `asyncio.create_task` är inte gratis: med tre klienter blev
          det 120 tasks i sekunden som skapades, schemalades och slängdes — allokering
          och GC-tryck i en process som delar CPU med simulatorn. Varje klient har
          därför nu EN skrivare som lever hela anslutningen och väcks med en Event.
        """
        if not self._clients:
            return
        msg = json.dumps(frame, separators=(",", ":"))
        for c in self._clients.values():
            c.pending = msg
            c.wake.set()

    async def _writer(self, c: _Client):
        try:
            while True:
                await c.wake.wait()
                c.wake.clear()
                msg, c.pending = c.pending, None
                if msg is None:
                    continue
                await c.ws.send(msg)
        except asyncio.CancelledError:
            raise
        except Exception:
            # Död klient: ur kartan och tyst ut. Aldrig en oupphämtad task-exception.
            self._clients.pop(c.ws, None)

    async def start(self, host: str, port: int):
        """Startar servern. Kastar OSError om porten redan är upptagen
        (t.ex. när en tidigare motor lever kvar) — anroparen loggar det."""
        return await websockets.serve(self.handler, host, port)
