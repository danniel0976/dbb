#!/usr/bin/env python3
"""
Build CardKingdom price cache keyed by SCRYFALL ID.

RUNS ON THE MACBOOK (16GB RAM) — never on the VPS (1.9GB, OOMs on these files).
Deploy: scp this to macbook, run with nohup, scp results back.

Inputs (downloaded to ~/dbb-price-build/):
  - MTGJSON AllIdentifiers.json.gz (~600MB decompressed) -> uuid -> scryfallId map
  - MTGJSON AllPricesToday.json.gz (~200MB decompressed) -> CardKingdom prices

Outputs (in ~/dbb-price-build/):
  - ck-prices.json  {prices: {scryfallId: {n,f,b}}, names: {name_lower: {n,f,b}}, _meta}
                    n=retail normal, f=retail foil, b=buylist normal (USD).
                    names index = cheapest normal-retail printing, used by the API as
                    fallback when the DB's scryfall_id is a different printing.
  - uuid-to-scryfall.json.gz {mtgjsonUuid: [scryfallId, name]} — small artifact the
                    VPS daily cron reuses so it only ever parses AllPricesToday.
"""
import json, gzip, os, sys, gc, datetime, subprocess

WORK = os.path.expanduser("~/dbb-price-build")
os.makedirs(WORK, exist_ok=True)

def download(url, path):
    # mtgjson.com 403s default python/curl agents; send a browser-ish UA
    if os.path.exists(path) and os.path.getsize(path) > 1_000_000:
        print(f"[skip] {path} already downloaded", flush=True)
        return
    print(f"[dl] {url}", flush=True)
    subprocess.run([
        "curl", "-fSL", "--retry", "3", "-A", "Mozilla/5.0 (DBB price bot)",
        "-o", path + ".part", url,
    ], check=True)
    os.rename(path + ".part", path)
    print(f"[dl] done {os.path.getsize(path)/1e6:.0f}MB", flush=True)

ids_gz = os.path.join(WORK, "AllIdentifiers.json.gz")
prices_gz = os.path.join(WORK, "AllPricesToday.json.gz")
download("https://mtgjson.com/api/v5/AllIdentifiers.json.gz", ids_gz)
download("https://mtgjson.com/api/v5/AllPricesToday.json.gz", prices_gz)

print("[parse] AllIdentifiers ...", flush=True)
with gzip.open(ids_gz, "rt", encoding="utf-8") as f:
    ids = json.load(f)["data"]
uuid_to_scry = {}
for uuid, card in ids.items():
    s = (card.get("identifiers") or {}).get("scryfallId")
    if s:
        uuid_to_scry[uuid] = [s, card.get("name") or ""]
print(f"[parse] uuid->scryfall mappings: {len(uuid_to_scry)}", flush=True)
del ids
gc.collect()

print("[parse] AllPricesToday ...", flush=True)
with gzip.open(prices_gz, "rt", encoding="utf-8") as f:
    prices = json.load(f)["data"]

def latest(series):
    if not series:
        return None
    return series[max(series.keys())]

by_id, by_name, unmapped = {}, {}, 0
for uuid, entry in prices.items():
    ck = (entry.get("paper") or {}).get("cardkingdom")
    if not ck:
        continue
    retail = ck.get("retail") or {}
    buylist = ck.get("buylist") or {}
    n = latest(retail.get("normal"))
    fo = latest(retail.get("foil"))
    b = latest(buylist.get("normal"))
    if n is None and fo is None and b is None:
        continue
    mapped = uuid_to_scry.get(uuid)
    if not mapped:
        unmapped += 1
        continue
    scry, name = mapped
    rec = {}
    if n is not None: rec["n"] = n
    if fo is not None: rec["f"] = fo
    if b is not None: rec["b"] = b
    by_id[scry] = rec
    # name index keeps the cheapest normal-retail printing (fallback pricing
    # should never overquote); entries without a normal price only fill gaps
    if name:
        key = name.lower()
        cur = by_name.get(key)
        if cur is None or (n is not None and (cur.get("n") is None or n < cur["n"])):
            by_name[key] = rec

out = {
    "prices": by_id,
    "names": by_name,
    "_meta": {
        "source": "cardkingdom via mtgjson AllPricesToday",
        "built": datetime.datetime.utcnow().isoformat() + "Z",
        "ids": len(by_id),
        "names": len(by_name),
        "unmapped_uuids": unmapped,
    },
}
print(f"[build] CK ids: {len(by_id)}, names: {len(by_name)}, unmapped uuids: {unmapped}", flush=True)

with open(os.path.join(WORK, "ck-prices.json"), "w") as f:
    json.dump(out, f, separators=(",", ":"))
with gzip.open(os.path.join(WORK, "uuid-to-scryfall.json.gz"), "wt", encoding="utf-8") as f:
    json.dump(uuid_to_scry, f, separators=(",", ":"))
print("[done] wrote ck-prices.json + uuid-to-scryfall.json.gz", flush=True)
