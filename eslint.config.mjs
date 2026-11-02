// Root ESLint config for every workspace except apps/web, which has its own (ESLint 10 finds the nearest
// eslint.config.* per file, so the two never merge). Recommended JS + TS rules plus braces on every block.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: { curly: ['error', 'all'] },
  },
  {
    ignores: [
      '.claude/**',
      '.scratch/**',
      '**/.venv/**',
      'apps/web/.next/**',
      '**/test-results/**',
      '**/playwright-report/**',
      'apps/web/e2e/ai/runs/**',
      'infra/**',
      'evals/fiftyone/**',
      'apps/detector/export/**',
    ],
  },
);
