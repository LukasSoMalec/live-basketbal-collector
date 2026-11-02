"""Local HTTP routing test; no bookmaker network access required."""
import asyncio
import json
import os
import unittest
from playwright.async_api import async_playwright


class BrowserCaptureTests(unittest.TestCase):
    def test_playwright_can_observe_post_response(self):
        async def check():
            async with async_playwright() as p:
                kwargs = {"headless": True, "args": ["--no-sandbox", "--disable-dev-shm-usage"]}
                if os.getenv("COLLECTOR_CHROME"):
                    kwargs["executable_path"] = os.environ["COLLECTOR_CHROME"]
                browser = await p.chromium.launch(**kwargs)
                try:
                    ctx = await browser.new_context()
                    sample = {"Result": 1, "ReturnValue": [{"DisciplineID": 21,
                              "Events": [{"ExternalID": "74131950", "Name": "Dubai Basketball - KK Zadar"}]}]}
                    async def fulfill(route):
                        await route.fulfill(status=200, content_type="application/json",
                                            headers={"access-control-allow-origin": "*"},
                                            body=json.dumps(sample))
                    await ctx.route("**/GetLiveEventsWL", fulfill)
                    page = await ctx.new_page()
                    responses = []
                    page.on("response", lambda res: responses.append((res.request.method, res.status))
                            if "GetLiveEventsWL" in res.url else None)
                    await page.set_content('<script>fetch("https://sport.synottip.cz/WebServices/Api/webapi/GetLiveEventsWL", {method:"POST",mode:"cors",headers:{"Content-Type":"application/json"},body:"{}"})</script>')
                    await page.wait_for_timeout(600)
                    self.assertEqual(responses, [("POST", 200)])
                finally:
                    await browser.close()
        asyncio.run(check())


if __name__ == "__main__":
    unittest.main()