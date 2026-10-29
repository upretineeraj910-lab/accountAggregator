// lib/profile.ts
// Strict extraction of Account Profile (Name, Branch, Account Number, IFSC) from statement headers
// Pure functions, deterministic, zero-dependency, unit-testable. Never logs personal data.

export interface AccountProfile {
  name?: string;
  branch?: string;
  accountNo?: string;
  ifsc?: string;
}

const EXCLUDE_WORDS_NAME_RE =
  /\b(?:BANK|BRANCH|STATEMENT|ACCOUNT|IFSC|ROAD|NAGAR|STREET|AVENUE|LANE|MARG|COLONY|SECTOR|BLOCK|FLOOR|HOUSE|BUILDING|INDIA|LIMITED|LTD|PVT|DATE|PAGE|TRANSACTION|PARTICULARS|BALANCE|CR|DR|INR|DETAILS|CUSTOMER|CITY|ADDRESS)\b/i;

const LABEL_STRIP_PREFIX_RE =
  /^(?:Details|Name|Branch|Customer|Address|City|Base|Your|Account|No|Number|Code)\b[:.-]?\s*/gi;

/**
 * Strips residual label words (Details, Name, Branch, Customer, Address, City, Base, etc.)
 * that might cling to extracted field values.
 */
export function cleanLabelRemnants(str: string): string {
  if (!str) return "";
  let cur = str.replace(/[:]+|\s*-\s*/g, " ").replace(/\s+/g, " ").trim();
  let prev = "";
  while (cur !== prev) {
    prev = cur;
    cur = cur.replace(LABEL_STRIP_PREFIX_RE, "").trim();
  }
  return cur;
}

/**
 * Validates extracted human name:
 * - Alphabets, spaces, dots only
 * - Length between 3 and 40 characters
 * - Does not contain bank/branch/address/document header keywords
 */
export function isValidName(val?: string): boolean {
  if (!val || typeof val !== "string") return false;
  const trimmed = val.trim();
  if (trimmed.length < 3 || trimmed.length > 40) return false;
  if (!/^[A-Za-z\s.]+$/.test(trimmed)) return false;
  if (EXCLUDE_WORDS_NAME_RE.test(trimmed)) return false;

  // Must not be only salutations/titles (e.g. 'MR', 'MR.')
  const withoutTitle = trimmed
    .replace(/^(?:MR|MS|MRS|DR|SH|SMT)\b\.?\s*/i, "")
    .trim();
  if (withoutTitle.length < 2) return false;

  return true;
}

/**
 * Cleans and validates branch name:
 * - Cuts off trailing header fields on the same line
 * - Strips leading label artifacts (Details, Name, Branch, etc.)
 * - Allows alphabets, spaces, dots, hyphens (2-40 characters)
 * - Must NOT start with "Details", "Name", or "Branch"
 * - Must NOT be purely exclude words
 */
export function cleanBranch(raw?: string): string | undefined {
  if (!raw || typeof raw !== "string") return undefined;

  // Cut off if adjacent headers exist on the same line
  const cut = raw.split(
    /\b(?:IFSC|MICR|Date|Account|A\/c|Tel|Phone|Email|Pin|State|Customer)\b/i
  )[0];

  let cleaned = cleanLabelRemnants(cut);
  cleaned = cleaned.replace(/[^A-Za-z\s.-]/g, " ").replace(/\s+/g, " ").trim();

  if (cleaned.length < 2 || cleaned.length > 40) return undefined;
  if (/^(?:Details|Name|Branch)\b/i.test(cleaned)) return undefined;
  if (/^(?:BANK|BRANCH|DETAILS|NAME|ADDRESS|CITY|BASE)$/i.test(cleaned)) {
    return undefined;
  }

  return cleaned;
}

/**
 * Strictly extracts Client & Account Profile from the first ~40 lines of bank statements.
 * Uses strict "Label: value" matching for PNB, Axis, ICICI, and generic formats.
 * If any field fails validation, leaves it undefined (never returns placeholder or garbage text).
 */
export function extractProfile(lines: string[]): AccountProfile {
  if (!Array.isArray(lines) || lines.length === 0) {
    return {
      name: undefined,
      branch: undefined,
      accountNo: undefined,
      ifsc: undefined,
    };
  }

  const topLines = lines.slice(0, 40);

  let name: string | undefined;
  let branch: string | undefined;
  let accountNo: string | undefined;
  let ifsc: string | undefined;

  // ----------------------------------------------------
  // 1. Name Extraction (Requires explicit label or known bank anchor)
  // ----------------------------------------------------
  for (let i = 0; i < topLines.length; i++) {
    const line = topLines[i].trim();

    // PNB & Generic labelled: Customer Name:, Name:
    const labelMatch = line.match(
      /(?:Customer\s*(?:Details\s*)?Name|Account\s*Holder(?:\s*Name)?|Account\s*Name|Primary\s*Account\s*Holder|Name\s*of\s*(?:the\s*)?Account\s*Holder)\s*[:.-]?\s*(.+)/i
    );
    if (labelMatch) {
      const cut = labelMatch[1].split(
        /\s{2,}|\t|\b(?:Account\s*No|A\/c|Date|Branch|IFSC)\b/i
      )[0];
      const candidate = cleanLabelRemnants(cut);
      if (isValidName(candidate)) {
        name = candidate;
        break;
      }
    }

    // Axis Bank anchor: line immediately preceding "Joint Holder"
    if (/Joint\s+Holder/i.test(line) && i > 0) {
      const prevLine = topLines[i - 1].trim();
      const candidate = cleanLabelRemnants(prevLine);
      if (isValidName(candidate)) {
        name = candidate;
        break;
      }
    }

    // ICICI Bank anchor: inline "<Name> Your Base Branch: <Branch>"
    const iciciInline = line.match(
      /^([A-Za-z\s.]{3,40})\s+Your\s+Base\s+Branch/i
    );
    if (iciciInline) {
      const candidate = cleanLabelRemnants(iciciInline[1]);
      if (isValidName(candidate)) {
        name = candidate;
        break;
      }
    }

    // ICICI Bank anchor: line above "Your Base Branch"
    if (/Your\s+Base\s+Branch/i.test(line) && i > 0) {
      const prevLine = topLines[i - 1].trim();
      const candidate = cleanLabelRemnants(prevLine);
      if (isValidName(candidate)) {
        name = candidate;
        break;
      }
    }
  }

  // ----------------------------------------------------
  // 2. Branch Extraction (Requires explicit branch label)
  // ----------------------------------------------------
  for (let i = 0; i < topLines.length; i++) {
    const line = topLines[i].trim();
    const branchMatch = line.match(
      /(?:Your\s*Base\s*Branch|Base\s*Branch|Branch\s*(?:Details\s*)?Name|Branch\s*Name|Branch\s*Details|Branch)\s*[:.-]?\s*(.*)/i
    );
    if (branchMatch) {
      const candidate = cleanBranch(branchMatch[1]);
      if (candidate) {
        branch = candidate;
        break;
      }
    }
  }

  // ----------------------------------------------------
  // 3. Account Number Extraction (Requires explicit account label)
  // ----------------------------------------------------
  for (const line of topLines) {
    const m =
      line.match(
        /(?:Statement\s+of\s+Axis\s+Account\s+No|Account\s*(?:no\.?|number|num)?|A\/c\s*(?:no\.?|number)?|Acct\s*No\.?)\s*[:.-]?\s*([0-9X]{9,18})\b/i
      ) ||
      line.match(
        /(?:Saving|Current|Salary|OD|Account)\s+no\.?\s*[:.-]?\s*([0-9X]{9,18})\b/i
      );
    if (m && /^[0-9X]{9,18}$/.test(m[1])) {
      accountNo = m[1];
      break;
    }
  }

  // ----------------------------------------------------
  // 4. IFSC Extraction (Requires explicit IFSC label)
  // ----------------------------------------------------
  for (const line of topLines) {
    const m = line.match(
      /(?:IFSC(?:\s*Code)?|RTGS\/NEFT\s*IFSC)\s*[:.-]?\s*([A-Z]{4}0[A-Z0-9]{6})\b/i
    );
    if (m && /^[A-Z]{4}0[A-Z0-9]{6}$/.test(m[1].toUpperCase())) {
      ifsc = m[1].toUpperCase();
      break;
    }
  }

  return { name, branch, accountNo, ifsc };
}
