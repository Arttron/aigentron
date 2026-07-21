import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const monorepoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Otherwise Next infers the tracing root from whichever lockfile is nearest
  // *upward* on disk — on a dev machine with a stray root-level lockfile
  // outside the repo, that silently traces (and standalone-copies) the wrong
  // tree entirely. Pin it to the actual monorepo root, which is also what
  // lets file tracing find sibling workspace packages (@lds/shared).
  outputFileTracingRoot: monorepoRoot,
  // @lds/shared ships compiled JS; transpile it so its exports resolve cleanly.
  transpilePackages: ['@lds/shared'],
  // Linting is run via the monorepo's root eslint, not at build time.
  eslint: { ignoreDuringBuilds: true },
  // Minimal/single-container profile (docs/plan-single-container.md Phase 4):
  // a self-contained server.js + pruned node_modules, so the runtime image
  // doesn't need the full monorepo install. The `full` profile's dev compose
  // uses `next dev`/`next start` directly and never touches this output.
  output: 'standalone',
};

export default nextConfig;
