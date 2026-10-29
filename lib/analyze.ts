// lib/analyze.ts
// Step 3: Strict & Realistic Financial Health Scoring for Loan DSA Underwriting
// Pure functions, no side effects, deterministic and unit-testable.

import type { Txn } from "./parse";
import { detectSalary, type SalaryResult, type SalaryCredit } from "./salary.ts";
import {
  summarizeOtherCredits,
  isSelfTransfer,
  type OtherCreditsSummary,
} from "./otherCredits.ts";
import { extractAccountInfo, type AccountInfo } from "./accountInfo.ts";
import { extractHolderName } from "./holder.ts";
import type { AiSummary } from "./ai.ts";
import {
  kw,
  CASH_DEPOSIT_RE,
  BOUNCE_RE,
  INSURANCE_RE,
  BILL_PAY_LATER_RE,
  isObligationDebit,
  SALARY_KW_REGEX,
  WALLET_RE,
  LOAN_APP_RE,
  BETTING_RE,
  BROKER_RE,
  MF_SIP_RE,
  CC_PAYMENT_RE,
} from "./keywords.ts";
import { detectRoundTrips, type RoundTripResult } from "./roundTrip.ts";

export { kw };

export interface Reason {
  text: string;
  type: "positive" | "negative" | "neutral" | "warning";
  points?: number;
}

export interface MonthlyRecord {
  month: string;
  monthKey: string;
  credit: number;
  debit: number;
  closingBalance: number;
  isPartial?: boolean;
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
  fullMonthsCount: number;
  fullMonthsLabel?: string;
  usedFullMonths: boolean;
  avgMonthlyCredit: number;
  avgMonthlyDebit: number;
  avgMonthlyCreditExSelf: number;
  realAdjustedCredit: number;
  avgSalary: number;
  abb: number;
  monthEndAvgBalance: number;
  medianDailyBalance: number;
  minBalance: number;
  preSalaryBalance: number;
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
  roundTrip: RoundTripResult;
  selfIn: number;
  selfOut: number;
  billPayLaterDebits: number;
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
  insurancePayments: number;
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
    dailyBalanceLow10: 15,
    dailyBalanceLow20: 8,
    roundTrip: 10,
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
    dailyMedianRatioHigh: 0.2,
    dailyMedianRatioLow: 0.1,
    dailyMedianHealthyRatio: 0.3,
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
    const isBroker = BROKER_RE.test(t.narration);
    const isMf = MF_SIP_RE.test(t.narration);

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
 * Calculates daily carry-forward end-of-day balances across all calendar days,
 * and derives medianDailyBalance and minBalance.
 */
function computeDailyBalanceMetrics(txns: Txn[]): {
  medianDailyBalance: number;
  minBalance: number;
} {
  if (!txns || txns.length === 0) {
    return { medianDailyBalance: 0, minBalance: 0 };
  }

  // Group last transaction balance by date YYYY-MM-DD
  const dayMap = new Map<string, number>();
  for (const t of txns) {
    const key = `${t.date.getFullYear()}-${String(t.date.getMonth() + 1).padStart(2, "0")}-${String(t.date.getDate()).padStart(2, "0")}`;
    dayMap.set(key, t.balance);
  }

  const firstDate = txns[0].date;
  const lastDate = txns[txns.length - 1].date;

  const curDate = new Date(
    firstDate.getFullYear(),
    firstDate.getMonth(),
    firstDate.getDate()
  );
  const endDate = new Date(
    lastDate.getFullYear(),
    lastDate.getMonth(),
    lastDate.getDate()
  );

  let lastKnownBalance = txns[0].balance;
  const dailyBalances: number[] = [];

  while (curDate <= endDate) {
    const dKey = `${curDate.getFullYear()}-${String(curDate.getMonth() + 1).padStart(2, "0")}-${String(curDate.getDate()).padStart(2, "0")}`;
    if (dayMap.has(dKey)) {
      lastKnownBalance = dayMap.get(dKey)!;
    }
    dailyBalances.push(lastKnownBalance);
    curDate.setDate(curDate.getDate() + 1);
  }

  if (dailyBalances.length === 0) {
    return { medianDailyBalance: 0, minBalance: 0 };
  }

  const minBalance = Math.min(...dailyBalances);

  const sorted = [...dailyBalances].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianDailyBalance =
    sorted.length % 2 !== 0
      ? sorted[mid]
      : Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 100) / 100;

  return {
    medianDailyBalance: Math.round(medianDailyBalance * 100) / 100,
    minBalance: Math.round(minBalance * 100) / 100,
  };
}

/**
 * Calculates average balance immediately preceding each salary credit transaction.
 */
function computePreSalaryBalance(txns: Txn[], salaryCredits: SalaryCredit[]): number {
  if (!salaryCredits || salaryCredits.length === 0) return 0;

  let totalPreBalance = 0;
  let count = 0;

  for (const sc of salaryCredits) {
    const scTime = sc.date.getTime();
    const idx = txns.findIndex(
      (t) => t.date.getTime() === scTime && t.credit === sc.amount
    );

    if (idx > 0) {
      totalPreBalance += txns[idx - 1].balance;
      count++;
    } else if (idx === 0) {
      totalPreBalance += txns[0].balance - txns[0].credit;
      count++;
    }
  }

  return count > 0 ? Math.round((totalPreBalance / count) * 100) / 100 : 0;
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
  const effectiveHolderName =
    holderName || (rawLines ? extractHolderName(rawLines) : undefined);

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
  let insurancePayments = 0;
  let billPayLaterDebits = 0;

  let selfIn = 0;
  let selfOut = 0;

  for (const t of txns) {
    totalCredits += t.credit;
    totalDebits += t.debit;
    balanceSum += t.balance;

    if (BOUNCE_RE.test(t.narration)) {
      bounces++;
    }

    if (BETTING_RE.test(t.narration)) {
      betting++;
    }

    if (t.credit > 0 && CASH_DEPOSIT_RE.test(t.narration)) {
      cashCreditsSum += t.credit;
    }

    // Wallet metrics
    if (WALLET_RE.test(t.narration)) {
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
    if (LOAN_APP_RE.test(t.narration)) {
      lendingAppsCount++;
      lendingAppsTotal += t.credit + t.debit;
    }

    // Credit card payments
    if (t.debit > 0 && CC_PAYMENT_RE.test(t.narration)) {
      ccDebitsSum += t.debit;
    }

    // Insurance payments
    if (t.debit > 0 && INSURANCE_RE.test(t.narration)) {
      insurancePayments += t.debit;
    }

    // Bill pay / pay later payments
    if (t.debit > 0 && BILL_PAY_LATER_RE.test(t.narration)) {
      billPayLaterDebits += t.debit;
    }

    // Self-transfers on debits & credits
    if (isSelfTransfer(t.narration, effectiveHolderName)) {
      if (t.credit > 0) selfIn += t.credit;
      if (t.debit > 0) selfOut += t.debit;
    }
  }

  totalCredits = Math.round(totalCredits * 100) / 100;
  totalDebits = Math.round(totalDebits * 100) / 100;
  walletIn = Math.round(walletIn * 100) / 100;
  walletOut = Math.round(walletOut * 100) / 100;
  lendingAppsTotal = Math.round(lendingAppsTotal * 100) / 100;
  ccDebitsSum = Math.round(ccDebitsSum * 100) / 100;
  insurancePayments = Math.round(insurancePayments * 100) / 100;
  billPayLaterDebits = Math.round(billPayLaterDebits * 100) / 100;
  selfIn = Math.round(selfIn * 100) / 100;
  selfOut = Math.round(selfOut * 100) / 100;

  // Round-trip detector
  const roundTrip = detectRoundTrips(txns, totalCredits);

  // Real adjusted credit: total credits - self - wallet - roundTrip
  const realAdjustedCredit = Math.max(
    0,
    Math.round((totalCredits - selfIn - walletIn - roundTrip.volume) * 100) / 100
  );

  // 2. Month-by-month table & Full Months Identification
  const sortedMonthKeys = Array.from(monthMap.keys()).sort();
  let closingBalanceSum = 0;

  const monthlyTable: MonthlyRecord[] = sortedMonthKeys.map((key, idx) => {
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

    const daysInMonth = new Date(item.year, item.month + 1, 0).getDate();
    let isPartial = false;

    // First month partial if earliest txn day >= 5
    if (idx === 0) {
      const minDay = Math.min(...item.txns.map((t) => t.date.getDate()));
      if (minDay >= 5) {
        isPartial = true;
      }
    }

    // Last month partial if latest txn day <= (daysInMonth - 4)
    if (idx === sortedMonthKeys.length - 1) {
      const maxDay = Math.max(...item.txns.map((t) => t.date.getDate()));
      if (maxDay <= daysInMonth - 4) {
        isPartial = true;
      }
    }

    return {
      monthKey: key,
      month: `${SHORT_MONTHS[item.month]} ${item.year}`,
      credit: Math.round(mCredit * 100) / 100,
      debit: Math.round(mDebit * 100) / 100,
      closingBalance: Math.round(closingBalance * 100) / 100,
      isPartial,
    };
  });

  const monthEndAvgBalance =
    monthlyTable.length > 0
      ? Math.round((closingBalanceSum / monthlyTable.length) * 100) / 100
      : 0;

  // Daily balance metrics (medianDailyBalance, minBalance)
  const { medianDailyBalance, minBalance } = computeDailyBalanceMetrics(txns);

  // Full Months Averages
  const fullMonths = monthlyTable.filter((m) => !m.isPartial);
  const usedFullMonths = fullMonths.length >= 2;

  let avgMonthlyCredit: number;
  let avgMonthlyDebit: number;
  let monthlyEmi: number;
  let fullMonthsCount: number;
  let fullMonthsLabel: string | undefined;

  if (usedFullMonths) {
    fullMonthsCount = fullMonths.length;
    fullMonthsLabel = `${fullMonths[0].month.split(" ")[0]}-${fullMonths[fullMonths.length - 1].month.split(" ")[0]}`;
    const fCredit = fullMonths.reduce((s, m) => s + m.credit, 0);
    const fDebit = fullMonths.reduce((s, m) => s + m.debit, 0);
    avgMonthlyCredit = Math.round((fCredit / fullMonths.length) * 100) / 100;
    avgMonthlyDebit = Math.round((fDebit / fullMonths.length) * 100) / 100;

    const fullMonthKeys = new Set(fullMonths.map((m) => m.monthKey));
    const fullMonthEmiDebits = txns
      .filter((t) => {
        if (t.debit <= 0 || !isObligationDebit(t.narration)) return false;
        const k = `${t.date.getFullYear()}-${String(t.date.getMonth() + 1).padStart(2, "0")}`;
        return fullMonthKeys.has(k);
      })
      .reduce((s, t) => s + t.debit, 0);

    monthlyEmi = Math.round((fullMonthEmiDebits / fullMonths.length) * 100) / 100;
  } else {
    fullMonthsCount = months;
    fullMonthsLabel = undefined;
    avgMonthlyCredit = Math.round((totalCredits / months) * 100) / 100;
    avgMonthlyDebit = Math.round((totalDebits / months) * 100) / 100;

    const emiTx = txns.filter(
      (t) => t.debit > 0 && isObligationDebit(t.narration)
    );
    const emiMonthSet = new Set<string>();
    let emiDebitsSum = 0;
    for (const t of emiTx) {
      emiMonthSet.add(`${t.date.getFullYear()}-${t.date.getMonth()}`);
      emiDebitsSum += t.debit;
    }
    const emiMonths = Math.max(1, emiMonthSet.size);
    monthlyEmi = Math.round((emiDebitsSum / emiMonths) * 100) / 100;
  }

  // Robust multi-step salary detection
  const salary = detectSalary(txns, effectiveHolderName);
  const avgSalary = salary.avgSalary;
  const salaryMonths = salary.months;

  // Pre-salary average balance
  const preSalaryBalance = computePreSalaryBalance(txns, salary.credits);

  // Primary income basis for scoring (avgSalary if identified, else avgMonthlyCredit)
  const incomeBasis = avgSalary > 0 ? avgSalary : avgMonthlyCredit;

  // FOIR: calculated on avgSalary basis if available, otherwise avgMonthlyCredit
  const foir =
    incomeBasis > 0
      ? Math.round((monthlyEmi / incomeBasis) * 10000) / 100
      : 0;

  // Historical abb (average of transaction balances)
  const abb =
    txns.length > 0 ? Math.round((balanceSum / txns.length) * 100) / 100 : 0;

  // Pass-through percentage
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
  let oneOffCount = 0;
  let oneOffTotal = 0;
  if (avgSalary > 0) {
    const oneOffThreshold = 2 * avgSalary;
    const salaryCreditTimes = new Set(salary.credits.map((c) => c.date.getTime()));
    for (const t of txns) {
      if (
        t.credit >= oneOffThreshold &&
        !salaryCreditTimes.has(t.date.getTime()) &&
        !SALARY_KW_REGEX.test(t.narration)
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

  // Categorize non-salary credits
  const otherCredits = summarizeOtherCredits(
    txns,
    salary.credits,
    effectiveHolderName,
    avgSalary
  );

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

  const creditCardPayments = ccDebitsSum;

  const emiCapacity =
    avgSalary > 0
      ? Math.max(0, Math.round(avgSalary * 0.5 - monthlyEmi))
      : null;

  const cashPct =
    totalCredits > 0
      ? Math.round((cashCreditsSum / totalCredits) * 10000) / 100
      : 0;

  const market = marketActivity(txns, incomeBasis, months);

  // Wallet rotation object: also flags suspected if roundTrip is suspected
  const isRotationSuspected =
    walletPctOfCredit > CONFIG.limits.walletPctMax ||
    walletPctOfDebit > CONFIG.limits.walletPctMax ||
    (ccDebitsSum > 0 && walletIn >= 10000) ||
    roundTrip.suspected;

  const adjustedMonthlyCredit =
    Math.round((realAdjustedCredit / months) * 100) / 100;
  const adjustedFoir =
    adjustedMonthlyCredit > 0
      ? Math.round((monthlyEmi / adjustedMonthlyCredit) * 10000) / 100
      : 0;

  let walletSummary = "";
  if (isRotationSuspected) {
    walletSummary = `High turnover / circular rotation detected (Wallet In: ₹${walletIn.toLocaleString("en-IN")}, Round-trip: ₹${roundTrip.volume.toLocaleString("en-IN")}). Inflow may be circular.`;
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
      points: -CONFIG.penalties.bounce,
    });
  } else {
    reasons.push({
      text: "No cheque or NACH bounces found (+0)",
      type: "positive",
      points: 0,
    });
  }

  // 2. FOIR Tiers: [{ above: 35, pts: 10 }, { above: 45, pts: 20 }, { above: 55, pts: 35 }]
  if (foir > 55) {
    score -= 35;
    reasons.push({
      text: `FOIR is high at ${Math.round(foir)}% (>50% income committed to EMIs) (-35)`,
      type: "negative",
      points: -35,
    });
  } else if (foir > 45) {
    score -= 20;
    reasons.push({
      text: `FOIR is elevated at ${Math.round(foir)}% (-20)`,
      type: "negative",
      points: -20,
    });
  } else if (foir > 35) {
    score -= 10;
    reasons.push({
      text: `FOIR is moderate at ${Math.round(foir)}% (-10)`,
      type: "negative",
      points: -10,
    });
  } else {
    reasons.push({
      text: "FOIR is within safe limits (<=35%) (+0)",
      type: "positive",
      points: 0,
    });
  }

  // 3. Betting / Gaming Outflows (-20)
  if (betting > 0) {
    score -= CONFIG.penalties.betting;
    reasons.push({
      text: `Betting or online gaming transactions detected (-${CONFIG.penalties.betting})`,
      type: "negative",
      points: -CONFIG.penalties.betting,
    });
  }

  // 4. Cash Deposit Ratio (> 40% => -10)
  if (cashPct > CONFIG.limits.cashPctMax) {
    score -= CONFIG.penalties.cashPct;
    reasons.push({
      text: `High cash deposit ratio: ${Math.round(cashPct)}% of total credits (-${CONFIG.penalties.cashPct})`,
      type: "negative",
      points: -CONFIG.penalties.cashPct,
    });
  }

  // 5. Daily Balance Metrics Scoring (medianDailyBalance vs incomeBasis)
  if (incomeBasis > 0) {
    if (medianDailyBalance < CONFIG.limits.dailyMedianRatioLow * incomeBasis) {
      score -= CONFIG.penalties.dailyBalanceLow10;
      reasons.push({
        text: `Low daily median balance (<10% of monthly income) (-${CONFIG.penalties.dailyBalanceLow10})`,
        type: "negative",
        points: -CONFIG.penalties.dailyBalanceLow10,
      });
    } else if (medianDailyBalance < CONFIG.limits.dailyMedianRatioHigh * incomeBasis) {
      score -= CONFIG.penalties.dailyBalanceLow20;
      reasons.push({
        text: `Sub-optimal daily median balance (<20% of monthly income) (-${CONFIG.penalties.dailyBalanceLow20})`,
        type: "negative",
        points: -CONFIG.penalties.dailyBalanceLow20,
      });
    } else if (medianDailyBalance >= CONFIG.limits.dailyMedianHealthyRatio * incomeBasis) {
      reasons.push({
        text: "Healthy balance maintained (daily median balance >= 30% of income) (+0)",
        type: "positive",
        points: 0,
      });
    }
  }

  // 6. Round-Trip Rotation Penalty (-10)
  if (roundTrip.suspected) {
    score -= CONFIG.penalties.roundTrip;
    reasons.push({
      text: `Same amount ka debit-credit same din (rotation jaisa) (-${CONFIG.penalties.roundTrip})`,
      type: "negative",
      points: -CONFIG.penalties.roundTrip,
    });
  }

  // 7. Salary Pass-Through Percentage (>= 80% => -20, >= 50% => -10)
  if (passThroughPct >= CONFIG.limits.passThroughHigh) {
    score -= CONFIG.penalties.passThrough80;
    reasons.push({
      text: `Salary pass-through: funds withdrawn within 3 days (-${CONFIG.penalties.passThrough80})`,
      type: "negative",
      points: -CONFIG.penalties.passThrough80,
    });
  } else if (passThroughPct >= CONFIG.limits.passThroughLow) {
    score -= CONFIG.penalties.passThrough50;
    reasons.push({
      text: `Salary pass-through: funds withdrawn within 3 days (-${CONFIG.penalties.passThrough50})`,
      type: "negative",
      points: -CONFIG.penalties.passThrough50,
    });
  }

  // 8. Salary Regularity & Recognition Check
  if (salaryMonths === 0) {
    score -= CONFIG.penalties.noSalaryRecognized;
    reasons.push({
      text: `Salary credit not identified; FOIR evaluated on total credit inflows (-${CONFIG.penalties.noSalaryRecognized})`,
      type: "negative",
      points: -CONFIG.penalties.noSalaryRecognized,
    });
  } else {
    if (salaryRegularity < CONFIG.limits.salaryRegularityMin) {
      score -= CONFIG.penalties.salaryIrregular;
      reasons.push({
        text: `Irregular salary credits detected across statement months (-${CONFIG.penalties.salaryIrregular})`,
        type: "negative",
        points: -CONFIG.penalties.salaryIrregular,
      });
    } else {
      reasons.push({
        text: "Regular monthly salary credits verified (+0)",
        type: "positive",
        points: 0,
      });
    }
  }

  // 9. Instant Fintech Lending Apps (-15)
  if (lendingApps.count > 0) {
    score -= CONFIG.penalties.lendingApps;
    reasons.push({
      text: `Instant fintech loan app transactions detected (-${CONFIG.penalties.lendingApps})`,
      type: "negative",
      points: -CONFIG.penalties.lendingApps,
    });
  }

  // 10. Large One-Off Credits (-5 per item, max -10)
  if (oneOffCredits.count > 0) {
    const oneOffDeduction = Math.min(
      CONFIG.penalties.oneOffMax,
      oneOffCredits.count * CONFIG.penalties.oneOffPerItem
    );
    score -= oneOffDeduction;
    reasons.push({
      text: `Large one-off credit detected (potential loan disbursal) (-${oneOffDeduction})`,
      type: "negative",
      points: -oneOffDeduction,
    });
  }

  // 11. Share Market & Speculative Exposure
  if (CONFIG.marketAffectsScore) {
    if (market.heavy) {
      score -= CONFIG.penalties.marketHeavy;
      reasons.push({
        text: `Heavy share market exposure (>30% of income in brokers) (-${CONFIG.penalties.marketHeavy})`,
        type: "negative",
        points: -CONFIG.penalties.marketHeavy,
      });
    }
    if (market.isActive) {
      score -= CONFIG.penalties.marketActive;
      reasons.push({
        text: `Active share market trading activity (-${CONFIG.penalties.marketActive})`,
        type: "negative",
        points: -CONFIG.penalties.marketActive,
      });
    }

    if (market.net < 0 && Math.abs(market.net) > 1 * incomeBasis) {
      score -= CONFIG.penalties.marketNetLoss;
      reasons.push({
        text: `Substantial net trading loss exceeding monthly income (-${CONFIG.penalties.marketNetLoss})`,
        type: "negative",
        points: -CONFIG.penalties.marketNetLoss,
      });
    }
  }

  // 12. Wallet Rotation Risk
  if (CONFIG.walletAffectsScore) {
    if (
      walletPctOfCredit > CONFIG.limits.walletPctMax ||
      walletPctOfDebit > CONFIG.limits.walletPctMax
    ) {
      score -= CONFIG.penalties.walletHeavy;
      reasons.push({
        text: `High wallet rotation / turnover detected (-${CONFIG.penalties.walletHeavy})`,
        type: "negative",
        points: -CONFIG.penalties.walletHeavy,
      });
    }
  }

  // 13. Informational & Warning Indicators
  // Insurance premium note: neutral ℹ️
  if (insurancePayments > 0) {
    reasons.push({
      text: `Insurance premium payments: ₹${insurancePayments.toLocaleString("en-IN")} (non-EMI)`,
      type: "neutral",
      points: 0,
    });
  }

  // Bill pay / card-like pay later note: neutral ℹ️
  if (billPayLaterDebits > 0) {
    reasons.push({
      text: `Bill pay / card-like (confirm karo): ₹${billPayLaterDebits.toLocaleString("en-IN")}`,
      type: "neutral",
      points: 0,
    });
  }

  // Salary share: positive ✓ if >= 40%, amber warning ⚠ if < 40%
  const salaryShare = Math.round(otherCredits.salaryPct);
  if (salaryShare < 40) {
    reasons.push({
      text: `Low salary share: Salary accounts for ${salaryShare}% of total credit inflows (remaining received from other sources)`,
      type: "warning",
      points: 0,
    });
  } else {
    reasons.push({
      text: `Salary accounts for ${salaryShare}% of total credit inflows (+0)`,
      type: "positive",
      points: 0,
    });
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
      points: 0,
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
    months,
    fullMonthsCount,
    fullMonthsLabel,
    usedFullMonths,
    avgMonthlyCredit,
    avgMonthlyDebit,
    avgMonthlyCreditExSelf,
    realAdjustedCredit,
    avgSalary,
    abb,
    monthEndAvgBalance,
    medianDailyBalance,
    minBalance,
    preSalaryBalance,
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
    roundTrip,
    selfIn,
    selfOut,
    billPayLaterDebits,
    passThroughPct,
    salaryRegularity,
    oneOffCredits,
    selfTransferCredits,
    wallet,
    lendingApps,
    creditCardPayments,
    insurancePayments,
    emiCapacity,
    salary,
    otherCredits,
    accountInfo: extractAccountInfo(rawLines || [], txns, effectiveHolderName),
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
      points: -CONFIG.penalties.bounce,
    });
  } else {
    reasons.push({
      text: "No cheque or NACH bounces found (+0)",
      type: "positive",
      points: 0,
    });
  }

  // 2. FOIR Tiers
  if (foir > 55) {
    score -= 35;
    reasons.push({
      text: `FOIR is high at ${Math.round(foir)}% (>50% income committed to EMIs) (-35)`,
      type: "negative",
      points: -35,
    });
  } else if (foir > 45) {
    score -= 20;
    reasons.push({
      text: `FOIR is elevated at ${Math.round(foir)}% (-20)`,
      type: "negative",
      points: -20,
    });
  } else if (foir > 35) {
    score -= 10;
    reasons.push({
      text: `FOIR is moderate at ${Math.round(foir)}% (-10)`,
      type: "negative",
      points: -10,
    });
  } else {
    reasons.push({
      text: "FOIR is within safe limits (<=35%) (+0)",
      type: "positive",
      points: 0,
    });
  }

  // 3. Betting
  if (result.betting > 0) {
    score -= CONFIG.penalties.betting;
    reasons.push({
      text: `Betting or online gaming transactions detected (-${CONFIG.penalties.betting})`,
      type: "negative",
      points: -CONFIG.penalties.betting,
    });
  }

  // 4. Cash deposit ratio
  if (result.cashPct > CONFIG.limits.cashPctMax) {
    score -= CONFIG.penalties.cashPct;
    reasons.push({
      text: `High cash deposit ratio: ${Math.round(result.cashPct)}% of total credits (-${CONFIG.penalties.cashPct})`,
      type: "negative",
      points: -CONFIG.penalties.cashPct,
    });
  }

  // 5. Daily median balance vs incomeBasis
  if (incomeBasis > 0) {
    if (result.medianDailyBalance < CONFIG.limits.dailyMedianRatioLow * incomeBasis) {
      score -= CONFIG.penalties.dailyBalanceLow10;
      reasons.push({
        text: `Low daily median balance (<10% of monthly income) (-${CONFIG.penalties.dailyBalanceLow10})`,
        type: "negative",
        points: -CONFIG.penalties.dailyBalanceLow10,
      });
    } else if (
      result.medianDailyBalance <
      CONFIG.limits.dailyMedianRatioHigh * incomeBasis
    ) {
      score -= CONFIG.penalties.dailyBalanceLow20;
      reasons.push({
        text: `Sub-optimal daily median balance (<20% of monthly income) (-${CONFIG.penalties.dailyBalanceLow20})`,
        type: "negative",
        points: -CONFIG.penalties.dailyBalanceLow20,
      });
    } else if (
      result.medianDailyBalance >=
      CONFIG.limits.dailyMedianHealthyRatio * incomeBasis
    ) {
      reasons.push({
        text: "Healthy balance maintained (daily median balance >= 30% of income) (+0)",
        type: "positive",
        points: 0,
      });
    }
  }

  // 6. Round-trip penalty
  if (result.roundTrip?.suspected) {
    score -= CONFIG.penalties.roundTrip;
    reasons.push({
      text: `Same amount ka debit-credit same din (rotation jaisa) (-${CONFIG.penalties.roundTrip})`,
      type: "negative",
      points: -CONFIG.penalties.roundTrip,
    });
  }

  // 7. Salary Pass-Through Percentage
  if (passThroughPct >= CONFIG.limits.passThroughHigh) {
    score -= CONFIG.penalties.passThrough80;
    reasons.push({
      text: `Salary pass-through: funds withdrawn within 3 days (-${CONFIG.penalties.passThrough80})`,
      type: "negative",
      points: -CONFIG.penalties.passThrough80,
    });
  } else if (passThroughPct >= CONFIG.limits.passThroughLow) {
    score -= CONFIG.penalties.passThrough50;
    reasons.push({
      text: `Salary pass-through: funds withdrawn within 3 days (-${CONFIG.penalties.passThrough50})`,
      type: "negative",
      points: -CONFIG.penalties.passThrough50,
    });
  }

  // 8. Salary Regularity & Recognition Check
  if (newSalaryMonths === 0) {
    score -= CONFIG.penalties.noSalaryRecognized;
    reasons.push({
      text: `Salary credit not identified; FOIR evaluated on total credit inflows (-${CONFIG.penalties.noSalaryRecognized})`,
      type: "negative",
      points: -CONFIG.penalties.noSalaryRecognized,
    });
  } else {
    if (salaryRegularity < CONFIG.limits.salaryRegularityMin) {
      score -= CONFIG.penalties.salaryIrregular;
      reasons.push({
        text: `Irregular salary credits detected across statement months (-${CONFIG.penalties.salaryIrregular})`,
        type: "negative",
        points: -CONFIG.penalties.salaryIrregular,
      });
    } else {
      reasons.push({
        text: "Regular monthly salary credits verified (+0)",
        type: "positive",
        points: 0,
      });
    }
  }

  // 9. Instant Fintech Lending Apps
  if (result.lendingApps.count > 0) {
    score -= CONFIG.penalties.lendingApps;
    reasons.push({
      text: `Instant fintech loan app transactions detected (-${CONFIG.penalties.lendingApps})`,
      type: "negative",
      points: -CONFIG.penalties.lendingApps,
    });
  }

  // 10. Large One-Off Credits
  if (result.oneOffCredits.count > 0) {
    const oneOffDeduction = Math.min(
      CONFIG.penalties.oneOffMax,
      result.oneOffCredits.count * CONFIG.penalties.oneOffPerItem
    );
    score -= oneOffDeduction;
    reasons.push({
      text: `Large one-off credit detected (potential loan disbursal) (-${oneOffDeduction})`,
      type: "negative",
      points: -oneOffDeduction,
    });
  }

  // 11. Share Market Exposure
  if (CONFIG.marketAffectsScore) {
    if (result.market.heavy) {
      score -= CONFIG.penalties.marketHeavy;
      reasons.push({
        text: `Heavy share market exposure (>30% of income in brokers) (-${CONFIG.penalties.marketHeavy})`,
        type: "negative",
        points: -CONFIG.penalties.marketHeavy,
      });
    }
    if (result.market.isActive) {
      score -= CONFIG.penalties.marketActive;
      reasons.push({
        text: `Active share market trading activity (-${CONFIG.penalties.marketActive})`,
        type: "negative",
        points: -CONFIG.penalties.marketActive,
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
        points: -CONFIG.penalties.marketNetLoss,
      });
    }
  }

  // 12. Wallet Rotation Risk
  if (CONFIG.walletAffectsScore) {
    if (
      result.wallet.walletPctOfCredit > CONFIG.limits.walletPctMax ||
      result.wallet.walletPctOfDebit > CONFIG.limits.walletPctMax
    ) {
      score -= CONFIG.penalties.walletHeavy;
      reasons.push({
        text: `High wallet rotation / turnover detected (-${CONFIG.penalties.walletHeavy})`,
        type: "negative",
        points: -CONFIG.penalties.walletHeavy,
      });
    }
  }

  // 13. Informational & Warning Indicators
  if (result.insurancePayments > 0) {
    reasons.push({
      text: `Insurance premium payments: ₹${result.insurancePayments.toLocaleString("en-IN")} (non-EMI)`,
      type: "neutral",
      points: 0,
    });
  }

  if (result.billPayLaterDebits > 0) {
    reasons.push({
      text: `Bill pay / card-like (confirm karo): ₹${result.billPayLaterDebits.toLocaleString("en-IN")}`,
      type: "neutral",
      points: 0,
    });
  }

  if (result.otherCredits) {
    const salaryShare = Math.round(result.otherCredits.salaryPct);
    if (salaryShare < 40) {
      reasons.push({
        text: `Low salary share: Salary accounts for ${salaryShare}% of total credit inflows (remaining received from other sources)`,
        type: "warning",
        points: 0,
      });
    } else {
      reasons.push({
        text: `Salary accounts for ${salaryShare}% of total credit inflows (+0)`,
        type: "positive",
        points: 0,
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
      points: 0,
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
