// lib/profiles/pnb.ts
// Profile-specific parser for Punjab National Bank (PNB ONE) statement format
// Pure functions, deterministic, unit-testable.

import type { Row } from "../pdfText.ts";
import type { Txn } from "../parse.ts";

export const PNB_CONFIG = {
  maxFragmentDist: 18,
};

// Anchor row regex matching PNB ONE transaction row structure:
// Date (dd/mm/yyyy) | Amount (1-2 decimals) | Type (DR/CR) | Balance (1-2 decimals, optional minus) | Inline remarks
export const PNB_ANCHOR_REGEX =
  /^(\d{2}\/\d{2}\/\d{4})\s+(\d[\d,]*\.\d{1,2})\s+(DR|CR)\s+(-?\d[\d,]*\.\d{1,2})\s*(.*)$/;

// Blacklist regexes for rows that must NOT be treated as narration fragments
const BLACKLIST_PATTERNS: RegExp[] = [
  /^Date:\s*\d{2}\/\d{2}\/\d{4}/i, // Footer date/page timestamp
  /Generated through PNB/i, // PNB ONE system watermark / footer
  /^[●•]/, // Bullet legend rows
  /\bAbbreviations\b/i, // Legend header
  /Amount\s*\(INR\)/i, // Column header
  /\bInstrument\s*ID\b/i, // Column header
  /\bType\b.*\bBalance\b.*\bRemarks\b/i, // Column header
];

export interface PnbDebugInfo {
  profile: "pnb";
  anchorsCount: number;
  droppedFragmentsCount: number;
  balanceMismatchCount: number;
}

/**
 * Detects whether the extracted statement rows match the PNB ONE format.
 */
export function isPnb(rows: Row[]): boolean {
  for (const r of rows) {
    const t = r.text.toUpperCase();
    if (t.includes("PNB ONE") || t.includes("PNBONE")) {
      return true;
    }
    if (
      t.includes("AMOUNT(INR)") &&
      t.includes("REMARKS") &&
      t.includes("TYPE")
    ) {
      return true;
    }
  }
  return false;
}

interface AnchorData {
  page: number;
  y: number;
  date: Date;
  amount: number;
  type: "DR" | "CR";
  balance: number;
  inlineRemarks: string;
  fragments: Array<{ text: string; y: number }>;
}

function isBlacklisted(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  for (const pat of BLACKLIST_PATTERNS) {
    if (pat.test(trimmed)) return true;
  }
  return false;
}

/**
 * Parses PNB ONE rows into structured transactions using nearest-anchor proximity grouping.
 */
export function parsePnb(rows: Row[]): {
  txns: Txn[];
  debug: PnbDebugInfo;
} {
  const anchorsByPage = new Map<number, AnchorData[]>();
  const allAnchors: AnchorData[] = [];
  const nonAnchorRowsByPage = new Map<number, Row[]>();

  // 1. Separate anchor rows from fragment candidates
  for (const row of rows) {
    const text = row.text.trim();
    if (!text) continue;

    const match = text.match(PNB_ANCHOR_REGEX);
    if (match) {
      const dateParts = match[1].split("/");
      const day = parseInt(dateParts[0], 10);
      const month = parseInt(dateParts[1], 10) - 1;
      const year = parseInt(dateParts[2], 10);
      const date = new Date(year, month, day);

      const amount = parseFloat(match[2].replace(/,/g, ""));
      const type = match[3].toUpperCase() as "DR" | "CR";
      const balance = parseFloat(match[4].replace(/,/g, ""));
      const inlineRemarks = (match[5] || "").trim();

      const anchor: AnchorData = {
        page: row.page,
        y: row.y,
        date,
        amount,
        type,
        balance,
        inlineRemarks,
        fragments: [],
      };

      allAnchors.push(anchor);
      let pageList = anchorsByPage.get(row.page);
      if (!pageList) {
        pageList = [];
        anchorsByPage.set(row.page, pageList);
      }
      pageList.push(anchor);
    } else {
      if (!isBlacklisted(text)) {
        let pageRows = nonAnchorRowsByPage.get(row.page);
        if (!pageRows) {
          pageRows = [];
          nonAnchorRowsByPage.set(row.page, pageRows);
        }
        pageRows.push(row);
      }
    }
  }

  // 2. Assign narration fragments to the closest anchor on the same page (within MAX_DIST)
  let droppedFragmentsCount = 0;

  for (const [pageNum, fragmentRows] of nonAnchorRowsByPage.entries()) {
    const pageAnchors = anchorsByPage.get(pageNum);
    if (!pageAnchors || pageAnchors.length === 0) {
      droppedFragmentsCount += fragmentRows.length;
      continue;
    }

    for (const frag of fragmentRows) {
      let nearestAnchor: AnchorData | null = null;
      let minDistance = Infinity;

      for (const anchor of pageAnchors) {
        const dist = Math.abs(anchor.y - frag.y);
        if (dist < minDistance) {
          minDistance = dist;
          nearestAnchor = anchor;
        }
      }

      if (nearestAnchor && minDistance <= PNB_CONFIG.maxFragmentDist) {
        nearestAnchor.fragments.push({ text: frag.text, y: frag.y });
      } else {
        droppedFragmentsCount++;
      }
    }
  }

  // 3. Assemble narration for each anchor: sort fragments y descending (top to bottom)
  interface RawPnbTxn {
    date: Date;
    narration: string;
    debit: number;
    credit: number;
    balance: number;
    type: "DR" | "CR";
  }

  const rawTxns: RawPnbTxn[] = [];

  for (const anchor of allAnchors) {
    const allPieces: Array<{ text: string; y: number }> = [];
    if (anchor.inlineRemarks) {
      allPieces.push({ text: anchor.inlineRemarks, y: anchor.y });
    }
    allPieces.push(...anchor.fragments);

    // Sort y descending (in PDF coordinates, higher y = higher on physical page)
    allPieces.sort((a, b) => b.y - a.y);

    const narration = allPieces
      .map((p) => p.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    const debit = anchor.type === "DR" ? anchor.amount : 0;
    const credit = anchor.type === "CR" ? anchor.amount : 0;

    rawTxns.push({
      date: anchor.date,
      narration,
      debit,
      credit,
      balance: anchor.balance,
      type: anchor.type,
    });
  }

  // 4. Reverse to chronological order (oldest to newest) since PNB ONE is newest first
  const chronological = [...rawTxns].reverse();

  // 5. Balance difference validation (mismatches counted for debug, without altering rows)
  let balanceMismatchCount = 0;
  let previousBalance: number | null = null;

  for (const row of chronological) {
    if (previousBalance !== null) {
      const diff = Math.round((row.balance - previousBalance) * 100) / 100;
      if (row.type === "DR" && diff > 0.05) {
        balanceMismatchCount++;
      } else if (row.type === "CR" && diff < -0.05) {
        balanceMismatchCount++;
      }
    }
    previousBalance = row.balance;
  }

  const txns: Txn[] = chronological.map((r) => ({
    date: r.date,
    narration: r.narration,
    debit: r.debit,
    credit: r.credit,
    balance: r.balance,
  }));

  return {
    txns,
    debug: {
      profile: "pnb",
      anchorsCount: allAnchors.length,
      droppedFragmentsCount,
      balanceMismatchCount,
    },
  };
}
