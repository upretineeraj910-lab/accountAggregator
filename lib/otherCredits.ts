// lib/otherCredits.ts
// Categorization and Risk Assessment for Non-Salary Inflows
// Pure functions, deterministic, unit-testable.

import type { Txn } from "./parse.ts";
import type { SalaryCredit } from "./salary.ts";

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

// Keyword regex helper matching alternatives flanked by non-alphanumerics
const kw = (alts: string): RegExp =>
  new RegExp(`(?<![A-Za-z0-9])(?:${alts})(?![A-Za-z0-9])`, "i");

// 1. Lending Apps
const LOAN_APP_RE = kw(
  "KREDITBEE|MONEYVIEW|CASHE|FIBE|EARLYSALARY|NIRA|LAZYPAY|SLICE|KISSHT|STASHFIN|PAYSENSE|MONEYTAP|FLEXSALARY|ZESTMONEY|TRUECREDIT|INDIALENDS"
);

// 2. Loan Disbursal Indicators
const LOAN_LIKE_RE = kw(
  "DISB|DISBURS|LDISB|LOAN\\s*CR|DISBURSEMENT|LOAN\\s+DISBURSAL"
);

// 3. Self Transfer Indicators
const SELF_TRANSFER_RE = kw(
  "SELF|OWN\\s+ACC|OWN\\s+ACCOUNT|SELF\\s+TRF|SELF\\s+TRANSFER"
);

// 4. Wallet Indicators
const WALLET_RE = kw(
  "PAYTM\\s+WALLET|PHONEPE\\s+WALLET|AMAZON\\s+PAY|MOBIKWIK|FREECHARGE|WALLET\\s+LOAD|ADD\\s+MONEY|PAYTM\\s+PAYMENTS\\s+BANK|PPBL|WALLET"
);

// 5. Broker Indicators
const BROKER_RE = kw(
  "ZERODHA|GROWW|UPSTOX|ANGEL\\s+ONE|ANGEL\\s+BROKING|ICICI\\s*SEC|ICICIDIRECT|HDFC\\s*SEC|KOTAK\\s*SEC|5PAISA|PAYTM\\s+MONEY|SHAREKHAN|MOTILAL|NSE\\s+CLEARING|INDIAN\\s+CLEARING|ICCL|NSCCL"
);

// 6. Refund Indicators
const REFUND_RE = kw("REFUND|REVERSAL|CASHBACK|RETURN|CHQ\\s*RET");

// 7. Interest Indicators
const INTEREST_RE = kw("INT\\.?PD|INTEREST|INT\\.PAID|CR\\s+INT|SAVINGS\\s+INT");

// 8. Cash Deposit Indicators
const CASH_RE = kw("CASH\\s*DEP|CDM|CASH\\s+DEPOSIT");

// 9. UPI / P2A Indicators
const UPI_RE = kw("UPI|P2A|P2P");

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
 * Categorizes a single non-salary credit based on strict precedence rules.
 */
function categorizeCredit(
  t: Txn,
  avgSalary: number,
  holderName?: string
): { category: CreditCategory; risk: "high" | "medium" | "low" } {
  const narUpper = t.narration.toUpperCase();

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
  // Holder name match OR explicit self keyword OR same-person UPI P2A pattern
  let isSelf = false;
  if (SELF_TRANSFER_RE.test(t.narration)) {
    isSelf = true;
  } else if (holderName && holderName.trim().length >= 3) {
    const cleanHolder = holderName.trim().toUpperCase();
    if (narUpper.includes(cleanHolder)) {
      isSelf = true;
    } else {
      // Check first word of holder's name in UPI P2A patterns (e.g. "NAVEEN D/CNRB")
      const firstWord = cleanHolder.split(/\s+/)[0];
      if (
        firstWord &&
        firstWord.length >= 3 &&
        /UPI.*P2A|P2A.*UPI|UPI.*\/|P2A.*\//i.test(narUpper) &&
        narUpper.includes(firstWord)
      ) {
        isSelf = true;
      }
    }
  }

  if (isSelf) {
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
  if (CASH_RE.test(t.narration)) {
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
