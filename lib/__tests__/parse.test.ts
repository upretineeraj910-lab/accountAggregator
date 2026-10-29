// lib/__tests__/parse.test.ts
// Unit tests for parsing, Axis multi-line fix, and strict loan scoring rules

import assert from "node:assert";
import { parseTxns, parseStatement, parseStatementWithDebug, type Txn } from "../parse.ts";
import type { Row } from "../pdfText.ts";
import { analyze } from "../analyze.ts";
import { calcEmi, maxLoanForEmi, checkNewLoan } from "../loanCheck.ts";
import { detectSalary, type SalaryCredit } from "../salary.ts";
import { summarizeOtherCredits, isSelfTransfer } from "../otherCredits.ts";
import {
  isObligationDebit,
  BOUNCE_RE,
  CASH_DEPOSIT_RE,
  INSURANCE_RE,
  WALLET_RE,
} from "../keywords.ts";
import { extractAccountInfo } from "../accountInfo.ts";
import { generateAiAssessment } from "../ai.ts";

// ==========================================
// Test 1: Axis Bank fixture parsing & FOIR
// ==========================================
const fixture = [
  "Tran Date Chq No Particulars Debit Credit Balance Init.",
  "OPENING BALANCE 35.52",
  "NEFT/CITIN111/HCL",
  "TECHNOLOGIES LTD/CITI BANK/Salary",
  "30-04-2026 Transfer 41387.00 41422.52 248",
  "PPR005612940841_EMI_05-05-2026_NAVEEN",
  "05-05-2026 DHAMA 15994.00 8.52 245",
  "TRANSACTION TOTAL 15994.00 41387.00",
  "CLOSING BALANCE 8.52",
  "Legends :",
  "EDC-Credit transaction through EDC Machine",
  "Axis Bank Loan Centre",
];

const txns = parseTxns(fixture);

// 1. Exactly 2 txns are parsed (header, totals, legends do not form txns)
assert.strictEqual(
  txns.length,
  2,
  `Expected exactly 2 transactions to be parsed, but got ${txns.length}`
);

// 2. First txn: credit 41387, narration contains "Salary"
assert.strictEqual(
  txns[0].credit,
  41387,
  `First txn credit expected 41387, got ${txns[0].credit}`
);
assert.ok(
  txns[0].narration.includes("Salary"),
  `First txn narration must contain 'Salary', got: ${txns[0].narration}`
);

// 3. Second txn: debit 15994, narration contains "_EMI_"
assert.strictEqual(
  txns[1].debit,
  15994,
  `Second txn debit expected 15994, got ${txns[1].debit}`
);
assert.ok(
  txns[1].narration.includes("_EMI_"),
  `Second txn narration must contain '_EMI_', got: ${txns[1].narration}`
);

// 4. "Loan Centre" is not in any narration
for (const t of txns) {
  assert.ok(
    !t.narration.toLowerCase().includes("loan centre"),
    `Narration must not contain 'Loan Centre', found: ${t.narration}`
  );
}

// 5. On this fixture monthlyEmi = 15994
const resAxis = analyze(txns);
assert.strictEqual(
  resAxis.monthlyEmi,
  15994,
  `Expected monthlyEmi to be 15994, got ${resAxis.monthlyEmi}`
);

// ==========================================
// Scenario 1: Pass-through case
// Salary 40k, EMI 16k, full salary transferred out in 1 day, balance ~₹10
// Verdict must NEVER be "Strong" (Average or Weak, score <= 69)
// ==========================================
const passThroughTxns: Txn[] = [];
const monthsData = [
  { y: 2026, m: 0 },
  { y: 2026, m: 1 },
  { y: 2026, m: 2 },
];

let curBal = 50;
for (const { y, m } of monthsData) {
  // Day 1: Salary credit 40,000
  curBal += 40000;
  passThroughTxns.push({
    date: new Date(y, m, 1),
    narration: "NEFT HCL TECH SALARY CREDIT",
    debit: 0,
    credit: 40000,
    balance: curBal,
  });

  // Day 2 (within 3 days): Transfer 38,000 out to another bank (pass-through > 90%)
  curBal -= 38000;
  passThroughTxns.push({
    date: new Date(y, m, 2),
    narration: "UPI CANARA BANK TRANSFER",
    debit: 38000,
    credit: 0,
    balance: curBal,
  });

  // Day 5: EMI 16,000 (partially overdraft or prior buffer, let's inject small buffer or balance)
  curBal += 15000;
  passThroughTxns.push({
    date: new Date(y, m, 4),
    narration: "TRANSFER IN",
    debit: 0,
    credit: 15000,
    balance: curBal,
  });

  curBal -= 16000;
  passThroughTxns.push({
    date: new Date(y, m, 5),
    narration: "LOAN EMI NACH DEBIT",
    debit: 16000,
    credit: 0,
    balance: curBal,
  });

  // Daily minor expenses to build >= 15 txns total
  for (let d = 10; d <= 12; d++) {
    curBal -= 100;
    passThroughTxns.push({
      date: new Date(y, m, d),
      narration: "UPI GROCERY STORE",
      debit: 100,
      credit: 0,
      balance: curBal,
    });
  }
}

const resPassThrough = analyze(passThroughTxns);
assert.strictEqual(
  resPassThrough.months,
  3,
  "Expected 3 months in pass-through test"
);
assert.ok(
  passThroughTxns.length >= 15,
  "Expected at least 15 transactions in pass-through test"
);
assert.ok(
  resPassThrough.passThroughPct >= 80,
  `Expected passThroughPct >= 80, got ${resPassThrough.passThroughPct}`
);
assert.notStrictEqual(
  resPassThrough.verdict,
  "Strong",
  "Pass-through case must NEVER receive a 'Strong' verdict"
);
assert.ok(
  resPassThrough.score <= 69,
  `Expected score <= 69 due to passThrough cap, got ${resPassThrough.score}`
);
assert.ok(
  resPassThrough.reasons.some((r) =>
    r.text.includes("Salary pass-through")
  ),
  "Must include 'Salary pass-through' reason"
);

// ==========================================
// Scenario 2: Clean case
// Salary 60k, EMI 10k, healthy month-end balance 30k+, 0 bounces
// Verdict must be "Strong" (score >= 75)
// ==========================================
const cleanTxns: Txn[] = [];
let cleanBal = 35000;
for (const { y, m } of monthsData) {
  // Day 1: Salary credit 60,000
  cleanBal += 60000;
  cleanTxns.push({
    date: new Date(y, m, 1),
    narration: "NEFT INFOSYS SALARY",
    debit: 0,
    credit: 60000,
    balance: cleanBal,
  });

  // Day 10: EMI 10,000 (FOIR = 10k / 60k = 16.7% <= 35%)
  cleanBal -= 10000;
  cleanTxns.push({
    date: new Date(y, m, 10),
    narration: "HDFC HOME LOAN EMI",
    debit: 10000,
    credit: 0,
    balance: cleanBal,
  });

  // Moderate distributed expenses spread over the month (no >90% drain in 3 days)
  for (let d = 12; d <= 16; d++) {
    cleanBal -= 2000;
    cleanTxns.push({
      date: new Date(y, m, d),
      narration: "UPI SHOPPING & UTILITY",
      debit: 2000,
      credit: 0,
      balance: cleanBal,
    });
  }
}

const resClean = analyze(cleanTxns);
assert.strictEqual(
  resClean.verdict,
  "Strong",
  `Clean case expected 'Strong' verdict, got ${resClean.verdict} (Score: ${resClean.score})`
);
assert.ok(
  resClean.score >= 75,
  `Clean case score must be >= 75, got ${resClean.score}`
);
assert.strictEqual(resClean.bounces, 0);
assert.ok(
  resClean.monthEndAvgBalance >= 0.2 * resClean.avgSalary,
  "Month-end balance should be healthy (>20% of salary)"
);

// ==========================================
// Scenario 3: Trader case
// Salary 50k, 40k debit to Zerodha/Groww, 6+ broker transfers
// Verdict cannot be "Strong"
// ==========================================
const traderTxns: Txn[] = [];
let traderBal = 20000;
for (const { y, m } of monthsData) {
  traderBal += 50000;
  traderTxns.push({
    date: new Date(y, m, 1),
    narration: "SALARY CREDIT TECH CORP",
    debit: 0,
    credit: 50000,
    balance: traderBal,
  });

  // 2 broker transfers per month -> 6 broker transfers over 3 months
  traderBal -= 20000;
  traderTxns.push({
    date: new Date(y, m, 8),
    narration: "UPI TO ZERODHA BROKING",
    debit: 20000,
    credit: 0,
    balance: traderBal,
  });

  traderBal -= 20000;
  traderTxns.push({
    date: new Date(y, m, 15),
    narration: "ACH GROWW INVEST BROKER",
    debit: 20000,
    credit: 0,
    balance: traderBal,
  });

  for (let d = 20; d <= 23; d++) {
    traderBal -= 500;
    traderTxns.push({
      date: new Date(y, m, d),
      narration: "UPI GROCERY STORE",
      debit: 500,
      credit: 0,
      balance: traderBal,
    });
  }
}

const resTrader = analyze(traderTxns);
assert.notStrictEqual(
  resTrader.verdict,
  "Strong",
  `Heavy trader case must NOT be Strong, got: ${resTrader.verdict} (Score: ${resTrader.score})`
);
assert.ok(
  resTrader.market.heavy || resTrader.market.isActive,
  "Expected trader to be flagged as heavy or active"
);
assert.ok(
  resTrader.reasons.some((r) => r.text.includes("share market")),
  "Expected share market penalty reason"
);

// ==========================================
// Scenario 4: Wallet-heavy case
// Inflow & outflow > 30% through wallets, low month-end balance
// Verdict cannot be "Strong", score is heavily penalized
// ==========================================
const walletTxns: Txn[] = [];
let walletBal = 500;
for (const { y, m } of monthsData) {
  // Day 1: Salary 30k
  walletBal += 30000;
  walletTxns.push({
    date: new Date(y, m, 1),
    narration: "SALARY ACME CORP",
    debit: 0,
    credit: 30000,
    balance: walletBal,
  });

  // Day 2: Inflow from Paytm Wallet 25k (> 40% of credits)
  walletBal += 25000;
  walletTxns.push({
    date: new Date(y, m, 2),
    narration: "PAYTM WALLET INFLOW CASHBACK",
    debit: 0,
    credit: 25000,
    balance: walletBal,
  });

  // Day 3: Outflow to PhonePe Wallet 25k (> 40% of debits)
  walletBal -= 25000;
  walletTxns.push({
    date: new Date(y, m, 3),
    narration: "PHONEPE WALLET LOAD ADD MONEY",
    debit: 25000,
    credit: 0,
    balance: walletBal,
  });

  // Day 4: Living expenses / transfer out
  walletBal -= 28000;
  walletTxns.push({
    date: new Date(y, m, 4),
    narration: "UPI TRANSFER OUT",
    debit: 28000,
    credit: 0,
    balance: walletBal,
  });

  for (let d = 15; d <= 17; d++) {
    walletBal -= 100;
    walletTxns.push({
      date: new Date(y, m, d),
      narration: "UPI GENERAL STORE",
      debit: 100,
      credit: 0,
      balance: walletBal,
    });
  }
}

const resWallet = analyze(walletTxns);
assert.notStrictEqual(
  resWallet.verdict,
  "Strong",
  `Wallet-heavy case must NOT be Strong, got: ${resWallet.verdict} (Score: ${resWallet.score})`
);
assert.ok(
  resWallet.score < 75,
  `Wallet-heavy case score must be < 75, got ${resWallet.score}`
);
assert.ok(
  resWallet.wallet.walletPctOfCredit > 30 || resWallet.wallet.walletPctOfDebit > 30,
  "Wallet % of credit or debit should be > 30%"
);
assert.ok(
  resWallet.reasons.some((r) => r.text.includes("High wallet rotation")),
  "Must include 'High wallet rotation' reason"
);

// ==========================================
// Tests for lib/loanCheck.ts ("Naya loan check")
// ==========================================

// 1. calcEmi(500000, 14, 60) ≈ 11634 (±2)
const testEmi = calcEmi(500000, 14, 60);
assert.ok(
  Math.abs(testEmi - 11634) <= 2,
  `calcEmi(500000, 14, 60) expected approx 11634 (±2), got ${testEmi}`
);

// 2. avgSalary 40587, monthlyEmi 15994, amount 500000, 14%, 60 months: newFoir ≈ 68, status "Fail"
const loanCheckFail = checkNewLoan({
  avgSalary: 40587,
  monthlyEmi: 15994,
  amount: 500000,
  ratePct: 14,
  tenureMonths: 60,
});
assert.ok(loanCheckFail !== null, "checkNewLoan should return result for valid input");
assert.ok(
  Math.abs(loanCheckFail.newFoir - 68) <= 1,
  `Expected newFoir approx 68, got ${loanCheckFail.newFoir}`
);
assert.strictEqual(
  loanCheckFail.status,
  "Fail",
  `Expected status 'Fail', got ${loanCheckFail.status}`
);

// 3. avgSalary 60000, monthlyEmi 10000, amount 200000, 14%, 36 months: status "Pass"
const loanCheckPass = checkNewLoan({
  avgSalary: 60000,
  monthlyEmi: 10000,
  amount: 200000,
  ratePct: 14,
  tenureMonths: 36,
});
assert.ok(loanCheckPass !== null);
assert.strictEqual(
  loanCheckPass.status,
  "Pass",
  `Expected status 'Pass', got ${loanCheckPass.status}`
);

// 4. maxLoanForEmi(calcEmi(500000, 14, 60), 14, 60) is around 500000 (slightly less due to floor 1000)
const calculatedEmi = calcEmi(500000, 14, 60);
const maxLoanRecovered = maxLoanForEmi(calculatedEmi, 14, 60);
assert.ok(
  maxLoanRecovered >= 498000 && maxLoanRecovered <= 500000,
  `Expected maxLoanRecovered around 500000, got ${maxLoanRecovered}`
);

// 5. avgSalary 0 or amount 0 returns null
assert.strictEqual(
  checkNewLoan({
    avgSalary: 0,
    monthlyEmi: 10000,
    amount: 500000,
    ratePct: 14,
    tenureMonths: 60,
  }),
  null,
  "avgSalary 0 must return null"
);
assert.strictEqual(
  checkNewLoan({
    avgSalary: 50000,
    monthlyEmi: 10000,
    amount: 0,
    ratePct: 14,
    tenureMonths: 60,
  }),
  null,
  "amount 0 must return null"
);
assert.strictEqual(
  checkNewLoan({
    avgSalary: 50000,
    monthlyEmi: 10000,
    amount: -10000,
    ratePct: 14,
    tenureMonths: 60,
  }),
  null,
  "negative amount must return null"
);

// ==========================================
// Tests for lib/salary.ts (Robust Salary Detection)
// ==========================================

// 1. Narration contains "Salary Transfer", 6 months: method "keyword", months 6
const txnsKeyword: Txn[] = [];
for (let m = 0; m < 6; m++) {
  txnsKeyword.push({
    date: new Date(2026, m, 1),
    narration: "NEFT Salary Transfer From TechCorp",
    credit: 50000,
    debit: 0,
    balance: 50000 * (m + 1),
  });
}
const resSal1 = detectSalary(txnsKeyword);
assert.strictEqual(resSal1.method, "keyword");
assert.strictEqual(resSal1.months, 6);
assert.strictEqual(resSal1.avgSalary, 50000);

// 2. Narration contains only "NEFT/CITIN123/ACME PVT LTD/CITI BANK/9871/26", one credit per month, amount ~40k: method "recurring", months 6
const txnsRecurring: Txn[] = [];
for (let m = 0; m < 6; m++) {
  txnsRecurring.push({
    date: new Date(2026, m, 1),
    narration: "NEFT/CITIN123/ACME PVT LTD/CITI BANK/9871/26",
    credit: 40000,
    debit: 0,
    balance: 40000 * (m + 1),
  });
}
const resSal2 = detectSalary(txnsRecurring);
assert.strictEqual(resSal2.method, "recurring");
assert.strictEqual(resSal2.months, 6);
assert.strictEqual(resSal2.avgSalary, 40000);

// 3. In one month, same sender sends 40000 and 1950: that month's salary is 40000, not 41950
const txnsDedupe: Txn[] = [
  {
    date: new Date(2026, 0, 1),
    narration: "NEFT/CITIN123/ACME PVT LTD/CITI BANK/9871/26",
    credit: 40000,
    debit: 0,
    balance: 40000,
  },
  {
    date: new Date(2026, 0, 15),
    narration: "NEFT/CITIN123/ACME PVT LTD/CITI BANK/9871/26",
    credit: 1950,
    debit: 0,
    balance: 41950,
  },
  {
    date: new Date(2026, 1, 1),
    narration: "NEFT/CITIN123/ACME PVT LTD/CITI BANK/9871/26",
    credit: 40000,
    debit: 0,
    balance: 81950,
  },
];
const resSal3 = detectSalary(txnsDedupe);
assert.strictEqual(resSal3.months, 2);
assert.strictEqual(resSal3.avgSalary, 40000);
assert.strictEqual(resSal3.credits[0].amount, 40000);

// 4. Different random senders with no recurring pattern: method "none"
const txnsRandom: Txn[] = [
  { date: new Date(2026, 0, 1), narration: "NEFT/1/ALPHA CORP/BANK/1", credit: 20000, debit: 0, balance: 20000 },
  { date: new Date(2026, 1, 1), narration: "NEFT/2/BETA INC/BANK/2", credit: 30000, debit: 0, balance: 50000 },
  { date: new Date(2026, 2, 1), narration: "NEFT/3/GAMMA LTD/BANK/3", credit: 15000, debit: 0, balance: 65000 },
  { date: new Date(2026, 3, 1), narration: "NEFT/4/DELTA CO/BANK/4", credit: 25000, debit: 0, balance: 90000 },
];
const resSal4 = detectSalary(txnsRandom);
assert.strictEqual(resSal4.method, "none");
assert.strictEqual(resSal4.months, 0);
assert.strictEqual(resSal4.avgSalary, 0);

// 5. UPI/P2A credits (even 16,000) are never detected as salary
const txnsUpi: Txn[] = [];
for (let m = 0; m < 6; m++) {
  txnsUpi.push({
    date: new Date(2026, m, 1),
    narration: "UPI/P2A/12345/Naveen/Canara Bank/16000",
    credit: 16000,
    debit: 0,
    balance: 16000 * (m + 1),
  });
}
const resSal5 = detectSalary(txnsUpi);
assert.strictEqual(resSal5.method, "none");
assert.strictEqual(resSal5.credits.length, 0);

// 6. When holderName is "NAVEEN DHAMA" and narration contains "NAVEEN DHAMA", it is excluded
const txnsSelf: Txn[] = [];
for (let m = 0; m < 6; m++) {
  txnsSelf.push({
    date: new Date(2026, m, 1),
    narration: "NEFT/CITIN123/NAVEEN DHAMA/CANARA BANK/40000",
    credit: 40000,
    debit: 0,
    balance: 40000 * (m + 1),
  });
}
const resSal6 = detectSalary(txnsSelf, "NAVEEN DHAMA");
assert.strictEqual(resSal6.method, "none");
assert.strictEqual(resSal6.credits.length, 0);

// ==========================================
// Tests for lib/otherCredits.ts (Non-Salary Inflow Categorization)
// ==========================================
const testSalaryCredits: SalaryCredit[] = [];
const allRealTxns: Txn[] = [];
let runBal = 5000;

for (let m = 0; m < 6; m++) {
  const d = new Date(2026, m, 1);
  const sc: SalaryCredit = {
    date: d,
    amount: 40000,
    narration: "NEFT/CITIN111/HCL TECHNOLOGIES LTD/SALARY",
    reason: "keyword",
  };
  testSalaryCredits.push(sc);
  runBal += 40000;
  allRealTxns.push({
    date: d,
    credit: 40000,
    debit: 0,
    balance: runBal,
    narration: "NEFT/CITIN111/HCL TECHNOLOGIES LTD/SALARY",
  });
}

// 1. Add 94914 NEFT ("HINDUSTAN INSTRUMENTS LTD ... LDISB")
runBal += 94914;
allRealTxns.push({
  date: new Date(2026, 2, 10),
  credit: 94914,
  debit: 0,
  balance: runBal,
  narration: "NEFT/PUNB123/HINDUSTAN INSTRUMENTS LTD/AXIS/LDISB",
});

// 2. Add 4x 16000 UPI/P2A credits "NAVEEN D/CNRB"
for (let m = 1; m <= 4; m++) {
  runBal += 16000;
  allRealTxns.push({
    date: new Date(2026, m, 12),
    credit: 16000,
    debit: 0,
    balance: runBal,
    narration: "UPI/P2A/512345/NAVEEN D/CNRB/CANARA BANK",
  });
}

// 3. Add 4345 "CREDIT BALANCE REFUND"
runBal += 4345;
allRealTxns.push({
  date: new Date(2026, 4, 18),
  credit: 4345,
  debit: 0,
  balance: runBal,
  narration: "CREDIT BALANCE REFUND ON CARD",
});

const otherSummary = summarizeOtherCredits(
  allRealTxns,
  testSalaryCredits,
  "NAVEEN DHAMA",
  40000
);

// Test 1: 94914 credit is LOAN_LIKE, risk "high", and at the very top of items
assert.strictEqual(otherSummary.items[0].amount, 94914);
assert.strictEqual(otherSummary.items[0].category, "LOAN_LIKE");
assert.strictEqual(otherSummary.items[0].risk, "high");

// Test 2: 16000 UPI/P2A credit with holderName "NAVEEN DHAMA" is SELF_TRANSFER
const selfItems = otherSummary.items.filter((i) => i.amount === 16000);
assert.strictEqual(selfItems.length, 4);
for (const item of selfItems) {
  assert.strictEqual(item.category, "SELF_TRANSFER");
  assert.strictEqual(item.risk, "medium");
}

// Test 3: "CREDIT BALANCE REFUND" 4345 is REFUND, risk "low"
const refundItem = otherSummary.items.find((i) => i.amount === 4345);
assert.ok(refundItem !== undefined);
assert.strictEqual(refundItem?.category, "REFUND");
assert.strictEqual(refundItem?.risk, "low");

// Test 4: Salary credits never appear in otherCredits.items
for (const sc of testSalaryCredits) {
  assert.ok(
    !otherSummary.items.some(
      (item) => item.amount === sc.amount && item.narration === sc.narration
    )
  );
}

// Test 5: pctOfTotalCredit + salaryPct = 100
assert.strictEqual(
  Math.round((otherSummary.pctOfTotalCredit + otherSummary.salaryPct) * 100) / 100,
  100
);

// Test 6: salaryPct is approximately < 66% on this real-style data
assert.ok(
  otherSummary.salaryPct < 66,
  `Expected salaryPct < 66%, got ${otherSummary.salaryPct}%`
);

// ==========================================
// Tests for lib/accountInfo.ts (Account & Client Profile Extraction)
// ==========================================
const sampleHeaderLines = [
  "Statement of Transactions in Saving Account no. 142001517582 in INR for the period April 8, 2026 - October 8, 2026",
  "RAJESHWARI M N Your Base Branch: ICICI BANK LIMITED,",
  "19,WARD NO -6 3RD MAIN 1ST,CROSS, 1659,10TH MAIN,HAL 3RD STAGE,, JEEVAN",
  "BEHIND OM SHAKTI,TEMPLE,HOSAPALYA BOMMANAHALL BIMA NAGAR, MAIN ROAD,, BANGALORE",
  "URBAN DIST., BANGALORE, KA, IN, 560075",
  "KARNATAKA - INDIA - 560068",
  "RTGS/NEFT IFSC : ICIC0001420",
];

const sampleTxnsForInfo: Txn[] = [
  {
    date: new Date(2026, 3, 10),
    credit: 0,
    debit: 23097,
    balance: 91783.9,
    narration: "ACH/CANFINHOMES",
  },
  {
    date: new Date(2026, 9, 8),
    credit: 166071,
    debit: 0,
    balance: 166162.25,
    narration: "QUESS CORP LIMITED",
  },
];

const parsedAccountInfo = extractAccountInfo(sampleHeaderLines, sampleTxnsForInfo);

// Test 1: Bank name identified
assert.strictEqual(parsedAccountInfo.bankName, "ICICI Bank");

// Test 2: Account number identified
assert.strictEqual(parsedAccountInfo.accountNumber, "142001517582");

// Test 3: Account type identified
assert.strictEqual(parsedAccountInfo.accountType, "Savings Account");

// Test 4: Holder name extracted from header
assert.strictEqual(parsedAccountInfo.holderName, "RAJESHWARI M N");

// Test 5: IFSC code extracted
assert.strictEqual(parsedAccountInfo.ifsc, "ICIC0001420");

// Test 6: Closing balance and opening balance
assert.strictEqual(parsedAccountInfo.closingBalance, 166162.25);
assert.strictEqual(parsedAccountInfo.openingBalance, 114880.9);

// Test 7: User override takes priority
const overriddenInfo = extractAccountInfo(sampleHeaderLines, sampleTxnsForInfo, "Custom User Name");
assert.strictEqual(overriddenInfo.holderName, "Custom User Name");

// ==========================================
// Test 10: AI Layer graceful fallback when GEMINI_API_KEY is not configured
// ==========================================
const sampleAnalysis = analyze(sampleTxnsForInfo);
const aiResultWithoutKey = await generateAiAssessment({
  accountInfo: parsedAccountInfo,
  analysis: sampleAnalysis,
});
assert.strictEqual(aiResultWithoutKey.enabled, false);

// ==========================================
// Tests for PNB ONE Profile, 1-Decimal Amounts, Remarks Centering, Legend Filtering, and Keyword Rules
// ==========================================

// --- PNB Test 1, 2, 3: Row-based fixture with 1-decimal amounts, remarks above anchor, and legend filtering ---
const fakePnbRows: Row[] = [
  // Header page 1
  { text: "PUNJAB NATIONAL BANK", y: 820, page: 1 },
  { text: "Statement of Account - Generated through PNB ONE", y: 805, page: 1 },
  { text: "Date | Instrument ID | Amount(INR) | Type | Balance | Remarks", y: 780, page: 1 },

  // Transaction A (Newer: 22/10/2026): 1-decimal amount 700.0 DR 1654.93
  // Remarks first line is ABOVE numbers row (y=745), numbers anchor row (y=735), remarks line below (y=725)
  { text: "UPI/DR/165240394537/Axis", y: 745, page: 1 },
  { text: "22/10/2026 700.0 DR 1654.93 Ban/UTIB/billpay.axb@upi/", y: 735, page: 1 },
  { text: "Electricity payment", y: 725, page: 1 },

  // Transaction B (Older: 20/10/2026): 1-decimal amount 9.7 DR
  // Narration above (y=675), anchor (y=665)
  { text: "Consolidated SMS charges for Q2", y: 675, page: 1 },
  { text: "20/10/2026 9.7 DR 2354.93 SMS Charges", y: 665, page: 1 },

  // Page 1 footer
  { text: "Date: 22/10/2026 17:47:62 Page 1", y: 40, page: 1 },

  // Page 2 header
  { text: "Date | Instrument ID | Amount(INR) | Type | Balance | Remarks", y: 800, page: 2 },

  // Transaction C (Oldest: 18/10/2026): 0.0 or normal amount on last page
  { text: "Interest credit for savings", y: 755, page: 2 },
  { text: "18/10/2026 50.0 CR 2364.63 CR INT", y: 745, page: 2 },

  // Last page footer & Legend
  { text: "Date: 22/10/2026 17:47:62 Page 2", y: 60, page: 2 },
  { text: "***Generated through PNB ONE***", y: 45, page: 2 },
  { text: "● Abbreviations / Legend: DR: Debit, CR: Credit, Entries in loan accounts", y: 30, page: 2 },
  { text: "loan accounts summary and recovery details", y: 15, page: 2 },
];

const pnbDebugResult = parseStatementWithDebug(fakePnbRows);
assert.strictEqual(pnbDebugResult.profile, "pnb", "Statement format must be detected as 'pnb'");
assert.strictEqual(pnbDebugResult.anchorsCount, 3, "Expected 3 anchors detected");
assert.strictEqual(pnbDebugResult.txns.length, 3, "Expected 3 transactions parsed");

// Sort check: date ascending (chronological order)
const [oldestTxn, middleTxn, newestTxn] = pnbDebugResult.txns;

// 1. Check 1-decimal amounts parsed properly
// Transaction B (20/10/2026): 9.7 debit, balance 2354.93
assert.strictEqual(middleTxn.debit, 9.7, "Expected 9.7 debit parsed correctly for 1-decimal amount");
assert.strictEqual(middleTxn.credit, 0);
assert.strictEqual(middleTxn.balance, 2354.93, "Expected balance 2354.93");

// Transaction A (22/10/2026): 700.0 debit, balance 1654.93
assert.strictEqual(newestTxn.debit, 700.0, "Expected 700.0 debit parsed correctly for 1-decimal amount");
assert.strictEqual(newestTxn.credit, 0);
assert.strictEqual(newestTxn.balance, 1654.93, "Expected balance 1654.93");

// Oldest txn (18/10/2026): 50.0 credit
assert.strictEqual(oldestTxn.credit, 50.0, "Oldest row on last page must be included");
assert.strictEqual(oldestTxn.balance, 2364.63);

// 2. Remarks ordering: remarks line above anchor (y=745) + anchor inline remarks (y=735) + remarks below (y=725)
// Sorted by y descending: line above -> anchor inline -> line below
assert.strictEqual(
  newestTxn.narration,
  "UPI/DR/165240394537/Axis Ban/UTIB/billpay.axb@upi/ Electricity payment",
  `Remarks above anchor must precede anchor remarks. Got: ${newestTxn.narration}`
);

// 3. Legend lines ("loan accounts", "***Generated through PNB ONE***", bullet "●") must be suppressed
for (const t of pnbDebugResult.txns) {
  assert.ok(
    !t.narration.toLowerCase().includes("loan accounts"),
    `Narration must not contain legend text 'loan accounts', found in: ${t.narration}`
  );
  assert.ok(
    !t.narration.includes("***Generated"),
    `Narration must not contain '***Generated', found in: ${t.narration}`
  );
  assert.ok(
    !t.narration.includes("●"),
    `Narration must not contain bullet '●', found in: ${t.narration}`
  );
}

// --- Test 4: 3 months of "NEFT_IN ... TREASURY" 42080 credit: salary detect ho (method "keyword") ---
const treasuryTxns: Txn[] = [
  {
    date: new Date(2026, 6, 31),
    narration: "NEFT_IN:BARASAT - I TREASURY, WE/WBP12345/SAL",
    credit: 42080,
    debit: 0,
    balance: 50000,
  },
  {
    date: new Date(2026, 7, 31),
    narration: "NEFT_IN:BARASAT - I TREASURY, WE/WBP12346",
    credit: 42080,
    debit: 0,
    balance: 60000,
  },
  {
    date: new Date(2026, 8, 30),
    narration: "NEFT_IN:BARASAT - I TREASURY, WE/WBP12347",
    credit: 42080,
    debit: 0,
    balance: 70000,
  },
  // Arrears credit outside median +/- 40% (75000 vs 42080 median)
  {
    date: new Date(2026, 8, 10),
    narration: "NEFT_IN:BARASAT - I TREASURY, WE/ARREARS",
    credit: 75000,
    debit: 0,
    balance: 145000,
  },
];

const treasurySalary = detectSalary(treasuryTxns);
assert.strictEqual(treasurySalary.method, "keyword", "Method must be keyword due to TREASURY keyword");
assert.strictEqual(treasurySalary.months, 3, "Expected 3 months of regular salary");
assert.strictEqual(treasurySalary.avgSalary, 42080, "Expected avgSalary 42080");
assert.ok(treasurySalary.extraCredits && treasurySalary.extraCredits.length === 1, "Expected 1 extra credit outside +/- 40%");
assert.strictEqual(treasurySalary.extraCredits![0].amount, 75000, "Arrears credit of 75000 must be in extraCredits");

// --- Test 5: "BY CASH", "ATM DEP", "BNADEP" credits counted in cashPct ---
const cashTxns: Txn[] = [
  { date: new Date(2026, 0, 5), narration: "BY CASH DEPOSIT AT BRANCH", credit: 10000, debit: 0, balance: 10000 },
  { date: new Date(2026, 0, 10), narration: "ATM DEP MACHINE CASH", credit: 5000, debit: 0, balance: 15000 },
  { date: new Date(2026, 0, 15), narration: "BNADEP CASH INWARD", credit: 5000, debit: 0, balance: 20000 },
  { date: new Date(2026, 0, 20), narration: "UPI TRANSFER IN", credit: 20000, debit: 0, balance: 40000 },
];
// Pad to 15 txns across 3 months for analyze
for (let i = 1; i <= 12; i++) {
  cashTxns.push({
    date: new Date(2026, Math.floor(i / 5), (i % 25) + 1),
    narration: "UPI GROCERY STORE",
    debit: 500,
    credit: 0,
    balance: 40000 - i * 500,
  });
}
const cashAnalysis = analyze(cashTxns);
// Cash credits = 10000 + 5000 + 5000 = 20000; Total credits = 40000 -> cashPct = 50%
assert.strictEqual(cashAnalysis.cashPct, 50, `Expected cashPct to be 50%, got ${cashAnalysis.cashPct}%`);

// --- Test 6: Bounces & EMI & Insurance keyword distinctions ---
// Bounce keywords: ACH RTN--05-10-2026
assert.ok(BOUNCE_RE.test("ACH RTN--05-10-2026"), "ACH RTN--05-10-2026 must match BOUNCE_RE");
assert.ok(BOUNCE_RE.test("ECSRTN123456"), "ECSRTN must match BOUNCE_RE");
assert.ok(BOUNCE_RE.test("NACH RTN RETURN"), "NACH RTN must match BOUNCE_RE");

// EMI vs Insurance:
// ACH/LIC OF INDIA is NOT EMI
assert.strictEqual(isObligationDebit("ACH/LIC OF INDIA"), false, "ACH/LIC OF INDIA must NOT be treated as EMI");
assert.strictEqual(isObligationDebit("ACH/STAR HEALTH INSURANCE"), false, "ACH/STAR HEALTH INSURANCE must NOT be treated as EMI");
// ACH/BAJAJ FINANCE LTD is EMI
assert.ok(isObligationDebit("ACH/BAJAJ FINANCE LTD"), "ACH/BAJAJ FINANCE LTD must be treated as EMI");
// Compound lender name without boundary: HDBFINANCIALSERLTD
assert.ok(isObligationDebit("HDBFINANCIALSERLTD/LOAN"), "HDBFINANCIALSERLTD must be treated as EMI");
// Loan-account transfer pattern: TO123456NA123456
assert.ok(isObligationDebit("TRF TO123456NA12345678 FOR LOAN"), "TO\\d{6}N[A-Z]\\d{6,} must be treated as EMI");
// Pure "ACH/" is not EMI
assert.strictEqual(isObligationDebit("ACH/9876543210"), false, "Plain ACH/ without lender must NOT be treated as EMI");

// Wallet keywords: MBK, MOBIKWIK, ONE MOBI, MBKCCBP, MBKWALLETADD
assert.ok(WALLET_RE.test("UPI/MBKWALLETADD/123"), "MBKWALLETADD must match WALLET_RE");
assert.ok(WALLET_RE.test("PG/MBKCCBP/BILL"), "MBKCCBP must match WALLET_RE");
assert.ok(WALLET_RE.test("ONE MOBI DIGITAL"), "ONE MOBI must match WALLET_RE");

// Insurance premium tracked in AnalysisResult
const insuranceTxns: Txn[] = [
  { date: new Date(2026, 0, 5), narration: "ACH/LIC OF INDIA", debit: 4500, credit: 0, balance: 10000 },
  { date: new Date(2026, 0, 10), narration: "STAR HEALTH INSURANCE PREMIUM", debit: 3500, credit: 0, balance: 6500 },
  { date: new Date(2026, 0, 15), narration: "SALARY CREDIT TECH CORP", debit: 0, credit: 50000, balance: 56500 },
];
for (let i = 1; i <= 13; i++) {
  insuranceTxns.push({
    date: new Date(2026, Math.floor(i / 5), (i % 25) + 1),
    narration: "GROCERY EXPENSE",
    debit: 200,
    credit: 0,
    balance: 50000 - i * 200,
  });
}
const insAnalysis = analyze(insuranceTxns);
assert.strictEqual(insAnalysis.insurancePayments, 8000, `Expected insurancePayments 8000, got ${insAnalysis.insurancePayments}`);
assert.strictEqual(insAnalysis.monthlyEmi, 0, "Insurance payments must not count towards monthlyEmi");

// --- Test 7: Self-transfer detection with token prefix match (min 5 chars) ---
assert.ok(isSelfTransfer("UPI/JOYDEEP/AXIS", "JOYDEEP BANERJEE"), "Full first name match must detect self-transfer");
assert.ok(isSelfTransfer("UPI/Mr JOYDE/HDFC", "JOYDEEP BANERJEE"), "Truncated 5-char prefix JOYDE must detect self-transfer");
assert.strictEqual(isSelfTransfer("UPI/RAMESH/HDFC", "JOYDEEP BANERJEE"), false, "Different name must NOT detect self-transfer");

console.log(
  "All unit test assertions (Axis fixture + PNB ONE tests + 4 scenarios + 5 loanCheck tests + 6 salary tests + 6 otherCredits tests + 7 accountInfo tests + AI fallback test) passed successfully!"
);
