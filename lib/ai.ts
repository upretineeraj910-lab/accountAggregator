// lib/ai.ts
// AI Layer for Bank Statement Analysis: Executive Underwriting Summary Guardrails
// Zero external npm dependencies: uses native fetch with graceful fallback when GEMINI_API_KEY is not set.
// Strict Guardrails: Only computed numbers are sent. Never includes names, PAN, address, mobile, or raw transactions.

import type { AnalysisResult } from "./analyze";
import type { AccountInfo } from "./accountInfo";

export interface AiSummary {
  enabled: boolean;
  executiveSummary?: string[];
  bullets?: string[];
  errorNotice?: string;
}

const PRIMARY_MODEL = "gemini-flash-lite-latest";
const FALLBACK_MODEL = "gemini-3.5-flash";

/**
 * Generates an executive underwriting assessment using Google Gemini API.
 * Anonymizes all PII: ONLY computed financial numbers are provided in the payload.
 * Strictly avoids personal data (no names, PAN, address, mobile) and no raw transaction narrations.
 * Gracefully returns { enabled: false } if GEMINI_API_KEY is not configured or if API times out.
 */
export async function generateAiAssessment(input: {
  accountInfo?: AccountInfo;
  analysis: AnalysisResult;
}): Promise<AiSummary> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();

  // If no API key configured, return gracefully without failing
  if (!apiKey) {
    return { enabled: false };
  }

  const { analysis } = input;

  // Prepare ONLY computed numbers (zero PII, zero personal data, zero narrations/transactions)
  const sanitizedNumbers = {
    statementMonths: analysis.months,
    fullMonthsAnalyzed: analysis.fullMonthsCount || analysis.months,
    avgMonthlySalary: Math.round(analysis.avgSalary),
    activeMonthlyEmi: Math.round(analysis.monthlyEmi),
    currentFoirPct: analysis.foir,
    chequeBouncesCount: analysis.bounces,
    cashDepositPct: Math.round(analysis.cashPct),
    passThroughRatioPct: analysis.passThroughPct,
    selfTransferInTotal: Math.round(analysis.selfIn || 0),
    selfTransferOutTotal: Math.round(analysis.selfOut || 0),
    roundTripCount: analysis.roundTrip?.count || 0,
    roundTripVolume: Math.round(analysis.roundTrip?.volume || 0),
    medianDailyBalance: Math.round(analysis.medianDailyBalance || 0),
    minBalance: Math.round(analysis.minBalance || 0),
    monthEndAvgBalance: Math.round(analysis.monthEndAvgBalance || 0),
    preSalaryAvgBalance: Math.round(analysis.preSalaryBalance || 0),
    overallScore: analysis.score,
    verdict: analysis.verdict,
  };

  const systemInstruction = `Sirf diye gaye numbers ka 4-5 bullet summary do. Koi nayi inference ya anumaan mat banao. Loan approve/reject ya credit limit ka faisla mat do. Har bullet diye gaye numbers pe based ho.

Respond ONLY with a valid JSON object matching this schema:
{
  "bullets": [
    "string",
    "string",
    "string",
    "string"
  ]
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
              text: `${systemInstruction}\n\nComputed Numbers:\n${JSON.stringify(
                sanitizedNumbers,
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
    const bullets: string[] = Array.isArray(parsed.bullets)
      ? parsed.bullets
      : Array.isArray(parsed.executiveSummary)
      ? parsed.executiveSummary
      : [];

    return {
      enabled: true,
      bullets,
      executiveSummary: bullets,
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
