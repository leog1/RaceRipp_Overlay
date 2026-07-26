"""WebSocket-buss: broadcastar telemetriramar (JSON) till alla anslutna klienter
(overlays + OBS). Läser INTE spelet — det gör källorna."""
from __future__ import annotations
import asyncio, json
import websockets


class Bus:
    def __init__(self):
        self._clients: set = set()

    async def handler(self, ws):
        self._clients.add(ws)
        try:
            await ws.wait_closed()
        finally:
            self._clients.discard(ws)

    async def broadcast(self, frame: dict):
        if not self._clients:
            return
        msg = json.dumps(frame, separators=(",", ":"))
        dead = []
        for ws in self._clients:
            try:
                await ws.send(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._clients.discard(ws)

    def serve(self, host: str, port: int):
        return websockets.serve(self.handler, host, port)
