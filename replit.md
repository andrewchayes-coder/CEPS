# CEPS Portal

## Overview
Web app for CEPS (Community Engaged Payee Support), a nonprofit administering a POS/FMS program for individuals with developmental disabilities via California Regional Centers (Alta). Replaces a paper/Excel/QuickBooks workflow with a role-based portal: staff, service coordinators, parents/guardians, self-representing clients, and vendors.

Build spec: `attached_assets/CEPS_Replit_Build_Prompt_1786734661546.md`. Open [CONFIRM] items and interim defaults: `docs/CEPS_OPEN_ITEMS.md`.

## Architecture
pnpm monorepo, OpenAPI-first:
- `lib/api-spec/openapi.yaml` — API contract (~30 endpoints). Run `pnpm --filter @workspace/api-spec run codegen` after edits. Note: the generated `lib/api-zod/src/generated/api.ts` must import from `zod/v4` (codegen emits `zod` — re-apply the import fix after regenerating).
- `lib/db/src/schema/` — Drizzle tables: users, sessions, magic_links, clients, vendors, referrals, authorizations, invoices, payments, remittances, audit_log.
- `artifacts/api-server` — Express 5 API. Custom session auth (httpOnly cookie, scrypt password hashes), magic links (login + e-signature; no email provider yet — dev links returned as `devLink`), RBAC scoping by role/linkedRecord, audit logging on staff mutations, Claude POS PDF parsing via Replit AI integration (`@workspace/integrations-anthropic-ai`).
- `artifacts/ceps-portal` — React/Vite frontend (wouter, react-query hooks from `@workspace/api-client-react`), previewPath `/`.

## Key business rules
- Referral flow: intake → pending_signature → pending_auth → pending_w9 (skipped if W-9 on file) → pending_invoice → active → closed.
- Invoice validation (`POST /invoices/{id}/validate`): auth active, month in period, amount within authorized, no duplicate payment (hard stop; override requires written justification), cumulative ≤ max period amount.
- paymentType derived from service code: 459=direct_payment, 024=reimbursement, 490=fee (staff can override).
- Max-amount data-quality warning on authorization create (monthly set + multi-month period + max==monthly) — resubmit with `acceptMaxAmountWarning`.
- Magic tokens: single use, 30-day expiry. Pending W-9 blocks payment; preferred vendors sort first.
- Fee auto-generation on payment: placeholder TODO (rule unconfirmed — see open items).

## Dev notes
- Seed dummy data: `npx tsx artifacts/api-server/src/scripts/seed.ts` (idempotent). Demo logins (password `ceps-demo-2026`): staff@ceps.example, coordinator@alta.example, parent@family.example, vendor@sunrisemusic.example.
- Dummy data only — never seed or import real client data.
- Brand: primary blue #00A8E0, accents (#F2863A, #F3B11B, #813072, #5EBE8F, #AFCE0C) for status only; "CEPS" text wordmark; no emojis in UI.

## User preferences
(none recorded yet)
