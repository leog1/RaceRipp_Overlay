"""WebSocket-buss: broadcastar telemetriramar (JSON) till alla anslutna klienter
(overlays + OBS). Läser INTE spelet — det gör källorna."""
from __future__ import annotations
import asyncio, json
import websockets


class Bus:
    def __init__(self):
        # ws -> pågående send-task (eller None). Vi håller reda på tasken för att
        # kunna HOPPA en ram för en klient som inte hunnit ta emot förra.
        self._clients: dict = {}

    async def handler(self, ws):
        self._clients[ws] = None
        try:
            await ws.wait_closed()
        finally:
            self._clients.pop(ws, None)

    async def broadcast(self, frame: dict):
        """Skickar utan att blockera läsloopen.

        Tidigare awaitades varje ws.send() i tur och ordning: en trög klient
        (minimerad OBS, strypt browserflik) stallade hela 40 Hz-loopen och ALLA
        overlays hackade. Nu skickas ramar parallellt, och en klient som ligger
        efter får hoppa framen i stället — färsk telemetri är ändå det enda som
        är värt något.
        """
        if not self._clients:
            return
        msg = json.dumps(frame, separators=(",", ":"))
        for ws, task in list(self._clients.items()):
            if task is not None and not task.done():
                continue                      # hänger efter → hoppa denna ram
            self._clients[ws] = asyncio.create_task(self._send(ws, msg))

    async def _send(self, ws, msg: str):
        # Fångar allt: en död klient ska bara försvinna ur setet, aldrig ge en
        # oupphämtad task-exception.
        try:
            await ws.send(msg)
        except Exception:
            self._clients.pop(ws, None)

    async def start(self, host: str, port: int):
        """Startar servern. Kastar OSError om porten redan är upptagen
        (t.ex. när en tidigare motor lever kvar) — anroparen loggar det."""
        return await websockets.serve(self.handler, host, port)
