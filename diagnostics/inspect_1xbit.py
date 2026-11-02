"""Print a privacy-safe shape summary of 1xBit's public match listing.

This intentionally excludes cookies, auth headers, and betting markets.
"""
import asyncio
from collections import Counter

import httpx
from collector import BIT_API

DISPLAY = ("I", "O1", "O2", "L", "LE", "SN", "SI", "S", "SC", "M", "IsLive",
           "G", "N", "B", "T", "LI", "CN", "CI", "C", "S1", "S2", "ST", "P", "K")

def brief(record):
    if not isinstance(record, dict):
        return {"type": type(record).__name__, "value": str(record)[:180]}
    out = {"keys": list(record.keys())[:90]}
    for k in DISPLAY:
        if k not in record:
            continue
        value = record[k]
        if isinstance(value, dict):
            out[k] = {x: str(y)[:120] if not isinstance(y, (dict, list)) else
                       {"type": type(y).__name__, "size": len(y)}
                       for x,y in list(value.items())[:16]}
        elif isinstance(value, list):
            out[k] = {"type": "list", "count": len(value),
                      "sample": brief(value[0]) if value else None}
        else:
            out[k] = str(value)[:150]
    return out

async def main():
    async with httpx.AsyncClient(timeout=20, follow_redirects=True,
                                 headers={"Accept": "application/json",
                                          "User-Agent": "Mozilla/5.0"}) as client:
        r = await client.get(BIT_API)
        print("HTTP:", r.status_code, "ctype:", r.headers.get("content-type"),
              "bytes:", len(r.content))
        if r.status_code != 200:
            return
        try:
            data = r.json()
        except ValueError:
            print("not JSON")
            return
        print("root:", type(data).__name__,
              "length:", len(data) if isinstance(data, (list, dict)) else None)
        if isinstance(data, dict):
            print("root keys:", list(data.keys())[:40])
            for k in ("Value", "value", "data", "games", "Games", "items"):
                if isinstance(data.get(k), list):
                    data = data[k]
                    print("events location:", k)
                    break
        if isinstance(data, list):
            print("first records:")
            for n, record in enumerate(data[:3]):
                print("record", n, brief(record))
            for k in ("SI", "SN", "S", "L", "LE", "G", "M", "IsLive"):
                counter = Counter(str(x.get(k))[:45] for x in data if isinstance(x,dict))
                print("distribution", k, counter.most_common(8))
        else:
            print("top shape:", brief(data))

if __name__ == "__main__":
    asyncio.run(main())
