// lib/holder.ts
// Auto-extraction of account holder name from statement headers
// Pure function, deterministic and testable.

const EXCLUDE_KEYWORDS_RE =
  /\b(?:BANK|BRANCH|STATEMENT|ACCOUNT|IFSC|ROAD|NAGAR|STREET|AVENUE|LANE|MARG|COLONY|SECTOR|BLOCK|FLOOR|HOUSE|BUILDING|INDIA|LIMITED|LTD|PVT|DATE|PAGE|TRANSACTION|PARTICULARS|BALANCE|CR|DR|INR)\b/i;

/**
 * Extracts account holder name from the first ~25 lines of a bank statement.
 * Supports PNB ONE ("Customer Name: ..."), Axis Bank (line immediately before "Joint Holder"),
 * and generic uppercase name heuristics.
 */
export function extractHolderName(lines: string[]): string | undefined {
  if (!Array.isArray(lines) || lines.length === 0) {
    return undefined;
  }

  const topLines = lines.slice(0, 25);

  // 1. PNB Pattern: "Customer Name:\s*(.+)"
  for (const line of topLines) {
    const trimmed = line.trim();
    const pnbMatch = trimmed.match(/Customer\s*Name\s*:\s*(.+)/i);
    if (pnbMatch && pnbMatch[1]) {
      // Clean trailing multi-spaces or adjacent headers
      const candidate = pnbMatch[1]
        .split(/\s{2,}|\t|Account\s*No|A\/c|Date/i)[0]
        .trim();
      if (candidate.length >= 3) {
        return candidate;
      }
    }
  }

  // 2. Axis Bank Pattern: line immediately preceding "Joint Holder"
  for (let i = 0; i < topLines.length; i++) {
    const line = topLines[i].trim();
    if (/Joint\s+Holder/i.test(line)) {
      if (i > 0) {
        const prevLine = topLines[i - 1].trim();
        // Remove prefixes like Mr/Mrs if helpful, but keep full name
        if (prevLine.length >= 3 && !EXCLUDE_KEYWORDS_RE.test(prevLine)) {
          return prevLine;
        }
      }
    }
  }

  // 3. Generic Pattern: first line matching ^[A-Z][A-Z .]{4,40}$ without bank/address words
  for (const line of topLines) {
    const trimmed = line.trim();
    // Must be uppercase name between 4 and 40 characters
    if (/^[A-Z][A-Z .]{4,40}$/.test(trimmed)) {
      if (!EXCLUDE_KEYWORDS_RE.test(trimmed)) {
        // Also ensure it has at least one space or dot (a realistic human full name)
        if (/[\s.]/.test(trimmed)) {
          return trimmed;
        }
      }
    }
  }

  return undefined;
}
