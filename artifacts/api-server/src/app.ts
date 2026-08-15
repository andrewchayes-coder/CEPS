import express, { type Express } from "express";
import cors, { type CorsOptions } from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { loginRateLimiter, sensitiveActionRateLimiter } from "./lib/rateLimit";

const app: Express = express();

// The API runs behind the Replit proxy (and any deployment ingress). Trust a
// single proxy hop so that express-rate-limit and req.ip resolve the real
// client IP from X-Forwarded-For instead of the proxy's address. We use a
// numeric hop count rather than `true` to avoid trusting arbitrary
// spoofed X-Forwarded-For chains.
app.set("trust proxy", 1);

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
// The portal and API are same-origin in this deployment: they are path-routed
// behind a single domain, and the portal calls the API using RELATIVE URLs
// (e.g. `/api/auth/login`). Same-origin requests are not subject to CORS, so
// the default is an empty allowlist (no cross-origin access permitted).
//
// CORS_ALLOWED_ORIGINS is a comma-separated list of extra origins that should
// be permitted (e.g. a separately-hosted client). credentials:true is only
// enabled when an explicit allowlist is configured, since credentialed CORS
// requires an exact origin echo (never a wildcard).
const allowedOrigins = (process.env["CORS_ALLOWED_ORIGINS"] ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter((o) => o.length > 0);

const corsOptions: CorsOptions = {
  origin(origin, callback) {
    // No Origin header => same-origin / non-browser (curl, server-to-server).
    if (!origin) {
      callback(null, true);
      return;
    }
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    // Not on the allowlist: respond without CORS headers so the browser blocks
    // the cross-origin read. We don't throw, to avoid surfacing a 500.
    callback(null, false);
  },
  credentials: allowedOrigins.length > 0,
};

// ---------------------------------------------------------------------------
// Helmet (security headers)
// ---------------------------------------------------------------------------
// The API is JSON-only (verified: no route serves HTML / static assets), so
// the default CSP is harmless on these responses. However, the app is embedded
// in a Replit-hosted iframe, so we must NOT emit a frame-ancestors / X-Frame-
// Options directive that would break framing.
//
// FRAME_ANCESTORS (comma-separated origins) optionally scopes framing to known
// hosting origins. When it is empty we OMIT the frame-ancestors directive and
// X-Frame-Options entirely, leaving the preview iframe functional.
const frameAncestors = (process.env["FRAME_ANCESTORS"] ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter((o) => o.length > 0);

type CspDirectives = Record<
  string,
  ReturnType<typeof helmet.contentSecurityPolicy.getDefaultDirectives>[string] | null
>;

const cspDirectives: CspDirectives = {
  ...helmet.contentSecurityPolicy.getDefaultDirectives(),
};
if (frameAncestors.length > 0) {
  cspDirectives["frame-ancestors"] = ["'self'", ...frameAncestors];
} else {
  // Remove the default `frame-ancestors 'self'` so the Replit preview iframe
  // (a different origin) can embed the app. Setting the directive to `null`
  // tells helmet to drop it entirely (deleting the key is not enough — helmet
  // re-adds defaults during its merge step).
  cspDirectives["frame-ancestors"] = null;
}

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: cspDirectives,
    },
    // Disable X-Frame-Options for the same iframe-friendliness reason;
    // frame-ancestors (when configured) is the modern replacement.
    frameguard: false,
  }),
);

app.use(cors(corsOptions));

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true }));

// ---------------------------------------------------------------------------
// Rate limiting (scoped to sensitive auth/invite endpoints only)
// ---------------------------------------------------------------------------
// Mounted here on the full `/api/...` paths (routes are mounted under `/api`).
// The rest of the API is intentionally left unthrottled.
app.use("/api/auth/login", loginRateLimiter);
app.use("/api/auth/magic-link/request", sensitiveActionRateLimiter);
// Invite acceptance is a `/invites/:token/accept` route; limit the accept path.
app.use("/api/invites/:token/accept", sensitiveActionRateLimiter);

app.use("/api", router);

export default app;
