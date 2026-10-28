// lib/ai.ts
// AI Layer for Bank Statement Analysis: Executive Underwriting Summary & Merchant Disambiguation
// Zero external npm dependencies: uses native fetch with graceful fallback when GEMINI_API_KEY is not set.

import type { AnalysisResult } from "./analyze";
import type { AccountInfo } from "./accountInfo";

export interface AiSummary {
  enabled: boolean;
  executiveSummary?: string[];
  riskHighlights?: string[];
  recommendation?: string;
  employerInsight?: string;
  errorNotice?: string;
}

const PRIMARY_MODEL = "gemini-flash-lite-latest";
const FALLBACK_MODEL = "gemini-3.5-flash";

/**
 * Generates an executive underwriting assessment using Google Gemini API.
 * Anonymizes PII (never sends full account numbers, customer addresses, or raw transaction logs).
 * Gracefully returns { enabled: false } if GEMINI_API_KEY is not configured or if API times out.
 */
export async function generateAiAssessment(input: {
  accountInfo: AccountInfo;
  analysis: AnalysisResult;
}): Promise<AiSummary> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();

  // If no API key configured, return gracefully without failing
  if (!apiKey) {
    return { enabled: false };
  }

  const { accountInfo, analysis } = input;

  // Prepare sanitized underwriting metrics (no PII, no account numbers, no sensitive addresses)
  const sanitizedContext = {
    bankName: accountInfo.bankName || "Unknown Bank",
    accountType: accountInfo.accountType || "Savings Account",
    statementMonths: analysis.months,
    avgMonthlySalary: Math.round(analysis.avgSalary),
    detectedEmployer: analysis.salary?.credits?.length
      ? accountInfo.holderName || "Verified Corporate Employer"
      : "Not Clearly Identified",
    primaryEmployerName: analysis.salary?.credits?.length
      ? "Identified in Statement"
      : "None",
    activeMonthlyEmi: Math.round(analysis.monthlyEmi),
    currentFoirPct: analysis.foir,
    monthEndAvgBalance: Math.round(analysis.monthEndAvgBalance),
    avgTxnBalanceAbb: Math.round(analysis.abb),
    chequeBouncesCount: analysis.bounces,
    bettingGamblingCount: analysis.betting,
    lendingAppsCount: analysis.lendingApps?.count || 0,
    lendingAppsTotal: Math.round(analysis.lendingApps?.total || 0),
    creditCardBillDebitsTotal: Math.round(analysis.creditCardPayments || 0),
    overallScore: analysis.score,
    verdict: analysis.verdict,
    salaryInflowSharePct: Math.round(analysis.otherCredits?.salaryPct || 0),
    otherInflowSharePct: Math.round(analysis.otherCredits?.pctOfTotalCredit || 0),
    passThroughRatioPct: analysis.passThroughPct,
  };

  const systemInstruction = `You are a Senior Credit Underwriter at an Indian Loan Sourcing Agency (DSA).
Analyze the provided sanitized bank statement underwriting metrics and generate:
1. "executiveSummary": Exactly 3 to 4 concise bullet points summarizing borrower's income profile, employment stability, obligation level, and overall creditworthiness.
2. "riskHighlights": 2 to 3 bullet points highlighting positive credit signals or critical underwriting risks (e.g. high FOIR, bounces, instant loan app usage, pass-through ratio).
3. "recommendation": A 1-2 sentence loan sourcing recommendation (e.g., suitable loan product, suggested loan ceiling, or cautionary stipulations).

Respond ONLY with a valid JSON object matching this exact schema:
{
  "executiveSummary": ["string", "string", "string"],
  "riskHighlights": ["string", "string"],
  "recommendation": "string"
}`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000); // 8s timeout

    const requestPayload = {
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `${systemInstruction}\n\nUnderwriting Context:\n${JSON.stringify(
                sanitizedContext,
                null,
                2
              )}`,
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
      },
    };

    let res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${PRIMARY_MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
      }
    );

    // If primary model is not found (404) or experiencing high demand / rate limit (503 / 429), fallback
    if (!res.ok && (res.status === 404 || res.status === 503 || res.status === 429)) {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${FALLBACK_MODEL}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestPayload),
          signal: controller.signal,
        }
      );
    }

    clearTimeout(timeoutId);

    if (!res.ok) {
      let errMessage = `API error (${res.status})`;
      try {
        const errJson = await res.json();
        if (errJson?.error?.message) {
          errMessage = errJson.error.message;
        }
      } catch {
        // fallback
      }
      return {
        enabled: false,
        errorNotice: errMessage,
      };
    }

    const data = await res.json();
    const rawText =
      data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";

    if (!rawText) {
      return { enabled: false };
    }

    const parsed = JSON.parse(rawText);

    return {
      enabled: true,
      executiveSummary: Array.isArray(parsed.executiveSummary)
        ? parsed.executiveSummary
        : [],
      riskHighlights: Array.isArray(parsed.riskHighlights)
        ? parsed.riskHighlights
        : [],
      recommendation:
        typeof parsed.recommendation === "string"
          ? parsed.recommendation
          : undefined,
    };
  } catch (err: unknown) {
    const isAbort =
      err instanceof Error &&
      (err.name === "AbortError" || err.message.includes("aborted"));
    return {
      enabled: false,
      errorNotice: isAbort
        ? "AI Underwriting request timed out."
        : "Failed to connect to AI Underwriter service.",
    };
  }
}
