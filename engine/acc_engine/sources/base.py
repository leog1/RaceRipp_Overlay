"""Källgränssnitt: en källa producerar en Frame per read()."""
from __future__ import annotations
from ..frame import Frame


class Source:
    name = "base"
    def read(self) -> Frame:          # pragma: no cover
        raise NotImplementedError
    def close(self) -> None:
        pass
