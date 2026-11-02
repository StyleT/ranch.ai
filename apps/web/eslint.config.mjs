import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

export default [
  ...nextVitals,
  ...nextTs,
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'test-results/**',
      'playwright-report/**',
      'e2e/ai/runs/**',
      'next-env.d.ts',
    ],
  },
  {
    rules: {
      '@next/next/no-img-element': 'off',
      curly: ['error', 'all'],
      'react/no-array-index-key': 'error',
      'react/jsx-no-bind': 'warn',
      'react/no-multi-comp': 'error',
    },
  }, // frames come from our own resize proxy; next/image adds nothing
];
