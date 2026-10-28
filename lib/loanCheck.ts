// lib/loanCheck.ts
// Pure functions for "Naya loan check" (New Loan Eligibility & FOIR impact)
// Client-side calculations, deterministic and unit-testable.

export const LOAN_CONFIG = {
  foirLimit: 50, // Standard bank FOIR ceiling percentage
  foirBorderline: 45, // Ratios above this threshold are flagged as "Borderline"
  defaultRate: 14, // Annual interest rate percentage (% p.a.)
  defaultTenureYears: 5,
};

/**
 * Standard EMI formula: P * r * (1+r)^n / ((1+r)^n - 1)
 * r = ratePct / 12 / 100.
 * If rate is 0, principal / n.
 * Returns EMI rounded to nearest rupee.
 */
export function calcEmi(
  principal: number,
  ratePct: number,
  months: number
): number {
  if (principal <= 0 || months <= 0) return 0;
  if (ratePct <= 0) {
    return Math.round(principal / months);
  }

  const r = ratePct / 12 / 100;
  const factor = Math.pow(1 + r, months);
  const emi = (principal * r * factor) / (factor - 1);
  return Math.round(emi);
}

/**
 * Reverse EMI formula: calculates max loan amount for a given EMI.
 * P = emi * ((1+r)^n - 1) / (r * (1+r)^n)
 * If rate is 0, emi * n.
 * Round down to nearest 1000.
 */
export function maxLoanForEmi(
  emi: number,
  ratePct: number,
  months: number
): number {
  if (emi <= 0 || months <= 0) return 0;

  let principal = 0;
  if (ratePct <= 0) {
    principal = emi * months;
  } else {
    const r = ratePct / 12 / 100;
    const factor = Math.pow(1 + r, months);
    principal = (emi * (factor - 1)) / (r * factor);
  }

  // Round down to nearest 1000
  return Math.max(0, Math.floor(principal / 1000) * 1000);
}

export type LoanCheck = {
  currentFoir: number;
  newEmi: number;
  totalEmi: number;
  newFoir: number;
  status: "Pass" | "Borderline" | "Fail";
  maxEmiRoom: number; // max(0, avgSalary * foirLimit/100 - monthlyEmi)
  maxLoanAmount: number; // maxLoanForEmi(maxEmiRoom, ...)
};

/**
 * Evaluates the impact of a proposed new loan on the borrower's FOIR.
 * Returns null if input is invalid or avgSalary <= 0.
 */
export function checkNewLoan(input: {
  avgSalary: number;
  monthlyEmi: number;
  amount: number;
  ratePct: number;
  tenureMonths: number;
}): LoanCheck | null {
  const { avgSalary, monthlyEmi, amount, ratePct, tenureMonths } = input;

  if (
    typeof avgSalary !== "number" ||
    isNaN(avgSalary) ||
    avgSalary <= 0 ||
    typeof amount !== "number" ||
    isNaN(amount) ||
    amount <= 0 ||
    typeof tenureMonths !== "number" ||
    isNaN(tenureMonths) ||
    tenureMonths <= 0 ||
    typeof ratePct !== "number" ||
    isNaN(ratePct) ||
    ratePct < 0 ||
    typeof monthlyEmi !== "number" ||
    isNaN(monthlyEmi) ||
    monthlyEmi < 0
  ) {
    return null;
  }

  const currentFoir = Math.round((monthlyEmi / avgSalary) * 10000) / 100;
  const newEmi = calcEmi(amount, ratePct, tenureMonths);
  const totalEmi = monthlyEmi + newEmi;
  const newFoir = Math.round((totalEmi / avgSalary) * 10000) / 100;

  let status: "Pass" | "Borderline" | "Fail";
  if (newFoir <= LOAN_CONFIG.foirBorderline) {
    status = "Pass";
  } else if (newFoir <= LOAN_CONFIG.foirLimit) {
    status = "Borderline";
  } else {
    status = "Fail";
  }

  const maxEmiRoom = Math.max(
    0,
    Math.round(avgSalary * (LOAN_CONFIG.foirLimit / 100) - monthlyEmi)
  );
  const maxLoanAmount = maxLoanForEmi(maxEmiRoom, ratePct, tenureMonths);

  return {
    currentFoir,
    newEmi,
    totalEmi,
    newFoir,
    status,
    maxEmiRoom,
    maxLoanAmount,
  };
}
