---
name: Isolated UI test routing
description: Real-API browser tests outside the artifact gateway need explicit API forwarding.
---

An isolated Vite server does not provide Replit's artifact-based API routing.
Real-API browser tests must forward API requests to the running development API;
do not mistake an HTML fallback at an API URL for an authenticated JSON response.

**Why:** Existing route-mocked tests hid this environment difference. Real-session
browser tests initially received Vite's HTML at the auth endpoint and reported a
misleading user-role rendering exception.

**How to apply:** Check response content types when a test-only server behaves
differently from the workspace preview. Keep forwarding in the test harness,
not hardcoded localhost URLs in application code.

Wait for forwarded route handlers to finish before disposing the browser context.

**Why:** Background page refreshes can still be inside `route.fetch` after the final assertion. Closing the context first can report “Fetch response has been disposed” and fail an otherwise successful user journey.

**How to apply:** Drain intercepted requests during test teardown before closing the page or context; distinguish teardown failures from failed application requests.
