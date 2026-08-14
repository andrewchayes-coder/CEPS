# CEPS — Open [CONFIRM] Items & Pending Decisions

Tracked from `attached_assets/CEPS_Replit_Build_Prompt_1786734661546.md`. Each item is a task to be completed (confirmed with CEPS) before its related decision is treated as final. Interim defaults are noted so Phase 1 can proceed without guessing silently.

| # | Status | Item | Source | Interim default while unconfirmed |
|---|--------|------|--------|-----------------------------------|
| 1 | ⬜ Open | **Phase 1 transactional email provider** — pick a lightweight provider (e.g. Resend, Postmark) for magic-link emails and staff notifications; migrate to SendGrid in Phase 2. Flag choice for CEPS/Drew review — do not pick silently. | §1 Technology Stack | Propose Resend; hold for CEPS/Drew sign-off |
| 2 | ⬜ Open | **Brand fonts** — confirm whether CEPS has web-license files for Gotham / Trade Gothic Next LT Pro. | §2 Design System | Use a free geometric sans (Inter/Poppins/Manrope) for headings + system Helvetica Neue stack for body |
| 3 | ⬜ Open | **UCI number format** — exact format and uniqueness rules for the Regional Center UCI identifier. | §4 Client model, §12 | Store as free-text string, unique per client, no format validation |
| 4 | ⬜ Open | **Fee auto-generation trigger rules** — exact trigger conditions and qualifying service codes for auto-creating Fee records when a Payment is logged. | §5.2 step 6, Module 5, §12 | Build the Fee record structure now; leave trigger logic behind a clearly marked placeholder rule |
| 5 | ⬜ Open | **E-signature legal sufficiency** — is typed-name + confirmation checkbox legally sufficient, or is a tracked e-signature product (DocuSign-style) required? (CEPS/legal) | §5.4, §12 | Build typed-name + checkbox + timestamp + IP capture, kept modular for later swap |
| 6 | ⬜ Open | **W-9 collection method** — do vendors fill out the W-9 electronically in-portal, or only upload a signed PDF? | §12 | Support signed-PDF upload only |
| 7 | ⬜ Open | **Sample Alta "Payment Detail Report" + sample check-register export** — needed to finalize remittance-matching and check-register parsing logic. | §12 | Build the data model (incl. `remittance_batch_id`); finalize parsers once samples arrive |
| 8 | ⬜ Open | **1099 delivery scope (Phase 2)** — IRS e-filing vs. vendor-facing PDF delivery only. Not urgent for Phase 1. | §8 Module 11, §12 | No action in Phase 1 |

## Related hard gates (not questions, but must-not-forget)

- **No real client/consumer/vendor data** until CEPS confirms in writing that its data-security/compliance requirements are met (§7). Dummy/de-identified data only.
- CEPS logo files not yet provided — use "CEPS" text wordmark in brand blue `#00A8E0`, with a clearly marked slot for the real logo asset (§2).
- Possible future requirement for Anthropic Claude API BAA — keep AI/OCR integration swappable, no hardcoded tier assumptions (§7).
