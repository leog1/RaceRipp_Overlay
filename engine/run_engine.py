"""Fristående startpunkt för sidecar-bygget (PyInstaller).

Importerar paketet acc_engine så att relativa importer fungerar även när
koden körs som en fryst exe (där __main__.py annars saknar paket-sammanhang).
"""
from acc_engine.__main__ import main

if __name__ == "__main__":
    main()
