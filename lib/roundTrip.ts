// lib/roundTrip.ts
// Pure function to detect rapid round-trip (circular rotation) transactions
// Pairs debits and credits of identical amount (>= 100) occurring on the same day or next day.

import type { Txn } from "./parse.ts";

export interface RoundTripPair {
  amount: number;
  debitDate: Date;
  creditDate: Date;
  debitNarration: string;
  creditNarration: string;
  diffDays: number;
}

export interface RoundTripResult {
  pairs: RoundTripPair[];
  count: number;
  volume: number;
  pctOfCredits: number;
  suspected: boolean;
}

/**
 * Calculates calendar days difference between two dates (|d2 - d1| in integer days).
 */
function calendarDaysDiff(d1: Date, d2: Date): number {
  const utc1 = Date.UTC(d1.getFullYear(), d1.getMonth(), d1.getDate());
  const utc2 = Date.UTC(d2.getFullYear(), d2.getMonth(), d2.getDate());
  return Math.abs(Math.floor((utc2 - utc1) / (1000 * 60 * 60 * 24)));
}

/**
 * Detects round-trip transactions: one-to-one greedy matching between equal debit and credit
 * amounts (>= 100) occurring on the same calendar day or adjacent day (diff <= 1 day).
 */
export function detectRoundTrips(
  txns: Txn[],
  totalCreditsOverride?: number
): RoundTripResult {
  if (!Array.isArray(txns) || txns.length === 0) {
    return {
      pairs: [],
      count: 0,
      volume: 0,
      pctOfCredits: 0,
      suspected: false,
    };
  }

  const debits = txns.filter((t) => t.debit >= 100);
  const credits = txns.filter((t) => t.credit >= 100);

  const matchedCreditIndices = new Set<number>();
  const pairs: RoundTripPair[] = [];

  for (const debit of debits) {
    let matchedCreditIdx = -1;

    for (let cIdx = 0; cIdx < credits.length; cIdx++) {
      if (matchedCreditIndices.has(cIdx)) continue;

      const credit = credits[cIdx];
      // Amounts must match exactly
      if (Math.round(debit.debit * 100) === Math.round(credit.credit * 100)) {
        const diff = calendarDaysDiff(debit.date, credit.date);
        if (diff <= 1) {
          matchedCreditIdx = cIdx;
          break;
        }
      }
    }

    if (matchedCreditIdx !== -1) {
      matchedCreditIndices.add(matchedCreditIdx);
      const matchedCredit = credits[matchedCreditIdx];
      pairs.push({
        amount: debit.debit,
        debitDate: debit.date,
        creditDate: matchedCredit.date,
        debitNarration: debit.narration,
        creditNarration: matchedCredit.narration,
        diffDays: calendarDaysDiff(debit.date, matchedCredit.date),
      });
    }
  }

  const totalCredits =
    typeof totalCreditsOverride === "number" && totalCreditsOverride >= 0
      ? totalCreditsOverride
      : txns.reduce((sum, t) => sum + t.credit, 0);

  const volume =
    Math.round(pairs.reduce((sum, p) => sum + p.amount, 0) * 100) / 100;
  const count = pairs.length;
  const pctOfCredits =
    totalCredits > 0
      ? Math.round((volume / totalCredits) * 10000) / 100
      : 0;

  // Suspected circular turnover if >= 5 pairs OR >= 20% of credit volume
  const suspected = count >= 5 || pctOfCredits >= 20;

  return {
    pairs,
    count,
    volume,
    pctOfCredits,
    suspected,
  };
}
