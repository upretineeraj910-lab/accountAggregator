// app/api/analyze/route.ts
// Secure API endpoint for rule-based bank statement financial analysis

import { NextRequest, NextResponse } from "next/server";
import { pdfToRows, rowsToLines } from "@/lib/pdfText";
import { parseStatementWithDebug, type Txn } from "@/lib/parse";
import { analyze, marketActivity } from "@/lib/analyze";
import { generateAiAssessment, type AiSummary } from "@/lib/ai";

export const runtime = "nodejs";
export const maxDuration = 60; // 60 seconds execution time on Vercel

const MAX_FILE_SIZE_BYTES = 4.5 * 1024 * 1024; // 4.5 MB (Vercel Serverless payload limit)

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
    let holderName =
      typeof holderNameRaw === "string" && holderNameRaw.trim().length > 0
        ? holderNameRaw.trim()
        : undefined;

    // Convert to Buffer strictly in-memory (never written to disk or logged)
    const arrayBuffer = await file.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);

    let txns: Txn[] = [];
    let profile: "pnb" | "axis" | "generic" = "generic";
    let anchorsCount = 0;
    let droppedFragmentsCount = 0;
    let balanceMismatchCount = 0;
    let narrationFirst = false;
    let lines: string[] = [];
    let parserUsed: "python" | "ts" = "ts";

    const parserUrl = process.env.PARSER_URL?.trim();
    const parserKey = process.env.PARSER_KEY?.trim();

    // 1. If PARSER_URL and PARSER_KEY are provided, attempt parsing via the Python microservice
    if (parserUrl && parserKey) {
      try {
        const pythonFormData = new FormData();
        const blob = new Blob([arrayBuffer], { type: "application/pdf" });
        pythonFormData.append("file", blob, file.name || "statement.pdf");
        if (password) {
          pythonFormData.append("password", password);
        }

        const pythonRes = await fetch(`${parserUrl.replace(/\/+$/, "")}/parse`, {
          method: "POST",
          headers: {
            "X-API-Key": parserKey,
          },
          body: pythonFormData,
        });

        if (pythonRes.status === 401) {
          const authData = (await pythonRes.json().catch(() => ({}))) as {
            needPassword?: boolean;
          };
          if (authData.needPassword) {
            return NextResponse.json(
              {
                error: "PDF password required or incorrect.",
                needPassword: true,
              },
              { status: 401 }
            );
          }
        }

        if (pythonRes.ok) {
          const data = (await pythonRes.json()) as {
            profile: "pnb" | "axis" | "icici" | "generic";
            txns: Array<{
              date: string;
              narration: string;
              debit: number;
              credit: number;
              balance: number;
            }>;
            holder?: {
              name?: string;
              branch?: string;
              accountNo?: string;
              ifsc?: string;
            };
            quality?: {
              ok: boolean;
              mismatches: number;
              total: number;
              firstRowUncertain: boolean;
            };
          };

          if (Array.isArray(data.txns) && data.txns.length > 0) {
            txns = data.txns.map((t) => ({
              date: new Date(t.date),
              narration: t.narration,
              debit: t.debit,
              credit: t.credit,
              balance: t.balance,
            }));
            profile =
              data.profile === "pnb"
                ? "pnb"
                : data.profile === "axis"
                ? "axis"
                : "generic";
            anchorsCount = txns.length;
            balanceMismatchCount = data.quality?.mismatches || 0;
            parserUsed = "python";

            if (!holderName && data.holder?.name) {
              holderName = data.holder.name;
            }
          }
        } else {
          console.warn(
            `[Python Parser]: received status ${pythonRes.status}, falling back to TS parser`
          );
        }
      } catch (pythonErr) {
        console.warn(
          "[Python Parser Error]: falling back to TS parser",
          pythonErr
        );
      }
    }

    // 2. Fallback to TypeScript parser if Python service was unavailable or not configured
    if (parserUsed === "ts") {
      const rows = await pdfToRows(buf, password);
      lines = rowsToLines(rows);
      const parsed = parseStatementWithDebug(rows);
      txns = parsed.txns;
      profile = parsed.profile;
      anchorsCount = parsed.anchorsCount;
      droppedFragmentsCount = parsed.droppedFragmentsCount;
      balanceMismatchCount = parsed.balanceMismatchCount;
      narrationFirst = parsed.narrationFirst;
    }

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
      parser: "python" | "ts";
      result: typeof analysis & { market: typeof market; ai: AiSummary };
      debug?: {
        parser: "python" | "ts";
        profile: "pnb" | "axis" | "generic";
        anchorsCount: number;
        droppedFragmentsCount: number;
        balanceMismatchCount: number;
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
      parser: parserUsed,
      result: {
        ...analysis,
        market,
        ai: aiAssessment,
      },
    };

    // Small debug option: ?debug=1 AND NODE_ENV !== "production"
    const { searchParams } = new URL(req.url);
    if (
      searchParams.get("debug") === "1" &&
      process.env.NODE_ENV !== "production"
    ) {
      responsePayload.debug = {
        parser: parserUsed,
        profile,
        anchorsCount,
        droppedFragmentsCount,
        balanceMismatchCount,
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

    console.error("[POST /api/analyze Error]:", err);

    // Generic error response - do not leak stack traces or internal logs
    return NextResponse.json(
      {
        error:
          process.env.NODE_ENV !== "production" && err instanceof Error
            ? `Statement error: ${err.message}`
            : "An error occurred while processing the statement. Please try again.",
      },
      { status: 500 }
    );
  }
}
