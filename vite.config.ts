import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Deployed at https://<user>.github.io/mahjong-puzzles/, so assets need the repo
// name as the base path. Override with BASE_PATH=/ for a custom domain.
const base = process.env.BASE_PATH ?? '/mahjong-puzzles/';

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
