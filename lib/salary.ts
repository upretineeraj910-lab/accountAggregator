// lib/salary.ts
// Robust Multi-tier Salary Detection for Indian Bank Statements
// Multi-step detection: Keyword matching -> Recurring Corporate / Employer Analysis -> Monthly Deduplication.
// Pure functions, no side effects, deterministic and unit-testable.

import type { Txn } from "./parse.ts";
import { SALARY_KW_REGEX, CORP_KEYWORDS } from "./keywords.ts";

export type SalaryCredit = {
  date: Date;
  amount: number;
  narration: string;
  reason: "keyword" | "recurring";
  isPassThrough?: boolean;
};

export type SalaryResult = {
  credits: SalaryCredit[]; // Deduplicated salary credits (highest credit per month within median +/-40%)
  avgSalary: number; // Average of per-month max credits across salary months
  months: number; // Number of months salary was received
  method: "keyword" | "recurring" | "none";
  extraCredits?: SalaryCredit[]; // Outlier credits from salary sender (e.g. arrears/reimbursements)
};

// Known bank names / routing tokens to clean from sender segments
const BANK_NAMES_RE =
  /\b(?:HDFC|ICICI|AXIS|SBI|CITI|KOTAK|CANARA|PNB|PUNB|YES|BOB|BARODA|UNION|INDIAN|FEDERAL|IDFC|INDUSIND)\w*\s*(?:BANK|BK)?\b/gi;

// UPI reference tokens (e.g. AXL6ee25..., ICI40c1..., IBLb5b43...)
const UPI_REF_RE = /\b(?:AXL|ICI|IBL|YES|SBI|HDF|PAY)[0-9a-z]{8,}\b/gi;

// Long hexadecimal hashes or alphanumeric tracking codes
const HEX_HASH_RE = /\b[0-9a-f]{6,}\b/gi;

// General routing / system transaction prefixes
const ROUTING_PREFIXES_RE =
  /\b(?:TO|FROM|BY|AT|FOR|REF|NEFT|RTGS|IMPS|CMS|INB|INF|CR|DR|TRXN|TXN|BIL|MMT|UPI|ACH|NACH|INT\.PD|INT|PD|TRANSFER|TRF|PAYMENT)\b/gi;

/**
 * Normalizes and cleans raw text strings by stripping bank names,
 * UPI ref codes, hex hashes, and system routing words.
 */
function cleanSegmentText(str: string): string {
  return str
    .replace(UPI_REF_RE, " ")
    .replace(HEX_HASH_RE, " ")
    .replace(BANK_NAMES_RE, " ")
    .replace(ROUTING_PREFIXES_RE, " ")
    .replace(/[^A-Za-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extracts a normalized company/sender name from a bank narration line.
 * Strips NEFT_IN:xxxx / UTR tokens, then selects segments with >= 60% alphabetic content.
 */
export function extractSenderKey(
  narration: string,
  holderName?: string
): string | null {
  if (!narration) return null;

  const upper = narration.toUpperCase();
  const cleanHolder = holderName ? holderName.trim().toUpperCase() : "";

  // Priority 1: Direct corporate entity pattern match
  const corpMatch = upper.match(
    /\b([A-Z0-9\s&]{3,45}\b(?:PVT\s*LTD|PRIVATE\s*LIMITED|LIMITED|LTD|CORP|CORPORATION|TECHNOLOGIES|TECH|SOLUTIONS|SERVICES|CONSULTANCY|ENTERPRISES|SYSTEMS|INDUSTRIES|HOLDINGS|VENTURES|INFOTECH|SOFTWARE|LABS|LLP|INC))\b/i
  );

  if (corpMatch) {
    let corp = cleanSegmentText(corpMatch[1]);
    if (corp.length >= 3 && (!cleanHolder || !corp.includes(cleanHolder))) {
      corp = corp.replace(/\bLTD\b/g, "LIMITED");
      return corp;
    }
  }

  // Strip NEFT_IN: tokens and UTR-style codes before segmenting
  const stripped = upper
    .replace(/\bNEFT_IN:[A-Z0-9_/-]+/gi, " ")
    .replace(/\bNEFT_IN\b/gi, " ")
    .replace(/\b[A-Z]{4}[0-9]{7,}\b/gi, " ");

  const rawSegments = stripped.split(/[/\\:;|,]+/);
  let bestCandidate: string | null = null;
  let bestScore = -1;

  for (const rawSeg of rawSegments) {
    const rawTrimmed = rawSeg.trim();
    if (rawTrimmed.length < 3) continue;

    // Check alphabet ratio: segment must have >= 60% letters among non-space characters
    const lettersCount = (rawTrimmed.match(/[A-Z]/g) || []).length;
    const nonSpaceChars = rawTrimmed.replace(/\s+/g, "").length;
    if (nonSpaceChars === 0) continue;
    const alphabetRatio = lettersCount / nonSpaceChars;
    if (alphabetRatio < 0.6) continue;

    let seg = cleanSegmentText(rawTrimmed);
    if (seg.length < 3) continue;

    // Skip segments that represent the account holder's name (beneficiary)
    if (cleanHolder && cleanHolder.length >= 3 && seg.includes(cleanHolder)) {
      continue;
    }

    let score = seg.length;
    if (CORP_KEYWORDS.test(seg)) score += 100;
    if (/TREASURY|PAYROLL|SALARY|WAGES/i.test(seg)) score += 80;

    if (score > bestScore) {
      bestScore = score;
      bestCandidate = seg;
    }
  }

  if (bestCandidate) {
    bestCandidate = bestCandidate.replace(/\bLTD\b/g, "LIMITED");
  }

  return bestCandidate;
}

/**
 * Determines the most frequent employer/sender name among detected salary credits.
 */
export function getPrimaryEmployerName(
  credits: SalaryCredit[],
  holderName?: string
): string {
  if (!credits || credits.length === 0) return "";
  const counts = new Map<string, number>();

  for (const c of credits) {
    const key = extractSenderKey(c.narration, holderName);
    if (key) {
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }

  if (counts.size === 0) {
    const cleanFirst = cleanSegmentText(credits[0].narration);
    const match = cleanFirst.match(/[A-Za-z]{3,}(?:\s+[A-Za-z]{3,})*/);
    return match ? match[0].trim() : "";
  }

  let best = "";
  let maxCount = -1;
  for (const [name, count] of counts.entries()) {
    if (count > maxCount) {
      maxCount = count;
      best = name;
    }
  }
  return best;
}

/**
 * Calculates the median of an array of numbers.
 */
function calculateMedian(numbers: number[]): number {
  if (numbers.length === 0) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Robust salary detection algorithm:
 * Step A: Explicit keyword matching (SALARY, SAL, PAYROLL, TREASURY, etc.)
 * Step B: Recurring sender / corporate employer analysis (anywhere in narration)
 * Step C: Monthly deduplication and outlier / arrears filtering (median +/- 40%)
 */
export function detectSalary(txns: Txn[], holderName?: string): SalaryResult {
  const totalMonthKeys = new Set<string>();
  for (const t of txns) {
    totalMonthKeys.add(`${t.date.getFullYear()}-${t.date.getMonth()}`);
  }

  // ----------------------------------------------------
  // Step A: Explicit Keyword Detection
  // ----------------------------------------------------
  const stepACredits: SalaryCredit[] = [];
  const stepAMonths = new Set<string>();

  for (const t of txns) {
    if (t.credit > 0 && SALARY_KW_REGEX.test(t.narration)) {
      stepACredits.push({
        date: t.date,
        amount: t.credit,
        narration: t.narration,
        reason: "keyword",
      });
      stepAMonths.add(`${t.date.getFullYear()}-${t.date.getMonth()}`);
    }
  }

  let chosenCredits: SalaryCredit[] = [];
  let chosenMethod: "keyword" | "recurring" | "none" = "none";

  if (stepAMonths.size >= 2) {
    chosenCredits = stepACredits;
    chosenMethod = "keyword";
  } else {
    // ----------------------------------------------------
    // Step B: Recurring Sender & Corporate Employer Analysis
    // ----------------------------------------------------
    const rawSenderMap = new Map<string, Txn[]>();

    for (const t of txns) {
      if (t.credit < 5000) continue;

      // Exclude obvious self-transfers
      const upper = t.narration.toUpperCase();
      if (/^(?:SELF|OWN\s+ACC|OWN\s+ACCOUNT)\b/i.test(upper)) continue;

      // Exclude personal UPI (P2A/P2P), Cash deposits, Refunds, Interest unless explicit corporate/salary keyword exists
      if (
        /\b(?:UPI\/P2A|P2A|P2P|UPI\/P2P|CDM|CASH\s*DEP|REFUND|REVERSAL|BOUNCE|INTEREST|INT\.PD)\b/i.test(
          t.narration
        ) &&
        !SALARY_KW_REGEX.test(t.narration) &&
        !CORP_KEYWORDS.test(t.narration)
      ) {
        continue;
      }

      // Check for electronic transfer protocol anywhere in narration (NEFT, RTGS, IMPS, NEFT_IN) or corporate keyword
      const hasProtocol =
        /(?:NEFT|RTGS|IMPS|NEFT_IN)/i.test(t.narration) ||
        CORP_KEYWORDS.test(t.narration);
      if (!hasProtocol) continue;

      const sKey = extractSenderKey(t.narration, holderName);
      if (!sKey) continue;

      let list = rawSenderMap.get(sKey);
      if (!list) {
        list = [];
        rawSenderMap.set(sKey, list);
      }
      list.push(t);
    }

    // Merge sender variants (e.g. "QUESS CORP" and "QUESS CORP LIMITED")
    const canonicalSenderMap = new Map<string, Txn[]>();
    const sortedKeys = Array.from(rawSenderMap.keys()).sort(
      (a, b) => b.length - a.length
    );

    for (const key of sortedKeys) {
      const txnsForKey = rawSenderMap.get(key) || [];
      let targetKey = key;
      for (const existingCanonical of canonicalSenderMap.keys()) {
        if (existingCanonical.includes(key) || key.includes(existingCanonical)) {
          targetKey =
            existingCanonical.length >= key.length ? existingCanonical : key;
          break;
        }
      }
      let existingList = canonicalSenderMap.get(targetKey);
      if (!existingList) {
        existingList = [];
        canonicalSenderMap.set(targetKey, existingList);
      }
      existingList.push(...txnsForKey);
    }

    interface SenderCandidate {
      senderKey: string;
      credits: Txn[];
      score: number;
      distinctMonths: number;
      median: number;
    }

    const candidates: SenderCandidate[] = [];

    for (const [sKey, sCredits] of canonicalSenderMap.entries()) {
      const monthlyMaxMap = new Map<string, number>();
      for (const sc of sCredits) {
        const mKey = `${sc.date.getFullYear()}-${sc.date.getMonth()}`;
        const cur = monthlyMaxMap.get(mKey) || 0;
        if (sc.credit > cur) {
          monthlyMaxMap.set(mKey, sc.credit);
        }
      }

      const distinctMonths = monthlyMaxMap.size;
      if (distinctMonths < 2) continue;

      const monthlyAmounts = Array.from(monthlyMaxMap.values());
      const median = calculateMedian(monthlyAmounts);
      if (median <= 0) continue;

      let consistentCount = 0;
      for (const amt of monthlyAmounts) {
        if (Math.abs(amt - median) / median <= 0.45) {
          consistentCount++;
        }
      }

      const isCorporate = CORP_KEYWORDS.test(sKey) || /TREASURY/i.test(sKey);
      const consistencyRatio = consistentCount / monthlyAmounts.length;

      // Senders must have either a corporate entity name or consistent amounts
      if (!isCorporate && consistencyRatio < 0.5) continue;

      let score = distinctMonths * 20;
      if (isCorporate) score += 50;
      if (consistencyRatio >= 0.6) score += 30;
      score += Math.min(50, Math.round(median / 10000));

      candidates.push({
        senderKey: sKey,
        credits: sCredits,
        score,
        distinctMonths,
        median,
      });
    }

    if (candidates.length > 0) {
      candidates.sort((a, b) => b.score - a.score);
      const winner = candidates[0];
      chosenCredits = winner.credits.map((c) => ({
        date: c.date,
        amount: c.credit,
        narration: c.narration,
        reason: "recurring",
      }));
      chosenMethod = "recurring";
    } else if (stepACredits.length > 0) {
      chosenCredits = stepACredits;
      chosenMethod = "keyword";
    }
  }

  // ----------------------------------------------------
  // Step C: Per-Month Deduplication & Outlier Filtering
  // ----------------------------------------------------
  if (chosenCredits.length === 0) {
    return {
      credits: [],
      avgSalary: 0,
      months: 0,
      method: "none",
      extraCredits: [],
    };
  }

  // Outlier / Arrears filtering: credits outside median +/- 40% are flagged as extraCredits
  const allAmounts = chosenCredits.map((c) => c.amount);
  const medianSalary = calculateMedian(allAmounts);

  const regularCredits: SalaryCredit[] = [];
  const extraCredits: SalaryCredit[] = [];

  for (const c of chosenCredits) {
    if (
      medianSalary > 0 &&
      Math.abs(c.amount - medianSalary) / medianSalary > 0.4
    ) {
      extraCredits.push(c);
    } else {
      regularCredits.push(c);
    }
  }

  const creditsToDedupe =
    regularCredits.length > 0 ? regularCredits : chosenCredits;

  const monthMap = new Map<string, SalaryCredit>();
  for (const c of creditsToDedupe) {
    const key = `${c.date.getFullYear()}-${String(c.date.getMonth() + 1).padStart(2, "0")}`;
    const existing = monthMap.get(key);
    if (!existing || c.amount > existing.amount) {
      monthMap.set(key, c);
    }
  }

  const deduplicatedCredits = Array.from(monthMap.values()).sort(
    (a, b) => a.date.getTime() - b.date.getTime()
  );

  const totalSum = deduplicatedCredits.reduce((sum, c) => sum + c.amount, 0);
  const avgSalary =
    deduplicatedCredits.length > 0
      ? Math.round((totalSum / deduplicatedCredits.length) * 100) / 100
      : 0;

  return {
    credits: deduplicatedCredits,
    avgSalary,
    months: deduplicatedCredits.length,
    method: chosenMethod,
    extraCredits,
  };
}
