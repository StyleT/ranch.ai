import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

export default [
  ...nextVitals,
  ...nextTs,
  { ignores: ['.next/**', 'node_modules/**', 'test-results/**', 'playwright-report/**', 'e2e/ai/runs/**', 'next-env.d.ts'] },
  { rules: { '@next/next/no-img-element': 'off' } }, // frames come from our own resize proxy; next/image adds nothing
];
