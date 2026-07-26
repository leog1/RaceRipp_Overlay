"""Snabbtest av ACC delade minnet. Kör med ACC IGÅNG och ute på banan:
    python acc_test.py
"""
try:
    from pyaccsharedmemory import accSharedMemory
except Exception as e:
    print("FEL: pyaccsharedmemory är INTE installerat:", e)
    print("Kör:  pip install pyaccsharedmemory")
    raise SystemExit(1)

import time
asm = accSharedMemory()
try:
    for _ in range(8):
        sm = asm.read_shared_memory()
        if sm is None:
            print("read_shared_memory() = None  (ACC kör inte / inget delat minne)")
        else:
            p, g, s = sm.Physics, sm.Graphics, sm.Static
            st = getattr(g, "status", None); st = getattr(st, "name", st)
            print(f"status={st}  gas={p.gas:.2f} brake={p.brake:.2f} gear={p.gear} "
                  f"rpm={p.rpm} speed={p.speed_kmh:.0f}  pos={g.normalized_car_position:.3f}  "
                  f"best={g.best_time} cur={g.current_time}  driver={s.player_name!r}")
        time.sleep(0.5)
finally:
    asm.close()
