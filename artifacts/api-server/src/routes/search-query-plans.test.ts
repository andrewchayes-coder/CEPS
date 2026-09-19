import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

type ExplainNode = {
  "Actual Loops"?: number;
  "Parent Relationship"?: string;
  Plans?: ExplainNode[];
};

function correlatedLoopCounts(node: ExplainNode): number[] {
  const own = node["Parent Relationship"] === "SubPlan"
    ? [node["Actual Loops"] ?? 0]
    : [];
  return own.concat(...(node.Plans ?? []).map(correlatedLoopCounts));
}

/**
 * Query-plan regression checks for the pg_trgm search surface.  These checks
 * deliberately run against the configured DATABASE_URL rather than a mock:
 * the planner and operator class are the thing under test. Planner settings
 * are left untouched; on small databases PostgreSQL may choose a sequential
 * scan for formatted predicates, while costs remain useful baseline output.
 */
describe("pg_trgm search query plans", () => {
  it("has the extension and all direct-search indexes", async () => {
    const result = await db.execute(sql`
      select indexname
      from pg_indexes
      where schemaname = 'public'
        and indexname in (
          'clients_first_name_trgm_idx', 'clients_last_name_trgm_idx',
          'clients_uci_number_trgm_idx', 'clients_full_name_trgm_idx',
          'vendors_name_trgm_idx', 'vendors_alta_vendor_number_trgm_idx',
          'vendors_contact_person_trgm_idx', 'vendors_email_trgm_idx',
          'authorizations_auth_number_trgm_idx',
          'authorizations_service_code_trgm_idx',
          'authorizations_activity_description_trgm_idx',
          'invoices_service_month_trgm_idx', 'invoices_notes_trgm_idx',
          'payments_qb_check_number_trgm_idx', 'payments_payment_month_trgm_idx',
          'users_name_trgm_idx', 'users_email_trgm_idx', 'users_phone_trgm_idx',
          'referrals_parent_email_trgm_idx', 'referrals_intake_sent_to_trgm_idx',
          'referrals_diagnosis_trgm_idx', 'referrals_eligibility_category_trgm_idx',
          'referrals_notes_trgm_idx', 'remittances_alta_reference_trgm_idx',
          'remittances_payment_month_trgm_idx', 'remittances_batch_id_trgm_idx',
          'remittances_report_reference_trgm_idx', 'remittances_review_reason_trgm_idx',
          'audit_log_action_trgm_idx', 'audit_log_entity_type_trgm_idx',
          'audit_log_entity_id_trgm_idx', 'audit_log_detail_trgm_idx'
        )
    `);
    expect(result.rows).toHaveLength(32);

    const extension = await db.execute(sql`
      select 1 from pg_extension where extname = 'pg_trgm'
    `);
    expect(extension.rows).toHaveLength(1);
  });

  it("keeps representative count and first-page plans linear", async () => {
    const probes = [
      ["clients", sql`from clients c where c.is_deleted = false and (c.first_name ilike '%plan-probe%' or c.last_name ilike '%plan-probe%' or c.uci_number ilike '%plan-probe%' or c.assigned_coordinator_id in (select id from users where name ilike '%plan-probe%') or c.id in (select client_id from authorizations where is_deleted = false and auth_number ilike '%plan-probe%'))`, sql`order by c.last_name, c.first_name`],
      ["vendors", sql`from vendors v where v.name ilike '%plan-probe%' or v.email ilike '%plan-probe%' or v.id in (select vendor_id from authorizations where is_deleted = false and auth_number ilike '%plan-probe%')`, sql`order by v.name`],
      ["invoices", sql`from invoices i where i.is_deleted = false and (i.notes ilike '%plan-probe%' or i.service_month ilike '%plan-probe%' or i.client_id in (select id from clients where is_deleted = false and (first_name || ' ' || last_name) ilike '%plan-probe%') or i.id in (select invoice_id from invoice_line_items where service_month ilike '%plan-probe%'))`, sql`order by i.created_at desc`],
      ["authorizations", sql`from authorizations a where a.is_deleted = false and (a.auth_number ilike '%plan-probe%' or a.service_code ilike '%plan-probe%' or a.client_id in (select id from clients where is_deleted = false and (first_name || ' ' || last_name) ilike '%plan-probe%'))`, sql`order by a.created_at desc`],
      ["payments", sql`from payments p where p.is_deleted = false and (p.qb_check_number ilike '%plan-probe%' or p.payment_month ilike '%plan-probe%' or p.client_id in (select id from clients where is_deleted = false and (first_name || ' ' || last_name) ilike '%plan-probe%') or p.id in (select pa.payment_id from payment_allocations pa inner join authorizations a on a.id = pa.authorization_id where a.is_deleted = false and a.auth_number ilike '%plan-probe%'))`, sql`order by p.check_date desc`],
      ["referrals", sql`from referrals r inner join clients c on c.id = r.client_id and c.is_deleted = false where r.parent_email ilike '%plan-probe%' or r.notes ilike '%plan-probe%' or r.client_id in (select id from clients where is_deleted = false and (first_name || ' ' || last_name) ilike '%plan-probe%')`, sql`order by r.created_at desc`],
      ["remittances", sql`from remittances r where r.is_deleted = false and (r.alta_reference ilike '%plan-probe%' or r.report_reference ilike '%plan-probe%' or r.client_id in (select id from clients where is_deleted = false and (first_name || ' ' || last_name) ilike '%plan-probe%'))`, sql`order by r.created_at desc`],
      ["audit_log", sql`from audit_log a where a.action ilike '%plan-probe%' or a.entity_type ilike '%plan-probe%' or a.detail ilike '%plan-probe%' or a.user_id in (select id from users where name ilike '%plan-probe%' or email ilike '%plan-probe%')`, sql`order by a.created_at desc`],
      ["users", sql`from users u where u.name ilike '%plan-probe%' or u.email ilike '%plan-probe%' or u.phone ilike '%plan-probe%'`, sql`order by u.name`],
    ] as const;

    for (const [relation, fromAndWhere, order] of probes) {
      for (const [shape, query] of [
        ["count", sql`select count(*) ${fromAndWhere}`],
        ["page", sql`select * ${fromAndWhere} ${order} limit 50`],
      ] as const) {
        const result = await db.execute(sql`explain (analyze, buffers, format json) ${query}`);
        const resultRows = result.rows as Array<{ "QUERY PLAN": unknown[] }>;
        const explained = resultRows[0]["QUERY PLAN"][0] as {
          Plan: ExplainNode & { "Total Cost": number };
          "Execution Time": number;
        };
        expect(explained.Plan["Total Cost"], `${relation} ${shape} cost`).toBeGreaterThanOrEqual(0);
        expect(explained["Execution Time"], `${relation} ${shape} execution`).toBeLessThan(2_000);
        expect(
          correlatedLoopCounts(explained.Plan).every((loops) => loops <= 1),
          `${relation} ${shape} must not reevaluate a related-record search per outer row`,
        ).toBe(true);
      }
    }
  });
});