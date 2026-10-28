// lib/pdfText.ts
// Step 1: PDF to lines
// pdfjs-dist ka legacy build, Node.js / Vercel serverless ke liye.

// @ts-ignore - pdfjs-dist legacy .mjs ke types nahi milte
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
// @ts-ignore - worker ko memory mein bind karna hai (Vercel pe file path se load nahi hota)
import * as pdfjsWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs";

// pdfjs "fake worker" mode mein globalThis.pdfjsWorker.WorkerMessageHandler dhundta hai.
// Hamesha set karo, taaki ./pdf.worker.mjs ko filesystem se import na karna pade.
(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorker;

export const PAGE = "<<PAGE>>";

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
 * In-memory PDF buffer se lines nikalta hai (reading order mein).
 * - Har page ke pehle PAGE marker push hota hai.
 * - Items ko y se rows mein group karta hai, rows top to bottom, items left to right.
 * - Password galat ya missing ho to pdfjs "PasswordException" throw karta hai,
 *   jo caller (API route) tak propagate hone dena hai.
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

  try {
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      allLines.push(PAGE);

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
        if (line) allLines.push(line);
      }
    }
  } finally {
    await doc.destroy();
  }

  return allLines;
}