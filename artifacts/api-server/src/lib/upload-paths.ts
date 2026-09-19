const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

/**
 * Returns a canonical private upload path only when it belongs to userId.
 * Do not normalize arbitrary URLs here: callers are validating a persisted
 * claim, not converting an external storage URL into an owned path.
 */
export function normalizeValidateOwnedUploadPath(value: string, userId: string): string | null {
  const path = value.trim();
  const match = path.match(new RegExp(`^/objects/uploads/([^/]+)/(${UUID})$`, 'i'));
  if (!match || match[1] !== userId) return null;
  return path;
}

export function isCanonicalUploadPath(value: string): boolean {
  return /^\/objects\/uploads\/[^/]+\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}