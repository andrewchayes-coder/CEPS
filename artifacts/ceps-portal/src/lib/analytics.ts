export type AnalyticsData = Record<string, string | number | boolean>;

export type AgreementValidationFailureReason =
  | 'missing_recipient_email'
  | 'participant_is_minor'
  | 'minor_status_unconfirmed'
  | 'invalid_request';

declare global {
  interface Window {
    umami?: {
      track: (name: string, data?: AnalyticsData) => void;
    };
  }
}

export function trackAnalyticsEvent(name: string, data?: AnalyticsData): void {
  if (typeof window === 'undefined') return;

  try {
    window.umami?.track(name, data);
  } catch {
    // Analytics must never interrupt a user workflow.
  }
}

export function getAgreementValidationFailureReason(
  error: unknown,
): AgreementValidationFailureReason | null {
  if (typeof error !== 'object' || error === null) return null;

  const status = 'status' in error && typeof error.status === 'number'
    ? error.status
    : null;
  if (status !== 400) return null;

  const message = (
    'data' in error &&
    typeof error.data === 'object' &&
    error.data !== null &&
    'error' in error.data &&
    typeof error.data.error === 'string'
  )
    ? error.data.error.toLowerCase()
    : '';

  if (message.includes('add an email')) return 'missing_recipient_email';
  if (message.includes('minor cannot sign')) return 'participant_is_minor';
  if (message.includes('confirm that the participant is not a minor')) {
    return 'minor_status_unconfirmed';
  }
  return 'invalid_request';
}
