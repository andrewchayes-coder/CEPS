import { expect, test } from "@playwright/test";

test("exhausted active authorization alert links directly to its authorization", async ({ page }) => {
  const authorizationId = "authorization-review-123";
  const secondAuthorizationId = "authorization-review-456";
  await page.route("**/api/auth/me", (route) => route.fulfill({
    json: {
      id: "dashboard-staff",
      name: "Dashboard Staff",
      email: "dashboard-staff@example.test",
      phone: null,
      role: "staff",
      active: true,
      lastLogin: null,
    },
  }));
  await page.route("**/api/dashboard/summary", (route) => route.fulfill({
    json: {
      referralsByStatus: [],
      totals: {
        activeClients: 1,
        activeAuthorizations: 2,
        pendingInvoices: 0,
        vendorsMissingW9: 0,
        paymentsThisMonth: "0.00",
        unmatchedRemittances: 0,
      },
      alerts: [
        {
          kind: "authorization_exhausted_active",
          message: "Authorization POS-123 for Review Participant has reached its maximum period amount and needs review.",
          entityType: "authorization",
          entityId: authorizationId,
        },
        {
          kind: "authorization_exhausted_active",
          message: "Authorization POS-456 for Another Participant has reached its maximum period amount and needs review.",
          entityType: "authorization",
          entityId: secondAuthorizationId,
        },
      ],
      recentActivity: [],
    },
  }));

  await page.goto("/");
  await expect(page.getByText("2 authorizations needing review")).toBeVisible();
  const link = page.getByTestId(`link-alert-authorization-${authorizationId}`);
  await expect(link).toHaveAttribute("href", `/authorizations/${authorizationId}`);
  await expect(link).toContainText("POS-123");
  const secondLink = page.getByTestId(`link-alert-authorization-${secondAuthorizationId}`);
  await expect(secondLink).toHaveAttribute("href", `/authorizations/${secondAuthorizationId}`);
  await expect(secondLink).toContainText("POS-456");
});