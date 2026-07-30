import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Vercel serves from the domain root, so the default base is '/'. Every asset
// reference in the app goes through import.meta.env.BASE_URL, so deploying under
// a subpath instead only needs this overridden — e.g. GitHub Pages would want
// BASE_PATH=/mahjong-puzzles/.
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  plugins: [react()],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The bank audits and the brute-force shanten cross-check are genuinely
    // compute-heavy — recomputing every puzzle's ukeire runs a few seconds
    // locally and longer on a slower CI runner. The 5s default put them right
    // at the edge and they failed in CI while passing locally.
    testTimeout: 60_000,
  },
});
