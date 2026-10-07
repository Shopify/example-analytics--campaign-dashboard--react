import {defineConfig} from 'vitest/config';

// Runs without the React Router plugin. Route modules import as plain ES modules.
export default defineConfig({
  esbuild: {jsx: 'automatic'},
  test: {environment: 'node', include: ['test/**/*.test.{js,jsx}']},
});
