import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import globals from 'globals';

export default [
  // Base configuration for all files
  {
    ignores: [
      'node_modules/**',
      'build/**',
      'dist/**',
      'coverage/**',
      '*.min.js',
      'app/css/**',
      'packages/*/lib/**',
      'packages/*/build/**',
      'packages/*/dist/**',
    ],
  },

  // JavaScript files
  {
    files: ['**/*.js', '**/*.jsx'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2022,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
    },
  },

  // TypeScript files
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parser: tsparser,
      parserOptions: {
        project: './tsconfig.json',
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2022,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...tseslint.configs.recommended.rules,
      // Disable rules that cause errors in this project
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      'no-undef': 'off',
      'no-case-declarations': 'off',
      'no-debugger': 'off',
      'no-fallthrough': 'off',
      'no-redeclare': 'off',
      'no-empty': 'off',
      'import/no-extraneous-dependencies': 'off',
      'no-control-regex': 'off',
    },
  },

  // Test files
  {
    files: ['**/*.spec.ts', '**/*.spec.tsx', '**/*.test.ts', '**/*.test.tsx'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parser: tsparser,
      parserOptions: {
        project: './tsconfig.json',
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2022,
        ...globals.mocha,
        ...globals.jest,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...tseslint.configs.recommended.rules,
      // Disable rules that cause errors in this project
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      'no-undef': 'off',
      'no-case-declarations': 'off',
      'no-debugger': 'off',
      'no-fallthrough': 'off',
      'no-redeclare': 'off',
      'no-empty': 'off',
      'import/no-extraneous-dependencies': 'off',
      'no-control-regex': 'off',
    },
  },
];
