// lib/accountInfo.ts
// Extraction of Account Holder, Account Number, IFSC, Bank Name, and Profile Information
// Pure functions, deterministic, unit-testable.

import type { Txn } from "./parse.ts";
import { extractHolderName } from "./holder.ts";

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
  let accountNumber: string | undefined;
  for (const line of headerLines) {
    const m =
      line.match(
        /(?:Account\s*(?:no\.?|number|num)?|A\/c\s*(?:no\.?|number)?|Acct\s*No\.?)\s*[:.-]?\s*([0-9X]{9,18})\b/i
      ) ||
      line.match(
        /(?:Saving|Current|Salary|OD|Account)\s+no\.?\s*([0-9X]{9,18})\b/i
      );
    if (m) {
      accountNumber = m[1];
      break;
    }
  }

  // 3. Holder Name (Prioritizes user input if provided, otherwise extracts from statement headers)
  let holderName =
    typeof userHolderName === "string" && userHolderName.trim().length > 0
      ? userHolderName.trim()
      : undefined;

  if (!holderName) {
    holderName = extractHolderName(lines);
  }

  if (!holderName) {
    for (const line of headerLines) {
      let m = line.match(/^([A-Z\s.]{3,35})\s+Your\s+Base\s+Branch/i);
      if (!m) {
        m = line.match(
          /(?:Customer\s*Name|Account\s*Name|Name\s*of\s*(?:the\s*)?Account\s*Holder|Primary\s*Account\s*Holder|Account\s*Holder\s*Name)\s*[:.-]\s*([A-Za-z\s.]{3,40})/i
        );
      }
      if (!m) {
        m = line.match(/\b(?:MR|MS|MRS|DR|SH\.?|SMT\.?)\s+([A-Z\s.]{3,35})\b/i);
      }
      if (m) {
        const clean = m[1]
          .replace(
            /\b(?:ACCOUNT|STATEMENT|BRANCH|BANK|CUSTOMER|NO|TRANSACTION|PERIOD)\b/gi,
            ""
          )
          .replace(/[^A-Za-z\s.]/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        if (clean.length >= 3) {
          holderName = clean;
          break;
        }
      }
    }
  }

  // 4. IFSC Code
  let ifsc: string | undefined;
  for (const line of headerLines) {
    const explicitMatch = line.match(
      /(?:IFSC(?:\s*Code)?|RTGS\/NEFT\s*IFSC)\s*[:.-]?\s*([A-Z]{4}0[A-Z0-9]{6})\b/i
    );
    if (explicitMatch) {
      ifsc = explicitMatch[1].toUpperCase();
      break;
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

  // 6. Branch / Location
  let branch: string | undefined;
  for (let i = 0; i < headerLines.length; i++) {
    const line = headerLines[i];
    const m = line.match(
      /(?:Your\s*Base\s*Branch|Branch\s*Name|Branch)\s*[:.-]?\s*(.*)/i
    );
    if (m) {
      let rawBranch = m[1].trim();
      if (
        headerLines[i + 1] &&
        !headerLines[i + 1].includes("Transaction") &&
        !headerLines[i + 1].includes("Withdrawal") &&
        !headerLines[i + 1].includes("Deposit")
      ) {
        rawBranch += " " + headerLines[i + 1];
      }
      rawBranch = rawBranch
        .replace(/\b(?:Your\s*Base\s*Branch|Branch|Base\s*Branch)\b[:.-]?/gi, "")
        .replace(/[^A-Za-z0-9\s,.-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (rawBranch.length >= 4) {
        branch = rawBranch;
        break;
      }
    }
  }

  // 7. Statement Period & Balances
  let statementPeriod: string | undefined;
  let openingBalance: number | undefined;
  let closingBalance: number | undefined;

  if (txns && txns.length > 0) {
    const sorted = [...txns].sort((a, b) => a.date.getTime() - b.date.getTime());
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

    // Calculate month difference
    const monthDiff =
      (lastTx.date.getFullYear() - firstTx.date.getFullYear()) * 12 +
      (lastTx.date.getMonth() - firstTx.date.getMonth()) +
      1;

    statementPeriod = `${startStr} - ${endStr} (${Math.max(1, monthDiff)} Months)`;
    closingBalance = Math.round(lastTx.balance * 100) / 100;
    openingBalance =
      Math.round((firstTx.balance - firstTx.credit + firstTx.debit) * 100) / 100;
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
