import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import svelte from 'eslint-plugin-svelte'
import globals from 'globals'
import svelteParser from 'svelte-eslint-parser'
import tsParser from '@typescript-eslint/parser'

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs['flat/recommended'],
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node
      },
      parser: tsParser,
      parserOptions: {
        projectService: true,
        extraFileExtensions: ['.svelte']
      }
    },
    rules: {
      'no-multiple-empty-lines': ['error', { max: 2, maxBOF: 2, maxEOF: 0 }],
      // Disable rules that flag pre-existing code patterns
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/prefer-as-const': 'off',
      'no-undef': 'off', // Svelte has its own scoping
      'no-constant-binary-expression': 'off',
      'svelte/no-reactive-reassign': 'off',
      'svelte/infinite-reactive-loop': 'off',
      'svelte/require-each-key': 'off',
      'svelte/require-event-dispatcher-types': 'off',
      'svelte/no-at-html-tags': 'off'
    }
  },
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parser: svelteParser,
      parserOptions: {
        parser: tsParser,
        projectService: true,
        extraFileExtensions: ['.svelte']
      }
    },
    rules: {
      '@typescript-eslint/no-unused-vars': 'off' // Disable for Svelte files - too many false positives
    }
  },
  {
    ignores: ['node_modules/*', 'dist/*', 'src-tauri/*', '*.json', '.eslintrc.cjs', 'eslint.config.js', 'vite.config.ts', 'svelte.config.js']
  }
)
