import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pdfjs-dist"],
  outputFileTracingIncludes: {
    "/api/**/*": ["./node_modules/pdfjs-dist/**/*"],
  },
};

export default nextConfig;
