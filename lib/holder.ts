// lib/holder.ts
// Auto-extraction of account holder name from statement headers
// Pure function, deterministic and testable.

import { extractProfile } from "./profile.ts";

const EXCLUDE_KEYWORDS_RE =
  /\b(?:BANK|BRANCH|STATEMENT|ACCOUNT|IFSC|ROAD|NAGAR|STREET|AVENUE|LANE|MARG|COLONY|SECTOR|BLOCK|FLOOR|HOUSE|BUILDING|INDIA|LIMITED|LTD|PVT|DATE|PAGE|TRANSACTION|PARTICULARS|BALANCE|CR|DR|INR)\b/i;

/**
 * Extracts account holder name from statement headers.
 * Uses strict profile extraction first, with fallbacks for legacy bank patterns.
 */
export function extractHolderName(lines: string[]): string | undefined {
  if (!Array.isArray(lines) || lines.length === 0) {
    return undefined;
  }

  // 1. Strict profile extraction
  const profileName = extractProfile(lines).name;
  if (profileName) {
    return profileName;
  }

  const topLines = lines.slice(0, 25);

  // 2. Axis Bank Pattern: line immediately preceding "Joint Holder"
  for (let i = 0; i < topLines.length; i++) {
    const line = topLines[i].trim();
    if (/Joint\s+Holder/i.test(line)) {
      if (i > 0) {
        const prevLine = topLines[i - 1].trim();
        if (prevLine.length >= 3 && !EXCLUDE_KEYWORDS_RE.test(prevLine)) {
          return prevLine;
        }
      }
    }
  }

  // 3. Generic Pattern: first line matching ^[A-Z][A-Z .]{4,40}$ without bank/address words
  for (const line of topLines) {
    const trimmed = line.trim();
    if (/^[A-Z][A-Z .]{4,40}$/.test(trimmed)) {
      if (!EXCLUDE_KEYWORDS_RE.test(trimmed)) {
        if (/[\s.]/.test(trimmed)) {
          return trimmed;
        }
      }
    }
  }

  return undefined;
}
