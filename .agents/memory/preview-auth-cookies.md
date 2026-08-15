---
name: Session cookies in the Replit preview iframe
description: Cookie attributes and frontend patterns needed for custom cookie auth to work in the embedded preview.
---
Rule: session cookies must be set with `SameSite=None; Secure; Partitioned` — the preview pane is a cross-site iframe (replit.com top level), and Chrome drops Lax cookies there and blocks unpartitioned third-party cookies.

**Why:** login POST returned 200 but every subsequent request was 401 in the preview, appearing as a "broken login" while curl worked fine.

**How to apply:** in `res.cookie(...)` use `{ sameSite: "none", secure: true, partitioned: true }`. Also: after login, prefer a full `window.location.assign(BASE_URL)` over SPA navigation — SPA redirect raced the react-query auth cache and left users stuck on /login. Related: workspace libs (e.g. api-client-react) can carry their own `@tanstack/react-query` copy; add it to vite `resolve.dedupe` and clear `node_modules/.vite` or mutations silently hang.

**Private file links:** a plain `<a href>` to an authenticated API file route opened in a new top-level tab does NOT send the partitioned session cookie → 401/404. Fetch with `credentials: 'include'`, then `window.open(URL.createObjectURL(blob))` instead (pattern used for invoice documents and vendor W-9 links).
