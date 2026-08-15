import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function retryAfterMessage(): { error: string } {
  return {
    error:
      "Too many requests. Please wait a few minutes and try again. Check the Retry-After header for when you can retry.",
  };
}

/**
 * Strict limiter for the password login endpoint. Guards against credential
 * stuffing / brute-force by capping attempts per IP within the window.
 */
export const loginRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: WINDOW_MS,
  limit: 10,
  standardHeaders: true, // emit RateLimit-* and Retry-After headers
  legacyHeaders: false,
  message: retryAfterMessage(),
});

/**
 * Looser limiter for endpoints that trigger emails or accept invites. These
 * are less sensitive than password login but still abusable, so we cap them at
 * a higher threshold per IP within the window.
 */
export const sensitiveActionRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: WINDOW_MS,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: retryAfterMessage(),
});
