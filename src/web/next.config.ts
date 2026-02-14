import { resolve } from 'path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The live agent widget runs on the Vite dev server (port 5173) or backend (port 3000).
  // Allow embedding via iframe by proxying API calls if needed in the future.

  // Silence "inferred workspace root" warning caused by multiple lockfiles in the monorepo.
  outputFileTracingRoot: resolve(__dirname),
};

export default nextConfig;
