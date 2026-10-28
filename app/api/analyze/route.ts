// app/api/analyze/route.ts
// Secure API endpoint for rule-based bank statement financial analysis

import { NextRequest, NextResponse } from "next/server";
import { pdfToLines } from "@/lib/pdfText";
import { parseTxnsWithDebug } from "@/lib/parse";
import { analyze, marketActivity } from "@/lib/analyze";
import { generateAiAssessment, type AiSummary } from "@/lib/ai";

export const runtime = "nodejs";

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      return NextResponse.json(
        { error: "Invalid form data submission." },
        { status: 400 }
      );
    }

    const file = formData.get("file");
    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: "Bank statement PDF file is required." },
        { status: 400 }
      );
    }

    // Accept only application/pdf (415)
    const isPdf =
      file.type === "application/pdf" ||
      file.name.toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      return NextResponse.json(
        { error: "Only PDF files are supported." },
        { status: 415 }
      );
    }

    // Limit upload size to 10 MB (413)
    if (file.size > MAX_FILE_SIZE_BYTES) {
      return NextResponse.json(
        { error: "File size exceeds the 10 MB limit." },
        { status: 413 }
      );
    }

    const passwordRaw = formData.get("password");
    const password =
      typeof passwordRaw === "string" && passwordRaw.trim().length > 0
        ? passwordRaw.trim()
        : undefined;

    const holderNameRaw = formData.get("holderName");
    const holderName =
      typeof holderNameRaw === "string" && holderNameRaw.trim().length > 0
        ? holderNameRaw.trim()
        : undefined;

    // Convert to Buffer strictly in-memory (never written to disk or logged)
    const arrayBuffer = await file.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);

    // Extract lines and parse transactions
    const lines = await pdfToLines(buf, password);
    const { txns, narrationFirst } = parseTxnsWithDebug(lines);

    // If fewer than 5 transactions, return 422
    if (txns.length < 5) {
      return NextResponse.json(
        {
          error:
            "No transactions could be extracted. The file may be a scanned image or in an unsupported bank format.",
        },
        { status: 422 }
      );
    }

    const analysis = analyze(txns, { holderName, rawLines: lines });
    const market = marketActivity(
      txns,
      analysis.avgMonthlyCredit,
      analysis.months
    );

    // AI assessment layer: zero-dependency, graceful fallback if GEMINI_API_KEY is not set
    const aiAssessment: AiSummary = await generateAiAssessment({
      accountInfo: analysis.accountInfo,
      analysis,
    });

    // Result with analysis merged with market, walletRotation, monthlyTable, and AI underwriting
    const responsePayload: {
      count: number;
      result: typeof analysis & { market: typeof market; ai: AiSummary };
      debug?: {
        narrationFirst: boolean;
        lines: string[];
        sampleTxns: Array<{
          date: string;
          narration: string;
          debit: number;
          credit: number;
          balance: number;
        }>;
      };
    } = {
      count: txns.length,
      result: {
        ...analysis,
        market,
        ai: aiAssessment,
      },
    };

    // Small debug option: ?debug=1 AND NODE_ENV !== "production"
    // Returns first 40 extracted lines, first 10 sample txns, and the narrationFirst mode
    const { searchParams } = new URL(req.url);
    if (
      searchParams.get("debug") === "1" &&
      process.env.NODE_ENV !== "production"
    ) {
      responsePayload.debug = {
        narrationFirst,
        lines: lines.slice(0, 40),
        sampleTxns: txns.slice(0, 10).map((t) => ({
          date: t.date.toISOString(),
          narration: t.narration,
          debit: t.debit,
          credit: t.credit,
          balance: t.balance,
        })),
      };
    }

    return NextResponse.json(responsePayload);
  } catch (err: unknown) {
    // If the PDF requires a password or password was incorrect, pdfjs throws PasswordException
    if (
      err &&
      typeof err === "object" &&
      ("name" in err && (err as { name: string }).name === "PasswordException" ||
        ("message" in err &&
          typeof (err as { message: unknown }).message === "string" &&
          (err as { message: string }).message.toLowerCase().includes("password")))
    ) {
      return NextResponse.json(
        {
          error: "PDF password required or incorrect.",
          needPassword: true,
        },
        { status: 401 }
      );
    }

    // Generic error response - do not leak stack traces or internal logs
    return NextResponse.json(
      {
        error:
          "An error occurred while processing the statement. Please try again.",
      },
      { status: 500 }
    );
  }
}
