import { SimulationService } from "../src/services/simulation-service";
import type { Subscription } from "../src/types/subscription";

describe("SimulationService", () => {
  let service: SimulationService;

  beforeEach(() => {
    service = new SimulationService();
  });

  describe("calculateNextRenewal", () => {
    it("should add 1 month for monthly billing cycle", () => {
      const currentDate = new Date("2024-01-01T00:00:00.000Z");
      const nextDate = service.calculateNextRenewal(currentDate, "monthly");

      expect(nextDate.toISOString()).toBe(new Date("2024-02-01T00:00:00.000Z").toISOString());
    });

    it("should add 1 quarter for quarterly billing cycle", () => {
      const currentDate = new Date("2024-01-01T00:00:00.000Z");
      const nextDate = service.calculateNextRenewal(currentDate, "quarterly");

      expect(nextDate.toISOString()).toBe(new Date("2024-04-01T00:00:00.000Z").toISOString());
    });


    it("should add 365 days for yearly billing cycle", () => {
      const currentDate = new Date("2024-01-01");
      const nextDate = service.calculateNextRenewal(currentDate, "yearly");

      expect(nextDate.toISOString()).toBe(
        new Date("2025-01-01").toISOString()
      );
    });
  });

  describe("projectSubscriptionRenewals", () => {
    const baseSubscription = {
      id: "1",
      user_id: "user1",
      email_account_id: null,
      merchant_id: null,
      name: "Netflix",
      provider: "Netflix",
      price: 15.99,
      currency: "USD",
      billing_cycle: "monthly",
      status: "active",
      category: "Entertainment",
      logo_url: null,
      website_url: null,
      renewal_url: null,
      notes: null,
      visibility: "private",
      tags: [],
      expired_at: null,
      paused_at: null,
      resume_at: null,
      pause_reason: null,
      created_at: "2024-01-01",
      updated_at: "2024-01-01",
    };

    it("should return empty array when no next_billing_date", () => {
      const subscription = {
        ...baseSubscription,
        next_billing_date: null,
      };

      const projections = service.projectSubscriptionRenewals(
        subscription as Subscription,
        new Date("2024-02-01")
      );

      expect(projections).toEqual([]);
    });

    it("should generate single renewal within range", () => {
      const subscription = {
        ...baseSubscription,
        next_billing_date: "2024-01-15",
      };

      const projections = service.projectSubscriptionRenewals(
        subscription as Subscription,
        new Date("2024-02-01")
      );

      expect(projections).toHaveLength(1);
      expect(projections[0].subscriptionId).toBe("1");
    });

    it("should generate multiple renewals", () => {
      const subscription = {
        ...baseSubscription,
        next_billing_date: "2024-01-01",
      };

      const projections = service.projectSubscriptionRenewals(
        subscription as Subscription,
        new Date("2024-02-15")
      );

      expect(projections).toHaveLength(2);
    });

    it("should not exceed end date", () => {
      const subscription = {
        ...baseSubscription,
        billing_cycle: "yearly",
        next_billing_date: "2024-01-01",
      };

      const projections = service.projectSubscriptionRenewals(
        subscription as Subscription,
        new Date("2024-02-01")
      );

      expect(projections).toHaveLength(1);
    });
  });

  describe("validation", () => {
    it("should reject invalid days", async () => {
      await expect(service.generateSimulation("user1", 0)).rejects.toThrow();
      await expect(service.generateSimulation("user1", 366)).rejects.toThrow();
    });
  });
});