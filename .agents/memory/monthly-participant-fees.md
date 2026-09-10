---
name: Monthly participant fees
description: Confirmed fee-generation and lifecycle rules for participant service months.
---

An active participant can have at most one $160 fee for a service month. Payment creation and moves into a new service month ensure that fee exists idempotently; payment amount changes do not alter it. Historical imports do not generate fees, and a missing service month must not be guessed.

**Why:** CEPS replaced the interim one-fee-per-payment percentage rule with a flat monthly obligation. Concurrent qualifying payments must not create duplicate fees.

**How to apply:** Treat the fee's payment link as historical trigger metadata only. Editing or deleting that payment must not move, recalculate, or delete the fee, and the retained fee must remain editable after the trigger payment is soft-deleted.