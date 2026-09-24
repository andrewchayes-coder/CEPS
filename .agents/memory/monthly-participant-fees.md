---
name: Monthly participant fees
description: Confirmed fee-generation and lifecycle rules for participant service months.
---

An active participant can have at most one $160 fee for a service month. Direct payments and reimbursements qualify; fee-type payments and historical imports do not. For multi-month payments, creation, allocation-month changes, payment-type changes, and deletion reconcile every affected allocation month. Payment amount changes do not alter the flat fee; never use the check date to guess a missing service month.

**Why:** CEPS replaced the interim one-fee-per-payment percentage rule with a flat monthly obligation. Concurrent qualifying payments must not create duplicate fees.

**How to apply:** Treat the fee's payment link as historical trigger metadata only. Preserve an existing fee's trigger, amount, and status. When no qualifying payments remain, reverse only an untouched pending fee created by the confirmed automatic rule; retain progressed or manually adjusted fees.