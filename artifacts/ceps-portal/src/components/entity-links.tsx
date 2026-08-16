import React from 'react';
import { Link } from 'wouter';
import { useAuth } from '@/components/auth/auth-provider';

// Roles allowed to open a client case record (/clients/:id). Server-side the
// GET /clients/:id route scopes every role to records it may see (staff/coord:
// caseload, parent/self: own client, vendor: own clients), so any client name
// the viewer already sees in a table is safe to link.
const CLIENT_LINK_ROLES = new Set([
  'staff',
  'service_coordinator',
  'parent_guardian',
  'self',
  'vendor',
]);

// Roles allowed to open a vendor detail page (/vendors/:id). Only staff and
// coordinators navigate to the vendor admin page; parents/self and vendor users
// get plain text (vendor users only ever see their own vendor and the detail
// page is an edit surface, so we don't link it from lists).
const VENDOR_LINK_ROLES = new Set(['staff', 'service_coordinator']);

const linkClass = 'font-medium text-primary hover:underline';

/**
 * Renders a client name as a link to /clients/:id when the current viewer can
 * access the destination, otherwise as plain text. Mirrors invoice-link styling.
 */
export function ClientLink({
  id,
  name,
  className,
  testId,
}: {
  id?: string | null;
  name?: string | null;
  className?: string;
  testId?: string;
}) {
  const { user } = useAuth();
  const label = name ?? '-';
  if (id && name && user && CLIENT_LINK_ROLES.has(user.role)) {
    return (
      <Link href={`/clients/${id}`} className={className ?? linkClass} data-testid={testId}>
        {label}
      </Link>
    );
  }
  return <span className={className}>{label}</span>;
}

/**
 * Renders a vendor name as a link to /vendors/:id when the current viewer can
 * access the destination, otherwise as plain text.
 */
export function VendorLink({
  id,
  name,
  className,
  testId,
}: {
  id?: string | null;
  name?: string | null;
  className?: string;
  testId?: string;
}) {
  const { user } = useAuth();
  const label = name ?? '-';
  if (id && name && user && VENDOR_LINK_ROLES.has(user.role)) {
    return (
      <Link href={`/vendors/${id}`} className={className ?? linkClass} data-testid={testId}>
        {label}
      </Link>
    );
  }
  return <span className={className}>{label}</span>;
}
