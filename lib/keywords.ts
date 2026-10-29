// lib/keywords.ts
// Centralized keyword definitions, regex patterns, and obligation classifiers
// Pure definitions, deterministic and testable.

/**
 * Keyword regex helper that matches alternatives flanked by non-alphanumeric characters or start/end of string.
 * Prevents false substring matches (e.g. 'NSE' inside 'LICENSE'), while matching '_EMI_'.
 */
export const kw = (alts: string): RegExp =>
  new RegExp(`(?<![A-Za-z0-9])(?:${alts})(?![A-Za-z0-9])`, "i");

// 1. Cash Deposits & Withdrawals
export const CASH_DEPOSIT_RE = kw(
  "CASH\\s*DEP|CDM|BY\\s*CASH|ATM\\s*DEP|BNADEP|CSH\\s*DEP|CASH\\s+DEPOSIT"
);

export const CASH_WITHDRAWAL_RE = kw(
  "UPI\\s*WDR|ATM\\s*WDL|CASH\\s*WDL|CWDR"
);

// 2. Cheque & ECS / NACH Returns & Bounces
export const BOUNCE_RE = kw(
  "RETURN|BOUNCE|CHQ\\s*RET|INSUFFICIENT|ACH\\s*RTN|ECSRTN\\d*|NACH\\s*RTN|RTN--"
);

// 3. Insurance (Information only, explicitly NOT loan obligation EMI)
export const INSURANCE_RE = kw("LIC|INSURANCE|STAR\\s*HEA");

// 4. Bill Pay & Card-like Pay Later (Informational only, explicitly NOT loan obligation EMI)
export const BILL_PAY_LATER_RE = kw(
  "BILLPAY|MBKCCBP|CCBP|AMAZON\\s*PAY\\s*LATER|AMAZONPAYLATER|OLA\\s*FIN"
);

// 5. Lender substring indicators (plain substring match to support compound lender names e.g. HDBFINANCIALSERLTD)
export const LENDER_SUBSTRING_RE =
  /(?:FINANCE|FINSERV|FINANCIAL|BAJAJ|HDB\s*FIN|FULLERTON|MUTHOOT|MANAPPURAM|TATA\s*CAPITAL)/i;

// Loan-account transfer pattern (e.g. TO123456NA123456)
export const LOAN_ACCOUNT_TRANSFER_RE = /TO\d{6}N[A-Z]\d{6,}/i;

// Base EMI keywords (Note: 'ACH/' alone is NOT included here)
export const BASE_EMI_RE = kw("EMI|NACH|ECS|LOAN");

/**
 * Determines whether a debit transaction is an active loan / EMI obligation.
 * Explicitly excludes pure insurance premiums (e.g. "ACH/LIC OF INDIA")
 * and bill pay / pay later lines (e.g. "BILLPAY", "AMAZON PAY LATER").
 */
export function isObligationDebit(narration: string): boolean {
  if (!narration) return false;
  // Pure insurance is excluded unless explicit lender substring is present
  if (INSURANCE_RE.test(narration) && !LENDER_SUBSTRING_RE.test(narration)) {
    return false;
  }
  // Bill pay / pay later is excluded from EMI unless explicit loan account transfer
  if (BILL_PAY_LATER_RE.test(narration) && !LOAN_ACCOUNT_TRANSFER_RE.test(narration)) {
    return false;
  }
  if (LENDER_SUBSTRING_RE.test(narration)) {
    return true;
  }
  if (LOAN_ACCOUNT_TRANSFER_RE.test(narration)) {
    return true;
  }
  if (BASE_EMI_RE.test(narration)) {
    return true;
  }
  return false;
}

// 6. Salary Keywords (Expanded to include Treasury, PAO, DDO, Pension, Pay & Accounts)
export const SALARY_KW_REGEX =
  /(?<![A-Za-z0-9])(?:SALARY|SAL|PAYROLL|WAGES|STIPEND|REMUNERATION|SAL[\s_/-]+(?:CR|CREDIT|TRF|TRANSFER)|SALARY[\s_/-]+(?:CR|CREDIT|TRF|TRANSFER)|MONTHLY[\s_/-]+SAL(?:ARY)?|SAL(?:ARY)?[\s_/-]+FOR|TREASURY|PAY\s*&\s*ACCOUNTS|\bPAO\b|\bDDO\b|PENSION)(?![A-Za-z0-9])/i;

// Corporate employer entity indicators
export const CORP_KEYWORDS =
  /\b(?:PVT\s*LTD|PRIVATE\s*LIMITED|LIMITED|LTD|CORP|CORPORATION|TECHNOLOGIES|TECH|SOLUTIONS|SERVICES|CONSULTANCY|ENTERPRISES|SYSTEMS|INDUSTRIES|HOLDINGS|VENTURES|INFOTECH|SOFTWARE|LABS|LLP|INC)\b/i;

// 7. Wallets & Digital PG Loaders (Expanded to include MBK, ONE MOBI, MBKCCBP, MBKWALLETADD)
export const WALLET_RE = kw(
  "PAYTM\\s+WALLET|PHONEPE\\s+WALLET|AMAZON\\s+PAY|MOBIKWIK|FREECHARGE|WALLET\\s+LOAD|ADD\\s+MONEY|PAYTM\\s+PAYMENTS\\s+BANK|PPBL|WALLET|MBK|ONE\\s*MOBI|MBKCCBP|MBKWALLETADD"
);

// 8. Instant Fintech Lending Apps
export const LOAN_APP_RE = kw(
  "KREDITBEE|MONEYVIEW|CASHE|FIBE|EARLYSALARY|NIRA|LAZYPAY|SLICE|KISSHT|STASHFIN|PAYSENSE|MONEYTAP|FLEXSALARY|ZESTMONEY|TRUECREDIT|INDIALENDS"
);

// 9. Gambling & Online Betting
export const BETTING_RE = kw("DREAM11|RUMMY|MPL|BETTING");

// 10. Stock Brokers & Depository Clearing
export const BROKER_RE = kw(
  "ZERODHA|GROWW|UPSTOX|ANGEL\\s+ONE|ANGEL\\s+BROKING|ICICI\\s*SEC|ICICIDIRECT|HDFC\\s*SEC|KOTAK\\s*SEC|5PAISA|PAYTM\\s+MONEY|SHAREKHAN|MOTILAL|NSE\\s+CLEARING|INDIAN\\s+CLEARING|ICCL|NSCCL"
);

// 11. Mutual Fund & SIP
export const MF_SIP_RE = kw(
  "BSE\\s+STAR|NSE\\s+NMF|MF\\s+UTILITIES|MUTUAL\\s+FUND|SIP|CAMS|KFIN"
);

// 12. Credit Card Bill Payments
export const CC_PAYMENT_RE = kw(
  "CRED|CREDIT\\s+CARD|CC\\s+PAYMENT|CARD\\s+PAYMENT|BILLDESK\\s+CC"
);

// 13. Loan Disbursal Indicators
export const LOAN_LIKE_RE = kw(
  "DISB|DISBURS|LDISB|LOAN\\s*CR|DISBURSEMENT|LOAN\\s+DISBURSAL"
);

// 14. Self-Transfer Indicators
export const SELF_TRANSFER_RE = kw(
  "SELF|OWN\\s+ACC|OWN\\s+ACCOUNT|SELF\\s+TRF|SELF\\s+TRANSFER"
);

// 15. Refunds & Reversals
export const REFUND_RE = kw("REFUND|REVERSAL|CASHBACK|RETURN|CHQ\\s*RET");

// 16. Bank Interest
export const INTEREST_RE = kw(
  "INT\\.?PD|INTEREST|INT\\.PAID|CR\\s+INT|SAVINGS\\s+INT"
);

// 17. Person UPI / P2A / P2P
export const UPI_RE = kw("UPI|P2A|P2P");
