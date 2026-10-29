// lib/parse.ts
// Step 2: Lines to transactions
// Pure function, no side effects, easily testable.

import type { Row } from "./pdfText.ts";
import { rowsToLines } from "./pdfText.ts";
import { isPnb, parsePnb } from "./profiles/pnb.ts";

export const PAGE = "<<PAGE>>";

export type Txn = {
  date: Date;
  narration: string;
  debit: number;
  credit: number;
  balance: number;
};

export interface RawRow {
  body: string;
  lead: string[];
  tail: string[];
}

const MONTH_NAMES: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

// Start of line date patterns:
// Supports optional serial number prefix (e.g. "1 ", "1. ", "100 ", "267 ")
// Supports date formats:
// 1) dd.mm.yyyy, dd/mm/yyyy, dd-mm-yyyy, dd.mm.yy, dd/mm/yy, dd-mm-yy
// 2) dd Mon yyyy, dd-Mon-yyyy, dd.Mon.yyyy, dd Mon yy, dd-Mon-yy
// 3) yyyy-mm-dd, yyyy/mm/dd, yyyy.mm.dd
export const START_DATE_REGEX =
  /^(?:(?:\d+)[\.\)]?\s+)?(?:(\d{1,2})[\s.-]+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[\s.-]+(\d{4}|\d{2})|(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})|(\d{4})[/.-](\d{1,2})[/.-](\d{1,2}))\b/i;

// Global date pattern for cleaning narrations
export const DATE_PATTERN_GLOBAL_REGEX =
  /\b(?:\d{1,2}[\s.-]+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[\s.-]+(?:\d{4}|\d{2})|\d{1,2}[/.-](\d{1,2})[/.-](\d{4}|\d{2})|\d{4}[/.-]\d{1,2}[/.-]\d{1,2})\b/gi;

// Amount regex: must require two decimals so reference numbers are not mistaken for amounts
// Uses negative lookahead and lookbehind to prevent false matching inside dot-separated dates (e.g. 10.04.2026)
export const AMOUNT_REGEX =
  /(?<![\d.])(?:\d{1,3}(?:,\d{2,3})*|\d+)\.\d{2}(?![\d.])/g;

export const STOP =
  /^(TRANSACTION TOTAL|CLOSING BALANCE|\+{2,}\s*End of Statement|Legends\s*:)/i;

export const HEADER =
  /^(Tran Date|Transaction Date|Chq No|Particulars|Debit\s+Credit|OPENING BALANCE|S No\.|Transaction Withdrawal|Date Amount|Value Date|Withdrawal Amount|Deposit Amount|Balance \(INR\))/i;

/**
 * Checks if a line starts with a supported date format (or serial number + date)
 * and returns the parsed Date object.
 */
export function extractStartDate(line: string): Date | null {
  const match = line.match(START_DATE_REGEX);
  if (!match) return null;

  if (match[1] && match[2] && match[3]) {
    // Named month: day, monthName, year
    const day = parseInt(match[1], 10);
    const monthKey = match[2].toLowerCase();
    const month = MONTH_NAMES[monthKey];
    let year = parseInt(match[3], 10);
    if (year < 100) year += 2000;

    if (day >= 1 && day <= 31 && month !== undefined) {
      return new Date(year, month, day);
    }
  } else if (match[4] && match[5] && match[6]) {
    // Numeric: day, monthNum, year (dd/mm/yyyy, dd.mm.yyyy, dd-mm-yyyy)
    const day = parseInt(match[4], 10);
    const month = parseInt(match[5], 10) - 1;
    let year = parseInt(match[6], 10);
    if (year < 100) year += 2000;

    if (day >= 1 && day <= 31 && month >= 0 && month <= 11) {
      return new Date(year, month, day);
    }
  } else if (match[7] && match[8] && match[9]) {
    // ISO format: year, monthNum, day (yyyy-mm-dd)
    const year = parseInt(match[7], 10);
    const month = parseInt(match[8], 10) - 1;
    const day = parseInt(match[9], 10);

    if (day >= 1 && day <= 31 && month >= 0 && month <= 11) {
      return new Date(year, month, day);
    }
  }

  return null;
}

/**
 * Extracts all numbers matching the two-decimal amount pattern from a string.
 */
export function extractAmounts(text: string): number[] {
  const matches = text.match(AMOUNT_REGEX);
  if (!matches) return [];
  return matches.map((m) => Number(m.replace(/,/g, "")));
}

/**
 * Checks if a narration suggests a credit transaction when balance difference is ambiguous.
 */
function isCreditKeyword(narration: string): boolean {
  return (
    /(?<![A-Za-z0-9])(?:CR|SALARY|SAL|CREDIT|DEPOSIT|REFUND)(?![A-Za-z0-9])/i.test(
      narration
    ) || /(?<![A-Za-z0-9])INT[.\s]*PD(?![A-Za-z0-9])/i.test(narration)
  );
}

/**
 * Groups lines into RawRow objects: { body, lead, tail }.
 * - Auto-detects narrationFirst mode (e.g. Axis Bank where multi-line narration precedes date).
 * - Excludes footers, totals, and legends via STOP regex until the next PAGE marker.
 * - Skips table header lines.
 */
export function groupRows(lines: string[]): {
  rows: RawRow[];
  narrationFirst: boolean;
} {
  // Mode auto-detect:
  // In Axis Bank statements, multi-line narration precedes the date and amount line,
  // starting immediately after the OPENING BALANCE row.
  let narrationFirst = false;
  let foundOpening = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^OPENING BALANCE/i.test(line)) {
      foundOpening = true;
      continue;
    }
    if (foundOpening) {
      if (line === PAGE || HEADER.test(line)) continue;
      if (!START_DATE_REGEX.test(line)) {
        narrationFirst = true;
      }
      break;
    }
  }

  const rows: RawRow[] = [];
  let inStopBlock = false;
  let pendingLead: string[] = [];
  let currentRow: RawRow | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // PAGE marker handling:
    // Reset STOP block for next page, clear pending lines
    if (line === PAGE) {
      inStopBlock = false;
      pendingLead = [];
      if (currentRow) {
        rows.push(currentRow);
        currentRow = null;
      }
      continue;
    }

    // STOP block check:
    // Once a STOP line is reached, skip all lines until next PAGE marker and clear pending lines
    if (STOP.test(line)) {
      inStopBlock = true;
      pendingLead = [];
      if (currentRow) {
        rows.push(currentRow);
        currentRow = null;
      }
      continue;
    }

    if (inStopBlock) {
      continue;
    }

    // HEADER check: skip header rows
    if (HEADER.test(line)) {
      continue;
    }

    const startsWithDate = START_DATE_REGEX.test(line);

    if (narrationFirst) {
      if (startsWithDate) {
        // In narrationFirst mode: preceding lines are lead, current date line is body
        rows.push({
          body: line,
          lead: [...pendingLead],
          tail: [],
        });
        pendingLead = [];
      } else {
        pendingLead.push(line);
      }
    } else {
      // Standard mode: date line is body, subsequent lines are tail
      if (startsWithDate) {
        if (currentRow) {
          rows.push(currentRow);
        }
        currentRow = {
          body: line,
          lead: [],
          tail: [],
        };
      } else if (currentRow) {
        currentRow.tail.push(line);
      }
    }
  }

  if (currentRow) {
    rows.push(currentRow);
  }

  return { rows, narrationFirst };
}

/**
 * Parses raw text lines into structured transactions.
 */
export function parseTxns(lines: string[]): Txn[] {
  const { rows } = groupRows(lines);

  interface IntermediateRow {
    date: Date;
    narration: string;
    txnAmount: number;
    balance: number;
  }

  const intermediateRows: IntermediateRow[] = [];

  for (const row of rows) {
    const date = extractStartDate(row.body);
    if (!date) continue;

    // Amounts are extracted strictly from row.body first.
    // Tail is read only if body contains fewer than 2 amounts.
    let amounts = extractAmounts(row.body);
    if (amounts.length < 2) {
      for (const tailLine of row.tail) {
        const tailAmounts = extractAmounts(tailLine);
        if (tailAmounts.length > 0) {
          amounts = amounts.concat(tailAmounts);
          if (amounts.length >= 2) break;
        }
      }
    }

    // Ignore rows with fewer than 2 amounts
    if (amounts.length < 2) {
      continue;
    }

    // The LAST amount is the closing balance
    const balance = amounts[amounts.length - 1];

    // The amount before it is the transaction amount.
    // Ignore zero amounts when picking the transaction amount.
    const candidateAmounts = amounts.slice(0, amounts.length - 1);
    const nonZeroAmounts = candidateAmounts.filter((amt) => amt !== 0);

    const txnAmount =
      nonZeroAmounts.length > 0
        ? nonZeroAmounts[nonZeroAmounts.length - 1]
        : candidateAmounts[candidateAmounts.length - 1];

    // Clean body by removing date patterns and amounts
    const bodyCleaned = row.body
      .replace(START_DATE_REGEX, " ")
      .replace(DATE_PATTERN_GLOBAL_REGEX, " ")
      .replace(AMOUNT_REGEX, " ")
      .replace(/^(?:\d+)[\.\)]?\s+/, " ");

    const allNarrationParts = [...row.lead, bodyCleaned, ...row.tail];
    const narration = allNarrationParts
      .join(" ")
      .replace(DATE_PATTERN_GLOBAL_REGEX, " ")
      .replace(/\s+/g, " ")
      .trim();

    intermediateRows.push({
      date,
      narration,
      txnAmount,
      balance,
    });
  }

  if (intermediateRows.length === 0) {
    return [];
  }

  // Some banks list newest first.
  // If the first row's date is later than the last row's date, reverse the rows before computing debit/credit.
  if (
    intermediateRows[0].date.getTime() >
    intermediateRows[intermediateRows.length - 1].date.getTime()
  ) {
    intermediateRows.reverse();
  }

  // Decide debit or credit from the BALANCE, not from columns:
  // difference = balance - previousBalance (round to 2 decimals).
  // If |difference| equals the amount (tolerance 0.05): positive means credit, negative means debit.
  // If it does not match (a missed row), fall back to keyword guess.
  const txns: Txn[] = [];
  let previousBalance: number | null = null;

  for (const row of intermediateRows) {
    let debit = 0;
    let credit = 0;
    const amount = Math.abs(row.txnAmount);

    if (previousBalance === null) {
      // First row: no previous balance, use keyword guess
      if (isCreditKeyword(row.narration)) {
        credit = amount;
      } else {
        debit = amount;
      }
    } else {
      const difference =
        Math.round((row.balance - previousBalance) * 100) / 100;
      const absDiff = Math.abs(difference);

      if (Math.abs(absDiff - amount) <= 0.05) {
        if (difference > 0) {
          credit = amount;
        } else if (difference < 0) {
          debit = amount;
        } else {
          // Zero difference fallback
          if (isCreditKeyword(row.narration)) {
            credit = amount;
          } else {
            debit = amount;
          }
        }
      } else {
        // Difference doesn't match amount (e.g. missed row), fallback to keyword guess
        if (isCreditKeyword(row.narration)) {
          credit = amount;
        } else {
          debit = amount;
        }
      }
    }

    previousBalance = row.balance;

    txns.push({
      date: row.date,
      narration: row.narration,
      debit,
      credit,
      balance: row.balance,
    });
  }

  return txns;
}

/**
 * Helper for debug mode: parses txns and returns the detected narrationFirst mode.
 */
export function parseTxnsWithDebug(lines: string[]): {
  txns: Txn[];
  narrationFirst: boolean;
} {
  const { narrationFirst } = groupRows(lines);
  const txns = parseTxns(lines);
  return { txns, narrationFirst };
}

export interface ParseResultWithDebug {
  txns: Txn[];
  profile: "pnb" | "axis" | "generic";
  anchorsCount: number;
  droppedFragmentsCount: number;
  balanceMismatchCount: number;
  narrationFirst: boolean;
}

/**
 * High-level parser that auto-detects statement format (e.g. PNB ONE profile)
 * and falls back to standard generic/Axis parsing path.
 */
export function parseStatement(input: Row[] | string[]): Txn[] {
  if (
    Array.isArray(input) &&
    input.length > 0 &&
    typeof input[0] === "object" &&
    "text" in input[0]
  ) {
    const rows = input as Row[];
    if (isPnb(rows)) {
      return parsePnb(rows).txns;
    }
    const lines = rowsToLines(rows);
    return parseTxns(lines);
  }
  return parseTxns(input as string[]);
}

/**
 * High-level parser with debug metadata: profile, anchorsCount, dropped fragments, and balance mismatches.
 */
export function parseStatementWithDebug(
  input: Row[] | string[]
): ParseResultWithDebug {
  if (
    Array.isArray(input) &&
    input.length > 0 &&
    typeof input[0] === "object" &&
    "text" in input[0]
  ) {
    const rows = input as Row[];
    if (isPnb(rows)) {
      const pnbResult = parsePnb(rows);
      return {
        txns: pnbResult.txns,
        profile: "pnb",
        anchorsCount: pnbResult.debug.anchorsCount,
        droppedFragmentsCount: pnbResult.debug.droppedFragmentsCount,
        balanceMismatchCount: pnbResult.debug.balanceMismatchCount,
        narrationFirst: false,
      };
    }
    const lines = rowsToLines(rows);
    const { txns, narrationFirst } = parseTxnsWithDebug(lines);
    return {
      txns,
      profile: narrationFirst ? "axis" : "generic",
      anchorsCount: txns.length,
      droppedFragmentsCount: 0,
      balanceMismatchCount: 0,
      narrationFirst,
    };
  }

  const lines = input as string[];
  const { txns, narrationFirst } = parseTxnsWithDebug(lines);
  return {
    txns,
    profile: narrationFirst ? "axis" : "generic",
    anchorsCount: txns.length,
    droppedFragmentsCount: 0,
    balanceMismatchCount: 0,
    narrationFirst,
  };
}
