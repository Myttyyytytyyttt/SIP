# Lists the tick-array accounts recent swaps on the NVDAx pool actually used,
# so clone-fixtures.sh can clone them for the local fork test.
import json, urllib.request, hashlib, time, sys
RPC = "https://api.mainnet-beta.solana.com"
POOL = "49iMatQtoyabsYAQc8GafVq6aeBFVDxSRH44oiatyyw6"
CLMM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

def b58d(s):
    n = 0
    for c in s:
        n = n * 58 + B58.index(c)
    b = n.to_bytes((n.bit_length() + 7) // 8, "big")
    pad = 0
    for c in s:
        if c == "1":
            pad += 1
        else:
            break
    return b"\0" * pad + b

def rpc(method, params):
    for attempt in range(3):
        try:
            req = urllib.request.Request(
                RPC,
                json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                {"content-type": "application/json"},
            )
            return json.loads(urllib.request.urlopen(req).read())["result"]
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 2:
                time.sleep(3)
                continue
            raise
    return None

disc = hashlib.sha256(b"global:swap_v2").digest()[:8].hex()
fixed = set(json.load(open("harness/raydium/captured-swap.json"))["accounts"][:13])
ticks = set()
sigs = rpc("getSignaturesForAddress", [POOL, {"limit": 12}]) or []
for s in sigs:
    if s["err"] is not None:
        continue
    time.sleep(0.6)
    tx = rpc("getTransaction", [s["signature"], {"maxSupportedTransactionVersion": 0, "encoding": "json"}])
    if not tx:
        continue
    msg = tx["transaction"]["message"]
    loaded = tx["meta"].get("loadedAddresses") or {}
    allk = msg["accountKeys"] + loaded.get("writable", []) + loaded.get("readonly", [])
    for ix in msg["instructions"]:
        if allk[ix["programIdIndex"]] != CLMM:
            continue
        data = b58d(ix["data"])
        if data[:8].hex() != disc:
            continue
        for a in [allk[i] for i in ix["accounts"]][13:]:
            if a not in fixed:
                ticks.add(a)
json.dump(sorted(ticks), open("harness/raydium/tick-arrays.json", "w"), indent=1)
print(f"tick arrays: {len(ticks)}")
for t in sorted(ticks):
    print(" ", t)
