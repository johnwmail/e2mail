const js = require('@eslint/js');
const reactPlugin = require('eslint-plugin-react');
const reactHooks = require('eslint-plugin-react-hooks');
const globals = require('globals');
const babelParser = require('@babel/eslint-parser');

/**
 * eslint-config-expo (and typescript-eslint) crash on TypeScript 7
 * (`ts-api-utils` reads SyntaxKind.Intrinsic, which is not on the TS 7 API).
 * Typecheck stays on `tsc` 7; lint parses TS/TSX through Babel instead.
 */
module.exports = [
  js.configs.recommended,
  {
    ignores: ['.expo/**', 'dist/**', 'coverage/**', 'node_modules/**'],
  },
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          presets: ['babel-preset-expo'],
        },
      },
      globals: {
        ...globals.node,
        ...globals.jest,
        ...globals.es2024,
        fetch: 'readonly',
        Headers: 'readonly',
        FormData: 'readonly',
        Response: 'readonly',
      },
    },
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooks,
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      // Type names are erased; tsc (TypeScript 7) is the unused/undef checker.
      'no-undef': 'off',
      'no-unused-vars': 'off',
    },
  },
];
