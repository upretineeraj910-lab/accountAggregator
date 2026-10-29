"use client";

// app/statement/page.tsx
// Statement Check feature for Loan DSA employees
// Pure rule-based client analysis dashboard (English interface)

import React, { useState, useRef, useMemo } from "react";
import styles from "./page.module.css";
import { checkNewLoan, LOAN_CONFIG } from "@/lib/loanCheck";
import {
  recomputeWithSalary,
  type Reason,
  type MonthlyRecord,
  type MarketActivity,
  type WalletRotation,
  type AnalysisResult,
} from "@/lib/analyze";
import { type SalaryResult, getPrimaryEmployerName } from "@/lib/salary";
import type { CreditCategory, OtherCreditsSummary } from "@/lib/otherCredits";
import type { AccountInfo } from "@/lib/accountInfo";
import type { AiSummary } from "@/lib/ai";

// TODO: Employee-only access check / DSA session auth middleware should be integrated here.
// Example:
// const { user, isAuthenticated } = useAuth();
// if (!isAuthenticated || user.role !== "dsa_agent") return <AccessDenied />;

// Redundant interfaces removed (imported from lib/analyze)

interface ApiResponse {
  count: number;
  result: AnalysisResult;
  error?: string;
  needPassword?: boolean;
}

function formatInr(val: number): string {
  return "₹" + Math.round(val).toLocaleString("en-IN");
}

function formatInrPrecise(val: number): string {
  return (
    "₹" +
    val.toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

const SHORT_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function formatMonthYear(dInput: Date | string): string {
  const d = new Date(dInput);
  return `${SHORT_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function formatDate(dInput: Date | string): string {
  const d = new Date(dInput);
  const day = String(d.getDate()).padStart(2, "0");
  const month = SHORT_MONTHS[d.getMonth()];
  const year = d.getFullYear();
  return `${day} ${month} ${year}`;
}

const CATEGORY_LABELS: Record<CreditCategory, string> = {
  SELF_TRANSFER: "Self Transfer",
  LOAN_LIKE: "Loan-Like Credit",
  LENDING_APP: "Lending App",
  WALLET: "Wallet Transfer",
  BROKER: "Broker / Securities",
  REFUND: "Refund / Reversal",
  INTEREST: "Bank Interest",
  CASH: "Cash Deposit",
  UPI_PERSON: "Personal UPI",
  OTHER: "Other Inflow",
};

const CATEGORY_ORDER: CreditCategory[] = [
  "LENDING_APP",
  "LOAN_LIKE",
  "SELF_TRANSFER",
  "WALLET",
  "BROKER",
  "CASH",
  "UPI_PERSON",
  "REFUND",
  "INTEREST",
  "OTHER",
];

export default function StatementPage() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [holderName, setHolderName] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [needPassword, setNeedPassword] = useState(false);
  const [rawAnalysis, setRawAnalysis] = useState<AnalysisResult | null>(null);
  const [txnCount, setTxnCount] = useState<number>(0);

  // Salary management interactive states
  const [selectedCreditKeys, setSelectedCreditKeys] = useState<Set<string>>(
    new Set()
  );
  const [manualSalary, setManualSalary] = useState<string>("");
  const [showSalaryDetails, setShowSalaryDetails] = useState(false);

  // Naya loan check form state (client-side interactive check)
  const [loanAmount, setLoanAmount] = useState<string>("");
  const [loanRate, setLoanRate] = useState<number>(LOAN_CONFIG.defaultRate);
  const [loanTenureYears, setLoanTenureYears] = useState<number>(
    LOAN_CONFIG.defaultTenureYears
  );

  const passwordInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setSelectedFile(e.target.files[0]);
      setErrorMsg(null);
      setNeedPassword(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!selectedFile) {
      setErrorMsg("Please select a bank statement PDF file.");
      return;
    }

    if (selectedFile.size > 4.5 * 1024 * 1024) {
      setErrorMsg(
        "File size exceeds 4.5 MB (hosting limit). Please upload a statement under 4.5 MB."
      );
      return;
    }

    setLoading(true);
    setErrorMsg(null);

    const formData = new FormData();
    formData.append("file", selectedFile);
    if (password.trim()) {
      formData.append("password", password.trim());
    }
    if (holderName.trim()) {
      formData.append("holderName", holderName.trim());
    }

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        body: formData,
      });

      let data: ApiResponse;
      try {
        data = await res.json();
      } catch {
        setErrorMsg(
          `Server returned error (${res.status}). Please check your server terminal console for details.`
        );
        return;
      }

      if (!res.ok) {
        if (res.status === 401 && data.needPassword) {
          setNeedPassword(true);
          setErrorMsg(data.error || "PDF password is required or incorrect.");
          setTimeout(() => {
            passwordInputRef.current?.focus();
          }, 50);
        } else {
          setErrorMsg(
            data.error ||
              "Failed to process statement. Please verify the file and format."
          );
        }
        return;
      }

      setNeedPassword(false);
      setRawAnalysis(data.result);
      setTxnCount(data.count);
      if (!holderName.trim() && data.result.accountInfo?.holderName) {
        setHolderName(data.result.accountInfo.holderName);
      }

      // Initialize selected credit keys with all detected salary credits
      const keys = new Set(
        (data.result.salary?.credits || []).map(
          (c) => `${new Date(c.date).getTime()}-${c.amount}`
        )
      );
      setSelectedCreditKeys(keys);
      setManualSalary("");
    } catch {
      setErrorMsg("A network error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  // Dynamically recompute underwriting and loan metrics on salary changes
  const analysisData = useMemo(() => {
    if (!rawAnalysis) return null;
    const activeCredits = (rawAnalysis.salary?.credits || [])
      .filter((c) =>
        selectedCreditKeys.has(`${new Date(c.date).getTime()}-${c.amount}`)
      )
      .map((c) => ({
        ...c,
        date: new Date(c.date),
      }));

    const parsedManual = parseFloat(manualSalary.replace(/,/g, "").trim());
    return recomputeWithSalary(
      rawAnalysis,
      activeCredits,
      !isNaN(parsedManual) && parsedManual > 0 ? parsedManual : undefined
    );
  }, [rawAnalysis, selectedCreditKeys, manualSalary]);

  const handleToggleCredit = (key: string) => {
    setSelectedCreditKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  // Client-side Naya loan check derivation
  const parsedLoanAmount = parseFloat(loanAmount.replace(/,/g, "").trim());
  const hasValidLoanAmount = !isNaN(parsedLoanAmount) && parsedLoanAmount > 0;
  const effectiveSalary = analysisData
    ? analysisData.avgSalary > 0
      ? analysisData.avgSalary
      : analysisData.avgMonthlyCredit
    : 0;
  const tenureMonths = Math.max(1, Math.round((loanTenureYears || 1) * 12));

  const loanCheckResult =
    analysisData && hasValidLoanAmount
      ? checkNewLoan({
          avgSalary: effectiveSalary,
          monthlyEmi: analysisData.monthlyEmi,
          amount: parsedLoanAmount,
          ratePct: loanRate,
          tenureMonths,
        })
      : null;

  const currentPassNewFail =
    loanCheckResult !== null &&
    loanCheckResult.currentFoir <= LOAN_CONFIG.foirLimit &&
    loanCheckResult.status === "Fail";

  const salaryNotRecognized =
    analysisData !== null && analysisData.avgSalary <= 0;

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div className={styles.brandBadge}>
          DSA Internal Portal • Loan Sourcing & Underwriting
        </div>
        <h1 className={styles.title}>Statement Check</h1>
        <p className={styles.subtitle}>
          Upload a client&apos;s 3-month or 6-month bank statement PDF to generate an
          automated loan eligibility and financial risk report.
        </p>
      </header>

      {/* Upload Form Card */}
      <section className={styles.uploadCard}>
        <form onSubmit={handleSubmit} className={styles.formGrid}>
          <div className={styles.formGroup}>
            <label className={styles.label} htmlFor="statementFile">
              Bank Statement PDF <span className={styles.hint}>(Max 10 MB)</span>
            </label>
            <input
              id="statementFile"
              type="file"
              accept="application/pdf"
              className={styles.fileInput}
              onChange={handleFileChange}
              disabled={loading}
            />
          </div>

          <div className={styles.formGroup}>
            <label className={styles.label} htmlFor="pdfPassword">
              PDF Password{" "}
              <span className={styles.hint}>(if password-protected)</span>
            </label>
            <input
              id="pdfPassword"
              ref={passwordInputRef}
              type="password"
              placeholder="Enter PDF password..."
              className={`${styles.textInput} ${
                needPassword ? styles.passwordHighlight : ""
              }`}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (needPassword) setNeedPassword(false);
              }}
              disabled={loading}
            />
          </div>

          <div className={styles.formGroup}>
            <label className={styles.label} htmlFor="accountHolderName">
              Account Holder Name{" "}
              <span className={styles.hint}>(optional)</span>
            </label>
            <input
              id="accountHolderName"
              type="text"
              placeholder="e.g. Naveen Dhama"
              className={styles.textInput}
              value={holderName}
              onChange={(e) => setHolderName(e.target.value)}
              disabled={loading}
            />
          </div>

          <div className={styles.formGroup}>
            <button
              type="submit"
              className={styles.submitBtn}
              disabled={loading || !selectedFile}
            >
              {loading ? "Analyzing statement..." : "Analyze Statement"}
            </button>
          </div>
        </form>
      </section>

      {/* Error Notification */}
      {errorMsg && (
        <div className={styles.errorBox} role="alert">
          <span className={styles.errorIcon}>⚠️</span>
          <span>{errorMsg}</span>
        </div>
      )}

      {/* Analysis Report Section */}
      {analysisData && (
        <main className={styles.reportSection}>
          {/* Client & Account Profile Card */}
          {analysisData.accountInfo && (
            <section className={styles.profileCard}>
              <div className={styles.profileHeaderRow}>
                <div className={styles.profileTitleWrap}>
                  <span className={styles.profileBadge}>Client &amp; Account Profile</span>
                  <div className={styles.holderNameWrap}>
                    <input
                      type="text"
                      className={styles.profileNameInput}
                      value={holderName}
                      placeholder="—"
                      onChange={(e) => setHolderName(e.target.value)}
                      title="Account Holder Name (Editable for self-transfer analysis)"
                    />
                    {selectedFile && (
                      <button
                        type="button"
                        className={styles.applyNameBtn}
                        onClick={(e) => handleSubmit(e as unknown as React.FormEvent)}
                        title="Re-run analysis with updated account holder name"
                        disabled={loading}
                      >
                        {loading ? "Updating..." : "Update Name"}
                      </button>
                    )}
                  </div>
                </div>
                {analysisData.accountInfo.bankName && (
                  <div className={styles.profileBankPill}>
                    🏦 {analysisData.accountInfo.bankName}
                  </div>
                )}
              </div>

              <div className={styles.profileGrid}>
                {/* Account Number */}
                <div className={styles.profileItem}>
                  <span className={styles.profileLabel}>Account Number</span>
                  <span className={styles.profileValue}>
                    {analysisData.accountInfo.accountNumber || "—"}
                  </span>
                </div>

                {/* Account Type */}
                <div className={styles.profileItem}>
                  <span className={styles.profileLabel}>Account Type</span>
                  <span className={styles.profileValue}>
                    {analysisData.accountInfo.accountType || "—"}
                  </span>
                </div>

                {/* IFSC Code */}
                <div className={styles.profileItem}>
                  <span className={styles.profileLabel}>IFSC Code</span>
                  <span className={styles.profileValue}>
                    {analysisData.accountInfo.ifsc || "—"}
                  </span>
                </div>

                {/* Branch / Location */}
                <div className={styles.profileItem}>
                  <span className={styles.profileLabel}>Branch / Location</span>
                  <span
                    className={styles.profileValue}
                    title={analysisData.accountInfo.branch}
                  >
                    {analysisData.accountInfo.branch || "—"}
                  </span>
                </div>

                {/* Statement Period */}
                <div className={styles.profileItem}>
                  <span className={styles.profileLabel}>Statement Period</span>
                  <span className={styles.profileValue}>
                    {analysisData.accountInfo.statementPeriod ||
                      `${analysisData.months} Month(s)`}
                  </span>
                </div>

                {/* Closing Balance */}
                <div className={styles.profileItem}>
                  <span className={styles.profileLabel}>Closing Balance</span>
                  <span
                    className={`${styles.profileValue} ${styles.balanceText}`}
                  >
                    {analysisData.accountInfo.closingBalance !== undefined
                      ? formatInrPrecise(analysisData.accountInfo.closingBalance)
                      : "—"}
                  </span>
                </div>
              </div>
            </section>
          )}

          {/* Verdict and Score Banner */}
          <div className={styles.verdictCard}>
            <div className={styles.verdictLeft}>
              <div className={styles.verdictTitleRow}>
                <span
                  className={`${styles.verdictBadge} ${
                    analysisData.verdict === "Strong"
                      ? styles.verdictStrong
                      : analysisData.verdict === "Average"
                      ? styles.verdictAverage
                      : styles.verdictWeak
                  }`}
                >
                  Verdict: {analysisData.verdict}
                </span>
              </div>
              <p className={styles.verdictSubtitle}>
                {analysisData.months} month(s) statement period • {txnCount}{" "}
                transactions analyzed
              </p>
            </div>

            <div className={styles.scoreBadgeContainer}>
              <span
                className={`${styles.scoreValue} ${
                  analysisData.verdict === "Strong"
                    ? styles.scoreStrong
                    : analysisData.verdict === "Average"
                    ? styles.scoreAverage
                    : styles.scoreWeak
                }`}
              >
                {analysisData.score}
              </span>
              <span className={styles.scoreMax}>/ 100</span>
            </div>
          </div>

          {/* Regulatory & DSA Disclaimer Banner */}
          <div className={styles.disclaimerBanner} role="note">
            <span>ℹ️ Indicative score for internal credit assessment. Final approval subject to bank underwriting policy.</span>
          </div>

          {/* AI Credit Underwriter Insights Card */}
          <section className={styles.aiCard}>
            <div className={styles.aiHeaderRow}>
              <div className={styles.aiTitleWrap}>
                <h2 className={styles.aiTitle}>
                  🤖 AI summary (indicative)
                </h2>
              </div>
              {analysisData.ai?.enabled ? (
                <span className={styles.aiBadgeActive}>
                  ✨ Gemini 2.5 Active
                </span>
              ) : (
                <span className={styles.aiBadgeInactive}>
                  AI summary (indicative)
                </span>
              )}
            </div>

            {analysisData.ai?.enabled ? (
              <>
                <div className={styles.aiContentGrid}>
                  {/* Executive Income & Profile Synthesis */}
                  <div className={styles.aiSectionBlock}>
                    <div className={styles.aiSectionHeading}>
                      📋 Executive Profile &amp; Stability
                    </div>
                    {analysisData.ai.executiveSummary &&
                    analysisData.ai.executiveSummary.length > 0 ? (
                      <ul className={styles.aiBulletList}>
                        {analysisData.ai.executiveSummary.map(
                          (point, idx) => (
                            <li key={idx} className={styles.aiBulletItem}>
                              {point}
                            </li>
                          )
                        )}
                      </ul>
                    ) : (
                      <p className={styles.aiPromptText}>
                        Borrower demonstrates consistent credit activity across the statement period.
                      </p>
                    )}
                  </div>

                  {/* Underwriting Risk & Merit Signals */}
                  <div className={styles.aiSectionBlock}>
                    <div className={styles.aiSectionHeading}>
                      ⚠️ Underwriting Signals &amp; Risk Checks
                    </div>
                    {analysisData.ai.riskHighlights &&
                    analysisData.ai.riskHighlights.length > 0 ? (
                      <ul className={styles.aiBulletList}>
                        {analysisData.ai.riskHighlights.map((risk, idx) => (
                          <li key={idx} className={styles.aiRiskItem}>
                            {risk}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className={styles.aiPromptText}>
                        No critical underwriting red flags identified in the statement.
                      </p>
                    )}
                  </div>
                </div>

                {/* Sourcing Recommendation */}
                {analysisData.ai.recommendation && (
                  <div className={styles.aiRecommendationBox}>
                    <span style={{ fontSize: "18px" }}>💡</span>
                    <div>
                      <div className={styles.aiRecommendationTitle}>
                        Underwriting Recommendation &amp; Sourcing Guidance
                      </div>
                      <p className={styles.aiRecommendationText}>
                        {analysisData.ai.recommendation}
                      </p>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className={styles.aiPromptBanner}>
                {analysisData.ai?.errorNotice ? (
                  <div>
                    <p className={styles.aiPromptText} style={{ color: "#b91c1c" }}>
                      ⚠️ <strong>Gemini API Notice:</strong> {analysisData.ai.errorNotice}
                    </p>
                    <p
                      className={styles.aiPromptText}
                      style={{ marginTop: "6px", fontSize: "12px", color: "#475569" }}
                    >
                      💡 <strong>How to fix:</strong> In Google AI Studio (aistudio.google.com), click <em>Create API key</em> and select <strong>&quot;Create API key in new project&quot;</strong> for unlimited free-tier access without billing/credit card requirements, then update your <span className={styles.aiPromptCode}>.env.local</span> file.
                    </p>
                  </div>
                ) : (
                  <div>
                    <p className={styles.aiPromptText}>
                      <strong>AI Co-Pilot Ready:</strong> Combine deterministic financial rules with Google Gemini AI to generate automated executive summaries, underwriter notes, and risk synthesis.
                    </p>
                    <p
                      className={styles.aiPromptText}
                      style={{ marginTop: "4px", fontSize: "12px", color: "#64748b" }}
                    >
                      To activate, set <span className={styles.aiPromptCode}>GEMINI_API_KEY=your_key</span> in your <span className={styles.aiPromptCode}>.env.local</span> file and restart dev server.
                    </p>
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Prominent Salary Card (Top of Report) */}
          <section className={styles.prominentSalaryCard}>
            <div className={styles.salaryHeaderRow}>
              <h2 className={styles.gridTitle} style={{ margin: 0 }}>
                Salary Overview
              </h2>
              <span
                className={`${styles.salaryMethodBadge} ${
                  manualSalary.trim() && parseFloat(manualSalary) > 0
                    ? styles.salaryBadgeKeyword
                    : analysisData.salary.method === "keyword"
                    ? styles.salaryBadgeKeyword
                    : analysisData.salary.method === "recurring"
                    ? styles.salaryBadgeRecurring
                    : styles.salaryBadgeNone
                }`}
              >
                {manualSalary.trim() && parseFloat(manualSalary) > 0
                  ? "Manual Override"
                  : analysisData.salary.method === "keyword"
                  ? "Keyword Detection"
                  : analysisData.salary.method === "recurring"
                  ? "Recurring Sender"
                  : "Not Detected"}
              </span>
            </div>

            <div className={styles.salaryMainDisplay}>
              <div className={styles.salaryBigNumber}>
                {formatInr(analysisData.avgSalary)}
                <span className={styles.salaryPerMonth}>/ month</span>
              </div>

              {analysisData.salary.method === "none" &&
              (!manualSalary.trim() || parseFloat(manualSalary) <= 0) ? (
                <div className={styles.salaryNotFoundNote} role="alert">
                  ⚠️ Salary not recognized. Please enter salary manually.
                </div>
              ) : (
                <p className={styles.salarySubtitle}>
                  Salary received across {analysisData.salary.months} month{analysisData.salary.months === 1 ? "" : "s"} (via{" "}
                  {manualSalary.trim() && parseFloat(manualSalary) > 0
                    ? "Manual Override"
                    : analysisData.salary.method === "keyword"
                    ? "Keyword Matching"
                    : analysisData.salary.method === "recurring"
                    ? "Recurring Electronic Transfers"
                    : "Manual Override"}
                  )
                </p>
              )}

              {/* Sender / Employer Name */}
              {(() => {
                const employerName = getPrimaryEmployerName(
                  analysisData.salary.credits,
                  holderName
                );
                return employerName ? (
                  <div className={styles.employerBadge}>
                    <span className={styles.employerLabel}>Employer / Sender:</span>
                    <strong className={styles.employerValue}>{employerName}</strong>
                  </div>
                ) : null;
              })()}

              {/* Mini-list of last up to 6 salary credits */}
              {(() => {
                const recentSalaryCredits = [...analysisData.salary.credits]
                  .sort(
                    (a, b) =>
                      new Date(a.date).getTime() - new Date(b.date).getTime()
                  )
                  .slice(-6);

                return recentSalaryCredits.length > 0 ? (
                  <div className={styles.salaryMiniList}>
                    {recentSalaryCredits.map((c, idx) => (
                      <div key={idx} className={styles.salaryMiniPill}>
                        <span className={styles.salaryMiniMonth}>
                          {formatMonthYear(c.date)}:
                        </span>
                        <span className={styles.salaryMiniAmount}>
                          {formatInr(c.amount)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null;
              })()}
            </div>

            {/* Toggle button to expand/collapse detailed credits & manual input */}
            <button
              type="button"
              className={styles.salaryToggleBtn}
              onClick={() => setShowSalaryDetails((prev) => !prev)}
              aria-expanded={showSalaryDetails}
            >
              <span>
                {showSalaryDetails
                  ? "▲ Hide Detailed Salary Credits & Override"
                  : `▼ View & Adjust Detected Salary Credits (${rawAnalysis?.salary.credits.length || 0})`}
              </span>
            </button>

            {/* Collapsible salary verification details */}
            {showSalaryDetails && (
              <div className={styles.salaryDetailsContainer}>
                <p className={styles.salaryNotice}>
                  Salary is auto-detected. Untick any non-salary credit or enter salary manually if required.
                </p>

                {/* Optional Manual Salary Input */}
                <div className={styles.manualSalaryRow}>
                  <div className={styles.manualInputGroup}>
                    <label className={styles.label} htmlFor="manualSalaryInput">
                      Manual Salary Override (₹/month, optional)
                    </label>
                    <input
                      id="manualSalaryInput"
                      type="number"
                      placeholder="e.g. 45000"
                      className={styles.textInput}
                      value={manualSalary}
                      onChange={(e) => setManualSalary(e.target.value)}
                      min="0"
                      step="500"
                    />
                  </div>
                </div>

                {/* Manual Override Active Alert */}
                {manualSalary.trim() && parseFloat(manualSalary) > 0 && (
                  <div className={styles.salaryOverrideBanner} role="status">
                    <span>
                      ℹ️ Manual salary override active ({formatInr(parseFloat(manualSalary))}/month).
                      Underwriting &amp; FOIR metrics dynamically updated.
                    </span>
                  </div>
                )}

                {/* Detected Credits Table */}
                {rawAnalysis && rawAnalysis.salary.credits.length > 0 ? (
                  <div className={styles.salaryTableResponsive}>
                    <table className={styles.salaryTable}>
                      <thead>
                        <tr>
                          <th style={{ width: 40, textAlign: "center" }}>Select</th>
                          <th>Month</th>
                          <th className={styles.textRight}>Amount</th>
                          <th>Narration (first 40 chars)</th>
                          <th>Detection Type</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rawAnalysis.salary.credits.map((c) => {
                          const key = `${new Date(c.date).getTime()}-${c.amount}`;
                          const isChecked = selectedCreditKeys.has(key);
                          return (
                            <tr key={key} style={{ opacity: isChecked ? 1 : 0.45 }}>
                              <td style={{ textAlign: "center" }}>
                                <input
                                  type="checkbox"
                                  className={styles.checkboxInput}
                                  checked={isChecked}
                                  onChange={() => handleToggleCredit(key)}
                                />
                              </td>
                              <td style={{ fontWeight: 600 }}>
                                {formatMonthYear(c.date)}
                              </td>
                              <td className={`${styles.textRight} ${styles.creditText}`}>
                                {formatInr(c.amount)}
                              </td>
                              <td style={{ color: "#475569" }}>
                                {c.narration.length > 40
                                  ? c.narration.slice(0, 40) + "..."
                                  : c.narration}
                              </td>
                              <td>
                                <span className={styles.salaryReasonTag}>
                                  {c.reason === "keyword"
                                    ? "Keyword"
                                    : "Recurring Sender"}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className={styles.loanPromptBox}>
                    No salary credits detected via keyword or recurring electronic transfers.
                    FOIR evaluated on total credit inflows. Enter salary manually above if needed.
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Non-Salary Inflow Breakdown Card */}
          {analysisData.otherCredits && (
            <section className={styles.otherCreditsCard}>
              <h2 className={styles.gridTitle} style={{ margin: 0, marginBottom: 8 }}>
                Non-Salary Inflow Breakdown
              </h2>

              {/* Top line */}
              <div className={styles.otherCreditsTopLine}>
                Salary accounts for {Math.round(analysisData.otherCredits.salaryPct)}% of total credit inflows; remaining{" "}
                {Math.round(analysisData.otherCredits.pctOfTotalCredit)}% is received from other sources.
              </div>

              {/* Red banner if any high risk item is present */}
              {analysisData.otherCredits.items.some((i) => i.risk === "high") && (
                <div className={styles.otherHighRiskBanner} role="alert">
                  <span>
                    ⚠️ Caution: Instant lending app or loan disbursal credit detected. Verify client&apos;s active borrowing liabilities.
                  </span>
                </div>
              )}

              {/* Amber note if self transfer > 20% of total credits */}
              {(() => {
                const totalCreditSum = analysisData.monthlyTable.reduce(
                  (sum, r) => sum + r.credit,
                  0
                );
                const selfTransferTotal =
                  analysisData.otherCredits.byCategory.SELF_TRANSFER?.total || 0;
                return totalCreditSum > 0 && selfTransferTotal / totalCreditSum > 0.2 ? (
                  <div className={styles.otherSelfTransferBanner} role="note">
                    <span>⚠️ High self-transfers detected (&gt;20% of credits). Inward transfers between own accounts may indicate overstated net income.</span>
                  </div>
                ) : null;
              })()}

              {/* Category Chips */}
              <div className={styles.categoryChipsGrid}>
                {CATEGORY_ORDER.map((cat) => {
                  const catData =
                    analysisData.otherCredits.byCategory[cat] || {
                      count: 0,
                      total: 0,
                    };
                  const isHigh =
                    (cat === "LENDING_APP" || cat === "LOAN_LIKE") &&
                    catData.count > 0;
                  const isMedium =
                    (cat === "SELF_TRANSFER" ||
                      cat === "WALLET" ||
                      cat === "BROKER" ||
                      cat === "CASH" ||
                      cat === "UPI_PERSON") &&
                    catData.count > 0;
                  const isMuted = catData.count === 0;

                  return (
                    <div
                      key={cat}
                      className={`${styles.categoryChip} ${
                        isHigh
                          ? styles.categoryChipHigh
                          : isMedium
                          ? styles.categoryChipMedium
                          : isMuted
                          ? styles.categoryChipMuted
                          : ""
                      }`}
                    >
                      <span className={styles.chipName}>
                        {CATEGORY_LABELS[cat] || cat}
                      </span>
                      <span className={styles.chipStats}>
                        {catData.count} txn{catData.count === 1 ? "" : "s"} •{" "}
                        {formatInr(catData.total)}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Table of Non-Salary Transactions */}
              {analysisData.otherCredits.items.length > 0 ? (
                <div className={styles.otherTableResponsive}>
                  <table className={styles.otherTable}>
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th className={styles.textRight}>Amount</th>
                        <th>Category</th>
                        <th>Risk</th>
                        <th>Narration</th>
                      </tr>
                    </thead>
                    <tbody>
                      {analysisData.otherCredits.items.map((item, idx) => (
                        <tr
                          key={idx}
                          className={
                            item.risk === "high"
                              ? styles.rowHighRisk
                              : item.risk === "medium"
                              ? styles.rowMediumRisk
                              : styles.rowLowRisk
                          }
                        >
                          <td style={{ whiteSpace: "nowrap", fontWeight: 600 }}>
                            {formatDate(item.date)}
                          </td>
                          <td
                            className={`${styles.textRight} ${styles.creditText}`}
                            style={{ whiteSpace: "nowrap" }}
                          >
                            {formatInrPrecise(item.amount)}
                          </td>
                          <td>
                            <span className={styles.catBadge}>
                              {CATEGORY_LABELS[item.category] || item.category}
                            </span>
                          </td>
                          <td>
                            <span
                              className={
                                item.risk === "high"
                                  ? styles.badgeRiskHigh
                                  : item.risk === "medium"
                                  ? styles.badgeRiskMedium
                                  : styles.badgeRiskLow
                              }
                            >
                              {item.risk}
                            </span>
                          </td>
                          <td
                            className={styles.narrationCell}
                            title={item.narration}
                          >
                            {item.narration.length > 50
                              ? item.narration.slice(0, 50) + "..."
                              : item.narration}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className={styles.loanPromptBox}>
                  No non-salary credit inflows detected in this statement period.
                </div>
              )}
            </section>
          )}

          {/* Grid of Key Financial Metrics */}
          <div>
            <h2 className={styles.gridTitle}>Key Financial Metrics</h2>
            <div className={styles.metricGrid}>
              {/* 1. Avg Monthly Salary (FOIR Basis) */}
              <div className={styles.metricCard}>
                <span className={styles.metricLabel}>Avg Monthly Salary</span>
                <span className={styles.metricValue}>
                  {formatInr(analysisData.avgSalary)}
                </span>
                <span className={styles.metricSubtext}>
                  Verified salary credits basis for FOIR
                </span>
              </div>

              {/* 2. Month-End Avg Balance (New Scoring Basis) */}
              <div className={styles.metricCard}>
                <span className={styles.metricLabel}>Month-End Avg Balance</span>
                <span className={styles.metricValue}>
                  {formatInr(analysisData.monthEndAvgBalance)}
                </span>
                <span className={styles.metricSubtext}>
                  Average of month-end balances (used in scoring)
                </span>
              </div>

              {/* 3. Avg txn balance (ABB) */}
              <div className={styles.metricCard}>
                <span className={styles.metricLabel}>Avg txn balance (ABB)</span>
                <span className={styles.metricValue}>
                  {formatInr(analysisData.abb)}
                </span>
                <span className={styles.metricSubtext}>
                  Average across all transaction balances
                </span>
              </div>

              {/* 4. Monthly EMI */}
              <div className={styles.metricCard}>
                <span className={styles.metricLabel}>
                  {analysisData.usedFullMonths
                    ? "EMI (poore mahino ka avg)"
                    : "Monthly EMI / NACH"}
                </span>
                <span className={styles.metricValue}>
                  {formatInr(analysisData.monthlyEmi)}
                </span>
                <span className={styles.metricSubtext}>
                  Active monthly loan & EMI obligations
                </span>
              </div>

              {/* 5. FOIR */}
              <div className={styles.metricCard}>
                <span className={styles.metricLabel}>FOIR (Obligation Ratio)</span>
                <span className={styles.metricValue}>
                  {analysisData.foir.toLocaleString("en-IN", {
                    maximumFractionDigits: 1,
                  })}
                  %
                </span>
                <span className={styles.metricSubtext}>
                  Monthly EMI / Avg Salary
                </span>
              </div>

              {/* 6. Estimated New EMI Capacity */}
              <div className={styles.metricCard}>
                <span className={styles.metricLabel}>New EMI Capacity</span>
                <span className={styles.metricValue}>
                  {analysisData.emiCapacity !== null
                    ? formatInr(analysisData.emiCapacity)
                    : "N/A"}
                </span>
                <span className={styles.metricSubtext}>
                  Estimated available EMI room (50% salary ceiling)
                </span>
              </div>

              {/* 7. Cheque / NACH Bounces */}
              <div className={styles.metricCard}>
                <span className={styles.metricLabel}>Cheque / NACH Bounces</span>
                <span className={styles.metricValue}>
                  {analysisData.bounces.toLocaleString("en-IN")}
                </span>
                <span className={styles.metricSubtext}>
                  Inward clearing and ECS bounce count
                </span>
              </div>

              {/* 8. Cash Deposit Share */}
              <div className={styles.metricCard}>
                <span className={styles.metricLabel}>Cash Deposit Ratio</span>
                <span className={styles.metricValue}>
                  {analysisData.cashPct.toLocaleString("en-IN", {
                    maximumFractionDigits: 1,
                  })}
                  %
                </span>
                <span className={styles.metricSubtext}>
                  Cash / CDM deposits vs total inflow
                </span>
              </div>

              {/* 9. Avg Monthly Inflow (Informational) */}
              <div className={styles.metricCard}>
                <span className={styles.metricLabel}>Avg Monthly Inflow</span>
                <span className={styles.metricValue}>
                  {formatInr(analysisData.avgMonthlyCredit)}
                </span>
                <span className={styles.metricSubtext}>
                  Total credits / {analysisData.months} month(s) (informational)
                </span>
              </div>
            </div>
          </div>

          {/* New Loan Check Section (Interactive FOIR Calculator) */}
          <section className={styles.loanCheckCard}>
            <div className={styles.loanCheckHeader}>
              <h2 className={styles.gridTitle} style={{ margin: 0 }}>
                New Loan Eligibility Check
              </h2>
            </div>
            <p className={styles.loanSubtitle}>
              Evaluate post-disbursal FOIR impact and maximum borrowing capacity based on
              verified salary credits and current active monthly EMIs.
            </p>

            {/* Input Controls */}
            <div className={styles.loanFormGrid}>
              <div className={styles.formGroup}>
                <label className={styles.label} htmlFor="proposedLoanAmount">
                  Proposed Loan Amount (₹)
                </label>
                <input
                  id="proposedLoanAmount"
                  type="number"
                  placeholder="Enter loan amount (₹)..."
                  className={styles.textInput}
                  value={loanAmount}
                  onChange={(e) => setLoanAmount(e.target.value)}
                  min="0"
                  step="10000"
                />
              </div>

              <div className={styles.formGroup}>
                <label className={styles.label} htmlFor="proposedInterestRate">
                  Interest Rate (% p.a.)
                </label>
                <input
                  id="proposedInterestRate"
                  type="number"
                  className={styles.textInput}
                  value={loanRate}
                  onChange={(e) => setLoanRate(parseFloat(e.target.value) || 0)}
                  min="1"
                  max="40"
                  step="0.25"
                />
              </div>

              <div className={styles.formGroup}>
                <label className={styles.label} htmlFor="proposedTenureYears">
                  Tenure (Years)
                </label>
                <input
                  id="proposedTenureYears"
                  type="number"
                  className={styles.textInput}
                  value={loanTenureYears}
                  onChange={(e) =>
                    setLoanTenureYears(parseInt(e.target.value, 10) || 1)
                  }
                  min="1"
                  max="30"
                  step="1"
                />
              </div>
            </div>

            {/* Salary Fallback Note */}
            {salaryNotRecognized && (
              <div className={styles.loanSalaryNote} role="note">
                <span>
                  ⚠️ Salary credits were not clearly detected; FOIR is estimated from overall credit inflows.
                </span>
              </div>
            )}

            {/* Calculation Result Display */}
            {loanCheckResult ? (
              <div>
                {/* Highlighted Warning Note: current Pass, new Fail */}
                {currentPassNewFail && (
                  <div className={styles.loanAlertNote} role="alert">
                    <span>
                      ⚠️ Current FOIR is within acceptable limits, but proposed new loan will breach the bank limit.
                    </span>
                  </div>
                )}

                {/* Side-by-Side FOIR Cards */}
                <div className={styles.loanFoirGrid}>
                  {/* Card 1: Current FOIR */}
                  <div className={styles.loanFoirCard}>
                    <div className={styles.loanFoirTitleRow}>
                      <span className={styles.loanFoirLabel}>Current FOIR</span>
                      <span
                        className={
                          loanCheckResult.currentFoir <= LOAN_CONFIG.foirLimit
                            ? styles.badgePass
                            : styles.badgeFail
                        }
                      >
                        {loanCheckResult.currentFoir <= LOAN_CONFIG.foirLimit
                          ? "Pass"
                          : "Fail"}
                      </span>
                    </div>
                    <div className={styles.loanFoirValue}>
                      {loanCheckResult.currentFoir.toLocaleString("en-IN", {
                        maximumFractionDigits: 1,
                      })}
                      %
                    </div>
                    <span className={styles.metricSubtext}>
                      Current EMI: {formatInr(analysisData.monthlyEmi)} / month
                      (Bank limit: {LOAN_CONFIG.foirLimit}%)
                    </span>
                  </div>

                  {/* Card 2: FOIR After New Loan */}
                  <div className={styles.loanFoirCard}>
                    <div className={styles.loanFoirTitleRow}>
                      <span className={styles.loanFoirLabel}>
                        FOIR After New Loan
                      </span>
                      <span
                        className={
                          loanCheckResult.status === "Pass"
                            ? styles.badgePass
                            : loanCheckResult.status === "Borderline"
                            ? styles.badgeBorderline
                            : styles.badgeFail
                        }
                      >
                        {loanCheckResult.status}
                      </span>
                    </div>
                    <div className={styles.loanFoirValue}>
                      {loanCheckResult.newFoir.toLocaleString("en-IN", {
                        maximumFractionDigits: 1,
                      })}
                      %
                    </div>
                    <span className={styles.metricSubtext}>
                      Status: {loanCheckResult.status} (Thresholds:{" "}
                      {LOAN_CONFIG.foirBorderline}% / {LOAN_CONFIG.foirLimit}%)
                    </span>
                  </div>
                </div>

                {/* Breakdown Line */}
                <div className={styles.loanBreakdownRow}>
                  Proposed EMI {formatInr(loanCheckResult.newEmi)} + Existing EMI{" "}
                  {formatInr(analysisData.monthlyEmi)} = Total Obligation{" "}
                  {formatInr(loanCheckResult.totalEmi)} / month
                </div>

                {/* Maximum Loan Capacity Line */}
                <div className={styles.loanMaxCapacityRow}>
                  Maximum estimated borrowing capacity on this income: ₹
                  {loanCheckResult.maxLoanAmount.toLocaleString("en-IN")} (at{" "}
                  {loanRate}%, {loanTenureYears} years)
                </div>
              </div>
            ) : null}
          </section>

          {/* Underwriting Risk Signals Card */}
          <section className={styles.reasonsCard}>
            <h2 className={styles.gridTitle}>Underwriting Risk Signals</h2>
            <div className={styles.marketGrid}>
              <div className={styles.marketSubCard}>
                <div className={styles.marketSubLabel}>Pass-Through Ratio</div>
                <div className={styles.marketSubValue}>
                  {analysisData.passThroughPct.toLocaleString("en-IN", {
                    maximumFractionDigits: 1,
                  })}
                  %
                </div>
                <span className={styles.metricSubtext}>
                  Salary debited within 3 days
                </span>
              </div>

              <div className={styles.marketSubCard}>
                <div className={styles.marketSubLabel}>Salary Regularity</div>
                <div className={styles.marketSubValue}>
                  {Math.round(analysisData.salaryRegularity * 100)}%
                </div>
                <span className={styles.metricSubtext}>
                  Months with salary credit
                </span>
              </div>

              <div className={styles.marketSubCard}>
                <div className={styles.marketSubLabel}>Instant Loan Apps</div>
                <div className={styles.marketSubValue}>
                  {analysisData.lendingApps.count}{" "}
                  <span style={{ fontSize: 13, fontWeight: 500 }}>
                    ({formatInr(analysisData.lendingApps.total)})
                  </span>
                </div>
                <span className={styles.metricSubtext}>
                  Fintech / short-term apps
                </span>
              </div>

              <div className={styles.marketSubCard}>
                <div className={styles.marketSubLabel}>One-Off Large Credits</div>
                <div className={styles.marketSubValue}>
                  {analysisData.oneOffCredits.count}{" "}
                  <span style={{ fontSize: 13, fontWeight: 500 }}>
                    ({formatInr(analysisData.oneOffCredits.total)})
                  </span>
                </div>
                <span className={styles.metricSubtext}>
                  Credits &ge; 2x monthly salary
                </span>
              </div>

              <div className={styles.marketSubCard}>
                <div className={styles.marketSubLabel}>Insurance Premium</div>
                <div className={styles.marketSubValue}>
                  {formatInr(analysisData.insurancePayments || 0)}
                </div>
                <span className={styles.metricSubtext}>
                  LIC / health &amp; life policies (non-EMI)
                </span>
              </div>

              <div className={styles.marketSubCard}>
                <div className={styles.marketSubLabel}>Credit Card Bill Debits</div>
                <div className={styles.marketSubValue}>
                  {formatInr(analysisData.creditCardPayments)}
                </div>
                <span className={styles.metricSubtext}>
                  Total credit card payments
                </span>
              </div>

              <div className={styles.marketSubCard}>
                <div className={styles.marketSubLabel}>Wallet Inflow / Outflow</div>
                <div className={styles.marketSubValue} style={{ fontSize: 14 }}>
                  In: {formatInr(analysisData.wallet.walletIn)} | Out:{" "}
                  {formatInr(analysisData.wallet.walletOut)}
                </div>
                <span className={styles.metricSubtext}>
                  Credits: {analysisData.wallet.walletPctOfCredit}% | Debits:{" "}
                  {analysisData.wallet.walletPctOfDebit}%
                </span>
              </div>
            </div>
          </section>

          {/* Credit Risk & Scoring Evaluation Factors */}
          <section className={styles.reasonsCard}>
            <h2 className={styles.gridTitle}>Credit Evaluation Factors</h2>
            <div className={styles.reasonsList}>
              {analysisData.reasons.map((r, i) => (
                <div
                  key={i}
                  className={`${styles.reasonItem} ${
                    r.type === "positive"
                      ? styles.reasonPositive
                      : styles.reasonNegative
                  }`}
                >
                  <span className={styles.reasonIcon}>
                    {r.type === "positive" ? "✓" : "✗"}
                  </span>
                  <span>{r.text}</span>
                </div>
              ))}
            </div>
          </section>

          {/* Credit Card / Wallet Rotation Detection Card */}
          {/* Round-trip transactions (suspected) section */}
          {analysisData.roundTrip && analysisData.roundTrip.count > 0 && (
            <section className={styles.rotationCard}>
              <div className={styles.marketHeader}>
                <h2 className={styles.gridTitle} style={{ margin: 0 }}>
                  Round-trip transactions (suspected)
                </h2>
                <span
                  className={
                    analysisData.roundTrip.suspected
                      ? styles.rotationTagRed
                      : styles.rotationTagNormal
                  }
                >
                  {analysisData.roundTrip.suspected
                    ? "⚠️ Rotation Suspected"
                    : "ℹ️ Rapid In-Out Detected"}
                </span>
              </div>

              <div
                className={`${styles.marketSummaryBox} ${
                  analysisData.roundTrip.suspected
                    ? styles.marketSummaryDanger
                    : styles.marketSummaryNormal
                }`}
              >
                ℹ️ {analysisData.roundTrip.count} pair(s) detected with equal amount (₹
                {formatInr(analysisData.roundTrip.volume)}) credited and debited within 0-1 day (
                {analysisData.roundTrip.pctOfCredits}% of total credits).
              </div>

              <div className={styles.tableResponsive}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Amount</th>
                      <th>Debit Date</th>
                      <th>Debit Narration</th>
                      <th>Credit Date</th>
                      <th>Credit Narration</th>
                      <th>Gap</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysisData.roundTrip.pairs.slice(0, 10).map((p, idx) => (
                      <tr key={idx}>
                        <td style={{ fontWeight: 600 }}>{formatInr(p.amount)}</td>
                        <td>{formatDate(p.debitDate)}</td>
                        <td className={styles.narrationCell} title={p.debitNarration}>
                          {p.debitNarration.length > 30
                            ? p.debitNarration.slice(0, 30) + "..."
                            : p.debitNarration}
                        </td>
                        <td>{formatDate(p.creditDate)}</td>
                        <td className={styles.narrationCell} title={p.creditNarration}>
                          {p.creditNarration.length > 30
                            ? p.creditNarration.slice(0, 30) + "..."
                            : p.creditNarration}
                        </td>
                        <td>{p.diffDays === 0 ? "Same Day" : "Next Day"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section className={styles.rotationCard}>
            <div className={styles.marketHeader}>
              <h2 className={styles.gridTitle} style={{ margin: 0 }}>
                Credit Card & Wallet Rotation Detection
              </h2>
              <span
                className={
                  analysisData.walletRotation.isSuspected
                    ? styles.rotationTagRed
                    : styles.rotationTagGreen
                }
              >
                {analysisData.walletRotation.isSuspected
                  ? "⚠️ Rotation Suspected"
                  : "✓ Clean Inflow"}
              </span>
            </div>

            <div
              className={`${styles.marketSummaryBox} ${
                analysisData.walletRotation.isSuspected
                  ? styles.marketSummaryDanger
                  : styles.marketSummaryNormal
              }`}
            >
              ℹ️ {analysisData.walletRotation.summary}
            </div>

            <div className={styles.marketGrid}>
              <div className={styles.marketSubCard}>
                <div className={styles.marketSubLabel}>Wallet Inflows</div>
                <div className={styles.marketSubValue}>
                  {formatInr(analysisData.walletRotation.walletCredits)}
                </div>
              </div>

              <div className={styles.marketSubCard}>
                <div className={styles.marketSubLabel}>Inflow Share</div>
                <div className={styles.marketSubValue}>
                  {analysisData.walletRotation.walletPct.toLocaleString("en-IN", {
                    maximumFractionDigits: 1,
                  })}
                  %
                </div>
              </div>

              <div className={styles.marketSubCard}>
                <div className={styles.marketSubLabel}>Credit Card Payments</div>
                <div className={styles.marketSubValue}>
                  {formatInr(analysisData.walletRotation.ccDebits)}
                </div>
              </div>

              <div className={styles.marketSubCard}>
                <div className={styles.marketSubLabel}>
                  Real Adjusted Credit
                </div>
                <div className={styles.marketSubValue}>
                  {formatInr(analysisData.walletRotation.adjustedMonthlyCredit)}
                </div>
              </div>
            </div>
          </section>

          {/* Share Market Activity Card (Traders flagged in RED) */}
          <section className={styles.marketCard}>
            <div className={styles.marketHeader}>
              <h2 className={styles.gridTitle} style={{ margin: 0 }}>
                Share Market & Broker Exposure
              </h2>
              <span
                className={`${styles.marketTag} ${
                  analysisData.market.heavy || analysisData.market.isActive
                    ? styles.marketTagRed
                    : styles.marketTagNormal
                }`}
              >
                {analysisData.market.heavy
                  ? "⚠️ Heavy Trader (High Risk)"
                  : analysisData.market.isActive
                  ? "⚠️ Active Trader (Risk)"
                  : "Normal Investment Activity"}
              </span>
            </div>

            <div
              className={`${styles.marketSummaryBox} ${
                analysisData.market.heavy || analysisData.market.isActive
                  ? styles.marketSummaryDanger
                  : styles.marketSummaryNormal
              }`}
            >
              ℹ️ {analysisData.market.summary}
            </div>

            <div className={styles.marketGrid}>
              <div className={styles.marketSubCard}>
                <div className={styles.marketSubLabel}>Broker Investments</div>
                <div className={styles.marketSubValue}>
                  {formatInr(analysisData.market.invested)}
                </div>
              </div>

              <div className={styles.marketSubCard}>
                <div className={styles.marketSubLabel}>Broker Withdrawals</div>
                <div className={styles.marketSubValue}>
                  {formatInr(analysisData.market.withdrawn)}
                </div>
              </div>

              <div className={styles.marketSubCard}>
                <div className={styles.marketSubLabel}>Net Position</div>
                <div className={styles.marketSubValue}>
                  {formatInr(analysisData.market.net)}
                </div>
              </div>

              <div className={styles.marketSubCard}>
                <div className={styles.marketSubLabel}>Mutual Fund / SIP Total</div>
                <div className={styles.marketSubValue}>
                  {formatInr(analysisData.market.sip)}
                </div>
              </div>
            </div>
          </section>

          {/* Month-wise Breakdown Table */}
          <section className={styles.tableCard}>
            <h2 className={styles.gridTitle}>Monthly Breakdown Summary</h2>
            <div className={styles.tableResponsive}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Month</th>
                    <th className={styles.textRight}>Total Credit</th>
                    <th className={styles.textRight}>Total Debit</th>
                    <th className={styles.textRight}>Closing Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {analysisData.monthlyTable.map((row) => (
                    <tr key={row.monthKey}>
                      <td>{row.month}</td>
                      <td className={`${styles.textRight} ${styles.creditText}`}>
                        {formatInrPrecise(row.credit)}
                      </td>
                      <td className={`${styles.textRight} ${styles.debitText}`}>
                        {formatInrPrecise(row.debit)}
                      </td>
                      <td className={`${styles.textRight} ${styles.balanceText}`}>
                        {formatInrPrecise(row.closingBalance)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </main>
      )}
    </div>
  );
}
