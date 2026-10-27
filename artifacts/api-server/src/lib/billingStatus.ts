import { sql, type SQL } from "drizzle-orm";
import { db } from "@workspace/db";
import { money } from "./money";
import type { BillingStatus, ReviewFlag } from "@workspace/api-zod";

export function deriveBillingStatus(amount: string, remitted: string, billed: boolean, feeStatus?: string): BillingStatus {
  if (feeStatus === "waived") return "waived";
  if (money(remitted).greaterThanOrEqualTo(money(amount))) return "paid";
  if (money(remitted).greaterThan(0)) return "partially_paid";
  if (feeStatus === "collected") return "paid"; // Preserve legacy collected fees.
  return billed || feeStatus === "invoiced" ? "billed" : "pending";
}

export interface BillingItem {
  targetType: "payment_line" | "fee"; targetId: string; clientId: string; clientName: string;
  item: string; serviceMonth: string | null; amount: string; remittedAmount: string;
  feeStatus: string | null; billingStatus: BillingStatus; billedAt: string | null;
  billedAmount: string | null; invoiceNumber: string | null; billingCount: number;
  daysSinceBilled: number | null; flag: ReviewFlag | null;
}

export const flagJsonSql = (alias: string): SQL => {
  // Aliases are internal constants, never request input.
  const f = sql.raw(alias);
  return sql`case when ${f}.id is null then null else json_build_object(
    'id', ${f}.id, 'reason', ${f}.reason, 'flaggedBy', ${f}.flagged_by,
    'flaggedByName', (select name from users where id = ${f}.flagged_by),
    'flaggedAt', ${f}.flagged_at, 'resolvedAt', ${f}.resolved_at,
    'resolvedBy', ${f}.resolved_by, 'resolutionNote', ${f}.resolution_note) end`;
};

/** Shared set-based financial truth for participant responses and both reports.
 * Re-bills count once per source row. Amounts are NOT summed across re-bills:
 * metadata comes from the newest invoice date and line_amount is its snapshot.
 */
export const billingItemsCte = sql`
  with items as (
    select 'payment_line'::text as "targetType", pa.id as "targetId", p.client_id as "clientId",
      'Check #' || p.qb_check_number as item, coalesce(pa.service_month, p.payment_month) as "serviceMonth",
      pa.amount::text as amount, null::text as "feeStatus"
    from payment_allocations pa join payments p on p.id = pa.payment_id where not p.is_deleted
    union all
    select 'fee', f.id, f.client_id, 'CEPS fee', f.fee_month, f.amount::text, f.status
    from fees f where not f.is_deleted
  ), links as (
    select 'payment_line'::text as kind, l.payment_allocation_id as id,
      b.id as source_id, b.invoice_date, b.invoice_number, b.created_at, l.line_amount as amount
    from alta_billing_row_lines l join alta_billing_rows b on b.id = l.billing_row_id
    where not b.is_deleted and b.match_status <> 'unmatched'
    union all
    select 'fee', b.fee_id, b.id, b.invoice_date, b.invoice_number, b.created_at, b.billed_amount
    from alta_billing_rows b where not b.is_deleted and b.fee_id is not null and b.match_status <> 'unmatched'
  ), metadata as (
    select kind, id, count(*)::int as "billingCount",
      to_char(max(invoice_date), 'YYYY-MM-DD') as "billedAt",
      (array_agg(invoice_number order by invoice_date desc, created_at desc, source_id desc))[1] as "invoiceNumber",
      (array_agg(amount order by invoice_date desc, created_at desc, source_id desc))[1]::text as "billedAmount"
    from links group by kind, id
  ), remitted as (
    select case when r.fee_id is not null then 'fee' else 'payment_line' end as kind,
      coalesce(r.fee_id, r.payment_allocation_id) as id, sum(r.amount)::text as total
    from remittance_allocations r join remittances parent on parent.id = r.remittance_id
    where not parent.is_deleted group by 1, 2
  ), billing_items as (
    select i.*, c.first_name || ' ' || c.last_name as "clientName",
      coalesce(r.total, '0.00') as "remittedAmount", m."billedAt", m."billedAmount", m."invoiceNumber",
      coalesce(m."billingCount", 0) as "billingCount",
      case when m."billedAt" is null then null else
        ((now() at time zone 'America/Los_Angeles')::date - m."billedAt"::date)::int end as "daysSinceBilled",
      ${flagJsonSql("rf")} as flag
    from items i join clients c on c.id = i."clientId" and not c.is_deleted
    left join metadata m on m.kind = i."targetType" and m.id = i."targetId"
    left join remitted r on r.kind = i."targetType" and r.id = i."targetId"
    left join review_flags rf on rf.target_type = i."targetType" and
      coalesce(rf.fee_id, rf.payment_allocation_id) = i."targetId" and rf.resolved_at is null
  )`;

export function withBillingStatus(row: Omit<BillingItem, "billingStatus">): BillingItem {
  return { ...row, billingStatus: deriveBillingStatus(row.amount, row.remittedAmount, !!row.billedAt, row.feeStatus ?? undefined) };
}

export async function billingDetails(kind: "payment_line" | "fee", ids: string[]) {
  if (!ids.length) return new Map<string, BillingItem>();
  const result = await db.execute(sql`${billingItemsCte} select * from billing_items
    where "targetType" = ${kind} and "targetId" in (${sql.join(ids.map(id => sql`${id}`), sql`, `)})`);
  return new Map((result.rows as unknown as Omit<BillingItem, "billingStatus">[]).map(r => [r.targetId, withBillingStatus(r)]));
}

export function billingFields(item: BillingItem | undefined) {
  return { billingStatus: item?.billingStatus, billedAt: item?.billedAt ?? null,
    billedAmount: item?.billedAmount ?? null, invoiceNumber: item?.invoiceNumber ?? null,
    billingCount: item?.billingCount ?? 0, flag: item?.flag ?? null };
}
