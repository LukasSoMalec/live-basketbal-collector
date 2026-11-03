"""Read the SAME Football.com data path as collector, but print rejection reasons.

Run from repository root: python diagnostics/football_audit.py
Only summaries and event metadata; no bookmaker cookies or private access.
"""
import asyncio
import logging
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from collections import Counter

import httpx
from playwright.async_api import async_playwright
import collector as co


REJECT = re.compile(r"not started|pre.?match|scheduled|finished|final|^ns$", re.I)
seen = 0


def audit_parser(payload, rejected=None):
    global seen
    seen += 1
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        print("AUDIT invalid JSON schema", flush=True)
        return co._audit_original(payload, rejected)

    reasons = Counter()
    groups = Counter()
    descriptions = []
    for g in payload["data"]:
        if not isinstance(g, dict):
            reasons["bad_group"] += 1
            continue
        league = str(g.get("name") or "")
        for e in g.get("events", []):
            if not isinstance(e, dict):
                reasons["invalid_event"] += 1
                continue
            status = e.get("status")
            sport = (e.get("sport") or {}).get("id")
            state = str(e.get("matchStatus") or "").strip()
            home = str(e.get("homeTeamName") or "")
            away = str(e.get("awayTeamName") or "")
            if str(status) != "1":
                reason = "status_not_1"
            elif sport != "sr:sport:2":
                reason = "different_sport"
            elif not state:
                reason = "missing_match_status"
            elif REJECT.search(state):
                reason = "pregame_or_finished_status"
            elif not home or not away:
                reason = "missing_team"
            elif co.is_simulated(league, home, away):
                reason = "simulated_name"
            elif not co.local_date(e.get("estimateStartTime")):
                reason = "missing_date_in_apps_script"
            else:
                reason = "ACCEPT"
            reasons[reason] += 1
            groups[league + " [" + reason + "]"] += 1
            if str(status) == "1":
                descriptions.append((reason, league[:50], home[:35], away[:35],
                  state[:25], str(e.get("eventId"))[:50], str(e.get("setScore"))[:22],
                  co.local_date(e.get("estimateStartTime"))))
    print("AUDIT snapshot=", seen, "total=", sum(reasons.values()),
          "reasons=", dict(reasons), flush=True)
    print("AUDIT groups=", groups.most_common(40), flush=True)
    print("AUDIT LIVE candidates (max 85):", flush=True)
    for d in descriptions[:85]:
        print("AUDIT EVENT", repr(d), flush=True)
    result = co._audit_original(payload, rejected)
    print("AUDIT PARSED count=", None if result is None else len(result), flush=True)
    return result


async def main():
    logging.basicConfig(level=logging.INFO)
    co._audit_original = co.parse_football
    co.parse_football = audit_parser
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True,
          args=["--disable-dev-shm-usage", "--no-sandbox"])
        try:
            async with httpx.AsyncClient(follow_redirects=True,
              headers={"User-Agent": "Mozilla/5.0 (LIVE-Coverage-Monitor)",
                       "Accept": "application/json, text/plain, */*"}) as client:
                src = await co.football(browser, client)
                print("AUDIT SOURCE status=", src.status, "error=", src.error,
                      "final_matches=", [(m.home, m.away, m.state, m.date)
                                         for m in src.matches[:100]], flush=True)
        finally:
            await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
