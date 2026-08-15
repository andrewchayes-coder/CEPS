---
name: Import dedupe & natural keys
description: Rules for CSV import duplicate detection and natural-key uniqueness across import paths
---
- Remittance dedupe fingerprints MUST hash pre-resolution source values (UCI, auth number, check ref, normalized amount/month/date) — never resolved UUIDs. **Why:** two import paths (Alta report import and generic bulk import) must hash the same logical row identically or dedupe is bypassed.
- Natural keys enforced at DB level: vendors UNIQUE lower(name); authorizations UNIQUE (client_id, auth_number) partial WHERE is_deleted=false. Commit paths catch 23505 and reclassify as skipped_duplicate.
- Ambiguous FK resolution (duplicate vendor names, duplicate auth numbers per client) is a hard row error — never pick one.
- Historical payment imports use source "historical_import" and must never call autoGenerateFee. Any new persisted enum value must also be added to the openapi.yaml enum or list-response validation breaks.
- Alta remittance parser columns are interim (`interim_alta_columns_pending_confirmation` marker in altaRemittanceParser.ts) — swap in one file once a real sample report arrives.
