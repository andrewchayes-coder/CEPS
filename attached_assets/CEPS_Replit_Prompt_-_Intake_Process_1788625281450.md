# CEPS App — Intake Process (Participant Agreement E-Signature)

Digitizes the CEPS FMS Intake Packet you attached by extending the app's
**existing** referral e-signature flow, rather than building a separate
system. Three decisions locked in before writing this:

**Repo re-checked against current `main` (commit `f596fed`) before finalizing
this prompt.** 20 commits landed after the last review this was drafted
against (`e205795`) — mostly the 8/28 demo-feedback work: table sorting
everywhere, the Client→Participant wording rollout (partial — copy only,
not variable/table names), referral/SC reassignment with new ownership
checks, vendor creation, and a remittance-parsing refactor. None of it
touches the referral schema, the signature/agreement content, or anything
intake-specific — no conflict at the data-model or feature level. But three
of the files this prompt edits changed underneath it, so the steps below
now call out exactly what to preserve rather than assuming e205795-era code:
- `POST /referrals/:id/send-magic-link` and `GET /referrals/:id` gained a
  check that blocks a coordinator from acting on a referral they don't own
  — the replacement endpoint below must keep that check, not regress it.
- `sign.tsx` now fires `trackAnalyticsEvent('signature_completed', ...)` on
  successful submit, and already says "Participant" instead of "Client" in
  its existing copy — both need to survive the content rewrite below.
- `referrals/[id].tsx`'s header and main info card already went through
  the Participant-wording/`ClientLink` pass; the sidebar "Signature Status"
  card this prompt replaces is untouched and still matches the structure
  described below.

- **Extends the existing flow.** The app already has a Referral →
  magic-link → `/sign/:token` e-signature mechanism (typed name, "I agree"
  checkbox, IP/timestamp capture, optional portal-account creation on
  signing). This reuses that Referral record, magic-link table, and sign
  page rather than a new parallel Intake entity.
- **Scope is the Participant Agreement only** — packet pages 1–2 (the data
  table + contract terms + signature). Page 3 (the blank per-service
  Invoice form) is out of scope: real invoices already have a home in the
  app's existing Invoice module once services actually start.
- **No new outbound-email infrastructure.** The repo has no email provider
  wired up yet — `createSignatureLink` in `referrals.ts` returns a dev-only
  link today with a `[CONFIRM]` comment, and CEPS's provider choice
  (Postmark vs. SendGrid, or Google Auth as an alternative to magic-links)
  is still an open decision from the 9/4 demo. Wire actual sending behind
  one call point so dropping in a real provider later is a one-file change
  — don't pick a provider now, and don't block this feature on that choice.

Run Prompt 1 first — Prompt 2 depends on the fields and endpoint it adds.

---

## Prompt 1 — Recipient choice, agreement data, and the send flow

```
Extend the CEPS app's referral e-signature flow so CEPS staff can start and
resend the intake/agreement process, choosing who it goes to.

SCHEMA (lib/db/src/schema/referrals.ts + a migration):
1. Add `intakeSentTo` (text: 'participant' | 'family_rep', nullable) — who
   the most recent send targeted.
2. Add `intakeSentAt` (timestamptz, nullable) — when the most recent send
   happened (separate from `parentSignedAt`, which only ever fires once).
3. Add `signerRelationship` (text, nullable) — captured at signing time:
   'self' | 'parent' | 'guardian' | 'conservator'.
4. Add fields the real Participant Agreement needs that referrals don't
   capture today: `cost` (numeric(12,2), nullable), `paymentSchedule` (text,
   nullable, free-form e.g. "$210 on the 1st of each month"), and
   `paymentTypeRequested` (text: 'service_payment' | 'reimbursement',
   nullable — mirrors the packet's Service Payment / Reimbursement
   checkboxes; distinct from `authorizations.paymentType`, which gets set
   later once the Regional Center actually authorizes funding). Reuse the
   EXISTING `serviceFrequency` field (already 'one_time' | 'monthly') for
   the packet's "Cost Frequency" — don't add a duplicate field for it. All
   new fields are nullable — they're proposed/estimated figures pending RC
   authorization, not guaranteed final numbers.
   Update the OpenAPI spec (lib/api-spec/openapi.yaml) — never hand-edit
   lib/api-zod/src/generated or lib/api-client-react/src/generated, the
   next unrelated codegen run silently wipes hand edits there. Regenerate
   with `pnpm --filter @workspace/api-spec run codegen`, then re-apply the
   fix that run always needs: change `import * as zod from 'zod'` to
   `'zod/v4'` in lib/api-zod/src/generated/api.ts (zod 3.25's classic entry
   is missing methods Orval v8 emits).
   For the schema change itself: this repo uses versioned drizzle
   migrations, not `drizzle-kit push` — after editing referrals.ts, run
   `pnpm --filter @workspace/db run db:generate` then `db:migrate` in dev.
   Production schema is applied automatically by Replit's Publish flow;
   don't add a deploy-time migrate step.

API (artifacts/api-server/src/routes/referrals.ts):
5. Replace `POST /referrals/:id/send-magic-link` with
   `POST /referrals/:id/send-intake`, body `{ recipient: 'participant' |
   'family_rep', serviceFrequency?, cost?, paymentSchedule?,
   paymentTypeRequested? }`. Carry forward the service-coordinator
   ownership check already on the current route (a coordinator may only
   send for a referral they're assigned to) — don't regress it.
   Normalize '' to null on the optional string/numeric fields before
   writing, same as every other create/update route in this codebase
   (reuse the existing clean()-style helper rather than a new one).
   - Look up the referral's client. Resolve the target email:
     'participant' → client.email; 'family_rep' → client.familyRepEmail.
   - If client.isMinor is true, reject `recipient: 'participant'` with a
     400 ("A minor cannot sign for themselves — send to the family rep,
     guardian, or conservator instead"). The frontend shouldn't even offer
     that option in this case (see Prompt 2).
   - If the resolved email is blank, return 400 with a message telling
     staff to add that email to the participant/family rep record first —
     don't silently fall back to the other recipient.
   - If any of serviceFrequency/cost/paymentSchedule/paymentTypeRequested
     are passed, persist them onto the referral (staff confirm/fill these
     right before sending, since they may not have been known when the
     referral was first submitted).
   - Set `parentEmail` to the resolved address (existing field, now used
     generically for whichever recipient was chosen), `intakeSentTo` to the
     chosen recipient, `intakeSentAt` to now, and advance `status` to
     `pending_signature` if it's currently `intake` (leave other statuses
     alone so this also works as a resend without losing progress).
   - Reuse `createSignatureLink` for the actual magic-link creation — don't
     duplicate that logic.
   - Audit-log this the same way the old endpoint did, but include the
     recipient in the log message (e.g. "Sent to family rep:
     jane@example.com").
   - Delete the old `/send-magic-link` route and its OpenAPI operation/
     generated types; update the frontend hook name (`useSendReferralMagicLink`
     → e.g. `useSendIntake`) and every call site.

6. Wrap the actual email delivery behind a single function (e.g. a
   `sendIntakeEmail` helper next to `createSignatureLink`, or a new
   `lib/email` package if that reads cleaner) so there's exactly one place
   to plug in a real provider later. For now it should log the link
   server-side and keep returning `devLink` in the response outside
   production, same as today.

TESTS:
7. Add/extend tests (follow the existing referrals test files' pattern)
   covering: minor rejects 'participant' recipient; missing email on the
   chosen recipient 400s; a successful send sets intakeSentTo/intakeSentAt
   and advances status; resending after a signature already exists doesn't
   clobber parentSignedAt/signedByName.
```

---

## Prompt 2 — Real agreement content on the signing page + staff status

```
Replace the generic "Service Authorization Agreement" click-through at
/sign/:token (artifacts/ceps-portal/src/pages/sign.tsx) with the actual CEPS
Participant Agreement content, and give staff a clear intake status view.
Depends on Prompt 1's new fields and the send-intake endpoint.

sign.tsx already uses "Participant" wording in its current copy and fires
`trackAnalyticsEvent('signature_completed', {...})` on successful submit —
preserve both; this is a content/layout rewrite, not copy or analytics work.

SIGNING PAGE (sign.tsx + GetSignaturePageResponse):
1. Expand the signature-page payload (GET /signature/:token in
   referrals.ts) to include everything the Participant Agreement needs,
   pulled from the referral + its linked client + intakeFields:
   participant name, UCI, DOB, service coordinator name/phone, regional
   center, parent/guardian/conservator name (client.familyRepName when
   intakeSentTo is 'family_rep'; otherwise the participant's own name),
   contact phone/email, mailing address, recreational activity name
   (vendorName), activity contact info (vendorContactPerson/vendorPhone),
   activity mailing address (the vendor service-address fields), start/end
   date, cost frequency (serviceFrequency), cost, payment schedule, and
   payment type requested. Reuse the existing client/vendor name-map
   helpers rather than re-querying ad hoc.

2. Rebuild the page content around the real packet text (attached
   separately as a reference) instead of today's two placeholder
   paragraphs:
   - A data section covering everything in point 1, laid out like the
     packet's table (participant info, service coordinator, parent/
     guardian/conservator + relationship, recreational activity + contact +
     mailing address, start/end date, cost frequency, cost, payment
     schedule, payment type).
   - The agreement text itself, adapted from the packet (verbatim source
     below) — Purpose of RC Funds, Eligible Expenditures, Budget
     Development and Approval, Record Keeping and Documentation, and the
     Service Payment and/or Reimbursement Process section. Keep the
     existing layout conventions (Card, sections, Separator) rather than
     introducing a new visual style.

3. At signing, in addition to the existing typed-name + "I agree"
   checkbox, add:
   - A relationship select: Self / Parent / Guardian / Conservator —
     default to "Self" and lock it when intakeSentTo is 'participant'
     (client.isMinor is false in that case, so it can only be Self);
     otherwise required, no default. Persist to `signerRelationship` via
     `SubmitSignatureBody`.
   - A read-only "signing on behalf of a minor" indicator driven by
     client.isMinor — don't add a manual checkbox for this, we already
     know it from the client record.
   Keep the existing "create your portal account" section unchanged.

4. Keep the signature mechanism itself exactly as it works today (typed
   name as the legally-binding signature, IP + timestamp capture) — this
   is still flagged [CONFIRM] pending a legal-sufficiency check with CEPS
   per the existing open item. Don't add a drawn/canvas signature pad;
   that's out of scope here.

STAFF STATUS & NOTIFICATION:
5. On the referral detail page (referrals/[id].tsx), replace the
   "Signature Status" card with an "Intake Status" card showing one of:
   Not Started (no intakeSentAt) / Sent to Participant, awaiting signature
   (with send date + Resend button) / Sent to Family Rep, awaiting
   signature (same) / Signed on <date> by <name> (<relationship>). Keep
   the existing "already signed" success styling for the signed state.

6. Replace the plain "Resend Link" button with a "Send Intake" / "Resend
   Intake" dialog: staff pick Participant or Family Rep — only offer
   options that have an email on file, and if neither does, show both
   disabled with a link to edit the participant's contact info instead of
   letting the send fail silently. On first send only (status still
   'intake'), let staff confirm/fill the cost, cost frequency, payment
   schedule, and payment type fields added in Prompt 1 before sending.
   Wire this to the new send-intake endpoint.

7. Staff notification that an intake was completed: the app has no
   notification infrastructure today (no staff email, no in-app
   notification center), so don't build one from scratch here. Instead,
   add a "Recently completed" item to the dashboard's existing alerts feed
   (dashboard.ts / dashboard.tsx) for referrals whose parentSignedAt falls
   in the last 7 days, using the same alert-item shape (`kind`, `message`,
   `entityType`, `entityId`) as the existing pending_signature alert so it
   renders through the same feed component. This gets staff a visible
   "just happened" signal without new infrastructure. Flag a real
   staff-facing email/push notification as a follow-up once CEPS picks an
   email provider.

TESTS:
8. Add a test verifying the expanded GetSignaturePageResponse payload
   includes the new fields, and that submitting a signature persists
   signerRelationship.
```

---

### Agreement text (verbatim from the attached packet, for Prompt 2 step 2)

> **1. Purpose of RC Funds:** The recipient of RC Funds, herein referred to
> as the "Participant," acknowledges that the primary purpose of these
> funds is to empower individuals with developmental disabilities to
> exercise greater control over their service delivery and to achieve
> personal outcomes based on their individual needs, preferences, and
> goals.
>
> **2. Eligible Expenditures:** The Participant understands that RC Funds
> can be used for a range of services, supports, and goods that promote
> community inclusion, enhance quality of life, and facilitate the
> attainment of personal objectives. These include but are not limited to,
> services related to education, and social and recreational activities.
>
> **3. Budget Development and Approval:** The Participant agrees to
> collaborate with their Service Coordinator to obtain the proper
> authorization and provide the supporting documentation to obtain the
> authorization. This includes program invoices or contracts, with the
> business and/or program name, the contact information for the
> business/program, and the service that is provided: (Example: Joe's
> Karate Club, summer program 2 x per week from 7/1-8/31; cost $420.00).
> The Participant understands that purchases cannot be granted unless
> CEPS obtains authorization for the item, and CEPS cannot pay outside the
> authorized amount. The Participant acknowledges the responsibility to
> utilize RC Funds in accordance with the guidelines and regulations. Any
> proposed expenditures must be consistent with the Participant's
> Individual Program Plan (IPP) and must not contravene state and federal
> laws, regulations, or policies. CEPS does not receive the IPP, but will
> assume if the Participant receives authorization from the RC, that the
> services are in line with the IPP as the RC provides the authorization
> to CEPS.
>
> **4. Record Keeping and Documentation:** The Participant agrees to
> provide CEPS with unpaid invoices, bills, or payment requests. The
> Participant agrees to maintain accurate and detailed records of all
> expenditures made using RC Funds. This documentation shall include
> receipts, invoices, and other pertinent information and be made
> available for inspection upon request.
>
> **5. Service Payment and/or Reimbursement Process: Service Payment:**
> The Participant will provide CEPS with the Recreational Activity
> Service/Program contact information and an invoice, bill or payment
> request from the vendor a minimum of two weeks prior to the payment due
> date. The Participant will provide CEPS with the requested payment
> schedule: (Example: $420.00 to be paid in two payments of $210.00 on the
> first of each month). CEPS will submit payment to the vendor by check
> and provide payment confirmation to the Participant. **Reimbursement**:
> Upon the completion of approved expenditures, the Participant will
> obtain authorization from the RC. The RC will provide CEPS with a copy
> of the authorization and any supporting documentation. The participant
> must complete a CEPS invoice and provide supporting documentation such
> as receipts or invoices for services. CEPS will initiate the
> reimbursement process for the Participant subsequent to the RC's
> fulfillment of the expenditure. The disbursement of payment may require
> a span of 30-45 days from the date of CEPS's formal submission to the
> RC.
>
> By signing this contract, the Participant affirms their commitment to
> utilizing RC Funds responsibly and in accordance with the principles and
> guidelines set forth by the California Department of Developmental
> Disabilities.
>
> The Parent/Guardian/Conservator is providing an attestation that
> confirms the participant's receipt of services and their payment for
> said services. This attestation is corroborated by their submission of
> the relevant receipt/invoice. Signatures indicate agreement and
> understanding of the terms outlined in this contract statement.

---

### Open items after this build

- **Email still won't actually leave CEPS's servers until a provider is
  chosen.** This build makes the send-intake flow provider-ready (one call
  point), but the dev-link behavior stays until Postmark/SendGrid/Resend
  (or Google Auth as an alternative to magic-links) is decided — still open
  as of the 9/4 demo notes.
- **"Participant" terminology.** The 8/28 demo-feedback rename has already
  landed in the exact files this build touches (sign.tsx, referrals/[id].tsx,
  dashboard.tsx all say "Participant" now) — this prompt's new copy just
  needs to match that existing convention, not introduce it. Variable/table
  names stay `client`, same as everywhere else in the app.
- **E-signature legal sufficiency** (typed name + checkbox + IP/timestamp)
  is still a standing [CONFIRM] item from the original PRD, unchanged by
  this build.
