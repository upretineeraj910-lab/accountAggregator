// lib/analyze.ts
// Step 3: Strict & Realistic Financial Health Scoring for Loan DSA Underwriting
// Pure functions, no side effects, deterministic and unit-testable.

import type { Txn } from "./parse";
import { detectSalary, type SalaryResult, type SalaryCredit } from "./salary.ts";
import {
  summarizeOtherCredits,
  type OtherCreditsSummary,
} from "./otherCredits.ts";
import { extractAccountInfo, type AccountInfo } from "./accountInfo.ts";
import type { AiSummary } from "./ai.ts";

export interface Reason {
  text: string;
  type: "positive" | "negative";
}

export interface MonthlyRecord {
  month: string;
  monthKey: string;
  credit: number;
  debit: number;
  closingBalance: number;
}

export interface MarketActivity {
  invested: number;
  withdrawn: number;
  net: number;
  transfers: number;
  sip: number;
  isActive: boolean;
  heavy: boolean;
  summary: string;
}

export interface WalletRotation {
  walletCredits: number;
  walletTransfers: number;
  walletPct: number;
  ccDebits: number;
  isSuspected: boolean;
  adjustedMonthlyCredit: number;
  adjustedFoir: number;
  summary: string;
}

export interface AnalysisResult {
  months: number;
  avgMonthlyCredit: number;
  avgMonthlyCreditExSelf: number;
  avgSalary: number;
  abb: number;
  monthEndAvgBalance: number;
  monthlyEmi: number;
  foir: number;
  bounces: number;
  betting: number;
  cashPct: number;
  score: number;
  verdict: "Strong" | "Average" | "Weak";
  reasons: Reason[];
  monthlyTable: MonthlyRecord[];
  market: MarketActivity;
  walletRotation: WalletRotation;
  passThroughPct: number;
  salaryRegularity: number;
  oneOffCredits: { count: number; total: number };
  selfTransferCredits: { count: number; total: number };
  wallet: {
    walletIn: number;
    walletOut: number;
    walletPctOfCredit: number;
    walletPctOfDebit: number;
  };
  lendingApps: { count: number; total: number };
  creditCardPayments: number;
  emiCapacity: number | null;
  salary: SalaryResult;
  otherCredits: OtherCreditsSummary;
  accountInfo: AccountInfo;
  ai?: AiSummary;
}

export const CONFIG = {
  scoreStart: 100,
  verdictThresholds: {
    strong: 75,
    average: 50,
  },
  marketAffectsScore: true,
  walletAffectsScore: true,
  foirTiers: [
    { above: 35, pts: 10 },
    { above: 45, pts: 20 },
    { above: 55, pts: 35 },
  ],
  penalties: {
    bounce: 25,
    betting: 20,
    cashPct: 10,
    monthEndLow10: 15,
    monthEndLow20: 8,
    passThrough80: 20,
    passThrough50: 10,
    salaryIrregular: 15,
    noSalaryRecognized: 20,
    lendingApps: 15,
    oneOffPerItem: 5,
    oneOffMax: 10,
    marketHeavy: 15,
    marketNetLoss: 10,
    marketActive: 5,
    walletHeavy: 10,
  },
  caps: {
    passThrough80MaxScore: 69,
    foir55MaxScore: 49,
    bounceMaxScore: 59,
    insufficientDataMaxScore: 74,
  },
  limits: {
    cashPctMax: 40,
    salaryRegularityMin: 0.7,
    monthEndRatioHigh: 0.2,
    monthEndRatioLow: 0.1,
    passThroughHigh: 80,
    passThroughLow: 50,
    marketHeavyRatio: 0.3,
    walletPctMax: 30,
    minMonths: 3,
    minTxns: 15,
    brokerActiveTransfers: 6,
  },
};

export const ANALYSIS_CONFIG = CONFIG;

const SHORT_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * Keyword regex helper that matches alternatives flanked by non-alphanumeric characters or start/end of string.
 * Prevents false substring matches (e.g. 'NSE' inside 'LICENSE'), while correctly matching '_EMI_'.
 */
export const kw = (alts: string): RegExp =>
  new RegExp(`(?<![A-Za-z0-9])(?:${alts})(?![A-Za-z0-9])`, "i");

// All keyword regexes built via kw helper
const EMI_REGEX = kw("EMI|NACH|ECS|LOAN");
const SALARY_REGEX = kw("SALARY|SAL");
const BOUNCE_REGEX = kw("RETURN|BOUNCE|CHQ\\s*RET|INSUFFICIENT");
const BETTING_REGEX = kw("DREAM11|RUMMY|MPL|BETTING");
const CASH_REGEX = kw("CASH\\s*DEP|CDM");

// Broker regex
const BROKER_REGEX = kw(
  "ZERODHA|GROWW|UPSTOX|ANGEL\\s+ONE|ANGEL\\s+BROKING|ICICI\\s*SEC|ICICIDIRECT|HDFC\\s*SEC|KOTAK\\s*SEC|5PAISA|PAYTM\\s+MONEY|SHAREKHAN|MOTILAL|NSE\\s+CLEARING|INDIAN\\s+CLEARING|ICCL|NSCCL"
);

// Mutual fund / SIP regex
const MF_SIP_REGEX = kw(
  "BSE\\s+STAR|NSE\\s+NMF|MF\\s+UTILITIES|MUTUAL\\s+FUND|SIP|CAMS|KFIN"
);

// Wallet regex
const WALLET_REGEX = kw(
  "PAYTM\\s+WALLET|PHONEPE\\s+WALLET|AMAZON\\s+PAY|MOBIKWIK|FREECHARGE|WALLET\\s+LOAD|ADD\\s+MONEY|PAYTM\\s+PAYMENTS\\s+BANK|PPBL"
);

// Instant lending apps regex
const LOAN_APP_REGEX = kw(
  "KREDITBEE|MONEYVIEW|CASHE|FIBE|EARLYSALARY|NIRA|LAZYPAY|SLICE|KISSHT|STASHFIN|PAYSENSE|MONEYTAP|FLEXSALARY|ZESTMONEY|TRUECREDIT|INDIALENDS"
);

// Credit card bill payment outflow regex
const CC_PAYMENT_REGEX = kw(
  "CRED|CREDIT\\s+CARD|CC\\s+PAYMENT|CARD\\s+PAYMENT|BILLDESK\\s+CC"
);

/**
 * Calculates share market and mutual fund / SIP activity from transactions.
 */
export function marketActivity(
  txns: Txn[],
  incomeBasis: number,
  monthsCount?: number
): MarketActivity {
  let invested = 0;
  let withdrawn = 0;
  let transfers = 0;
  let sip = 0;

  for (const t of txns) {
    const isBroker = BROKER_REGEX.test(t.narration);
    const isMf = MF_SIP_REGEX.test(t.narration);

    if (isBroker) {
      if (t.debit > 0) {
        invested += t.debit;
        transfers++;
      }
      if (t.credit > 0) {
        withdrawn += t.credit;
        transfers++;
      }
    }

    if (isMf) {
      if (t.debit > 0) {
        sip += t.debit;
      }
    }
  }

  invested = Math.round(invested * 100) / 100;
  withdrawn = Math.round(withdrawn * 100) / 100;
  sip = Math.round(sip * 100) / 100;
  const net = Math.round((withdrawn - invested) * 100) / 100;

  let months = monthsCount;
  if (!months || months < 1) {
    const monthSet = new Set<string>();
    for (const t of txns) {
      monthSet.add(`${t.date.getFullYear()}-${t.date.getMonth()}`);
    }
    months = Math.max(1, monthSet.size);
  }

  const isActive = transfers >= CONFIG.limits.brokerActiveTransfers;
  const monthlyBrokerInvestment = invested / months;
  const heavy =
    incomeBasis > 0 &&
    monthlyBrokerInvestment > incomeBasis * CONFIG.limits.marketHeavyRatio;

  let summary = "";
  if (transfers === 0 && sip === 0) {
    summary = "No share market or SIP activity detected.";
  } else if (heavy) {
    summary = `Heavy share market exposure (>30% of income in brokers). Speculative lending risk.`;
  } else if (isActive) {
    summary = `Active share market trader (${transfers} transactions). Net: ₹${Math.abs(net).toLocaleString("en-IN")}. Elevated risk.`;
  } else if (sip > 0 && transfers === 0) {
    summary = `Disciplined Mutual Fund / SIP investments detected (Total: ₹${sip.toLocaleString("en-IN")}).`;
  } else {
    summary = `Moderate share market transactions (${transfers} transfers, SIP: ₹${sip.toLocaleString("en-IN")}).`;
  }

  return {
    invested,
    withdrawn,
    net,
    transfers,
    sip,
    isActive,
    heavy,
    summary,
  };
}

/**
 * Helper to calculate calendar days difference between two dates (d2 - d1).
 */
function calendarDaysDiff(d1: Date, d2: Date): number {
  const utc1 = Date.UTC(d1.getFullYear(), d1.getMonth(), d1.getDate());
  const utc2 = Date.UTC(d2.getFullYear(), d2.getMonth(), d2.getDate());
  return Math.floor((utc2 - utc1) / (1000 * 60 * 60 * 24));
}

/**
 * Performs strict, rule-based loan eligibility analysis on parsed bank transactions.
 */
export function analyze(
  txns: Txn[],
  opts?: { holderName?: string; rawLines?: string[] } | string
): AnalysisResult {
  const holderName = typeof opts === "string" ? opts : opts?.holderName;
  const rawLines = typeof opts === "object" ? opts?.rawLines : undefined;

  // 1. Group transactions by month
  const monthMap = new Map<
    string,
    { year: number; month: number; txns: Txn[] }
  >();

  for (const t of txns) {
    const y = t.date.getFullYear();
    const m = t.date.getMonth();
    const key = `${y}-${String(m + 1).padStart(2, "0")}`;
    let entry = monthMap.get(key);
    if (!entry) {
      entry = { year: y, month: m, txns: [] };
      monthMap.set(key, entry);
    }
    entry.txns.push(t);
  }

  const months = Math.max(1, monthMap.size);

  let totalCredits = 0;
  let totalDebits = 0;
  let balanceSum = 0;
  let bounces = 0;
  let betting = 0;
  let cashCreditsSum = 0;

  let walletIn = 0;
  let walletOut = 0;
  let walletTxnCount = 0;

  let lendingAppsCount = 0;
  let lendingAppsTotal = 0;

  let ccDebitsSum = 0;

  for (const t of txns) {
    totalCredits += t.credit;
    totalDebits += t.debit;
    balanceSum += t.balance;

    if (BOUNCE_REGEX.test(t.narration)) {
      bounces++;
    }

    if (BETTING_REGEX.test(t.narration)) {
      betting++;
    }

    if (t.credit > 0 && CASH_REGEX.test(t.narration)) {
      cashCreditsSum += t.credit;
    }

    // Wallet metrics
    if (WALLET_REGEX.test(t.narration)) {
      if (t.credit > 0) {
        walletIn += t.credit;
        walletTxnCount++;
      }
      if (t.debit > 0) {
        walletOut += t.debit;
        walletTxnCount++;
      }
    }

    // Lending apps metrics
    if (LOAN_APP_REGEX.test(t.narration)) {
      lendingAppsCount++;
      lendingAppsTotal += t.credit + t.debit;
    }

    // Credit card payments
    if (t.debit > 0 && CC_PAYMENT_REGEX.test(t.narration)) {
      ccDebitsSum += t.debit;
    }
  }

  totalCredits = Math.round(totalCredits * 100) / 100;
  totalDebits = Math.round(totalDebits * 100) / 100;
  walletIn = Math.round(walletIn * 100) / 100;
  walletOut = Math.round(walletOut * 100) / 100;
  lendingAppsTotal = Math.round(lendingAppsTotal * 100) / 100;
  ccDebitsSum = Math.round(ccDebitsSum * 100) / 100;

  // avgMonthlyCredit
  const avgMonthlyCredit = Math.round((totalCredits / months) * 100) / 100;

  // Robust multi-step salary detection
  const salary = detectSalary(txns, holderName);
  const avgSalary = salary.avgSalary;
  const salaryMonths = salary.months;

  // Primary income basis for scoring (avgSalary if identified, else avgMonthlyCredit)
  const incomeBasis = avgSalary > 0 ? avgSalary : avgMonthlyCredit;

  // EMI calculations
  const emiTx = txns.filter(
    (t) => t.debit > 0 && EMI_REGEX.test(t.narration)
  );
  const emiMonthSet = new Set<string>();
  let emiDebitsSum = 0;
  for (const t of emiTx) {
    emiMonthSet.add(`${t.date.getFullYear()}-${t.date.getMonth()}`);
    emiDebitsSum += t.debit;
  }
  const emiMonths = Math.max(1, emiMonthSet.size);
  const monthlyEmi = Math.round((emiDebitsSum / emiMonths) * 100) / 100;

  // FOIR: calculated on avgSalary basis if available, otherwise avgMonthlyCredit
  const foir =
    incomeBasis > 0
      ? Math.round((monthlyEmi / incomeBasis) * 10000) / 100
      : 0;

  // 2. Metric a: monthEndAvgBalance
  // Average of the closing balance of the last transaction in each month
  const sortedMonthKeys = Array.from(monthMap.keys()).sort();
  let closingBalanceSum = 0;
  const monthlyTable: MonthlyRecord[] = sortedMonthKeys.map((key) => {
    const item = monthMap.get(key)!;
    let mCredit = 0;
    let mDebit = 0;

    for (const t of item.txns) {
      mCredit += t.credit;
      mDebit += t.debit;
    }

    const lastTxnInMonth = item.txns[item.txns.length - 1];
    const closingBalance = lastTxnInMonth ? lastTxnInMonth.balance : 0;
    closingBalanceSum += closingBalance;

    return {
      monthKey: key,
      month: `${SHORT_MONTHS[item.month]} ${item.year}`,
      credit: Math.round(mCredit * 100) / 100,
      debit: Math.round(mDebit * 100) / 100,
      closingBalance: Math.round(closingBalance * 100) / 100,
    };
  });

  const monthEndAvgBalance =
    monthlyTable.length > 0
      ? Math.round((closingBalanceSum / monthlyTable.length) * 100) / 100
      : 0;

  // Historical abb (average of transaction balances)
  const abb =
    txns.length > 0 ? Math.round((balanceSum / txns.length) * 100) / 100 : 0;

  // Metric b: passThroughPct
  // For each detected salary credit, check debits within 3 calendar days
  const passThroughSalaryMonths = new Set<string>();
  for (const sc of salary.credits) {
    let debitsWithin3Days = 0;
    for (const t of txns) {
      if (t.debit > 0) {
        const diffDays = calendarDaysDiff(sc.date, t.date);
        if (diffDays >= 0 && diffDays <= 3) {
          debitsWithin3Days += t.debit;
        }
      }
    }
    if (debitsWithin3Days >= 0.9 * sc.amount) {
      sc.isPassThrough = true;
      const mKey = `${sc.date.getFullYear()}-${sc.date.getMonth()}`;
      passThroughSalaryMonths.add(mKey);
    } else {
      sc.isPassThrough = false;
    }
  }

  const passThroughPct =
    salaryMonths > 0
      ? Math.round((passThroughSalaryMonths.size / salaryMonths) * 10000) / 100
      : 0;

  // Metric c: salaryRegularity
  const salaryRegularity =
    months > 0 ? Math.round((salaryMonths / months) * 100) / 100 : 0;

  // Metric d: oneOffCredits
  // Credits that are not salary, and >= 2 * avgSalary (when avgSalary > 0)
  let oneOffCount = 0;
  let oneOffTotal = 0;
  if (avgSalary > 0) {
    const oneOffThreshold = 2 * avgSalary;
    const salaryCreditTimes = new Set(salary.credits.map((c) => c.date.getTime()));
    for (const t of txns) {
      if (
        t.credit >= oneOffThreshold &&
        !salaryCreditTimes.has(t.date.getTime()) &&
        !SALARY_REGEX.test(t.narration)
      ) {
        oneOffCount++;
        oneOffTotal += t.credit;
      }
    }
  }
  const oneOffCredits = {
    count: oneOffCount,
    total: Math.round(oneOffTotal * 100) / 100,
  };

  // Categorize all non-salary inflows and evaluate credit turnover composition
  const otherCredits = summarizeOtherCredits(
    txns,
    salary.credits,
    holderName,
    avgSalary
  );

  // Metric e: selfTransferCredits (grounded directly on categorized SELF_TRANSFER)
  const selfTransferCredits = {
    count: otherCredits.byCategory.SELF_TRANSFER.count,
    total: otherCredits.byCategory.SELF_TRANSFER.total,
  };
  const avgMonthlyCreditExSelf = Math.max(
    0,
    Math.round(
      ((totalCredits - otherCredits.byCategory.SELF_TRANSFER.total) / months) *
        100
    ) / 100
  );

  // Metric f: wallet
  const walletPctOfCredit =
    totalCredits > 0
      ? Math.round((walletIn / totalCredits) * 10000) / 100
      : 0;
  const walletPctOfDebit =
    totalDebits > 0
      ? Math.round((walletOut / totalDebits) * 10000) / 100
      : 0;
  const wallet = {
    walletIn,
    walletOut,
    walletPctOfCredit,
    walletPctOfDebit,
  };

  // Metric g: lendingApps
  const lendingApps = {
    count: lendingAppsCount,
    total: lendingAppsTotal,
  };

  // Metric h: creditCardPayments
  const creditCardPayments = ccDebitsSum;

  // Metric i: emiCapacity
  const emiCapacity =
    avgSalary > 0
      ? Math.max(0, Math.round(avgSalary * 0.5 - monthlyEmi))
      : null;

  // Cash deposit %
  const cashPct =
    totalCredits > 0
      ? Math.round((cashCreditsSum / totalCredits) * 10000) / 100
      : 0;

  // Market activity
  const market = marketActivity(txns, incomeBasis, months);

  // Wallet rotation object (for UI and backwards compatibility)
  const isRotationSuspected =
    walletPctOfCredit > CONFIG.limits.walletPctMax ||
    walletPctOfDebit > CONFIG.limits.walletPctMax ||
    (ccDebitsSum > 0 && walletIn >= 10000);

  const genuineCredits = Math.max(0, totalCredits - walletIn);
  const adjustedMonthlyCredit =
    Math.round((genuineCredits / months) * 100) / 100;
  const adjustedFoir =
    adjustedMonthlyCredit > 0
      ? Math.round((monthlyEmi / adjustedMonthlyCredit) * 10000) / 100
      : 0;

  let walletSummary = "";
  if (isRotationSuspected) {
    walletSummary = `High wallet turnover / rotation detected (Credits: ₹${walletIn.toLocaleString("en-IN")}, Debits: ₹${walletOut.toLocaleString("en-IN")}). Inflow may be circular.`;
  } else if (walletIn > 0 || walletOut > 0) {
    walletSummary = `Normal wallet transfers (In: ₹${walletIn.toLocaleString("en-IN")}, Out: ₹${walletOut.toLocaleString("en-IN")}).`;
  } else {
    walletSummary = "No significant wallet activity detected.";
  }

  const walletRotation: WalletRotation = {
    walletCredits: walletIn,
    walletTransfers: walletTxnCount,
    walletPct: walletPctOfCredit,
    ccDebits: ccDebitsSum,
    isSuspected: isRotationSuspected,
    adjustedMonthlyCredit,
    adjustedFoir,
    summary: walletSummary,
  };

  // ================= SCORING (Start 100, Point Deductions & Evaluative Factors) =================
  let score = CONFIG.scoreStart;
  const reasons: Reason[] = [];

  // 1. Cheque / NACH Bounces (-25)
  if (bounces > 0) {
    score -= CONFIG.penalties.bounce;
    reasons.push({
      text: `${bounces} bounce(s) detected (NACH / cheque return) (-${CONFIG.penalties.bounce})`,
      type: "negative",
    });
  } else {
    reasons.push({
      text: "No cheque or NACH bounces found",
      type: "positive",
    });
  }

  // 2. FOIR Tiers: [{ above: 35, pts: 10 }, { above: 45, pts: 20 }, { above: 55, pts: 35 }]
  // Apply highest matching tier (do not stack)
  if (foir > 55) {
    score -= 35;
    reasons.push({
      text: `FOIR is high at ${Math.round(foir)}% (>50% income committed to EMIs) (-35)`,
      type: "negative",
    });
  } else if (foir > 45) {
    score -= 20;
    reasons.push({
      text: `FOIR is elevated at ${Math.round(foir)}% (-20)`,
      type: "negative",
    });
  } else if (foir > 35) {
    score -= 10;
    reasons.push({
      text: `FOIR is moderate at ${Math.round(foir)}% (-10)`,
      type: "negative",
    });
  } else {
    reasons.push({
      text: "FOIR is within safe limits (<=35%)",
      type: "positive",
    });
  }

  // 3. Betting / Gaming Outflows (-20)
  if (betting > 0) {
    score -= CONFIG.penalties.betting;
    reasons.push({
      text: `Betting or online gaming transactions detected (-${CONFIG.penalties.betting})`,
      type: "negative",
    });
  }

  // 4. Cash Deposit Ratio (> 40% => -10)
  if (cashPct > CONFIG.limits.cashPctMax) {
    score -= CONFIG.penalties.cashPct;
    reasons.push({
      text: `High cash deposit ratio: ${Math.round(cashPct)}% of total credits (-${CONFIG.penalties.cashPct})`,
      type: "negative",
    });
  }

  // 5. Month-End Average Balance relative to incomeBasis (< 10% => -15, < 20% => -8)
  if (incomeBasis > 0) {
    if (monthEndAvgBalance < CONFIG.limits.monthEndRatioLow * incomeBasis) {
      score -= CONFIG.penalties.monthEndLow10;
      reasons.push({
        text: `Low month-end average balance (<10% of monthly income) (-${CONFIG.penalties.monthEndLow10})`,
        type: "negative",
      });
    } else if (
      monthEndAvgBalance <
      CONFIG.limits.monthEndRatioHigh * incomeBasis
    ) {
      score -= CONFIG.penalties.monthEndLow20;
      reasons.push({
        text: `Sub-optimal month-end average balance (<20% of monthly income) (-${CONFIG.penalties.monthEndLow20})`,
        type: "negative",
      });
    } else {
      reasons.push({
        text: "Healthy month-end balance maintained",
        type: "positive",
      });
    }
  }

  // 6. Salary Pass-Through Percentage (>= 80% => -20, >= 50% => -10)
  if (passThroughPct >= CONFIG.limits.passThroughHigh) {
    score -= CONFIG.penalties.passThrough80;
    reasons.push({
      text: `Salary pass-through: funds withdrawn within 3 days (-${CONFIG.penalties.passThrough80})`,
      type: "negative",
    });
  } else if (passThroughPct >= CONFIG.limits.passThroughLow) {
    score -= CONFIG.penalties.passThrough50;
    reasons.push({
      text: `Salary pass-through: funds withdrawn within 3 days (-${CONFIG.penalties.passThrough50})`,
      type: "negative",
    });
  }

  // 7. Salary Regularity & Recognition Check
  if (salaryMonths === 0) {
    score -= CONFIG.penalties.noSalaryRecognized;
    reasons.push({
      text: `Salary credit not identified; FOIR evaluated on total credit inflows (-${CONFIG.penalties.noSalaryRecognized})`,
      type: "negative",
    });
  } else {
    if (salaryRegularity < CONFIG.limits.salaryRegularityMin) {
      score -= CONFIG.penalties.salaryIrregular;
      reasons.push({
        text: `Irregular salary credits detected across statement months (-${CONFIG.penalties.salaryIrregular})`,
        type: "negative",
      });
    } else {
      reasons.push({
        text: "Regular monthly salary credits verified",
        type: "positive",
      });
    }
  }

  // 8. Instant Fintech Lending Apps (-15)
  if (lendingApps.count > 0) {
    score -= CONFIG.penalties.lendingApps;
    reasons.push({
      text: `Instant fintech loan app transactions detected (-${CONFIG.penalties.lendingApps})`,
      type: "negative",
    });
  }

  // 9. Large One-Off Credits (-5 per item, max -10)
  if (oneOffCredits.count > 0) {
    const oneOffDeduction = Math.min(
      CONFIG.penalties.oneOffMax,
      oneOffCredits.count * CONFIG.penalties.oneOffPerItem
    );
    score -= oneOffDeduction;
    reasons.push({
      text: `Large one-off credit detected (potential loan disbursal) (-${oneOffDeduction})`,
      type: "negative",
    });
  }

  // 10. Share Market & Speculative Exposure (if marketAffectsScore)
  if (CONFIG.marketAffectsScore) {
    if (market.heavy) {
      score -= CONFIG.penalties.marketHeavy;
      reasons.push({
        text: `Heavy share market exposure (>30% of income in brokers) (-${CONFIG.penalties.marketHeavy})`,
        type: "negative",
      });
    }
    if (market.isActive) {
      score -= CONFIG.penalties.marketActive;
      reasons.push({
        text: `Active share market trading activity (-${CONFIG.penalties.marketActive})`,
        type: "negative",
      });
    }

    if (market.net < 0 && Math.abs(market.net) > 1 * incomeBasis) {
      score -= CONFIG.penalties.marketNetLoss;
      reasons.push({
        text: `Substantial net trading loss exceeding monthly income (-${CONFIG.penalties.marketNetLoss})`,
        type: "negative",
      });
    }
  }

  // 11. Wallet Rotation / Circular Turnover Risk (if walletAffectsScore)
  if (CONFIG.walletAffectsScore) {
    if (
      walletPctOfCredit > CONFIG.limits.walletPctMax ||
      walletPctOfDebit > CONFIG.limits.walletPctMax
    ) {
      score -= CONFIG.penalties.walletHeavy;
      reasons.push({
        text: `High wallet rotation / turnover detected (-${CONFIG.penalties.walletHeavy})`,
        type: "negative",
      });
    }
  }

  // ================= HARD CAPS =================
  if (
    passThroughPct >= CONFIG.limits.passThroughHigh &&
    score > CONFIG.caps.passThrough80MaxScore
  ) {
    score = CONFIG.caps.passThrough80MaxScore;
  }

  if (foir > 55 && score > CONFIG.caps.foir55MaxScore) {
    score = CONFIG.caps.foir55MaxScore;
  }

  if (bounces > 0 && score > CONFIG.caps.bounceMaxScore) {
    score = CONFIG.caps.bounceMaxScore;
  }

  if (months < CONFIG.limits.minMonths || txns.length < CONFIG.limits.minTxns) {
    if (score > CONFIG.caps.insufficientDataMaxScore) {
      score = CONFIG.caps.insufficientDataMaxScore;
    }
    reasons.push({
      text: "Limited statement data (< 3 months or < 15 txns); indicative score",
      type: "negative",
    });
  }

  // Turnover composition info line
  reasons.push({
    text: `Salary accounts for ${Math.round(otherCredits.salaryPct)}% of total credit inflows`,
    type: "positive",
  });

  score = Math.max(0, Math.min(100, Math.round(score)));

  let verdict: "Strong" | "Average" | "Weak";
  if (score >= CONFIG.verdictThresholds.strong) {
    verdict = "Strong";
  } else if (score >= CONFIG.verdictThresholds.average) {
    verdict = "Average";
  } else {
    verdict = "Weak";
  }

  return {
    months,
    avgMonthlyCredit,
    avgMonthlyCreditExSelf,
    avgSalary,
    abb,
    monthEndAvgBalance,
    monthlyEmi,
    foir,
    bounces,
    betting,
    cashPct,
    score,
    verdict,
    reasons,
    monthlyTable,
    market,
    walletRotation,
    passThroughPct,
    salaryRegularity,
    oneOffCredits,
    selfTransferCredits,
    wallet,
    lendingApps,
    creditCardPayments,
    emiCapacity,
    salary,
    otherCredits,
    accountInfo: extractAccountInfo(rawLines || [], txns, holderName),
  };
}

/**
 * Pure function to recompute financial underwriting metrics when the user
 * overrides the detected salary (either by toggling credit checkboxes or entering manual salary).
 * Runs instantly in client memory without re-uploading the PDF.
 */
export function recomputeWithSalary(
  result: AnalysisResult,
  selectedSalaryCredits: SalaryCredit[],
  manualSalary?: number
): AnalysisResult {
  const isManual =
    typeof manualSalary === "number" &&
    !isNaN(manualSalary) &&
    manualSalary > 0;

  let newAvgSalary = 0;
  let newSalaryMonths = 0;

  if (isManual) {
    newAvgSalary = Math.round(manualSalary * 100) / 100;
    newSalaryMonths =
      selectedSalaryCredits.length > 0
        ? selectedSalaryCredits.length
        : result.months;
  } else if (selectedSalaryCredits.length > 0) {
    const total = selectedSalaryCredits.reduce((s, c) => s + c.amount, 0);
    newAvgSalary =
      Math.round((total / selectedSalaryCredits.length) * 100) / 100;
    newSalaryMonths = selectedSalaryCredits.length;
  }

  const newSalaryResult: SalaryResult = {
    credits: selectedSalaryCredits,
    avgSalary: newAvgSalary,
    months: newSalaryMonths,
    method: isManual
      ? result.salary.method
      : selectedSalaryCredits.length > 0
      ? result.salary.method
      : "none",
  };

  const incomeBasis =
    newAvgSalary > 0 ? newAvgSalary : result.avgMonthlyCredit;

  // Recompute FOIR
  const foir =
    incomeBasis > 0
      ? Math.round((result.monthlyEmi / incomeBasis) * 10000) / 100
      : 0;

  // Recompute passThroughPct from selected credits
  const passThroughCount = selectedSalaryCredits.filter(
    (c) => c.isPassThrough
  ).length;
  const passThroughPct =
    selectedSalaryCredits.length > 0
      ? Math.round(
          (passThroughCount / selectedSalaryCredits.length) * 10000
        ) / 100
      : 0;

  // Recompute salaryRegularity
  const salaryRegularity =
    result.months > 0
      ? Math.round((newSalaryMonths / result.months) * 100) / 100
      : 0;

  // Recompute emiCapacity
  const emiCapacity =
    newAvgSalary > 0
      ? Math.max(0, Math.round(newAvgSalary * 0.5 - result.monthlyEmi))
      : null;

  // Recompute scoring
  let score = CONFIG.scoreStart;
  const reasons: Reason[] = [];

  // 1. Cheque / NACH Bounces
  if (result.bounces > 0) {
    score -= CONFIG.penalties.bounce;
    reasons.push({
      text: `${result.bounces} bounce(s) detected (NACH / cheque return) (-${CONFIG.penalties.bounce})`,
      type: "negative",
    });
  } else {
    reasons.push({
      text: "No cheque or NACH bounces found",
      type: "positive",
    });
  }

  // 2. FOIR Tiers
  if (foir > 55) {
    score -= 35;
    reasons.push({
      text: `FOIR is high at ${Math.round(foir)}% (>50% income committed to EMIs) (-35)`,
      type: "negative",
    });
  } else if (foir > 45) {
    score -= 20;
    reasons.push({
      text: `FOIR is elevated at ${Math.round(foir)}% (-20)`,
      type: "negative",
    });
  } else if (foir > 35) {
    score -= 10;
    reasons.push({
      text: `FOIR is moderate at ${Math.round(foir)}% (-10)`,
      type: "negative",
    });
  } else {
    reasons.push({
      text: "FOIR is within safe limits (<=35%)",
      type: "positive",
    });
  }

  // 3. Betting
  if (result.betting > 0) {
    score -= CONFIG.penalties.betting;
    reasons.push({
      text: `Betting or online gaming transactions detected (-${CONFIG.penalties.betting})`,
      type: "negative",
    });
  }

  // 4. Cash deposit ratio
  if (result.cashPct > CONFIG.limits.cashPctMax) {
    score -= CONFIG.penalties.cashPct;
    reasons.push({
      text: `High cash deposit ratio: ${Math.round(result.cashPct)}% of total credits (-${CONFIG.penalties.cashPct})`,
      type: "negative",
    });
  }

  // 5. Month-End Average Balance relative to incomeBasis
  if (incomeBasis > 0) {
    if (
      result.monthEndAvgBalance <
      CONFIG.limits.monthEndRatioLow * incomeBasis
    ) {
      score -= CONFIG.penalties.monthEndLow10;
      reasons.push({
        text: `Low month-end average balance (<10% of monthly income) (-${CONFIG.penalties.monthEndLow10})`,
        type: "negative",
      });
    } else if (
      result.monthEndAvgBalance <
      CONFIG.limits.monthEndRatioHigh * incomeBasis
    ) {
      score -= CONFIG.penalties.monthEndLow20;
      reasons.push({
        text: `Sub-optimal month-end average balance (<20% of monthly income) (-${CONFIG.penalties.monthEndLow20})`,
        type: "negative",
      });
    } else {
      reasons.push({
        text: "Healthy month-end balance maintained",
        type: "positive",
      });
    }
  }

  // 6. Salary Pass-Through Percentage
  if (passThroughPct >= CONFIG.limits.passThroughHigh) {
    score -= CONFIG.penalties.passThrough80;
    reasons.push({
      text: `Salary pass-through: funds withdrawn within 3 days (-${CONFIG.penalties.passThrough80})`,
      type: "negative",
    });
  } else if (passThroughPct >= CONFIG.limits.passThroughLow) {
    score -= CONFIG.penalties.passThrough50;
    reasons.push({
      text: `Salary pass-through: funds withdrawn within 3 days (-${CONFIG.penalties.passThrough50})`,
      type: "negative",
    });
  }

  // 7. Salary Regularity & Recognition Check
  if (newSalaryMonths === 0) {
    score -= CONFIG.penalties.noSalaryRecognized;
    reasons.push({
      text: `Salary credit not identified; FOIR evaluated on total credit inflows (-${CONFIG.penalties.noSalaryRecognized})`,
      type: "negative",
    });
  } else {
    if (salaryRegularity < CONFIG.limits.salaryRegularityMin) {
      score -= CONFIG.penalties.salaryIrregular;
      reasons.push({
        text: `Irregular salary credits detected across statement months (-${CONFIG.penalties.salaryIrregular})`,
        type: "negative",
      });
    } else {
      reasons.push({
        text: "Regular monthly salary credits verified",
        type: "positive",
      });
    }
  }

  // 8. Instant Fintech Lending Apps
  if (result.lendingApps.count > 0) {
    score -= CONFIG.penalties.lendingApps;
    reasons.push({
      text: `Instant fintech loan app transactions detected (-${CONFIG.penalties.lendingApps})`,
      type: "negative",
    });
  }

  // 9. Large One-Off Credits
  if (result.oneOffCredits.count > 0) {
    const oneOffDeduction = Math.min(
      CONFIG.penalties.oneOffMax,
      result.oneOffCredits.count * CONFIG.penalties.oneOffPerItem
    );
    score -= oneOffDeduction;
    reasons.push({
      text: `Large one-off credit detected (potential loan disbursal) (-${oneOffDeduction})`,
      type: "negative",
    });
  }

  // 10. Share Market Exposure
  if (CONFIG.marketAffectsScore) {
    if (result.market.heavy) {
      score -= CONFIG.penalties.marketHeavy;
      reasons.push({
        text: `Heavy share market exposure (>30% of income in brokers) (-${CONFIG.penalties.marketHeavy})`,
        type: "negative",
      });
    }
    if (result.market.isActive) {
      score -= CONFIG.penalties.marketActive;
      reasons.push({
        text: `Active share market trading activity (-${CONFIG.penalties.marketActive})`,
        type: "negative",
      });
    }
    if (
      result.market.net < 0 &&
      Math.abs(result.market.net) > 1 * incomeBasis
    ) {
      score -= CONFIG.penalties.marketNetLoss;
      reasons.push({
        text: `Substantial net trading loss exceeding monthly income (-${CONFIG.penalties.marketNetLoss})`,
        type: "negative",
      });
    }
  }

  // 11. Wallet Rotation Risk
  if (CONFIG.walletAffectsScore) {
    if (
      result.wallet.walletPctOfCredit > CONFIG.limits.walletPctMax ||
      result.wallet.walletPctOfDebit > CONFIG.limits.walletPctMax
    ) {
      score -= CONFIG.penalties.walletHeavy;
      reasons.push({
        text: `High wallet rotation / turnover detected (-${CONFIG.penalties.walletHeavy})`,
        type: "negative",
      });
    }
  }

  // Hard Caps
  if (
    passThroughPct >= CONFIG.limits.passThroughHigh &&
    score > CONFIG.caps.passThrough80MaxScore
  ) {
    score = CONFIG.caps.passThrough80MaxScore;
  }
  if (foir > 55 && score > CONFIG.caps.foir55MaxScore) {
    score = CONFIG.caps.foir55MaxScore;
  }
  if (result.bounces > 0 && score > CONFIG.caps.bounceMaxScore) {
    score = CONFIG.caps.bounceMaxScore;
  }
  if (result.months < CONFIG.limits.minMonths) {
    if (score > CONFIG.caps.insufficientDataMaxScore) {
      score = CONFIG.caps.insufficientDataMaxScore;
    }
    reasons.push({
      text: "Limited statement data (< 3 months or < 15 txns); indicative score",
      type: "negative",
    });
  }

  // Turnover composition info line
  if (result.otherCredits) {
    reasons.push({
      text: `Salary accounts for ${Math.round(result.otherCredits.salaryPct)}% of total credit inflows`,
      type: "positive",
    });
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let verdict: "Strong" | "Average" | "Weak";
  if (score >= CONFIG.verdictThresholds.strong) {
    verdict = "Strong";
  } else if (score >= CONFIG.verdictThresholds.average) {
    verdict = "Average";
  } else {
    verdict = "Weak";
  }

  return {
    ...result,
    avgSalary: newAvgSalary,
    foir,
    passThroughPct,
    salaryRegularity,
    emiCapacity,
    score,
    verdict,
    reasons,
    salary: newSalaryResult,
  };
}
