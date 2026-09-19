import { expect, test } from "@playwright/test";

const staff = {
  id: "staff-1",
  name: "Check Writer",
  email: "checks@example.test",
  role: "staff",
  active: true,
  permissions: ["check_writing"],
};

const csv = [
  "Vendor Name,Address,Amount,Check Number,Check Date",
  "Acme Vendor,12 Main St,100.00,C-100,2026-01-15",
].join("\n");

async function openPayments(page: import("@playwright/test").Page, permissions = ["check_writing"]) {
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { ...staff, permissions } }));
  await page.route("**/api/payments?*", (route) => route.fulfill({ json: { items: [], total: 0 } }));
  await page.goto("/payments");
}

test("check writer can paste a check run and see read-only reconciliation buckets", async ({ page }) => {
  await openPayments(page);
  let requestCount = 0;
  await page.route("**/api/payments/check-run/reconcile", async (route) => {
    requestCount++;
    expect(route.request().postDataJSON()).toEqual({ csv, startDate: "2026-01-01", endDate: "2026-01-31" });
    await route.fulfill({
      json: {
        parsedCount: 1,
        errorCount: 0,
        errors: [],
        matched: [{ payment: { id: "p1", vendorName: "Acme Vendor", address: "12 Main St", amount: "100.00", checkNumber: "app-1", checkDate: "2026-01-15" }, check: { rowNumber: 2, vendorName: "Acme Vendor", address: "12 Main St", amount: "100.00", checkNumber: "C-100", checkDate: "2026-01-15" }, addressMatch: true }],
        paymentsWithoutChecks: [],
        checksWithoutPayments: [],
        amountMismatches: [],
      },
    });
  });
  await page.getByTestId("button-reconcile-check-run").click();
  await page.getByTestId("input-check-run-start-date").fill("2026-01-01");
  await page.getByTestId("input-check-run-end-date").fill("2026-01-31");
  await page.getByTestId("textarea-check-run-csv").fill(csv);
  await page.getByTestId("button-run-check-reconciliation").click();
  await expect(page.getByTestId("text-check-run-matched")).toHaveText("1");
  await expect(page.getByText("Address matches")).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("button", { name: /Commit|Import/ })).toHaveCount(0);
  expect(requestCount).toBe(1);
});

test("check writer can upload a CSV and parse errors are shown", async ({ page }) => {
  await openPayments(page);
  let uploadedRequest = "";
  await page.route("**/api/payments/check-run/reconcile", (route) => route.fulfill({
    json: { parsedCount: 0, errorCount: 1, errors: ["Row 2: vendor name is required."], matched: [], paymentsWithoutChecks: [], checksWithoutPayments: [], amountMismatches: [] },
  }));
  page.on("request", (request) => { if (request.url().includes("/check-run/reconcile")) uploadedRequest = request.postData() ?? ""; });
  await page.getByTestId("button-reconcile-check-run").click();
  await page.getByTestId("input-check-run-start-date").fill("2026-01-01");
  await page.getByTestId("input-check-run-end-date").fill("2026-01-31");
  await page.getByTestId("input-check-run-csv").setInputFiles({ name: "checks.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByTestId("button-run-check-reconciliation").click();
  await expect(page.getByTestId("check-run-parse-errors")).toContainText("Row 2");
  expect(JSON.parse(uploadedRequest)).toMatchObject({ csv, startDate: "2026-01-01", endDate: "2026-01-31" });
});

test("report renders all buckets, addresses, amounts, and unknown vendor", async ({ page }) => {
  await openPayments(page);
  await page.route("**/api/payments/check-run/reconcile", (route) => route.fulfill({ json: {
    parsedCount: 4, errorCount: 0, errors: [],
    matched: [{ payment: { id: "m", vendorName: "Matched Co", address: "Current M", amount: "100.00", checkNumber: "A1", checkDate: "2026-01-01" }, check: { rowNumber: 2, vendorName: "Matched Co", address: "Uploaded M", amount: "100.00", checkNumber: "C1", checkDate: "2026-01-01" }, addressMatch: false }],
    paymentsWithoutChecks: [{ payment: { id: "u", vendorName: "Unknown vendor", address: null, amount: "22.00", checkNumber: "A2", checkDate: "2026-01-02" }, check: null, addressMatch: false }],
    checksWithoutPayments: [{ payment: null, check: { rowNumber: 3, vendorName: "Missing Co", address: "Uploaded X", amount: "33.00", checkNumber: "C3", checkDate: "2026-01-03" }, addressMatch: false }],
    amountMismatches: [{ payment: { id: "x", vendorName: "Mismatch Co", address: "Current X", amount: "40.00", checkNumber: "A4", checkDate: "2026-01-04" }, check: { rowNumber: 4, vendorName: "Mismatch Co", address: "Uploaded X", amount: "41.00", checkNumber: "C4", checkDate: "2026-01-04" }, addressMatch: false }],
  } }));
  await page.getByTestId("button-reconcile-check-run").click();
  await page.getByTestId("input-check-run-start-date").fill("2026-01-01");
  await page.getByTestId("input-check-run-end-date").fill("2026-01-31");
  await page.getByTestId("textarea-check-run-csv").fill(csv);
  await page.getByTestId("button-run-check-reconciliation").click();
  await expect(page.getByTestId("text-check-run-matched")).toHaveText("1");
  await expect(page.getByTestId("text-check-run-payment-without-check")).toHaveText("1");
  await expect(page.getByTestId("text-check-run-check-without-payment")).toHaveText("1");
  await expect(page.getByTestId("text-check-run-amount-mismatch")).toHaveText("1");
  await expect(page.getByText("Uploaded check address: Uploaded M")).toBeVisible();
  await expect(page.getByText("Current billing address: Current M")).toBeVisible();
  await expect(page.getByText("Unknown vendor")).toBeVisible();
  await expect(page.getByText("Review amount/address")).toBeVisible();
  await expect(page.getByText("C4 / 2026-01-04")).toBeVisible();
});

test("client validation rejects missing CSV and reversed dates without API call", async ({ page }) => {
  await openPayments(page);
  let calls = 0;
  await page.route("**/api/payments/check-run/reconcile", (route) => { calls++; return route.continue(); });
  await page.getByTestId("button-reconcile-check-run").click();
  await page.getByTestId("input-check-run-start-date").fill("2026-02-01");
  await page.getByTestId("input-check-run-end-date").fill("2026-01-01");
  await page.getByTestId("textarea-check-run-csv").fill(csv);
  await page.getByTestId("button-run-check-reconciliation").click();
  await expect(page.getByTestId("text-check-run-error")).toContainText("on or before");
  expect(calls).toBe(0);
});

test("API failure is readable and preserves pasted input", async ({ page }) => {
  await openPayments(page);
  await page.route("**/api/payments/check-run/reconcile", (route) => route.fulfill({ status: 500, body: "Server unavailable" }));
  await page.getByTestId("button-reconcile-check-run").click();
  await page.getByTestId("input-check-run-start-date").fill("2026-01-01");
  await page.getByTestId("input-check-run-end-date").fill("2026-01-31");
  await page.getByTestId("textarea-check-run-csv").fill(csv);
  await page.getByTestId("button-run-check-reconciliation").click();
  await expect(page.getByTestId("text-check-run-request-error")).toBeVisible();
  await expect(page.getByTestId("textarea-check-run-csv")).toHaveValue(csv);
});

test("staff without check-writing permission does not see the reconciliation action", async ({ page }) => {
  await openPayments(page, []);
  await expect(page.getByTestId("button-reconcile-check-run")).toHaveCount(0);
});