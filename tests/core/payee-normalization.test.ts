import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPayeeProposals, normalizePayeeLabel } from "../../src/core";

type PayeeNormalizationFixture = {
  labels: string[];
  expected_normalized: ReturnType<typeof normalizePayeeLabel>[];
  group_header_labels: string[];
  expected_group_proposals: ReturnType<typeof buildPayeeProposals>;
};

function loadFixture(fileName: string): PayeeNormalizationFixture {
  const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/excel", fileName);
  return JSON.parse(readFileSync(fixturePath, "utf8")) as PayeeNormalizationFixture;
}

describe("payee normalization heuristics", () => {
  it("maps representative labels into deterministic normalized outputs", () => {
    const fixture = loadFixture("payee-normalization.json");
    const normalized = fixture.labels.map((label) => normalizePayeeLabel(label));

    expect(normalized).toEqual(fixture.expected_normalized);
  });

  it("maps group-header rows into one proposal with deterministic account-hint variants", () => {
    const fixture = loadFixture("payee-normalization.json");
    const proposals = buildPayeeProposals(fixture.group_header_labels);

    expect(proposals).toEqual(fixture.expected_group_proposals);
  });

  it("falls back to raw label + unknown account for unmatched labels", () => {
    const proposal = normalizePayeeLabel("   ");
    expect(proposal).toEqual({
      raw_label: "   ",
      payee: "   ",
      account_hint: {
        kind: "unknown",
        last4: null,
        payment_method: null,
      },
      category_suggestion: null,
      is_group_header: false,
    });
  });
});
