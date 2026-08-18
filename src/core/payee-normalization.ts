export type AccountHintKind = "last4" | "payment_method" | "unknown";

export type CategorySuggestion =
  | "utilities"
  | "telecom"
  | "credit-card payment"
  | "insurance"
  | "giving"
  | "taxes"
  | "services";

export interface AccountHint {
  kind: AccountHintKind;
  last4: string | null;
  payment_method: string | null;
}

export interface NormalizedPayeeLabel {
  raw_label: string;
  payee: string;
  account_hint: AccountHint;
  category_suggestion: CategorySuggestion | null;
  is_group_header: boolean;
}

export interface PayeeProposal {
  payee: string;
  labels: string[];
  account_hint_variants: AccountHint[];
  category_suggestion: CategorySuggestion | null;
}

const LEADING_LAST4_RE = /^\s*(\d{4})\s*\(([^)]*)\)\s*$/;
const PAY_WITH_RE = /\bpay\s*w\/\s*([^()\-;,.]+)/i;
const PAY_AT_WITH_RE = /\bpay\s*@\s*([^:()]+?)\s+w\/\s*([^()\-;,.]+)/i;

const CATEGORY_RULES: Array<{ category: CategorySuggestion; keywords: string[] }> = [
  { category: "utilities", keywords: ["metro power", "water", "electric", "utility"] },
  {
    category: "telecom",
    keywords: ["internet", "wireless", "mobile", "phone"],
  },
  {
    category: "credit-card payment",
    keywords: ["credit card", "card payment"],
  },
  { category: "insurance", keywords: ["insurance"] },
  { category: "giving", keywords: ["giving", "tithe", "donation", "charity", "church"] },
  { category: "taxes", keywords: ["tax", "irs"] },
  { category: "services", keywords: ["service", "pest", "lawn", "maintenance"] },
];

function collapseWhitespace(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

function stripTrailingPunctuation(value: string): string {
  return value.replaceAll(/[:\-;,]+\s*$/g, "").trim();
}

function inferCategorySuggestion(payee: string, rawLabel: string): CategorySuggestion | null {
  const probe = `${payee} ${rawLabel}`.toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((keyword) => probe.includes(keyword))) {
      return rule.category;
    }
  }
  return null;
}

function parseBasePayee(rawLabel: string): string | null {
  const payAtMatch = PAY_AT_WITH_RE.exec(rawLabel);
  if (payAtMatch) {
    const payee = stripTrailingPunctuation(collapseWhitespace(payAtMatch[1]));
    return payee.length > 0 ? payee : null;
  }

  const last4Match = LEADING_LAST4_RE.exec(rawLabel);
  if (last4Match) {
    const insideParens = stripTrailingPunctuation(collapseWhitespace(last4Match[2]));
    return insideParens.length > 0 ? insideParens : null;
  }

  const colonIndex = rawLabel.indexOf(":");
  if (colonIndex > 0) {
    const payee = stripTrailingPunctuation(collapseWhitespace(rawLabel.slice(0, colonIndex)));
    return payee.length > 0 ? payee : null;
  }

  const parenIndex = rawLabel.indexOf("(");
  if (parenIndex > 0) {
    const payee = stripTrailingPunctuation(collapseWhitespace(rawLabel.slice(0, parenIndex)));
    return payee.length > 0 ? payee : null;
  }

  const strippedPayWith = rawLabel.replace(PAY_WITH_RE, "");
  const normalized = stripTrailingPunctuation(collapseWhitespace(strippedPayWith));
  return normalized.length > 0 ? normalized : null;
}

function parseAccountHint(rawLabel: string): AccountHint {
  const last4Match = LEADING_LAST4_RE.exec(rawLabel);
  if (last4Match) {
    return {
      kind: "last4",
      last4: last4Match[1],
      payment_method: null,
    };
  }

  const payAtMatch = PAY_AT_WITH_RE.exec(rawLabel);
  if (payAtMatch) {
    const paymentMethod = collapseWhitespace(payAtMatch[2]);
    if (paymentMethod.length > 0) {
      return {
        kind: "payment_method",
        last4: null,
        payment_method: paymentMethod,
      };
    }
  }

  const payWithMatch = PAY_WITH_RE.exec(rawLabel);
  if (payWithMatch) {
    const paymentMethod = collapseWhitespace(payWithMatch[1]);
    if (paymentMethod.length > 0) {
      return {
        kind: "payment_method",
        last4: null,
        payment_method: paymentMethod,
      };
    }
  }

  return {
    kind: "unknown",
    last4: null,
    payment_method: null,
  };
}

function isAccountHintOnlyLabel(rawLabel: string): boolean {
  const trimmed = rawLabel.trim();
  return LEADING_LAST4_RE.test(trimmed) || /^\s*pay\s*w\//i.test(trimmed);
}

function hintKey(hint: AccountHint): string {
  return `${hint.kind}|${hint.last4 ?? ""}|${hint.payment_method ?? ""}`;
}

function compareHints(a: AccountHint, b: AccountHint): number {
  const weight = (hint: AccountHint): number => {
    if (hint.kind === "last4") return 1;
    if (hint.kind === "payment_method") return 2;
    return 3;
  };
  if (weight(a) !== weight(b)) return weight(a) - weight(b);
  if ((a.last4 ?? "") !== (b.last4 ?? "")) return (a.last4 ?? "").localeCompare(b.last4 ?? "");
  return (a.payment_method ?? "").localeCompare(b.payment_method ?? "");
}

export function normalizePayeeLabel(rawLabel: string): NormalizedPayeeLabel {
  const collapsed = collapseWhitespace(rawLabel);
  const accountHint = parseAccountHint(collapsed);
  const parsedBase = parseBasePayee(collapsed);

  if (!parsedBase) {
    return {
      raw_label: rawLabel,
      payee: rawLabel,
      account_hint: {
        kind: "unknown",
        last4: null,
        payment_method: null,
      },
      category_suggestion: null,
      is_group_header: false,
    };
  }

  const payee = parsedBase;
  const isGroupHeader = /:\s*$/.test(collapsed);
  return {
    raw_label: rawLabel,
    payee,
    account_hint: accountHint,
    category_suggestion: inferCategorySuggestion(payee, rawLabel),
    is_group_header: isGroupHeader,
  };
}

export function buildPayeeProposals(labels: string[]): PayeeProposal[] {
  const byPayee = new Map<
    string,
    {
      payee: string;
      labels: string[];
      hints: Map<string, AccountHint>;
      categoryCandidates: Map<CategorySuggestion, number>;
    }
  >();

  let activeGroupHeader: string | null = null;

  for (const rawLabel of labels) {
    const normalized = normalizePayeeLabel(rawLabel);
    const collapsed = collapseWhitespace(rawLabel);
    const inheritsHeader =
      activeGroupHeader !== null && !normalized.is_group_header && isAccountHintOnlyLabel(collapsed);
    const payee: string = inheritsHeader ? activeGroupHeader! : normalized.payee;

    if (normalized.is_group_header) {
      activeGroupHeader = normalized.payee;
    } else if (collapsed.length > 0 && !isAccountHintOnlyLabel(collapsed)) {
      activeGroupHeader = null;
    }

    const key = payee.toLowerCase();
    const existing = byPayee.get(key) ?? {
      payee,
      labels: [],
      hints: new Map<string, AccountHint>(),
      categoryCandidates: new Map<CategorySuggestion, number>(),
    };

    existing.labels.push(rawLabel);
    existing.hints.set(hintKey(normalized.account_hint), normalized.account_hint);
    if (normalized.category_suggestion) {
      const current = existing.categoryCandidates.get(normalized.category_suggestion) ?? 0;
      existing.categoryCandidates.set(normalized.category_suggestion, current + 1);
    }

    byPayee.set(key, existing);
  }

  return Array.from(byPayee.values())
    .sort((a, b) => a.payee.localeCompare(b.payee))
    .map((entry) => {
      let categorySuggestion: CategorySuggestion | null = null;
      let categoryCount = -1;
      for (const category of [
        "utilities",
        "telecom",
        "credit-card payment",
        "insurance",
        "giving",
        "taxes",
        "services",
      ] as const) {
        const count = entry.categoryCandidates.get(category) ?? 0;
        if (count > categoryCount) {
          categoryCount = count;
          categorySuggestion = count > 0 ? category : categorySuggestion;
        }
      }

      return {
        payee: entry.payee,
        labels: entry.labels,
        account_hint_variants: Array.from(entry.hints.values()).sort(compareHints),
        category_suggestion: categorySuggestion,
      };
    });
}