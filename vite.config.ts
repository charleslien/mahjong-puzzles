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
  },
});
