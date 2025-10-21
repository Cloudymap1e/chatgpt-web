import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import dsv from '@rollup/plugin-dsv'

import purgecss from '@fullhuman/postcss-purgecss'

const plugins = [svelte(), dsv()]

const purgecssConfig = {
  content: ['./**/*.html', './**/*.svelte'],
  safelist: ['pre', 'code']
}

// https://vitejs.dev/config/
export default defineConfig(({ command }) => {
  // Only run PurgeCSS in production builds
  if (command === 'build') {
    return {
      plugins,
      css: {
        postcss: {
          plugins: [
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (purgecss as any).default ? (purgecss as any).default(purgecssConfig) : purgecss(purgecssConfig)
          ]
        }
      },
      base: './'
    }
  } else {
    return {
      plugins
    }
  }
})
