import js from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'apps/web/src/components/ui/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { boundaries },
    settings: {
      'boundaries/elements': [
        { type: 'core', pattern: 'packages/core/**' },
        { type: 'infrastructure', pattern: 'packages/infrastructure/**' },
        { type: 'application', pattern: 'apps/*/**' }
      ]
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'boundaries/dependencies': ['error', {
        default: 'allow',
        policies: [
          { from: { element: { type: 'core' } }, disallow: { to: { element: { type: 'infrastructure' } } } },
          { from: { element: { type: 'core' } }, disallow: { to: { module: { source: ['@slacato/infrastructure', '@nestjs/*', 'bullmq', 'react', 'react-dom'] } } } }
        ]
      }]
    }
  }
);
