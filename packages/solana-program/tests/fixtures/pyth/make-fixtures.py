# Writes the Pyth PriceUpdateV2 accounts settle_v3's tests preload into the
# validator (Anchor.toml [[test.validator.account]], and rehearsal/validator.ts).
#
# BUILT FROM MAINNET'S OWN BYTES. The two base64 strings below are the SOL/USD
# and USDC/USD accounts as mainnet returned them at slot 447_956_907, copied
# from packages/solana-core/test/fixtures/pyth-accounts.ts. Each fixture says
# what it changes; everything else is mainnet's.
#
# FRESH MEANS FAR IN THE FUTURE. settle_v3 refuses a publish more than a day
# old and has no upper bound (a future publish_time cannot be forged past the
# receiver), so a "fresh" fixture is published at 2100-01-01 and stays fresh
# for as long as these tests run. The untouched mainnet bytes are the stale one.
#
#   python3 -I tests/fixtures/pyth/make-fixtures.py tests/fixtures/pyth
import base64
import hashlib
import json
import os
import struct
import sys

SOL_USD = "IvEjY51+9M1bsRWwDdII6qyfKmvtWLaGyH3c9S5trfFYcCJDMhaezQHvDYtv2izrpB2hXUCV0do5Kg0vjtDGx7wPTPrIwoC1bT3RgGMCAAAANSAVAAAAAAD4////OqWsagAAAAA5paxqAAAAAKiftGACAAAABVkZAAAAAACdR7MaAAAAAAA="
USDC_USD = "IvEjY51+9M1Obu8PnqBjv5eIEq7D76ieT8TUJqeUwLMkUfRhMcnEcAHqoCDGHMR5cSgTRhzhU4lKlqbACyHtDPwnmNH5qenJSmCu9QUAAAAAmFcBAAAAAAD4////OqWsagAAAAA5paxqAAAAAGCw9QUAAAAA0kQBAAAAAACdR7MaAAAAAAA="
RECEIVER = "rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp"
# The push-oracle program the feed addresses derive under: it never owns a price account.
PUSH_ORACLE = "pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT"
FUTURE = 4_102_444_800  # 2100-01-01T00:00:00Z
VERIFICATION_AT = 40
ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58(raw):
    n = int.from_bytes(raw, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = ALPHABET[r] + out
    return "1" * (len(raw) - len(raw.lstrip(b"\0"))) + out


def address(name):
    return b58(hashlib.sha256(("sip-vault test pyth " + name).encode()).digest())


def body_at(data):
    return VERIFICATION_AT + (1 if data[VERIFICATION_AT] == 1 else 2)


def patched(data, price=None, publish_time=None):
    data = bytearray(data)
    body = body_at(data)
    if price is not None:
        data[body + 32 : body + 40] = struct.pack("<q", price)
    if publish_time is not None:
        data[body + 52 : body + 60] = struct.pack("<q", publish_time)
    return bytes(data)


def partial(full):
    # Partial { num_signatures: 5 }: two bytes where Full had one, so the body moves by one
    # and the trailing byte Full leaves is used up. Same 134 bytes.
    assert full[VERIFICATION_AT] == 1 and len(full) == 134
    return full[:VERIFICATION_AT] + bytes([0, 5]) + full[VERIFICATION_AT + 1 : -1]


sol = base64.b64decode(SOL_USD)
usdc = base64.b64decode(USDC_USD)
assert len(sol) == 134 and len(usdc) == 134
sol150 = patched(sol, price=15_000_000_000, publish_time=FUTURE)

FIXTURES = {
    # $150.00000000, Full, fresh: the ADR's worked example.
    "sol-usd-150": (sol150, RECEIVER),
    # mainnet's $102.59321149, Full, publish_time moved to 2100.
    "sol-usd-mainnet-fresh": (patched(sol, publish_time=FUTURE), RECEIVER),
    # mainnet's bytes untouched: published 2026-09-18, more than a day ago.
    "sol-usd-mainnet-stale": (sol, RECEIVER),
    # the $150 update behind a Partial verification level.
    "sol-usd-150-partial": (partial(sol150), RECEIVER),
    # mainnet's USDC/USD, publish_time moved to 2100: the right owner, the wrong feed.
    "usdc-usd-fresh": (patched(usdc, publish_time=FUTURE), RECEIVER),
    # the $150 update's bytes under an owner that is not the receiver.
    "sol-usd-150-wrong-owner": (sol150, PUSH_ORACLE),
}

out = sys.argv[1]
for name, (data, owner) in FIXTURES.items():
    account = {
        "pubkey": address(name),
        "account": {
            "lamports": (len(data) + 128) * 6_960,
            "data": [base64.b64encode(data).decode(), "base64"],
            "owner": owner,
            "executable": False,
            "rentEpoch": 18_446_744_073_709_551_615,
            "space": len(data),
        },
    }
    with open(os.path.join(out, name + ".json"), "w") as f:
        json.dump(account, f, indent=2)
        f.write("\n")
    print(name, address(name))
