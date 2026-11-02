#!/usr/bin/env python3
"""LIVE basketball coverage from public feeds; no account login or bets."""
import asyncio
import json
import logging
import os
import re
import unicodedata
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import httpx
from playwright.async_api import async_playwright

TZ = ZoneInfo("Europe/Prague")
SYN_URL = "https://sport.synottip.cz/live"
FOOT_API = "https://www.football.com/api/ng/factsCenter/configurableLiveOrPrematchEvents?sportId=sr%3Asport%3A2"
FOOT_PAGE = "https://www.football.com/ng/m/sport/basketball/live_list"
FON_URL = "https://fonbet.com.cy/live/basketball"
FON_API = "https://line-lb51.bk6bba-resources.com/events/listBase?lang=en&scopeMarket=1600"
BIT_URL = "https://1xbit-8976.pro/cs/live/basketball"
BIT_API = ("https://1xbit-8976.pro/service-api/main-live-feed/v3/games1x2"
           "?cfView=3&count=40&fcountry=204&gr=933&grMode=4&lng=cs&ref=65&selectedMs=1.3,2.3,10.3")
LOG = logging.getLogger("basketball")


@dataclass
class Match:
    home: str
    away: str
    competition: str
    date: str
    eventId: str = ""
    providerId: str = ""
    state: str = ""
    score: str = ""


@dataclass
class Source:
    source: str
    status: str = "NEDOSTUPNÉ"
    complete: bool = False
    matches: list[Match] = field(default_factory=list)
    error: str = ""

    def as_dict(self) -> dict:
        return asdict(self)


def local_date(value: Any) -> str:
    try:
        if isinstance(value, (int, float)):
            seconds = value / (1000 if value > 10**11 else 1)
            return datetime.fromtimestamp(seconds, TZ).date().isoformat()
        if isinstance(value, str) and value:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return (dt.astimezone(TZ) if dt.tzinfo else dt).date().isoformat()
    except (ValueError, OverflowError, OSError):
        pass
    return ""


def split_teams(name: Any) -> tuple[str, str]:
    if not isinstance(name, str):
        return "", ""
    a = re.split(r"\s+[-–]\s+", name.strip(), maxsplit=1)
    return (a[0].strip(), a[1].strip()) if len(a) == 2 else ("", "")


def is_simulated(*values: str) -> bool:
    text = " ".join(str(x or "") for x in values).lower()
    return bool(re.search(r"(?<![a-z])(ebasket|e-basket|cyber|simulated|simulation|virtual|bskt cup|esport)", text))


def dedup(matches: list[Match]) -> list[Match]:
    found, seen = [], set()
    for m in matches:
        key = m.eventId or (m.date, m.home.lower(), m.away.lower())
        if key not in seen:
            found.append(m)
            seen.add(key)
    return found


def parse_synot(payload: Any) -> list[Match] | None:
    """Return None on invalid response, [] on valid but empty basket response."""
    if not isinstance(payload, dict) or payload.get("Result") != 1:
        return None
    groups = payload.get("ReturnValue")
    if not isinstance(groups, list):
        return None
    basket = next((g for g in groups if isinstance(g, dict)
                   and (str(g.get("DisciplineID")) == "21"
                        or g.get("Name") in ("Basketbal", "Basketball"))), None)
    if basket is None or not isinstance(basket.get("Events"), list):
        return None
    result = []
    for e in basket["Events"]:
        if not isinstance(e, dict) or (
                e.get("SportExtId") and e.get("SportExtId") != "sr:sport:2"):
            continue
        home, away = split_teams(e.get("Name"))
        if not home or not away or is_simulated(e.get("CategoryPath"), home, away):
            continue
        external = str(e.get("ExternalID") or "")
        scores = e.get("Results") or []
        score = next((r.get("Score", "") for r in scores
                      if isinstance(r, dict) and r.get("MainResult")), "")
        result.append(Match(home, away, e.get("CategoryPath") or "",
                            local_date(e.get("Date")),
                            "sr:match:" + external if external.isdigit() else "",
                            str(e.get("ID") or ""), str(e.get("StateName") or ""), str(score)))
    return dedup(result)


def parse_football(payload: Any) -> list[Match] | None:
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        return None
    matches = []
    for group in payload["data"]:
        if not isinstance(group, dict) or not isinstance(group.get("events"), list):
            continue
        league = group.get("name") or ""
        for e in group["events"]:
            if not isinstance(e, dict):
                continue
            if str(e.get("status")) != "1" or (
                    (e.get("sport") or {}).get("id") != "sr:sport:2"):
                continue
            state = str(e.get("matchStatus") or "").strip()
            if not state or re.search(r"not started|pre.?match|scheduled|finished|final|^ns$", state, re.I):
                continue
            home, away = e.get("homeTeamName") or "", e.get("awayTeamName") or ""
            if not home or not away or is_simulated(league, home, away):
                continue
            event_id = str(e.get("eventId") or "")
            matches.append(Match(home, away, league, local_date(e.get("estimateStartTime")),
                                 event_id if event_id.startswith("sr:match:") else "",
                                 str(e.get("gameId") or ""), state, str(e.get("setScore") or "")))
    return dedup(matches)



def parse_fonbet(payload: Any) -> list[Match] | None:
    """Parse a complete Fonbet event listing, not a versioned delta packet.

    The event sportId usually refers to a league, whose parent points up
    through the sport tree. Strictly require place=live and root level=1.
    None means unknown/incomplete schema; [] means valid with no matches.
    """
    if not isinstance(payload, dict):
        return None
    data = payload.get("data", payload)
    if not isinstance(data, dict):
        return None
    sports, events = data.get("sports"), data.get("events")
    if not isinstance(sports, list) or not isinstance(events, list):
        return None

    # A delta packet cannot be interpreted as a full list; do not treat its
    # missing matches as absent.
    if str(data.get("fromVersion", "0")) not in ("0", ""):
        return None

    by_id = {str(s.get("id")): s for s in sports if isinstance(s, dict)}
    def basketball_league(sport_id):
        current, visited = str(sport_id), set()
        league = ""
        for _ in range(12):
            if current in visited or current not in by_id:
                break
            visited.add(current)
            item = by_id[current]
            alias = str(item.get("alias") or "").lower()
            kind = str(item.get("kind") or "").lower()
            name = str(item.get("name") or "")
            if alias in ("basketball", "basket"):
                return league or "Basketball"
            if kind == "sport":
                return (league or "Basketball") if name.lower() == "basketball" else ""
            if not league:
                league = name
            current = str(item.get("parentId") or "")
        return ""

    scores = {}
    for item in data.get("eventMiscs") or []:
        if isinstance(item, dict) and "eventId" in item:
            a, b = item.get("score1"), item.get("score2")
            if a is not None and b is not None:
                scores[str(item["eventId"])] = f"{a}:{b}"
    found = []
    for event in events:
        if not isinstance(event, dict):
            continue
        if str(event.get("place", "")).lower() != "live":
            continue
        if str(event.get("level", "1")) != "1" or event.get("parentId"):
            continue
        if event.get("kind") is not None and str(event["kind"]) != "1":
            continue
        home = str(event.get("team1") or "").strip()
        away = str(event.get("team2") or "").strip()
        if not home or not away:
            continue
        competition = basketball_league(event.get("sportId"))
        if not competition or is_simulated(competition, home, away):
            continue
        if re.search(r"(?i)(ipbl|esportsbattle|nba\s*2k|h2h|gg league|cyber|virtual)", " ".join((competition, home, away))):
            continue
        date = local_date(event.get("startTime"))
        if not date:
            continue
        eid = str(event.get("id") or "")
        found.append(Match(home, away, competition, date, "",
                           eid, "live", scores.get(eid, "")))
    return dedup(found)


async def synot(browser) -> Source:
    """Let the site's own JS create its POST session; observe ONLY responses."""
    s = Source("SynotTip")
    ctx = await browser.new_context(locale="cs-CZ", timezone_id="Europe/Prague")
    page = await ctx.new_page()
    snapshots = []
    tasks = set()

    async def handle(res):
        try:
            if res.status == 200 and res.request.method == "POST":
                matches = parse_synot(await res.json())
                if matches is not None:
                    snapshots.append(matches)
        except Exception as exc:
            LOG.debug("Synot response parse failed: %s", type(exc).__name__)

    def on_response(res):
        if "GetLiveEventsWL" not in res.url:
            return
        task = asyncio.create_task(handle(res))
        tasks.add(task)
        task.add_done_callback(tasks.discard)

    page.on("response", on_response)
    try:
        await page.goto(SYN_URL, wait_until="domcontentloaded", timeout=35000)
        await page.wait_for_timeout(18000)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        valid = [snap for snap in snapshots if snap]
        if valid:
            s.matches = dedup([m for snap in valid for m in snap])
            s.status = "ÚSPĚCH"
        elif snapshots:
            s.status = "ČÁSTEČNĚ"
            s.error = "Only empty long-poll snapshots."
        else:
            s.error = "No valid GetLiveEventsWL POST observed."
    except Exception as exc:
        s.error = "Browser: " + type(exc).__name__
    finally:
        await ctx.close()
    # Never infer absence from long-poll/incomplete lists.
    s.complete = False
    return s


async def football(browser, client: httpx.AsyncClient, wait_ms: int = 8500) -> Source:
    """Use public JSON directly; if it returns an HTML/202 response, read the
    website's own JSON traffic via Chromium (no account or copied cookies).
    """
    s = Source("Football.com")
    notes = []
    try:
        response = await client.get(FOOT_API, timeout=15)
        if response.status_code == 200:
            try:
                parsed = parse_football(response.json())
                if parsed is not None:
                    s.matches, s.status = parsed, "ÚSPĚCH"
                    return s
                notes.append("Direct API: unexpected schema")
            except ValueError:
                notes.append("Direct API: non-JSON response")
        else:
            notes.append("Direct API HTTP " + str(response.status_code))
    except Exception as exc:
        notes.append("Direct API: " + type(exc).__name__)

    ctx = await browser.new_context(locale="en-US", timezone_id="Europe/Prague")
    page = await ctx.new_page()
    snapshots: list[list[Match]] = []
    tasks = set()

    async def observe(res):
        try:
            if res.status != 200:
                notes.append("Browser API HTTP " + str(res.status))
                return
            parsed = parse_football(await res.json())
            if parsed is None:
                notes.append("Browser API: unexpected schema")
            else:
                snapshots.append(parsed)
        except Exception as exc:
            notes.append("Browser API: " + type(exc).__name__)

    def on_response(res):
        if "configurableLiveOrPrematchEvents" not in res.url:
            return
        task = asyncio.create_task(observe(res))
        tasks.add(task)
        task.add_done_callback(tasks.discard)

    page.on("response", on_response)
    try:
        await page.goto(FOOT_PAGE, wait_until="domcontentloaded", timeout=30000)
        await page.wait_for_timeout(wait_ms)
        if tasks:
            await asyncio.gather(*list(tasks), return_exceptions=True)

        if not snapshots and page.url.startswith("https://www.football.com/"):
            # Same-origin fetch from the already opened public LIVE page. An
            # HTTP 202 / challenge is NOT considered a successful match list.
            result = await page.evaluate("""async url => {
                try {
                    const res = await fetch(url, {credentials: 'same-origin', cache: 'no-store'});
                    if (res.status !== 200) return {status: res.status};
                    if (!(res.headers.get('content-type') || '').includes('json'))
                        return {status: 200, error: 'non-JSON'};
                    return {status: 200, data: await res.json()};
                } catch (err) {
                    return {error: String(err).slice(0, 120)};
                }
            }""", FOOT_API)
            if result.get("status") == 200 and "data" in result:
                parsed = parse_football(result["data"])
                if parsed is not None:
                    snapshots.append(parsed)
                else:
                    notes.append("In-page API: unexpected schema")
            else:
                notes.append("In-page API status: " + str(result.get("status", result.get("error", "?"))))
            if tasks:
                await asyncio.gather(*list(tasks), return_exceptions=True)

        if snapshots:
            s.matches = dedup([m for snap in snapshots for m in snap])
            s.status = "ÚSPĚCH"
        else:
            s.error = "; ".join(dict.fromkeys(notes))[:450] or "No valid LIVE JSON found in browser"
    except Exception as exc:
        notes.append("Browser: " + type(exc).__name__)
        s.error = "; ".join(dict.fromkeys(notes))[:450]
    finally:
        await ctx.close()

    # Complete coverage is not proven even when the API returns valid JSON.
    s.complete = False
    return s

async def fonbet(browser, client: httpx.AsyncClient, wait_ms: int = 7000) -> Source:
    """Read a complete public Fonbet feed; fall back to site's own API calls.

    No anti-bot solving, login, copied cookies, or guesswork about access.
    /events/listBase returns the complete event directory instead of a stale\n    versioned /events/list delta. Only place=live counts as LIVE coverage.
    """
    src = Source("Fonbet")
    notes = []
    try:
        response = await client.get(FON_API, timeout=15)
        if response.status_code == 200:
            try:
                parsed = parse_fonbet(response.json())
                if parsed:
                    src.matches, src.status = parsed, "ÚSPĚCH"
                    return src
                notes.append("Direct feed: incomplete/empty event listing")
            except ValueError:
                notes.append("Direct feed: not JSON")
        else:
            notes.append("Direct feed HTTP " + str(response.status_code))
    except Exception as exc:
        notes.append("Direct feed: " + type(exc).__name__)

    ctx = await browser.new_context(locale="en-US", timezone_id="Europe/Prague")
    page = await ctx.new_page()
    snapshots = []
    pending = set()
    statuses = set()

    async def observe(response):
        try:
            if response.status != 200:
                statuses.add("Feed HTTP " + str(response.status))
                return
            parsed = parse_fonbet(await response.json())
            if parsed is None:
                statuses.add("Feed JSON incomplete/delta")
            else:
                snapshots.append(parsed)
        except Exception as exc:
            statuses.add("Feed parse " + type(exc).__name__)

    def on_response(response):
        if "/events/listBase" not in response.url:
            return
        t = asyncio.create_task(observe(response))
        pending.add(t)
        t.add_done_callback(pending.discard)

    page.on("response", on_response)
    try:
        nav = await page.goto(FON_URL, wait_until="domcontentloaded", timeout=30000)
        notes.append("Page HTTP " + str(nav.status if nav else "none"))
        await page.wait_for_timeout(wait_ms)
        if pending:
            await asyncio.gather(*list(pending), return_exceptions=True)
        valid = [m for batch in snapshots for m in batch]
        if valid:
            src.matches = dedup(valid)
            src.status = "ÚSPĚCH"
        elif snapshots:
            src.status = "ČÁSTEČNĚ"
            notes.append("Feed contained no confirmable live basketball matches")
        else:
            try:
                title = (await page.title())[:70]
                if title:
                    notes.append("Page title: " + title)
            except Exception:
                pass
            notes.append("No complete browser feed")
    except Exception as exc:
        notes.append("Browser: " + type(exc).__name__)
    finally:
        await ctx.close()
    notes.extend(sorted(statuses))
    src.error = "; ".join(dict.fromkeys(notes))[:450]
    src.complete = False
    return src


async def inspect_source(browser, client, name, page_url, api_url, needle):
    """Probe other feeds without treating unverified structure as match coverage."""
    s = Source(name)
    notes = []
    try:
        r = await client.get(api_url, timeout=12)
        if r.status_code == 200:
            data = r.json()
            notes.append("API root keys: " + ",".join(list(data)[:12])
                         if isinstance(data, dict) else "API root: " + type(data).__name__)
            s.status = "ČÁSTEČNĚ"
        else:
            notes.append("API HTTP " + str(r.status_code))
    except Exception as exc:
        notes.append("API: " + type(exc).__name__)

    ctx = await browser.new_context(locale="cs-CZ", timezone_id="Europe/Prague")
    page = await ctx.new_page()
    pending = set()

    async def observe(res):
        try:
            if res.status == 200:
                obj = await res.json()
                if isinstance(obj, dict):
                    notes.append("Browser API keys: " + ",".join(list(obj)[:12]))
                    s.status = "ČÁSTEČNĚ"
        except Exception:
            pass

    def callback(res):
        if needle in res.url:
            t = asyncio.create_task(observe(res))
            pending.add(t)
            t.add_done_callback(pending.discard)

    page.on("response", callback)
    try:
        await page.goto(page_url, wait_until="domcontentloaded", timeout=25000)
        await page.wait_for_timeout(6500)
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
    except Exception as exc:
        notes.append("Browser: " + type(exc).__name__)
    finally:
        await ctx.close()
    s.error = "; ".join(dict.fromkeys(notes))[:450]
    s.complete = False
    return s


def _pair_key(home: str, away: str) -> tuple[str, str]:
    def clean(text):
        value = unicodedata.normalize("NFKD", str(text)).casefold()
        value = "".join(c for c in value if not unicodedata.combining(c))
        return re.sub(r"[^a-z0-9]+", " ", value).strip()
    return clean(home), clean(away)


# Carefully reviewed equivalents, not fuzzy similarity. The pair must match
# in full (both teams, same day) and have one unique SportRadar event ID.
# These aliases never change which bookmaker actually listed a fixture.
_FONBET_PAIR_ALIASES_RAW = [
    (("Zenit", "Igokea"), ("Zenit Saint Petersburg", "Igokea Aleksandrovac")),
    (("Mega", "Spartak Subotica"), ("KK Mega Basket", "Spartak Subotica")),
    (("Nevezis Kedainiai", "BC Gargždai"), ("Nevezis Kedainiai", "Gargzdu Gargzdai")),
    (("Khimki", "Chelbasket"), ("BC Khimki Moscow", "BC Chelbasket Chelyabinsk")),
    (("Desna Bryansk", "CSKA 2"), ("BC Desna Bryansk", "CSKA-2 Moscow")),
    (("Rusichi", "Dynamo Grozny"), ("Rusichi Kursk", "BK Dynamo Grozny")),
    (("Besiktas (w)", "Maccabi Bnot Ashdod (w)"), ("Besiktas JK", "Maccabi Ashdod")),
    (("TTT-Riga (w)", "Elitzur Ramla (w)"), ("TTT Riga", "Elizur Ramla")),
    (("Borac Banja Luka", "Orlovik Zepce"), ("Borac Banja Luka", "Kk Orlovik Zepce")),
    (("Qatar SC", "Al-Ahli Doha"), ("Qatar SC", "AL Ahli (Qat)")),
    (("Apollon Limassol", "APOEL"), ("BC Apollon Limassol", "Apoel Nicosia")),
    (("Murray State (stud)", "Tennesee State (stud)"),
     ("Murray State Racers", "Tennessee State Tigers")),
]
_FONBET_PAIR_ALIASES = {
    _pair_key(*fonbet_names): _pair_key(*reference_names)
    for fonbet_names, reference_names in _FONBET_PAIR_ALIASES_RAW
}


def reconcile_fonbet_references(sources: list[Source]) -> int:
    """Link Fonbet matches to a unique observed SportRadar ID from other sources.

    Avoids matching on Google Sheets' date cell type (Date vs text) until
    the deployed Apps Script is updated. Never invent a Sportradar ID.
    """
    ids_by_key: dict[tuple[str, tuple[str, str]], set[str]] = {}
    for source in sources:
        if source.source not in ("SynotTip", "Football.com"):
            continue
        for m in source.matches:
            if not re.fullmatch(r"sr:match:\d{5,}", m.eventId or ""):
                continue
            key = (m.date, _pair_key(m.home, m.away))
            ids_by_key.setdefault(key, set()).add(m.eventId)

    linked = 0
    for source in sources:
        if source.source != "Fonbet":
            continue
        for m in source.matches:
            pair = _pair_key(m.home, m.away)
            reference_pair = _FONBET_PAIR_ALIASES.get(pair, pair)
            ids = ids_by_key.get((m.date, reference_pair), set())
            if len(ids) == 1:
                m.eventId = next(iter(ids))
                linked += 1
    return linked


async def collect():
    stamp = datetime.now(timezone.utc).isoformat()
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True, args=["--disable-dev-shm-usage", "--no-sandbox"])
        try:
            async with httpx.AsyncClient(
                follow_redirects=True,
                headers={"User-Agent": "Mozilla/5.0 (LIVE-Coverage-Monitor)",
                         "Accept": "application/json, text/plain, */*"}) as client:
                sources = await asyncio.gather(
                    synot(browser), football(browser, client),
                    fonbet(browser, client),
                    inspect_source(browser, client, "1xBit", BIT_URL, BIT_API, "/games1x2"))
        finally:
            await browser.close()
    linked = reconcile_fonbet_references(sources)
    LOG.info("Fonbet: %s exact/known-alias matches linked to a unique SportRadar ID", linked)
    payload = {"checkedAt": stamp, "sources": [s.as_dict() for s in sources]}
    Path("output").mkdir(exist_ok=True)
    Path("output/latest.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    for s in sources:
        LOG.info("%s: %s – %s matches (%s)", s.source, s.status, len(s.matches), s.error)
    return payload


async def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    data = await collect()
    url = os.environ.get("SHEETS_WEBAPP_URL")
    key = os.environ.get("SHEETS_INGEST_KEY")
    if not url or not key:
        LOG.warning("Missing SHEETS_WEBAPP_URL or SHEETS_INGEST_KEY: DRY RUN, no Sheets write")
        return
    async with httpx.AsyncClient(follow_redirects=True, timeout=45) as client:
        res = await client.post(url, json={**data, "key": key})
        res.raise_for_status()
        output = res.json()
        if output.get("ok") is not True:
            raise RuntimeError("Google Sheets rejected write: " + str(output.get("error", "unknown")))
        LOG.info("Sheets write OK: created %s", output.get("created"))


if __name__ == "__main__":
    asyncio.run(main())
