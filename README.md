<<<<<<< HEAD
# Statement Check - Loan DSA Bank Statement Analyzer

An internal Next.js (App Router + TypeScript) tool for loan sourcing agencies (DSAs) in India. Employees upload a client's 3-month or 6-month bank statement PDF, and the app extracts transactions in-memory and generates a rule-based financial health report to judge loan eligibility.

---

## 🚀 Quick Start

### 1. Installation

Only **one** external package is required: `pdfjs-dist` (using the legacy build `pdfjs-dist/legacy/build/pdf.mjs`).

```bash
# Exact install command:
npm install pdfjs-dist@4.10.38
```

To install all dependencies:
```bash
npm install
```

### 2. Next.js Configuration (`next.config.ts`)

`pdfjs-dist` is configured in `serverExternalPackages` so Next.js does not bundle it for the client:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pdfjs-dist"],
};

export default nextConfig;
```

### 3. Run Development Server & Unit Tests

```bash
# Run unit tests
npm test

# Run development server
npm run dev
```

Visit [http://localhost:3000/statement](http://localhost:3000/statement) in your browser.

---

## 📁 Architecture & File Layout

- [`lib/pdfText.ts`](file:///c:/Users/dell/Desktop/statemtReader/lib/pdfText.ts)  
  `pdfToLines(buf: Buffer, password?: string): Promise<string[]>`  
  Uses the legacy build of `pdfjs-dist` to group text items into rows by $y$ coordinate within a 4-unit tolerance. Inserts `PAGE = "<<PAGE>>"` before every page's extracted lines, sorts rows top-to-bottom and items left-to-right, collapses spaces, and returns ordered text lines. Password exceptions propagate cleanly.

- [`lib/parse.ts`](file:///c:/Users/dell/Desktop/statemtReader/lib/parse.ts)  
  `parseTxns(lines: string[]): Txn[]` & `groupRows(lines: string[]): { rows: RawRow[]; narrationFirst: boolean }`  
  Pure function converting text lines into structured transactions.
  - **Mode Auto-Detect (`narrationFirst`)**: Detects Axis Bank multi-line layouts where the narration precedes the date line (`lead` lines before `body`).
  - **Footer & Legends Truncation**: Excludes summary totals, closing balance lines, and disclaimer blocks (e.g. `Axis Bank Loan Centre`) using `STOP` regex until the next `PAGE` boundary.
  - **Start Date Matching**: Handles optional serial numbers (`1 `, `10 `, `100 `) and multiple date formats (`dd.mm.yyyy`, `dd/mm/yyyy`, `dd-mm-yyyy`, `yyyy-mm-dd`).
  - **Amount Extraction**: Extracts amounts from `row.body` using negative-lookahead regex `(?<![\d.])(?:\d{1,3}(?:,\d{2,3})*|\d+)\.\d{2}(?![\d.])`.

- [`lib/analyze.ts`](file:///c:/Users/dell/Desktop/statemtReader/lib/analyze.ts)  
  `analyze(txns: Txn[]): AnalysisResult` & `marketActivity(txns: Txn[], avgMonthlyCredit: number): MarketActivity`  
  Pure rule-based scoring module:
  - **Salary-Based FOIR**: Identifies salary transactions via `kw("SALARY|SAL")`, computes `avgSalary`, and calculates FOIR strictly against salary income (prevents one-off transfers or disbursals from distorting the denominator).
  - **`kw(alts)` Helper**: Pattern `(?<![A-Za-z0-9])(?:${alts})(?![A-Za-z0-9])` ensures patterns like `_EMI_` match while preventing false substrings like `LICENSE` matching `NSE`.
  - **Credit Card / Wallet Rotation**: Identifies fund churning from wallets (`PAYTM`, `MOBIKWIK`, `CRED`, etc.).
  - **Trader Risk**: Flags active/heavy share market trading in prominent red warnings.

- [`app/api/analyze/route.ts`](file:///c:/Users/dell/Desktop/statemtReader/app/api/analyze/route.ts)  
  Node.js API route accepting `multipart/form-data`. In debug mode (`?debug=1` non-production), returns `narrationFirst` along with sample transactions.

- [`app/statement/page.tsx`](file:///c:/Users/dell/Desktop/statemtReader/app/statement/page.tsx) & [`app/statement/page.module.css`](file:///c:/Users/dell/Desktop/statemtReader/app/statement/page.module.css)  
  Client dashboard displaying Avg Salary, Avg Inflow, FOIR, ABB, Bounces, Cash Deposit Share, Wallet Rotation card, Share Market card, and monthly summary table.

- [`lib/__tests__/parse.test.ts`](file:///c:/Users/dell/Desktop/statemtReader/lib/__tests__/parse.test.ts)  
  Unit test validating Axis Bank multi-line narration, EMI identification with underscores, disclaimer exclusion, and exact FOIR computation.
=======
# accountAggregator
>>>>>>> c7c563f148fa2e9f36a837f51bff1b7b0a00f559
