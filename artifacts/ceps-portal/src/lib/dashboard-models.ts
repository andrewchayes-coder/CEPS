export type TileVariant = 'alert' | 'neutral' | 'primary' | 'turquoise';

export const MESSAGE_ALERT_KINDS = ['message_assigned_to_you', 'message_assigned_new'] as const;

export function getMessageAlertHref(kind: string, threadId?: string | null): string | undefined {
  if (kind === 'message_assigned_new' && threadId) return `/messages/${threadId}`;
  if ((MESSAGE_ALERT_KINDS as readonly string[]).includes(kind)) return '/messages?view=assigned_to_me';
  return undefined;
}

export interface TileTotals {
  expiringAuthorizations?: number;
  invoicesInReview?: number;
  pendingInvoices?: number;
  needsEntryInvoices?: number;
  activeClients?: number;
}

export interface CoordinatorTileModel {
  key: 'expiring' | 'referrals' | 'participants';
  title: string;
  value: number;
  subtitle: string;
  subtitleTone: 'orange' | 'muted';
  href: string;
  variant: TileVariant;
  testId: string;
}

export const TILE_VARIANT_STYLES: Record<TileVariant, { card: string; value: string; icon: string }> = {
  alert: { card: 'border-l-4 border-destructive bg-destructive/5', value: 'text-destructive', icon: 'text-destructive' },
  neutral: { card: 'border-border bg-muted/30', value: 'text-muted-foreground', icon: 'text-muted-foreground' },
  primary: { card: 'border-primary', value: '', icon: 'text-primary' },
  turquoise: { card: 'border-chart-4', value: '', icon: 'text-chart-4' },
};

export function getCoordinatorTiles(
  totals: TileTotals,
  activeReferrals: number,
  pendingReferrals: number,
): CoordinatorTileModel[] {
  const expiring = totals.expiringAuthorizations ?? 0;
  return [
    {
      key: 'expiring',
      title: 'Expiring Authorizations',
      value: expiring,
      subtitle: expiring > 0 ? 'Ending in the next 30 days' : 'None in the next 30 days',
      subtitleTone: 'muted',
      href: '/reports?tab=expiring-auth',
      variant: expiring > 0 ? 'alert' : 'neutral',
      testId: 'card-kpi-expiring-authorizations',
    },
    {
      key: 'referrals',
      title: 'Active Referrals',
      value: activeReferrals,
      subtitle: `${pendingReferrals} pending processing`,
      subtitleTone: pendingReferrals > 0 ? 'orange' : 'muted',
      href: '/referrals',
      variant: 'primary',
      testId: 'card-kpi-referrals',
    },
    {
      key: 'participants',
      title: 'My Participants',
      value: totals.activeClients ?? 0,
      subtitle: 'On your caseload',
      subtitleTone: 'muted',
      href: '/clients',
      variant: 'turquoise',
      testId: 'card-kpi-clients',
    },
  ];
}

export function getInvoicesInReview(totals: TileTotals): number {
  return totals.invoicesInReview ?? (totals.pendingInvoices ?? 0) + (totals.needsEntryInvoices ?? 0);
}

export function filterAlertsForRole<T extends { kind: string }>(alerts: T[], role?: string): T[] {
  return role === 'service_coordinator' ? alerts.filter((a) => a.kind !== 'expiring_authorization') : alerts;
}

const ALL_TABS = ['vendor-payments', 'case-status', 'pending-auth', 'missing-docs', 'expiring-auth'];

export function getAllowedReportTabs(role?: string): string[] {
  if (role === 'staff') return ALL_TABS;
  if (role === 'service_coordinator') return ['pending-auth', 'expiring-auth'];
  return ['vendor-payments'];
}

export function resolveReportTab(role: string | undefined, tabParam: string | null | undefined): string {
  const allowed = getAllowedReportTabs(role);
  if (tabParam && allowed.includes(tabParam)) return tabParam;
  return role === 'service_coordinator' ? 'expiring-auth' : 'vendor-payments';
}
