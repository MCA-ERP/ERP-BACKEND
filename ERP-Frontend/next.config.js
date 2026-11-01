/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // ── Build Speed Optimisations ──────────────────────────────────
  // SWC (Rust-based) minifier — 10–20× faster than Terser
  swcMinify: true,

  // Skip ESLint during build → saves 2–4 min (run lint separately)
  eslint: {
    ignoreDuringBuilds: true,
  },

  // Skip TypeScript type-check during build → saves 1–2 min
  typescript: {
    ignoreBuildErrors: true,
  },

  // Disable source maps → smaller output, faster finalization
  productionBrowserSourceMaps: false,

  // ── CRITICAL: Disable output file tracing ─────────────────────
  // Next.js 13 "Collecting build traces" uses @vercel/nft which
  // tries to resolve 1000+ modules including `typescript` at runtime.
  // On Node 16 / Windows this hangs for 5–15 minutes or errors out.
  // Disabling it makes the build finish in ~30s after compilation.
  output: undefined,
  outputFileTracing: false,
};

module.exports = nextConfig;
