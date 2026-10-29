// lib/otherCredits.ts
// Categorization and Risk Assessment for Non-Salary Inflows
// Pure functions, deterministic, unit-testable.

import type { Txn } from "./parse.ts";
import type { SalaryCredit } from "./salary.ts";
import {
  LOAN_APP_RE,
  LOAN_LIKE_RE,
  SELF_TRANSFER_RE,
  WALLET_RE,
  BROKER_RE,
  REFUND_RE,
  INTEREST_RE,
  CASH_DEPOSIT_RE,
  UPI_RE,
} from "./keywords.ts";

export type CreditCategory =
  | "SELF_TRANSFER"
  | "LOAN_LIKE"
  | "LENDING_APP"
  | "WALLET"
  | "BROKER"
  | "REFUND"
  | "INTEREST"
  | "CASH"
  | "UPI_PERSON"
  | "OTHER";

export type OtherCredit = {
  date: Date;
  amount: number;
  narration: string;
  category: CreditCategory;
  risk: "high" | "medium" | "low";
};

export type OtherCreditsSummary = {
  items: OtherCredit[]; // All non-salary credits, sorted by risk priority (high first)
  byCategory: Record<CreditCategory, { count: number; total: number }>;
  totalOther: number;
  pctOfTotalCredit: number; // totalOther / total credits * 100
  salaryPct: number; // 100 - pctOfTotalCredit
};

const ALL_CATEGORIES: CreditCategory[] = [
  "SELF_TRANSFER",
  "LOAN_LIKE",
  "LENDING_APP",
  "WALLET",
  "BROKER",
  "REFUND",
  "INTEREST",
  "CASH",
  "UPI_PERSON",
  "OTHER",
];

/**
 * Checks if a transaction is a self-transfer.
 * Matches explicit self keywords, full holder name, token prefix match (min 5 chars),
 * or UPI P2A pattern.
 */
export function isSelfTransfer(
  narration: string,
  holderName?: string
): boolean {
  if (!narration) return false;
  const narUpper = narration.toUpperCase();

  // 1. Explicit self keywords
  if (SELF_TRANSFER_RE.test(narration)) {
    return true;
  }

  // 2. Holder name matching
  if (holderName && holderName.trim().length >= 3) {
    const cleanHolder = holderName.trim().toUpperCase();

    // Exact full name match
    if (narUpper.includes(cleanHolder)) {
      return true;
    }

    // Token match: title stripped, first token (or 5-char prefix, e.g. "JOYDEEP" -> "JOYDE")
    const nameWithoutTitles = cleanHolder
      .replace(/\b(?:MR|MS|MRS|DR|SH|SMT)\b\.?/gi, " ")
      .replace(/[^A-Z\s]/g, " ")
      .trim();
    const tokens = nameWithoutTitles.split(/\s+/).filter((w) => w.length >= 3);

    if (tokens.length > 0) {
      const firstToken = tokens[0];
      const prefix5 = firstToken.length >= 5 ? firstToken.slice(0, 5) : firstToken;

      if (narUpper.includes(firstToken) || narUpper.includes(prefix5)) {
        return true;
      }

      // Check initials / short representation: e.g. "ABC DEF" -> "ABC D"
      if (tokens.length >= 2) {
        const firstPlusInitial = `${firstToken} ${tokens[1][0]}`;
        if (narUpper.includes(firstPlusInitial)) {
          return true;
        }
      }
    }

    // UPI P2A pattern with first word >= 3 chars
    const firstWord = cleanHolder.split(/\s+/)[0];
    if (
      firstWord &&
      firstWord.length >= 3 &&
      /UPI.*P2A|P2A.*UPI|UPI.*\/|P2A.*\//i.test(narUpper) &&
      narUpper.includes(firstWord)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Categorizes a single non-salary credit based on strict precedence rules.
 */
function categorizeCredit(
  t: Txn,
  avgSalary: number,
  holderName?: string
): { category: CreditCategory; risk: "high" | "medium" | "low" } {
  // 1. Lending Apps (Risk: High)
  if (LOAN_APP_RE.test(t.narration)) {
    return { category: "LENDING_APP", risk: "high" };
  }

  // 2. Loan-Like Credits (Risk: High)
  // >= 2x avgSalary (when avgSalary > 0) OR contains loan disbursal keywords
  if (
    (avgSalary > 0 && t.credit >= 2 * avgSalary) ||
    LOAN_LIKE_RE.test(t.narration)
  ) {
    return { category: "LOAN_LIKE", risk: "high" };
  }

  // 3. Self-Transfer (Risk: Medium)
  if (isSelfTransfer(t.narration, holderName)) {
    return { category: "SELF_TRANSFER", risk: "medium" };
  }

  // 4. Wallet Inflows (Risk: Medium)
  if (WALLET_RE.test(t.narration)) {
    return { category: "WALLET", risk: "medium" };
  }

  // 5. Broker Withdrawals (Risk: Medium)
  if (BROKER_RE.test(t.narration)) {
    return { category: "BROKER", risk: "medium" };
  }

  // 6. Refunds & Reversals (Risk: Low)
  if (REFUND_RE.test(t.narration)) {
    return { category: "REFUND", risk: "low" };
  }

  // 7. Bank Interest (Risk: Low)
  if (INTEREST_RE.test(t.narration)) {
    return { category: "INTEREST", risk: "low" };
  }

  // 8. Cash / CDM Deposits (Risk: Medium)
  if (CASH_DEPOSIT_RE.test(t.narration)) {
    return { category: "CASH", risk: "medium" };
  }

  // 9. Person UPI / P2A (Risk: Medium)
  if (UPI_RE.test(t.narration)) {
    return { category: "UPI_PERSON", risk: "medium" };
  }

  // 10. Other Miscellaneous (Risk: Low)
  return { category: "OTHER", risk: "low" };
}

/**
 * Summarizes all non-salary inflows by category and evaluates credit turnover composition.
 */
export function summarizeOtherCredits(
  txns: Txn[],
  salaryCredits: SalaryCredit[],
  holderName?: string,
  avgSalary: number = 0
): OtherCreditsSummary {
  // Pool of salary credits to safely exclude exact matching transactions
  const remainingSalaryPool = salaryCredits.map((sc) => ({
    time: new Date(sc.date).getTime(),
    amount: sc.amount,
    narration: sc.narration,
  }));

  const byCategory: Record<CreditCategory, { count: number; total: number }> =
    ALL_CATEGORIES.reduce((acc, cat) => {
      acc[cat] = { count: 0, total: 0 };
      return acc;
    }, {} as Record<CreditCategory, { count: number; total: number }>);

  let totalAllCredits = 0;
  const items: OtherCredit[] = [];

  for (const t of txns) {
    if (t.credit <= 0) continue;
    totalAllCredits += t.credit;

    // Check if this credit corresponds to a recognized salary credit
    const tTime = t.date.getTime();
    const salIdx = remainingSalaryPool.findIndex(
      (sc) =>
        sc.time === tTime &&
        sc.amount === t.credit &&
        sc.narration === t.narration
    );

    if (salIdx !== -1) {
      // Exclude matched salary credit from other credits
      remainingSalaryPool.splice(salIdx, 1);
      continue;
    }

    const { category, risk } = categorizeCredit(t, avgSalary, holderName);
    items.push({
      date: t.date,
      amount: t.credit,
      narration: t.narration,
      category,
      risk,
    });

    byCategory[category].count++;
    byCategory[category].total += t.credit;
  }

  // Round byCategory totals
  for (const cat of ALL_CATEGORIES) {
    byCategory[cat].total = Math.round(byCategory[cat].total * 100) / 100;
  }

  const totalOther = items.reduce((sum, item) => sum + item.amount, 0);
  const roundedTotalOther = Math.round(totalOther * 100) / 100;
  totalAllCredits = Math.round(totalAllCredits * 100) / 100;

  const pctOfTotalCredit =
    totalAllCredits > 0
      ? Math.round((roundedTotalOther / totalAllCredits) * 10000) / 100
      : 0;

  const salaryPct = Math.round((100 - pctOfTotalCredit) * 100) / 100;

  // Sort items: High risk first, then medium risk, then low risk; secondarily by date descending
  const riskWeight: Record<"high" | "medium" | "low", number> = {
    high: 0,
    medium: 1,
    low: 2,
  };

  items.sort((a, b) => {
    const rDiff = riskWeight[a.risk] - riskWeight[b.risk];
    if (rDiff !== 0) return rDiff;
    return b.date.getTime() - a.date.getTime();
  });

  return {
    items,
    byCategory,
    totalOther: roundedTotalOther,
    pctOfTotalCredit,
    salaryPct,
  };
}
