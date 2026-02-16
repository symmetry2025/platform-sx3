/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // MVP production: don't fail image build due to existing lint debt.
  eslint: { ignoreDuringBuilds: true },
  webpack: (config, ctx) => {
    // In dev we observed frequent corruption of filesystem webpack cache (missing chunks / broken _next/static).
    // Switching to memory cache makes dev-server stable at the cost of a bit slower rebuilds.
    if (ctx.dev) {
      config.cache = { type: 'memory' };
    }
    return config;
  },
};

export default nextConfig;

