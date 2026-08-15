---
name: List endpoint pagination
description: Conventions for paginated list endpoints and pages
---
All seven list endpoints (payments, referrals, clients, vendors, authorizations, invoices, remittances) return { items, total } with limit/offset params (clamp: limit 1..1000 default 50, offset >=0). Role scoping and filters live in the drizzle .where(), count + page query in Promise.all, orderBy(desc(sortCol), desc(id)). search uses ilike with %/_ escaping (escapeLike helper). Hot filter columns are indexed (<table>_<column>_idx).

**Why:** JS .filter() after full-table fetch was the old pattern; scope conditions in SQL must stay AND-combined with caller filters so a filter can never widen a role's visibility (tests assert this).

**How to apply:** new list endpoints follow this shape; audit-log is the original reference but uses envelope key `entries` (the exception — everything else uses `items`). Dropdown consumers pass { limit: 1000 } and read .items. Known quirk: listVendors active param coerces "false"→true (open follow-up task).
