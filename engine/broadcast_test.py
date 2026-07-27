"""Snabbtest av ACC Broadcasting-UDP. Kör med ACC IGÅNG och en session laddad:
    python broadcast_test.py

Motsvarar acc_test.py, fast för den andra datakällan. Detta är det enda som kan
avgöra om vår tolkning av byte-layouten stämmer med spelet — tests/broadcast_protocol.py
testar bara parsern mot vår egen förståelse av protokollet (CLAUDE.md §7).

Vad du ska se om allt stämmer:
  • "ansluten (connectionId=…)" inom ett par sekunder
  • förarnamn och startnummer som matchar sessionens deltagare
  • spline 0..1 som ökar när bilarna kör, och wrappar vid mållinjen
  • varvtider i rimliga millisekunder (inte 2147483647 eller negativa)

Ser du "ACC avvisade registreringen" är connectionPassword fel — jämför med
Documents\\Assetto Corsa Competizione\\Config\\broadcasting.json.
"""
from __future__ import annotations
import asyncio, sys
from acc_engine.sources.acc_broadcast import AccBroadcast, find_config, read_config


async def main():
    cfg = find_config()
    if cfg is None:
        print("FEL: broadcasting.json hittades inte i ACC:s Config-mapp.")
        print("Starta ACC en gång så skapas den, eller ange sökvägen som argument.")
        return 1
    print(f"config: {cfg}")
    data = read_config(cfg)
    if data is None:
        return 1
    print(f"  port={data.get('updListenerPort')}  "
          f"lösenord={'satt' if data.get('connectionPassword') else 'TOMT'}")

    bc = AccBroadcast(display_name="ACC Overlay (test)", update_ms=100)
    if not await bc.start():
        print("FEL: kunde inte starta Broadcasting-källan.")
        return 1

    try:
        for i in range(30):                      # ~15 s
            await asyncio.sleep(0.5)
            s = bc.snapshot()
            if s["status"] != "live":
                print(f"[{i:02d}] status={s['status']} {s['error']}")
                continue
            t, ses = s["track"], s["session"]
            print(f"[{i:02d}] bana={t.get('name')!r} {t.get('meters')} m  "
                  f"fas={ses.get('phase')}  fokus={ses.get('focusedCarIndex')}  "
                  f"{len(s['cars'])} bilar, {len(s['entries'])} i entry list")
            for c in s["cars"][:6]:
                e = s["entries"].get(str(c["i"]), {})
                print(f"      #{e.get('num','?'):>3} {e.get('name','(okänd)'):<22} "
                      f"P{c['pos']:<2} varv={c['laps']:<3} spline={c['spline']:.3f} "
                      f"{c['kmh']:>3} km/h  {c['loc']:<8} bäst={c['bestMs']}")
    finally:
        bc.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
