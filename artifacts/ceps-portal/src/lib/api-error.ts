export function apiErrorMessage(error: unknown, fallback: string): string {
  const message = (error as { data?: { error?: unknown } } | null)?.data?.error;
  return typeof message === 'string' && message.trim() ? message : fallback;
}