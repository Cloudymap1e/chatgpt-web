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
      'no-multiple-empty-lines': ['error', { max: 2, maxBOF: 2, maxEOF: 0 }]
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
    }
  },
  {
    ignores: ['node_modules/*', 'dist/*', 'src-tauri/*', '*.json', '.eslintrc.cjs']
  }
)
