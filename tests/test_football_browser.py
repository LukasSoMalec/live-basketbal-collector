"""Browser-level Football.com fallback tests. All network traffic is mocked."""
import asyncio
import json
import unittest

from playwright.async_api import async_playwright

from collector import FOOT_API, football


SAMPLE = {
    "bizCode": 10000,
    "data": [
        {"name": "Liga ABA", "events": [
            {"eventId": "sr:match:74131950", "status": 1, "matchStatus": "Q3",
             "sport": {"id": "sr:sport:2"}, "homeTeamName": "Dubai Basketball",
             "awayTeamName": "KK Zadar", "estimateStartTime": 1793633400000,
             "setScore": "47:43"},
            {"eventId": "sr:match:10001", "status": 0, "matchStatus": "NS",
             "sport": {"id": "sr:sport:2"}, "homeTeamName": "Future",
             "awayTeamName": "Scheduled", "estimateStartTime": 1793633400000}
        ]}
    ]
}


class NotJsonResponse:
    status_code = 202


class StubClient:
    async def get(self, *args, **kwargs):
        return NotJsonResponse()


class StubBrowser:
    def __init__(self, browser, trigger):
        self.browser = browser
        self.trigger = trigger

    async def new_context(self, **kwargs):
        ctx = await self.browser.new_context(**kwargs)

        async def serve_api(route):
            await route.fulfill(status=200, content_type="application/json",
                                body=json.dumps(SAMPLE))

        async def serve_live_page(route):
            if self.trigger:
                script = f'<script>fetch("{FOOT_API}")</script>'
            else:
                script = "<div>LIVE</div>"
            await route.fulfill(status=200, content_type="text/html",
                                body="<html><body>" + script + "</body></html>")

        await ctx.route("**/api/ng/factsCenter/configurableLiveOrPrematchEvents**",
                        serve_api)
        await ctx.route("**/ng/m/sport/basketball/live_list", serve_live_page)
        return ctx


class FootballBrowserTests(unittest.TestCase):
    def _run(self, page_initiates_request):
        async def go():
            async with async_playwright() as pw:
                browser = await pw.chromium.launch(
                    headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
                try:
                    return await football(
                        StubBrowser(browser, page_initiates_request),
                        StubClient(), wait_ms=150)
                finally:
                    await browser.close()
        return asyncio.run(go())

    def test_capture_page_api_response_after_http_202(self):
        result = self._run(True)
        self.assertEqual(result.status, "ÚSPĚCH")
        self.assertEqual(len(result.matches), 1)
        self.assertEqual(result.matches[0].eventId, "sr:match:74131950")
        self.assertFalse(result.complete)

    def test_same_origin_fetch_after_http_202(self):
        result = self._run(False)
        self.assertEqual(result.status, "ÚSPĚCH")
        self.assertEqual(len(result.matches), 1)
        self.assertEqual(result.matches[0].home, "Dubai Basketball")


if __name__ == "__main__":
    unittest.main()
