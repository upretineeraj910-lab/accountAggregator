// lib/salary.ts
// Robust Multi-tier Salary Detection for Indian Bank Statements
// Multi-step detection: Keyword matching -> Recurring Corporate / Employer Analysis -> Monthly Deduplication.
// Pure functions, no side effects, deterministic and unit-testable.

import type { Txn } from "./parse.ts";
import { SALARY_KW_REGEX, CORP_KEYWORDS } from "./keywords.ts";
import { isSelfTransfer } from "./otherCredits.ts";

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

  // Strip NEFT_IN: tokens, standard IFSC codes, alphanumeric UTRs, and long numbers before segmenting
  const stripped = upper
    .replace(/\bNEFT_IN:[A-Z0-9_/-]+/gi, " ")
    .replace(/\bNEFT_IN\b/gi, " ")
    .replace(/\b[A-Z]{4}0[A-Z0-9]{6}\b/gi, " ")
    .replace(/\b(?=[A-Z0-9]*\d)[A-Z0-9]{8,}\b/gi, " ")
    .replace(/\b\d{6,}\b/g, " ");

  const rawSegments = stripped.split(/[/\\:;|,-]+/);
  let bestCandidate: string | null = null;
  let bestScore = -1;

  // Extract individual tokens from holderName (min 3 chars)
  const holderTokens = cleanHolder
    ? cleanHolder
        .replace(/\b(?:MR|MS|MRS|DR|SH|SMT)\b\.?/gi, " ")
        .replace(/[^A-Z\s]/g, " ")
        .trim()
        .split(/\s+/)
        .filter((w) => w.length >= 3)
    : [];

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

    // Discard pure salary/remark phrases from becoming the employer name
    if (
      /^(?:SALARY|SAL|PAYROLL|WAGES|REMUNERATION|MONTHLY\s*SAL(?:ARY)?)$/i.test(
        seg
      )
    ) {
      continue;
    }

    // Skip segments that represent the account holder's name (beneficiary)
    if (cleanHolder && cleanHolder.length >= 3 && seg.includes(cleanHolder)) {
      continue;
    }

    // Strip employee/holder tokens from segment if mixed with employer name
    if (holderTokens.length > 0) {
      for (const ht of holderTokens) {
        seg = seg.replace(new RegExp(`\\b${ht}\\b`, "gi"), " ");
      }
      // Also remove partial/fuzzy tokens of holder (e.g. truncated middle name like 'NDAN' from 'NANDAN')
      const words = seg.split(/\s+/);
      const filteredWords = words.filter((w) => {
        if (
          w.length >= 4 &&
          holderTokens.some((ht) => ht.includes(w) || w.includes(ht))
        ) {
          return false;
        }
        return true;
      });
      seg = filteredWords.join(" ");
      // Clean up orphan 1-2 character abbreviations
      seg = seg.replace(/\b[A-Za-z]{1,2}\b/g, " ").replace(/\s+/g, " ").trim();
    }

    if (seg.length < 3) continue;

    let score = seg.length;
    if (CORP_KEYWORDS.test(seg)) score += 100;
    if (/TREASURY/i.test(seg)) score += 80;

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
      const isCorporate = CORP_KEYWORDS.test(sKey) || /TREASURY/i.test(sKey);
      const minMonthsNeeded =
        totalMonthKeys.size === 1 && isCorporate ? 1 : 2;
      if (distinctMonths < minMonthsNeeded) continue;

      const monthlyAmounts = Array.from(monthlyMaxMap.values());
      const median = calculateMedian(monthlyAmounts);
      if (median <= 0) continue;

      let consistentCount = 0;
      for (const amt of monthlyAmounts) {
        if (Math.abs(amt - median) / median <= 0.45) {
          consistentCount++;
        }
      }

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

      // If Step A found explicit high-value corporate salary credits (>= 10,000)
      // and the recurring winner is significantly smaller (< 50% of Step A amount),
      // prioritize the explicit corporate salary credit over minor recurring transfers.
      const stepAMax =
        stepACredits.length > 0
          ? Math.max(...stepACredits.map((c) => c.amount))
          : 0;

      if (
        stepACredits.length > 0 &&
        stepAMax >= 10000 &&
        winner.median < 0.5 * stepAMax
      ) {
        chosenCredits = stepACredits;
        chosenMethod = "keyword";
      } else {
        chosenCredits = winner.credits.map((c) => ({
          date: c.date,
          amount: c.credit,
          narration: c.narration,
          reason: "recurring",
        }));
        chosenMethod = "recurring";
      }
    } else if (stepACredits.length > 0) {
      chosenCredits = stepACredits;
      chosenMethod = "keyword";
    }
  }

  // ----------------------------------------------------
  // Step B.2: Anchored Cross-Month Salary Recovery
  // If at least one genuine salary credit (>= 10,000) was identified (via keyword or recurring),
  // recover consistent electronic transfer credits in months where salary narration was abbreviated
  // or sent via a different remitting gateway/bank (e.g. IMPS Northeast Small Finance vs NEFT Pharmanovia).
  // ----------------------------------------------------
  if (chosenCredits.length > 0) {
    const anchorAmounts = chosenCredits.map((c) => c.amount);
    const anchorMedian = calculateMedian(anchorAmounts);

    if (anchorMedian >= 10000) {
      const existingSalaryMonthKeys = new Set(
        chosenCredits.map(
          (c) => `${c.date.getFullYear()}-${c.date.getMonth()}`
        )
      );

      for (const t of txns) {
        if (t.credit < 10000) continue;
        const mKey = `${t.date.getFullYear()}-${t.date.getMonth()}`;
        if (existingSalaryMonthKeys.has(mKey)) continue;

        // Must be consistent with the anchor salary (within +/- 35%)
        const diffRatio = Math.abs(t.credit - anchorMedian) / anchorMedian;
        if (diffRatio > 0.35) continue;

        // Exclude self-transfers
        if (isSelfTransfer(t.narration, holderName)) continue;

        // Exclude cash deposits, refunds, interest, reversals, bounces
        if (
          /\b(?:UPI\/P2A|P2A|P2P|UPI\/P2P|CDM|CASH\s*DEP|REFUND|REVERSAL|BOUNCE|INTEREST|INT\.PD)\b/i.test(
            t.narration
          ) &&
          !SALARY_KW_REGEX.test(t.narration) &&
          !CORP_KEYWORDS.test(t.narration)
        ) {
          continue;
        }

        // Must arrive via electronic transfer protocol or corporate/salary keywords
        const isElectronicPayroll =
          /(?:NEFT|RTGS|IMPS|NEFT_IN)/i.test(t.narration) ||
          CORP_KEYWORDS.test(t.narration) ||
          SALARY_KW_REGEX.test(t.narration);

        if (isElectronicPayroll) {
          chosenCredits.push({
            date: t.date,
            amount: t.credit,
            narration: t.narration,
            reason: "recurring",
          });
          existingSalaryMonthKeys.add(mKey);
        }
      }
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
