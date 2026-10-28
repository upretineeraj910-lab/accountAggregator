// lib/pdfText.ts
// Step 1: PDF to lines
// Uses the legacy build of pdfjs-dist for Node.js server environment

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - pdfjs-dist legacy mjs export typings
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - in-memory worker binding for serverless environments (Vercel / AWS Lambda)
import * as pdfjsWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs";

// Ensure pdfjs uses the in-memory worker instead of attempting dynamic relative filesystem imports on Vercel
if (typeof globalThis !== "undefined" && !("pdfjsWorker" in globalThis)) {
  // @ts-ignore
  globalThis.pdfjsWorker = pdfjsWorker;
}

export const PAGE = "<<PAGE>>";

interface TextItemLike {
  str: string;
  transform: number[];
}

function isTextItem(item: unknown): item is TextItemLike {
  if (typeof item !== "object" || item === null) return false;
  const candidate = item as { str?: unknown; transform?: unknown };
  return (
    typeof candidate.str === "string" &&
    Array.isArray(candidate.transform) &&
    candidate.transform.length >= 6
  );
}

interface TextRow {
  y: number;
  items: Array<{ str: string; x: number }>;
}

/**
 * Extracts all lines of text from an in-memory PDF buffer, preserving reading order.
 * - Adds a PAGE ("<<PAGE>>") delimiter before each page's extracted lines.
 * - Groups text items into rows by their y-coordinate within a ~4 unit tolerance.
 * - Sorts rows top to bottom (y descending).
 * - Sorts items inside each row left to right (x ascending).
 * - Collapses repeated whitespace and trims lines.
 *
 * If the PDF needs a password and it is missing or incorrect, pdfjs throws
 * an error with name "PasswordException", which is allowed to propagate.
 */
export async function pdfToLines(
  buf: Buffer,
  password?: string
): Promise<string[]> {
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buf),
    password: password || undefined,
    useSystemFonts: true,
    isEvalSupported: false,
  });

  const doc = await loadingTask.promise;
  const allLines: string[] = [];

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    // Add page marker before every page's extracted lines
    allLines.push(PAGE);

    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();

    const items: Array<{ str: string; x: number; y: number }> = [];

    for (const rawItem of content.items) {
      if (!isTextItem(rawItem)) continue;
      // Skip empty items
      if (!rawItem.str || rawItem.str.trim() === "") continue;

      items.push({
        str: rawItem.str,
        x: rawItem.transform[4],
        y: rawItem.transform[5],
      });
    }

    // Group text items into rows by their y coordinate, using a 4 unit tolerance bucket
    const rows: TextRow[] = [];
    const Y_TOLERANCE = 4.0;

    for (const item of items) {
      let matchedRow: TextRow | null = null;
      let minDiff = Infinity;

      for (const row of rows) {
        const diff = Math.abs(row.y - item.y);
        if (diff <= Y_TOLERANCE && diff < minDiff) {
          minDiff = diff;
          matchedRow = row;
        }
      }

      if (matchedRow) {
        matchedRow.items.push({ str: item.str, x: item.x });
      } else {
        rows.push({
          y: item.y,
          items: [{ str: item.str, x: item.x }],
        });
      }
    }

    // Sort rows top to bottom (y descending)
    rows.sort((a, b) => b.y - a.y);

    // Sort items inside each row left to right (x ascending, transform[4])
    for (const row of rows) {
      row.items.sort((a, b) => a.x - b.x);

      // Join items with a space, collapse repeated whitespace, trim.
      const line = row.items
        .map((it) => it.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      if (line.length > 0) {
        allLines.push(line);
      }
    }
  }

  return allLines;
}
