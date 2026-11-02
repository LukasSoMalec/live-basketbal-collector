"""Fonbet public feed browser capture with fully mocked network traffic."""
import asyncio
import json
import unittest

from playwright.async_api import async_playwright
from collector import FON_API, fonbet


PAYLOAD = {
    "fromVersion": 0,
    "packetVersion": 12345,
    "sports": [
        {"id": 1, "kind": "sport", "alias": "basketball", "name": "Basketball"},
        {"id": 40, "parentId": 1, "name": "EuroCup Women"},
    ],
    "events": [
        {"id": 123, "sportId": 40, "level": 1, "kind": 1,
         "place": "live", "team1": "TTT Riga", "team2": "Elizur Ramla",
         "startTime": 1793633400}
    ],
}


class DeniedResponse:
    status_code = 403


class StubClient:
    async def get(self, *args, **kwargs):
        return DeniedResponse()


class StubBrowser:
    def __init__(self, browser, blocked=False):
        self.browser = browser
        self.blocked = blocked

    async def new_context(self, **kwargs):
        ctx = await self.browser.new_context(**kwargs)

        async def api_response(route):
            await route.fulfill(
                status=200, content_type="application/json",
                headers={"access-control-allow-origin": "*"},
                body=json.dumps(PAYLOAD)
            )

        async def site_response(route):
            if self.blocked:
                await route.fulfill(status=403, body="Forbidden")
            else:
                await route.fulfill(
                    status=200, content_type="text/html",
                    body='<html><head><title>Fonbet Live</title></head><body>'
                         f'<script>fetch("{FON_API}")</script></body></html>'
                )

        await ctx.route("**/events/list**", api_response)
        await ctx.route("**/live/basketball", site_response)
        return ctx


class FonbetBrowserTests(unittest.TestCase):
    def run_case(self, blocked):
        async def runner():
            async with async_playwright() as pw:
                browser = await pw.chromium.launch(
                    headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
                try:
                    return await fonbet(StubBrowser(browser, blocked), StubClient(), wait_ms=160)
                finally:
                    await browser.close()
        return asyncio.run(runner())

    def test_fonbet_browser_captures_real_site_request(self):
        result = self.run_case(False)
        self.assertEqual(result.status, "ÚSPĚCH")
        self.assertEqual(len(result.matches), 1)
        self.assertEqual(result.matches[0].providerId, "123")
        self.assertFalse(result.complete)

    def test_fonbet_reports_blocked_site_as_unavailable(self):
        result = self.run_case(True)
        self.assertEqual(result.status, "NEDOSTUPNÉ")
        self.assertEqual(result.matches, [])


if __name__ == "__main__":
    unittest.main()
