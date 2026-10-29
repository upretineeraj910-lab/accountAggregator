// lib/pdfText.ts
// Step 1: PDF to lines & rows
// pdfjs-dist legacy build for Node.js / Vercel serverless environment.

// @ts-ignore - pdfjs-dist legacy .mjs types
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
// @ts-ignore - in-memory worker binding for serverless environments
import * as pdfjsWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs";

// Ensure pdfjs fake worker mode uses in-memory WorkerMessageHandler
(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorker;

export const PAGE = "<<PAGE>>";

export type Row = {
  text: string;
  y: number;
  page: number;
};

interface TextItemLike {
  str: string;
  transform: number[];
}

function isTextItem(item: unknown): item is TextItemLike {
  if (typeof item !== "object" || item === null) return false;
  const c = item as { str?: unknown; transform?: unknown };
  return (
    typeof c.str === "string" &&
    Array.isArray(c.transform) &&
    c.transform.length >= 6
  );
}

interface TextRow {
  y: number;
  items: Array<{ str: string; x: number }>;
}

const Y_TOLERANCE = 3.5;

/**
 * Extracts rows with precise vertical (y) coordinates and page numbers from in-memory PDF buffer.
 */
export async function pdfToRows(
  buf: Buffer,
  password?: string
): Promise<Row[]> {
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buf),
    password: password || undefined,
    useSystemFonts: true,
    isEvalSupported: false,
  });

  const doc = await loadingTask.promise;
  const allRows: Row[] = [];

  try {
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();

      const rows: TextRow[] = [];

      for (const raw of content.items) {
        if (!isTextItem(raw)) continue;
        if (!raw.str || raw.str.trim() === "") continue;

        const x = raw.transform[4];
        const y = raw.transform[5];

        let target: TextRow | null = null;
        let best = Infinity;
        for (const row of rows) {
          const diff = Math.abs(row.y - y);
          if (diff <= Y_TOLERANCE && diff < best) {
            best = diff;
            target = row;
          }
        }

        if (target) target.items.push({ str: raw.str, x });
        else rows.push({ y, items: [{ str: raw.str, x }] });
      }

      rows.sort((a, b) => b.y - a.y);

      for (const row of rows) {
        row.items.sort((a, b) => a.x - b.x);
        const line = row.items
          .map((it) => it.str)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (line) {
          allRows.push({
            text: line,
            y: row.y,
            page: pageNum,
          });
        }
      }
    }
  } finally {
    await doc.destroy();
  }

  return allRows;
}

/**
 * Converts Row objects into string lines with PAGE delimiter, preserving backwards compatibility.
 */
export function rowsToLines(rows: Row[]): string[] {
  const allLines: string[] = [];
  let currentPage = -1;
  for (const r of rows) {
    if (r.page !== currentPage) {
      allLines.push(PAGE);
      currentPage = r.page;
    }
    allLines.push(r.text);
  }
  return allLines;
}

/**
 * In-memory PDF buffer to lines array with PAGE markers.
 */
export async function pdfToLines(
  buf: Buffer,
  password?: string
): Promise<string[]> {
  const rows = await pdfToRows(buf, password);
  return rowsToLines(rows);
}
