// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DashboardPage } from "../src/pages/DashboardPage";
import { openTestDb, type TestDb } from "./support/test-db";

describe("DashboardPage", () => {
  let fixtureDb: TestDb | null = null;

  beforeEach(() => {
    fixtureDb = openTestDb();
  });

  afterEach(() => {
    fixtureDb?.close();
    fixtureDb = null;
    cleanup();
  });

  it("renders explicit empty states with no recurring definitions", async () => {
    if (!fixtureDb) throw new Error("fixture db not available");

    render(
      <DashboardPage repos={fixtureDb.repos} initialYear={2026} initialMonth={1} />,
    );

    await screen.findByRole("heading", { level: 1, name: "Dashboard" });
    await screen.findByText("No recurring definitions yet. Add one above or accept a suggestion below.");
    expect(
      screen.getByText("No unpaid bills are currently due this month."),
    ).toBeTruthy();
    expect(
      screen.getByText("No suggestions right now. Import more history or add recurring bills manually."),
    ).toBeTruthy();
  });

  it("supports recurring CRUD and suggestion accept/dismiss behavior", async () => {
    if (!fixtureDb) throw new Error("fixture db not available");

    const checking = await fixtureDb.repos.accounts.insert({ name: "Checking", kind: "checking" });
    const power = await fixtureDb.repos.payees.insert({
      name: "Power Co",
      default_account_id: checking.id,
    });

    await fixtureDb.repos.payments.insert({
      payee_id: power.id,
      account_id: checking.id,
      date: "2026-01-03",
      amount_cents: 5000,
      source: "manual",
    });
    await fixtureDb.repos.payments.insert({
      payee_id: power.id,
      account_id: checking.id,
      date: "2026-02-03",
      amount_cents: 5000,
      source: "manual",
    });
    await fixtureDb.repos.payments.insert({
      payee_id: power.id,
      account_id: checking.id,
      date: "2026-03-03",
      amount_cents: 5000,
      source: "manual",
    });
    await fixtureDb.repos.payments.insert({
      payee_id: power.id,
      account_id: checking.id,
      date: "2026-04-03",
      amount_cents: 5000,
      source: "manual",
    });

    const user = userEvent.setup();
    render(
      <DashboardPage repos={fixtureDb.repos} initialYear={2026} initialMonth={4} />,
    );

    await screen.findByRole("heading", { level: 1, name: "Dashboard" });
    await screen.findByRole("button", { name: "Dismiss" });

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    await screen.findByText("Dismissed recurring suggestion for Power Co.");
    await screen.findByText("No suggestions right now. Import more history or add recurring bills manually.");

    await user.selectOptions(screen.getByLabelText("Recurring payee"), String(power.id));
    await user.clear(screen.getByLabelText("Recurring due day"));
    await user.type(screen.getByLabelText("Recurring due day"), "3");
    await user.type(screen.getByLabelText("Recurring expected amount"), "50.00");
    await user.click(screen.getByRole("button", { name: "Add recurring bill" }));

    await screen.findByText("Recurring bill created.");

    await user.click(screen.getByRole("button", { name: "Archive" }));
    await screen.findByText("Recurring bill archived.");

    await user.click(screen.getByRole("button", { name: "Activate" }));
    await screen.findByText("Recurring bill re-activated.");

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await screen.findByText("Recurring bill deleted.");
  });

  it("persists accepted and edited suggestions deterministically across remount", async () => {
    if (!fixtureDb) throw new Error("fixture db not available");

    const checking = await fixtureDb.repos.accounts.insert({ name: "Checking", kind: "checking" });
    const power = await fixtureDb.repos.payees.insert({
      name: "Power Co",
      default_account_id: checking.id,
    });
    const water = await fixtureDb.repos.payees.insert({
      name: "Water Co",
      default_account_id: checking.id,
    });

    for (const [date, amountCents] of [
      ["2026-01-03", 5000],
      ["2026-02-03", 5000],
      ["2026-03-03", 5000],
      ["2026-04-03", 5000],
    ] as const) {
      await fixtureDb.repos.payments.insert({
        payee_id: power.id,
        account_id: checking.id,
        date,
        amount_cents: amountCents,
        source: "manual",
      });
    }

    for (const [date, amountCents] of [
      ["2026-01-07", 6000],
      ["2026-02-07", 6000],
      ["2026-03-07", 6000],
      ["2026-04-07", 6000],
    ] as const) {
      await fixtureDb.repos.payments.insert({
        payee_id: water.id,
        account_id: checking.id,
        date,
        amount_cents: amountCents,
        source: "manual",
      });
    }

    const user = userEvent.setup();
    let view = render(
      <DashboardPage repos={fixtureDb.repos} initialYear={2026} initialMonth={4} />,
    );

    await screen.findByRole("heading", { level: 1, name: "Dashboard" });
    await screen.findByText("Power Co", { selector: "strong" });
    await screen.findByText("Water Co", { selector: "strong" });

    const powerSuggestion = screen.getByText("Power Co", { selector: "strong" }).closest("li");
    if (!powerSuggestion) throw new Error("missing Power Co suggestion row");
    await user.click(within(powerSuggestion).getByRole("button", { name: "Accept" }));

    await screen.findByText("Accepted recurring suggestion for Power Co.");

    const afterPowerAccept = await fixtureDb.repos.recurringBills.list();
    expect(afterPowerAccept).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payee_id: power.id,
          frequency: "monthly",
          due_day: 3,
          expected_amount_cents: 5000,
          anchor_month: 1,
          anchor_phase: 1,
          active: true,
        }),
      ]),
    );

    view.unmount();
    view = render(<DashboardPage repos={fixtureDb.repos} initialYear={2026} initialMonth={4} />);
    await screen.findByRole("heading", { level: 1, name: "Dashboard" });
    expect(screen.queryByText("Power Co", { selector: "strong" })).toBeNull();

    const waterSuggestion = await screen.findByText("Water Co", { selector: "strong" });
    const waterRow = waterSuggestion.closest("li");
    if (!waterRow) throw new Error("missing Water Co suggestion row");

    await user.click(within(waterRow).getByRole("button", { name: "Edit before accept" }));
    const dueDayInput = within(waterRow).getByDisplayValue("7");
    await user.clear(dueDayInput);
    await user.type(dueDayInput, "9");

    const expectedAmountInput = within(waterRow).getByDisplayValue("60.00");
    await user.clear(expectedAmountInput);
    await user.type(expectedAmountInput, "61.25");

    await user.click(within(waterRow).getByRole("button", { name: "Accept edited" }));
    await screen.findByText("Accepted recurring suggestion for Water Co.");

    const afterWaterAccept = await fixtureDb.repos.recurringBills.list();
    expect(afterWaterAccept).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payee_id: water.id,
          frequency: "monthly",
          due_day: 9,
          expected_amount_cents: 6125,
          anchor_month: 1,
          anchor_phase: 1,
          active: true,
        }),
      ]),
    );

    view.unmount();
  view = render(<DashboardPage repos={fixtureDb.repos} initialYear={2026} initialMonth={4} />);
    await screen.findByRole("heading", { level: 1, name: "Dashboard" });
    await screen.findByText(
      "No suggestions right now. Import more history or add recurring bills manually.",
    );
  });
});
