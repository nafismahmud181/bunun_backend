import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'src/generated', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // k6 scripts run in k6's own runtime, which provides these globals.
  {
    files: ['loadtest/**/*.js'],
    languageOptions: { globals: { __ENV: 'readonly', __VU: 'readonly', __ITER: 'readonly', open: 'readonly' } },
  },
);
