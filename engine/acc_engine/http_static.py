"""Liten statisk HTTP-server så OBS kan ladda overlays som browser source, t.ex.
http://127.0.0.1:8078/overlays/delta-bar/index.html . Kör i egen tråd."""
from __future__ import annotations
import http.server, functools, threading
from pathlib import Path


def start(root: Path, host: str, port: int) -> threading.Thread:
    """Kastar OSError om porten är upptagen — anroparen får avgöra om det är
    fatalt (det är det inte: OBS-servern är valfri, WS-bussen är det viktiga)."""
    handler = functools.partial(_Quiet, directory=str(root))
    httpd = _Server((host, port), handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True, name="http-static")
    t.start()
    return t


class _Server(http.server.ThreadingHTTPServer):
    # HTTPServer sätter allow_reuse_address=1, vilket på Windows låter en ANDRA
    # motor binda samma port och tyst kapa den (då blir det slumpmässigt vem som
    # svarar OBS). Vi vill i stället få ett ärligt OSError och logga det.
    allow_reuse_address = False


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):  # tyst
        pass
