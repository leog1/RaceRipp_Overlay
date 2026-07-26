"""Liten statisk HTTP-server så OBS kan ladda overlays som browser source, t.ex.
http://127.0.0.1:8078/overlays/delta-bar/index.html . Kör i egen tråd."""
from __future__ import annotations
import http.server, functools, threading
from pathlib import Path


def start(root: Path, host: str, port: int) -> threading.Thread:
    handler = functools.partial(_Quiet, directory=str(root))
    httpd = http.server.ThreadingHTTPServer((host, port), handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True, name="http-static")
    t.start()
    return t


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):  # tyst
        pass
