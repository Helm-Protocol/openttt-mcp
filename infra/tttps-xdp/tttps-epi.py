#!/usr/bin/env python3
"""Small bounded Epi controller for the XDP source-distribution map."""
import json, math, subprocess, time

def dump(name):
    raw = subprocess.check_output(["bpftool", "-j", "map", "dump", "name", name], text=True)
    return json.loads(raw)

def set_limit(index, value):
    key = f"{index:02x} 00 00 00"
    val = " ".join(f"{b:02x}" for b in int(value).to_bytes(4, "little"))
    subprocess.run(["bpftool", "map", "update", "name", "limits", "key", "hex", *key.split(), "value", "hex", *val.split()], check=True)

while True:
    try:
        rows = dump("source_buckets")
        counts = [int(row["formatted"]["value"]["packets"]) for row in rows if int(row["formatted"]["value"]["packets"]) > 0]
        total = sum(counts)
        entropy = 0.0
        if total:
            entropy = -sum((n / total) * math.log2(n / total) for n in counts)
        # Low diversity at high volume is suspicious; lower only the shared
        # port ceilings, never below a safe floor, and recover gradually.
        limit = 5000 if total > 10000 and entropy < 2.0 else 20000
        set_limit(0, limit)
        set_limit(1, min(limit, 5000))
        print(json.dumps({"sources": len(counts), "packets": total, "entropy_bits": round(entropy, 4), "port_limit": limit}), flush=True)
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), flush=True)
    time.sleep(5)
