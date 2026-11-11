#!/usr/bin/env python3
"""Recover historical live snapshots attached to GitHub Actions runs.

Read-only: does not POST to Apps Script or edit the Sheets workbook.
The resulting JSONL artifact preserves each raw snapshot and provenance.
"""
from __future__ import annotations
import asyncio
import collections
import io
import json
import os
from pathlib import Path
import re
import sys
import zipfile
import httpx

API = "https://api.github.com"
SOURCES = {"SynotTip", "Football.com", "Fonbet", "1xBit"}
DEST = Path("recovery-output")
LIMIT = 18  # Up to 1800 artifacts; stop as soon as older artifacts are encountered.


async def request_json(client, url):
    for trial in range(4):
        response = await client.get(url)
        if response.status_code in (429, 502, 503, 504):
            await asyncio.sleep(1.5 * (trial + 1))
            continue
        response.raise_for_status()
        return response.json()
    raise RuntimeError("Exceeded retries fetching " + url)


async def list_artifacts(client):
    files = []
    from_date = os.environ.get("RECOVERY_FROM", "2026-11-03")
    for page in range(1, LIMIT + 1):
        data = await request_json(client,
            f"{API}/repos/{os.environ['GITHUB_REPOSITORY']}/actions/artifacts?per_page=100&page={page}")
        items = data.get("artifacts", [])
        for item in items:
            if not str(item.get("name", "")).startswith("live-basketball-"):
                continue
            if item.get("expired", False):
                continue
            if str(item.get("created_at", ""))[:10] < from_date:
                continue
            files.append(item)
        print(f"GitHub artifact page {page}: {len(items)} total, {len(files)} selected", flush=True)
        if len(items) < 100 or (items and str(items[-1].get("created_at", ""))[:10] < from_date):
            break
    return files


async def fetch_one(client, sem, a):
    async with sem:
        artifact_id = a["id"]
        url = f"{API}/repos/{os.environ['GITHUB_REPOSITORY']}/actions/artifacts/{artifact_id}/zip"
        for attempt in range(3):
            try:
                response = await client.get(url, timeout=90.0)
                response.raise_for_status()
                with zipfile.ZipFile(io.BytesIO(response.content)) as z:
                    options = [name for name in z.namelist() if name.endswith("latest.json")]
                    if not options:
                        return None, f"artifact {artifact_id}: missing latest.json"
                    payload = json.loads(z.read(options[0]))
                sources = payload.get("sources")
                stamp = payload.get("checkedAt")
                if not isinstance(sources, list) or not isinstance(stamp, str):
                    return None, f"artifact {artifact_id}: invalid format"
                if any(not isinstance(s, dict) or s.get("source") not in SOURCES
                       or not isinstance(s.get("matches"), list)
                       or len(s.get("matches")) > 3000 for s in sources):
                    return None, f"artifact {artifact_id}: invalid source list"
                return {"artifact_id": artifact_id,
                        "run_id": (a.get("workflow_run") or {}).get("id"),
                        "created_at": a.get("created_at"),
                        "checkedAt": stamp, "sources": sources}, None
            except Exception as exc:
                if attempt == 2:
                    return None, f"artifact {artifact_id}: {type(exc).__name__}: {exc}"
                await asyncio.sleep((attempt + 1) * 3)


async def main():
    token = os.environ.get("GH_TOKEN")
    if not token:
        raise RuntimeError("Missing GITHUB_TOKEN")
    DEST.mkdir(exist_ok=True)
    async with httpx.AsyncClient(
        headers={"Authorization": "Bearer " + token,
                 "Accept": "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28"},
        follow_redirects=True, timeout=90.0
    ) as client:
        artifacts = await list_artifacts(client)
        if not artifacts:
            raise RuntimeError("No recoverable artifacts")
        sem = asyncio.Semaphore(6)
        work = [fetch_one(client, sem, a) for a in artifacts]
        collected = await asyncio.gather(*work)
    successes = [item for item, error in collected if item]
    problems = [error for item, error in collected if error]
    # The same workflow run may have several uploaded artifacts after retries.
    # The newest valid artifact per exact snapshot timestamp wins.
    by_stamp = {}
    for entry in successes:
        stamp = entry["checkedAt"]
        if stamp not in by_stamp or entry["artifact_id"] > by_stamp[stamp]["artifact_id"]:
            by_stamp[stamp] = entry
    snapshots = sorted(by_stamp.values(), key=lambda x: x["checkedAt"])
    with (DEST / "snapshots.jsonl").open("w", encoding="utf-8") as file:
        for entry in snapshots:
            file.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")
    counts = collections.defaultdict(lambda: {"snapshots": 0, "observations": 0})
    for row in snapshots:
        day = row["checkedAt"][:10]
        counts[day]["snapshots"] += 1
        counts[day]["observations"] += sum(len(src.get("matches", []))
                                            for src in row["sources"])
    summary = {"listed_artifacts": len(artifacts),
               "downloaded_artifacts": len(successes),
               "distinct_snapshots": len(snapshots),
               "download_errors": len(problems),
               "by_day": dict(sorted(counts.items())),
               "errors": problems[:100],
               "first": snapshots[0]["checkedAt"] if snapshots else None,
               "last": snapshots[-1]["checkedAt"] if snapshots else None}
    (DEST / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
    if not snapshots or len(snapshots) < len(artifacts) // 2:
        raise RuntimeError("Recovered insufficient snapshots; inspect errors")


if __name__ == "__main__":
    asyncio.run(main())
