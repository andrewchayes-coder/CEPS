> **How to use this:** Paste everything below the line into Replit Agent as your first message when you create the new Repl (choose the full-stack app / "build me an app" flow). It's written to be handed to the agent directly. Answers to a handful of items are still pending from CEPS (marked **[CONFIRM]** below) — either resolve those first or tell the agent to make a reasonable placeholder choice and flag it for review.

---

You are building a production web application for **CEPS** ("Community Engaged Payee Support"), a nonprofit that administers a Purchase of Service (PDS) / Financial Management Services (FMS) program connecting individuals with developmental disabilities to community-based services funded through California Regional Centers (primarily Alta Regional Center). Today this runs on paper referral packets, PDF authorizations, Excel, and QuickBooks. You are replacing that manual workflow end-to-end with a single web application used by four different types of people: CEPS staff, Regional Center service coordinators, parents/guardians (or self-representing adult clients), and vendors.

Build this as a **Phase 1 Core MVP** first, end-to-end and fully working, before touching anything listed under Phase 2 or the Automation Add-On later in this document. Use PostgreSQL, a responsive web app (no native mobile), and application-level authentication. Do not load or accept any real client, consumer, or vendor data — use dummy/de-identified data for all development and testing. Real data may only be entered after CEPS confirms in writing that its own compliance requirements are met (see "Data & Compliance Guardrails" below).

## 1. Technology Stack

- **Hosting/runtime:** Replit, for both development and production. No separate production hosting environment.
- **Database:** PostgreSQL (Replit-hosted).
- **Auth:** Custom application-level authentication — email/password for CEPS staff and service coordinators; passwordless magic links for parents/guardians, self-representing clients, and vendors.
- **AI/OCR:** Claude API, used for parsing fields out of the Alta POS/authorization PDF (Phase 1 — see Module 4). Use dummy/de-identified sample PDFs during development.
- **QuickBooks:** QuickBooks Online API via OAuth, **read-only** — this app never writes checks or invoices into QuickBooks. QuickBooks Desktop is not supported (no API).
- **Transactional email (Phase 1):** Phase 1 still needs to deliver magic-link emails and basic staff notifications even though SendGrid isn't scoped in until Phase 2 — **[CONFIRM]** use a lightweight transactional email provider (e.g. Resend, Postmark) for Phase 1, then formally migrate to SendGrid in Phase 2 for richer in-app messaging (Module 12). Flag this choice for CEPS/Drew review rather than silently picking one.
- **Email (Phase 2 only):** SendGrid, once a CEPS-owned sending domain is available for DKIM/SPF authentication.
- **Automation Add-On:** Built and run *outside* this Replit app (separate Claude API bots) — do not build this inside the main application. It's described here only so the schema and payment/remittance log support it later (see Section 8).

## 2. Design System (per CEPS's Identity Standards & Guidelines)

CEPS did not provide actual logo image files (.png/.svg) alongside their style guide — only the identity-standards document describing usage rules. Until CEPS supplies real logo files, render a simple text wordmark ("CEPS") in the primary brand blue in the header/nav rather than fabricating a logo. Leave a clearly-marked spot to drop in the real logo asset later.

**Color palette** (use the primary blue as the dominant UI color — buttons, active states, links, header; use the others sparingly as accents for status badges, charts, and highlights — not as large background fields):

| Role | Hex | Notes |
|---|---|---|
| Primary (Blue) | `#00A8E0` | Primary brand color — main CTAs, links, active nav state |
| Dark Orange | `#F2863A` | Accent / warning-adjacent status |
| Light Orange / Gold | `#F3B11B` | Accent / pending-status badges |
| Purple | `#813072` | Accent |
| Turquoise | `#5EBE8F` | Accent / success-adjacent status |
| Lime | `#AFCE0C` | Accent |

Pair these with standard neutral grays/whites for backgrounds, body text, and borders — the palette above is for brand accents and status indicators, not for large surfaces. Ensure all color pairings meet WCAG AA contrast, particularly for status badges (don't rely on color alone — pair with text/icons for colorblind accessibility, since several of these accent colors are similar in hue to each other for some users).

**Typography:** CEPS's brand typefaces are Gotham (primary, used in their logo wordmark) and Trade Gothic Next LT Pro (secondary/web), with Helvetica Neue as an approved alternate. These are commercial fonts that likely aren't licensed for this app — **[CONFIRM with CEPS]** whether they have web-license files to provide. In the meantime, use a clean geometric sans that's visually close to Gotham and freely available (e.g. **Inter**, **Poppins**, or **Manrope** via Google Fonts) for headings and UI chrome, with a system sans-serif stack (`-apple-system, "Helvetica Neue", Arial, sans-serif`) as the fallback/body font — consistent with Helvetica Neue being CEPS's own approved alternate.

**Logo usage rules to respect once real logo files are added:** maintain clear space around the mark (roughly the height of the "P" in the wordmark), never recolor or skew it, and never place the full-color logo over a background that isn't at least ~80% white/light. Use the horizontal lockup in wide/landscape headers and the vertical lockup in narrow/portrait contexts (e.g. a mobile nav drawer or a printed 1099 cover sheet).

## 3. User Roles & Authentication

Five roles, each scoped to its own data:

| Role | Who | Access |
|---|---|---|
| `staff` | CEPS employees | Full access to all records and functions; accounts created/invited by a CEPS admin |
| `service_coordinator` | Alta Regional Center caseworkers | Scoped to their assigned caseload; submit referrals; view payment history for their clients |
| `parent_guardian` | Family members of clients | Scoped to their child's records; e-signature via magic link; view service/payment status |
| `self` | Adult clients who self-represent (no parent/guardian) | Same as `parent_guardian` but scoped to their own record |
| `vendor` | Service providers (individuals or orgs) | Scoped to their own records; submit W-9 and invoices; view their payment history |

Requirements:
- CEPS requires **individually named accounts for every staff member — no shared logins** — plus a per-user audit history log (who did what, when) for accountability.
- Role-based access control must be enforced at the middleware/route level, not just hidden in the UI.
- Account creation: staff and coordinators are created/invited by a CEPS admin with role assigned at creation. Parents/guardians and self-representing clients start with a magic-link-only interaction (no account needed to complete their first e-signature) and are prompted, optionally, to create a full account afterward for ongoing portal access. Vendors are invited by CEPS staff and get portal access once a W-9 is on file.
- Magic link tokens expire on first use or after 30 days, whichever comes first.

## 4. Data Model

Design the schema around these entities. Field names/types are a working draft validated against CEPS's actual referral form (Section 9 below) and discovery calls — confirm anything still marked **[CONFIRM]** rather than guessing silently.

### Client / Consumer
| Field | Type | Required | Notes |
|---|---|---|---|
| id | UUID | Yes | |
| first_name | String | Yes | |
| last_name | String | Yes | |
| date_of_birth | Date | Yes | |
| uci_number | String | Yes | Regional Center's unique client identifier — **[CONFIRM]** exact format/uniqueness rules with CEPS |
| address | String | No | |
| phone | String | No | |
| email | String | No | |
| status | Enum | Yes | `active \| inactive \| closed` |
| regional_center | String | No | e.g. "Alta Regional Center" |
| preferred_language | String | No | For translated materials / interpreter coordination |
| assigned_coordinator_id | FK → User | No | Auto-populated from the most recent referral's service coordinator; staff can manually reassign at any time (coordinator turnover is common) |
| created_at | Timestamp | Yes | |

### Referral
| Field | Type | Required | Notes |
|---|---|---|---|
| id | UUID | Yes | |
| client_id | FK → Client | Yes | Created at time of first referral |
| service_coordinator_id | FK → User | No | |
| referral_date | Date | Yes | |
| status | Enum | Yes | `Intake → Pending Signature → Pending Auth → Pending W-9 → Pending Invoice → Active → Closed` |
| submitted_via | String | No | `portal \| staff_manual_entry` — portal is the standard path; manual entry is a fallback for rare phone-in referrals |
| intake_fields | JSON | No | Structured data entered directly via the fillable portal form — see Section 9 for the full field list. **No PDF upload or OCR for referrals — this is a fillable form only.** |
| parent_email | String | No | Triggers the magic link |
| parent_magic_token | String | No | Expires on use or after 30 days |
| parent_signed_at | Timestamp | No | |
| alta_auth_received_at | Timestamp | No | Set once the POS/authorization PDF is loaded |
| service_frequency | Enum | No | `one_time \| monthly` |
| notes | Text | No | |
| created_at | Timestamp | Yes | |

### Authorization (POS — Purchase of Service)
| Field | Type | Required | Notes |
|---|---|---|---|
| id | UUID | Yes | |
| client_id | FK → Client | Yes | |
| vendor_id | FK → Vendor | No | Nullable — fee authorizations may not be vendor-specific |
| auth_number | String | Yes | Used as the validation key for payments |
| service_code | String | Yes | Labeled "Budget Code" on the POS form. Exactly three codes are used, no subcodes: **459 = direct payment to vendor, 024 = reimbursement (to parent), 490 = fee.** Determines `payment_type`. |
| payment_type | Enum | Yes | `direct_payment \| reimbursement \| fee` — derived from service_code, staff can override |
| activity_description | String | No | e.g. "Social Recreation" |
| service_period_start | Date | Yes | |
| service_period_end | Date | Yes | System should alert as this approaches |
| monthly_amount | Decimal | No | |
| one_time_amount | Decimal | No | |
| max_period_amount | Decimal | Yes | Total ceiling for the full authorization. **Known data-quality issue:** some POS forms only print a single month's amount here even when the authorization spans multiple months (e.g. $150/month × 6 months should be $900 but the form may show $150). See the "Max-Amount Warning" business rule below — do not silently trust this field. |
| units | Integer | No | |
| status | Enum | Yes | `active \| expired \| pending \| exhausted` |
| pos_pdf_url | String | No | |
| received_date | Date | No | |

### Invoice
| Field | Type | Required | Notes |
|---|---|---|---|
| id | UUID | Yes | |
| client_id | FK → Client | Yes | |
| authorization_id | FK → Authorization | Yes | Must be selected before an invoice can be approved |
| vendor_id | FK → Vendor | No | Nullable for parent-submitted reimbursement invoices |
| submitted_by_role | Enum | Yes | `vendor \| parent \| staff` |
| submitted_date | Date | Yes | |
| service_month | String | Yes | `YYYY-MM` |
| amount_requested | Decimal | Yes | |
| payment_type | Enum | Yes | `direct_payment \| reimbursement` — must match the authorization's payment_type |
| document_url | String | No | Uploaded invoice PDF/photo |
| status | Enum | Yes | `pending_review \| validated \| approved \| rejected \| duplicate` |
| reviewed_by | FK → User | No | |
| reviewed_at | Timestamp | No | |
| notes | Text | No | |

### Payment / Check
| Field | Type | Required | Notes |
|---|---|---|---|
| id | UUID | Yes | |
| client_id | FK → Client | Yes | |
| authorization_id | FK → Authorization | No | |
| vendor_id | FK → Vendor | No | |
| invoice_id | FK → Invoice | No | |
| qb_check_number | String | Yes | |
| check_date | Date | Yes | |
| amount | Decimal | Yes | |
| payment_month | String | No | `YYYY-MM`, may differ from check date |
| payment_type | Enum | Yes | `direct_payment \| reimbursement \| fee` |
| source | Enum | Yes | `quickbooks \| manual` — QB-pulled records are read-only in the UI |
| logged_by | FK → User | No | For manually-logged payments |

### Remittance
Money coming back **from** Alta to CEPS (separate from — and not to be confused with — the `024 reimbursement` payment type, which is money CEPS pays *out* to a parent).

| Field | Type | Required | Notes |
|---|---|---|---|
| id | UUID | Yes | |
| client_id | FK → Client | Yes | |
| authorization_id | FK → Authorization | No | |
| alta_reference | String | No | |
| remittance_date | Date | Yes | |
| amount | Decimal | Yes | |
| payment_month | String | No | |
| status | Enum | Yes | `pending \| received \| matched` |
| source | Enum | Yes | `alta_regional \| manual` |
| matched_payment_id | FK → Payment | No | |
| auto_matched | Boolean | Yes | |
| remittance_batch_id | String | No | A single Alta "Payment Detail Report" commonly covers multiple clients and/or service months at once — this groups the split-out lines together so the payment log still shows correct remitted status per client/authorization/month. |

### Vendor
| Field | Type | Required | Notes |
|---|---|---|---|
| id | UUID | Yes | |
| name | String | Yes | |
| alta_vendor_number | String | No | Alta's own vendor ID (e.g. "PA1737"), distinct from this app's internal id — cross-reference only |
| ein | String | No | ~60% of existing vendors have one on file; required for Phase 2 1099s |
| billing_address | String | No | From QB export — may be a shared billing address, not the service location |
| service_address | String | No | May differ from billing_address |
| phone | String | No | |
| email | String | No | Vendor portal login |
| contact_person | String | No | |
| w9_status | Enum | Yes | `pending \| on_file \| expired` — system must block payment while pending |
| w9_document_url | String | No | |
| preferred | Boolean | Yes | Shown first in vendor selection dropdowns |
| active | Boolean | Yes | Soft delete — inactive vendors remain for history |

### User
| Field | Type | Required | Notes |
|---|---|---|---|
| id | UUID | Yes | |
| name | String | Yes | |
| email | String | Yes | Unique login identifier |
| phone | String | No | |
| role | Enum | Yes | `staff \| service_coordinator \| parent_guardian \| self \| vendor` |
| linked_record_id | UUID | No | FK to Client (parent_guardian/self) or Vendor (vendor) |
| linked_record_type | Enum | No | `client \| vendor` |
| account_created_at | Timestamp | No | Null for magic-link-only users |
| last_login | Timestamp | No | |
| active | Boolean | Yes | |

**Entity relationships:** Client →< Referral · Client →< Authorization ><Vendor · Authorization →< Invoice · Invoice →< Payment (source: QuickBooks) · Authorization →< Remittance (source: Alta Regional) · Client →< User (role: parent_guardian/self) · Vendor →< User (role: vendor).

## 5. Key Workflows

**5.1 Referral Intake**
1. The Alta service coordinator logs into the portal and submits a referral via the fillable form (Section 9) — structured data entry, no PDF upload, no OCR. Volume can range from 15–46 referrals in a single day.
2. The system validates required fields and creates the referral record immediately.
3. As soon as the coordinator enters the parent's email, the system automatically sends a magic-link email for the agreement/e-signature section.
4. The parent/guardian (or self-representing adult client) reviews and electronically signs.
5. CEPS staff is notified once fully signed; status advances to "Pending Auth."
6. CEPS waits for the formal POS/authorization PDF from Alta's fiscal department (manual upload in Phase 1; automated daily retrieval is the separate Automation Add-On, Section 8).
7. Once authorization is in hand and parsed, if the vendor doesn't already have a W-9 on file, status moves to "Pending W-9"; otherwise it skips straight to "Pending Invoice."
8. Once the first invoice is validated, status becomes "Active."
9. **Documents don't always arrive in this order in practice** (e.g. an invoice may show up before the authorization exists). The app must accept and hold documents in a pending state regardless of case status, rather than enforcing strict sequential submission — staff complete validation once all required pieces are present.

**5.2 Authorization & Payment (CEPS pays vendor or parent)**
1. An invoice arrives (portal, or email/staff entry as a fallback).
2. Staff opens it, selects the client, then selects the applicable authorization from that client's active list.
3. System checks, before anything is marked valid: (a) the authorization is active and not expired, (b) the service month falls within the authorized service period, (c) the amount matches the authorized monthly/one-time amount, (d) no payment already exists for this client + authorization + service month, (e) this amount plus all prior validated/approved payments against the same authorization does not exceed `max_period_amount` (see the data-quality caveat above).
4. If all checks pass, invoice status becomes "Validated," then staff marks it "Approved" and hands it to the check processor (outside the app, in QuickBooks).
5. After each QuickBooks check run, Payment records get populated either via the QuickBooks OAuth pull (primary path) or a manual check-register upload (fallback) — no manual entry of individual check numbers/dates in the normal path.
6. When a Payment is recorded for a client/month, auto-generate a corresponding **Fee** record for that client/month, mirroring CEPS's existing QuickBooks practice — **[CONFIRM]** exact trigger rules and qualifying service codes with CEPS before finalizing this logic; build the record structure now, refine the trigger condition once confirmed.

**5.3 Alta Remittance**
1. Alta issues a "Payment Detail Report" that can cover multiple clients and/or service months in a single payment.
2. Staff downloads it from Alta's portal (automated retrieval is the separate Add-On).
3. Each line item is matched against an existing Payment record for the same client/authorization/service month — this is a *matching* step against payments already on file, distinct from the invoice-validation flow above.
4. Matched Payment records are marked "remitted" and linked via `remittance_batch_id` (since one Alta payment often splits across several client/authorization/month records).
5. Unmatched lines are flagged for manual staff review.

**5.4 Parent / Guardian / Self E-Signature**
Same flow whether it's a parent/guardian or a self-representing adult client — wherever "parent" appears, treat it as "parent/guardian or self." Magic link → pre-filled agreement page → typed name + confirmation checkbox → timestamp + IP logged → optional account-creation prompt afterward. **[CONFIRM with CEPS/legal]** whether typed-name + checkbox is legally sufficient or a tracked e-signature (DocuSign-style) is required — build the simpler version first but keep the signature capture modular so it can be swapped later.

**5.5 POS / Authorization PDF Parsing**
Field positions are consistent across Alta's POS forms. Use the Claude API with a field map (position → field name) trained on sample forms to extract: client name, address, phone, UCI number, service period, service code/"Budget Code," activity description, authorization units, monthly amount, max period amount, caseworker name. **Staff always reviews and can edit parsed values before confirming — never auto-commit parsed data.** Fall back to fully manual entry if parsing fails.

## 6. Phase 1 — Core MVP (build this first, in full)

**Module 1 — Foundation: Database, Auth & User Roles**
Full schema from Section 4. Email/password + magic-link auth. Middleware-level RBAC on every route. Admin panel for CEPS staff to create/invite users and assign roles — individually named accounts only, no shared logins. Per-user audit log of actions.

**Module 2 — Referral Intake**
Fillable portal form for service coordinators (see Section 9 for exact fields) — the sole intake path. Staff manual-entry fallback into the same form for rare phone-in cases. Required-field validation. A confirmation/review screen before final submit. Parent-email capture that auto-triggers the magic link.

**Module 3 — Case Record Management & Staff Dashboard**
Case status workflow as in Section 4 (Referral.status). Dashboard filterable by status, assignee, date, and vendor. Case detail view showing all documents/authorizations/payment history in one place. Authorization list per case with expiry alerts. Payment & remittance log per client, grouped by authorization then by month, showing paid/remitted status. Optional outreach/contact log. Missing-document and expiring-authorization dashboard badges. Assigned-coordinator display with manual reassignment (coordinator turnover is common — reassigning must update which coordinator sees the client in their portal caseload).

**Module 4 — Authorization (POS) Management**
Manual POS upload with Claude-API-assisted field extraction and mandatory staff review before confirming. Support 6+ simultaneous authorizations per client. Link authorization to vendor. Derive `payment_type` from `service_code` (459/024/490) with staff override. **Max-amount warning:** if `monthly_amount` is set, the service period spans more than one month, and `max_period_amount` equals `monthly_amount`, warn staff to confirm/correct the true total before saving — this is a known recurring data-entry error on the source PDFs.

**Module 5 — Invoice Validation & Payment Logging**
Invoice intake via vendor portal, parent submission, or staff manual entry. Full validation workflow from Section 5.2, including the hard duplicate-payment stop (staff must override with a written justification note, never a silent bypass). Check-register upload with automatic parsing/matching into Payment records, working alongside the QuickBooks OAuth pull as a fallback path. Auto-generation of Fee records per the rule in Section 5.2 (flag the trigger-rule gap for CEPS).

**Module 6 — Vendor Database & Management**
Import from Excel/QuickBooks export. Add/edit vendor records. Preferred-vendor flag surfaced first in dropdowns. W-9 tracking that hard-blocks payment while status is `pending`. Vendor ↔ authorization linkage.

**Module 7 — Vendor Portal**
Vendor login (email/password or magic link), scoped to their own records only. View assigned clients/active authorizations, submit invoices (upload or form), view invoice and payment status/history, submit/upload W-9, and self-manage profile info (staff reviews changes before they take effect).

**Module 8 — QuickBooks Integration**
Read-only OAuth connection to QuickBooks **Online** (not Desktop). CEPS does not track invoices in QuickBooks — it's used solely to write checks — so the only integration needed is pulling check records (amount, date, QB check number, client/project, vendor) and surfacing them against client/vendor records. This app never writes to QuickBooks.

**Module 9 — Reporting & Dashboards**
Program-level case-status overview, vendor payment summary (YTD, feeds Phase 2 1099s), pending-authorization tracker, missing-document alerts, expiring-authorization alerts. Every report/dashboard view must be exportable to CSV/XLS for offline use and Regional Center billing reconciliation.

**MVP Launch checklist** (all required before any real data enters the system): internal QA of every workflow end-to-end with dummy data; CEPS's own written confirmation that its data security/compliance requirements are met (see Section 7); vendor data imported; CEPS staff onboarded with accounts/roles; one successful live referral run in production.

## 7. Data & Compliance Guardrails

CEPS has researched and confirmed HIPAA does not apply to this program, but the app will still handle sensitive PII (names, addresses, payment records), so general data-security discipline still applies regardless of HIPAA status:

- Neither Replit nor the developer makes any compliance guarantee beyond Replit's platform-level SOC 2 Type II certification and encryption at rest/in transit.
- **No real client, consumer, or vendor data may be loaded — dev and testing use dummy/de-identified data only — until CEPS has confirmed in writing that the hosting environment meets its own data security and compliance requirements.** Treat this as a hard gate before MVP Launch, not a soft recommendation.
- CEPS may separately elect to require Anthropic's Claude API Business Associate Agreement as an extra safeguard for the AI/OCR parsing and (later) the automation bots once real data is in play — build with that swap-in in mind rather than hardcoding a specific Claude API tier/agreement assumption.

## 8. Phase 2 and the Automation Add-On (do NOT build yet — context only)

Design the schema and module boundaries above so these can be layered on later without a rework, but do not implement them in this pass:

- **Module 10 — AI Chat Agent:** staff-configurable FAQ knowledge base (seed content is in Section 10 below) plus a RAG layer so the agent can answer both general policy questions and record-specific questions (e.g. "do I have an active authorization?") from the live database, with separate contexts per user type so each role only sees answers appropriate to its access level.
- **Module 11 — 1099 Generation:** pull annual per-vendor totals from QuickBooks, map to 1099-NEC fields, bulk-generate PDFs, deliver electronically via the vendor portal. IRS e-filing (FIRE system or a service like Track1099) is a separate, TBD research item — not committed scope.
- **Module 12 — In-App Messaging (SendGrid):** case notifications, invoice-status updates, signature reminders, message threads attached to records, and segment-based bulk messaging (e.g. "all vendors missing a W-9"). Requires a CEPS-owned sending domain for DKIM/SPF.
- **Automation Add-On (built outside this Replit app):** a scheduled job that logs into the Alta Regional Center portal daily, retrieves new POS/authorization PDFs, and auto-uploads them for parsing (eliminating the manual daily download); plus automatic matching of Alta's "Payment Detail Report" remittance data against the payment log, splitting a single Alta payment across the correct client/authorization/month combinations via `remittance_batch_id`.

## 9. Referral Form — Exact Fields (Module 2)

This is CEPS's actual field list for the fillable referral form — build to this, not a paraphrase:

**Service Coordinator Info:** Regional Center name · Service coordinator name · Service coordinator email · Service coordinator direct number.

**Vendor Info:** Does the vendor accept checks? (Yes/No — selecting **No disables the rest of the form**, since FMS can only pay vendors who accept checks) · Vendor name · Vendor email · Vendor phone number · Person of contact at business (optional) · Vendor service address (street, city, ZIP, state) · Is the vendor billing address different than the service address? (Yes/No/Unknown — if Yes, capture a separate vendor billing address: street, city, ZIP, state).

**Activity Info:** Service type requested (Direct Pay [459] or Reimbursement [024]) · Description of activity (free text, e.g. "2-hour guitar lessons, once a week at Guitar Center, $100/lesson, 5 weeks = $500/mo") · Service dates (start/end) · POS number (optional) · POS dates (optional, start/end).

**Client Info:** First name · Last name · DOB · UCI # · Preferred language · Family representative name (optional) · Is the client a minor? — if **Yes**: family representative phone number, email, and address (street, city, ZIP, state); if **No**: client's own phone number, email, and address (street, city, ZIP, state).

Implement the "disable rest of form" and "branch on minor status" logic as real conditional form logic, not just visual hints — a service coordinator should not be able to submit a referral for a vendor who doesn't accept checks, and the client-vs-family-representative contact fields must switch based on the minor-status answer.

## 10. Phase 2 FAQ Seed Content (for the future AI Chat Agent's knowledge base — capture now, don't build the agent yet)

**From Service Coordinators:** What is your vendor number? Are you accepting new clients? What authorization code do I need to use? Do the authorization dates need to line up with the dates of service? How do I submit a new referral to you? Can I get an update on a referral I submitted / did the payment go out? Have you received the authorization yet? Can you pay by card? Do you process reimbursements? When do I need to submit a new referral vs. update an existing one? How do I set up the authorization? What's your turnaround time?

**From Parents/Guardians:** Who are you? Where is my reimbursement? Can I get an update on a referral I submitted / did the payment go out? What do I need to do on my end? Do I submit invoices, or does the vendor? The vendor says they haven't been paid — what's going on? I can't open the email you sent. I'm having trouble filling out the referral. When can my child start their activity? I want to change my child's activity/frequency/vendor — what do I do? I need to update my address on file. What are the next steps? Can you pay by credit card?

**From Vendors:** Who are you? Where's my payment? Why do you need a W-9? I need to update my address on file. Do you have a referral for [client name]? Can you pay by card? Can you pay for multiple months at once? What's the process / what are the next steps? Did you receive an authorization for [client name]? How much is [client name] approved for? What months is [client name] approved for? I'm raising my rates — what do I do? What information does an invoice need to include?

## 11. Explicitly Out of Scope (do not build; flag if asked to expand)

- Historical data migration from Excel/QuickBooks (CEPS goes live with new referrals and builds history organically; a full migration would be a separate scoped engagement).
- IRS 1099 e-filing (FIRE system or a service like Track1099) — vendor-facing PDF delivery is in scope for Phase 2, e-filing is not.
- Writing or issuing checks — all check processing stays in QuickBooks; this app only ever displays/pulls check data.
- Syncing invoices into QuickBooks — invoices are tracked independently in this app.
- Native iOS/Android apps — responsive web only.
- Support for Regional Centers other than Alta — the initial build assumes Alta only.
- SendGrid, QuickBooks Online subscription costs, and any 1099 e-filing service — these are CEPS's own direct costs, not part of this build.

## 12. Open Items Still Needing a CEPS Answer

Build reasonable defaults where noted, but don't treat these as settled:

- Exact UCI number format/uniqueness rules.
- Whether typed-name e-signature is legally sufficient or a tracked e-signature product is required.
- Whether vendors fill out W-9 electronically in-portal or only upload a signed PDF.
- Fee auto-generation trigger rules and qualifying service codes (Module 5).
- Sample Alta "Payment Detail Report" and a sample check-register export — needed to finalize the remittance-matching and check-register-parsing logic; build the data model now, finalize the parser once samples are in hand.
- Whether CEPS wants 1099 IRS e-filing or vendor-facing PDF delivery only (Phase 2 decision, not urgent now).

---

Start with Module 1 (schema + auth + roles), then work through Modules 2–9 in order, since each depends on the ones before it (you can't validate an invoice against an authorization that doesn't exist yet, etc.). Ask before making an irreversible schema decision on anything marked **[CONFIRM]** above rather than guessing silently.
