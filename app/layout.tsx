import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Statement Check - Loan DSA",
  description: "Bank statement health check for loan eligibility",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0, backgroundColor: "#f8fafc" }}>
        {children}
      </body>
    </html>
  );
}
