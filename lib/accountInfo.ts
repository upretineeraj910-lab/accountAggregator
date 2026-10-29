// lib/accountInfo.ts
// Extraction of Account Holder, Account Number, IFSC, Bank Name, and Profile Information
// Pure functions, deterministic, unit-testable.

import type { Txn } from "./parse.ts";
import { extractHolderName } from "./holder.ts";
import { extractProfile } from "./profile.ts";

export interface AccountInfo {
  holderName?: string;
  accountNumber?: string;
  bankName?: string;
  ifsc?: string;
  accountType?: string;
  branch?: string;
  statementPeriod?: string;
  openingBalance?: number;
  closingBalance?: number;
}

const BANK_PATTERNS: Array<{ re: RegExp; name: string }> = [
  { re: /\bSTATE\s+BANK\s+OF\s+INDIA|SBI\b/i, name: "State Bank of India" },
  { re: /\bHDFC\s+BANK(?:\s+LIMITED|\s+LTD)?\b/i, name: "HDFC Bank" },
  { re: /\bICICI\s+BANK(?:\s+LIMITED|\s+LTD)?\b/i, name: "ICICI Bank" },
  { re: /\bAXIS\s+BANK(?:\s+LIMITED|\s+LTD)?\b/i, name: "Axis Bank" },
  { re: /\bKOTAK\s+MAHINDRA\s+BANK|KOTAK\s+BANK\b/i, name: "Kotak Mahindra Bank" },
  { re: /\bBANK\s+OF\s+BARODA|BOB\b/i, name: "Bank of Baroda" },
  { re: /\bPUNJAB\s+NATIONAL\s+BANK|PNB\b/i, name: "Punjab National Bank" },
  { re: /\bCANARA\s+BANK\b/i, name: "Canara Bank" },
  { re: /\bUNION\s+BANK\s+OF\s+INDIA|UNION\s+BANK\b/i, name: "Union Bank of India" },
  { re: /\bINDUSIND\s+BANK(?:\s+LTD)?\b/i, name: "IndusInd Bank" },
  { re: /\bYES\s+BANK(?:\s+LTD)?\b/i, name: "Yes Bank" },
  { re: /\bIDFC\s+FIRST\s+BANK|IDFC\s+BANK\b/i, name: "IDFC First Bank" },
  { re: /\bFEDERAL\s+BANK(?:\s+LTD)?\b/i, name: "Federal Bank" },
  { re: /\bINDIAN\s+BANK\b/i, name: "Indian Bank" },
  { re: /\bBANK\s+OF\s+INDIA\b/i, name: "Bank of India" },
  { re: /\bCENTRAL\s+BANK\s+OF\s+INDIA\b/i, name: "Central Bank of India" },
  { re: /\bRBL\s+BANK(?:\s+LTD)?\b/i, name: "RBL Bank" },
  { re: /\bBANDHAN\s+BANK(?:\s+LTD)?\b/i, name: "Bandhan Bank" },
  { re: /\bSTANDARD\s+CHARTERED\b/i, name: "Standard Chartered Bank" },
  { re: /\bCITIBANK|CITI\s+BANK\b/i, name: "Citibank" },
  { re: /\bHSBC(?:\s+BANK)?\b/i, name: "HSBC Bank" },
];

/**
 * Extracts account metadata (Holder Name, Account Number, IFSC, Bank Name, etc.)
 * from statement header lines and transaction summaries.
 */
export function extractAccountInfo(
  lines: string[],
  txns?: Txn[],
  userHolderName?: string
): AccountInfo {
  try {
    const profile = extractProfile(lines || []);
    const headerLines = (lines || []).slice(0, 60);

    // 1. Bank Name
    let bankName: string | undefined;
    for (const line of headerLines) {
      for (const b of BANK_PATTERNS) {
        if (b.re.test(line)) {
          bankName = b.name;
          break;
        }
      }
      if (bankName) break;
    }

    // 2. Account Number
    let accountNumber = profile.accountNo;
    if (!accountNumber) {
      for (const line of headerLines) {
        const m =
          line.match(
            /(?:Statement\s+of\s+Axis\s+Account\s+No|Account\s*(?:no\.?|number|num)?|A\/c\s*(?:no\.?|number)?|Acct\s*No\.?)\s*[:.-]?\s*([0-9X]{9,18})\b/i
          ) ||
          line.match(
            /(?:Saving|Current|Salary|OD|Account)\s+no\.?\s*[:.-]?\s*([0-9X]{9,18})\b/i
          );
        if (m && /^[0-9X]{9,18}$/.test(m[1])) {
          accountNumber = m[1];
          break;
        }
      }
    }

    // 3. Holder Name (Prioritizes user input if provided, otherwise extracts from strict profile)
    let holderName =
      typeof userHolderName === "string" && userHolderName.trim().length > 0
        ? userHolderName.trim()
        : profile.name || extractHolderName(lines);

    // 4. IFSC Code
    let ifsc = profile.ifsc;
    if (!ifsc) {
      for (const line of headerLines) {
        const explicitMatch = line.match(
          /(?:IFSC(?:\s*Code)?|RTGS\/NEFT\s*IFSC)\s*[:.-]?\s*([A-Z]{4}0[A-Z0-9]{6})\b/i
        );
        if (
          explicitMatch &&
          /^[A-Z]{4}0[A-Z0-9]{6}$/.test(explicitMatch[1].toUpperCase())
        ) {
          ifsc = explicitMatch[1].toUpperCase();
          break;
        }
      }
    }

    // 5. Account Type
    let accountType: string | undefined;
    for (const line of headerLines) {
      const m = line.match(
        /\b(Saving(?:s)?\s+Account|Current\s+Account|Salary\s+Account|Overdraft(?:\s+Account)?|OD\s+Account|Cash\s+Credit(?:\s+Account)?|CC\s+Account)\b/i
      );
      if (m) {
        const raw = m[1].toLowerCase();
        if (raw.includes("saving")) accountType = "Savings Account";
        else if (raw.includes("current")) accountType = "Current Account";
        else if (raw.includes("salary")) accountType = "Salary Account";
        else if (raw.includes("overdraft") || raw.includes("od"))
          accountType = "Overdraft (OD)";
        else if (raw.includes("credit") || raw.includes("cc"))
          accountType = "Cash Credit (CC)";
        break;
      }
    }
    if (!accountType) accountType = "Savings Account";

    // 6. Branch / Location (strictly from profile, never garbage)
    const branch: string | undefined = profile.branch;

    // 7. Statement Period & Balances
    let statementPeriod: string | undefined;
    let openingBalance: number | undefined;
    let closingBalance: number | undefined;

    if (txns && txns.length > 0) {
      const sorted = [...txns].sort(
        (a, b) => a.date.getTime() - b.date.getTime()
      );
      const firstTx = sorted[0];
      const lastTx = sorted[sorted.length - 1];

      const startStr = firstTx.date.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      });
      const endStr = lastTx.date.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      });

      const monthDiff =
        (lastTx.date.getFullYear() - firstTx.date.getFullYear()) * 12 +
        (lastTx.date.getMonth() - firstTx.date.getMonth()) +
        1;

      statementPeriod = `${startStr} - ${endStr} (${Math.max(1, monthDiff)} Months)`;
      closingBalance = Math.round(lastTx.balance * 100) / 100;
      openingBalance =
        Math.round((firstTx.balance - firstTx.credit + firstTx.debit) * 100) /
        100;
    }

    return {
      holderName,
      accountNumber,
      bankName,
      ifsc,
      accountType,
      branch,
      statementPeriod,
      openingBalance,
      closingBalance,
    };
  } catch (err) {
    console.error("[extractAccountInfo Error]:", err);
    return {
      holderName: userHolderName,
    };
  }
}
