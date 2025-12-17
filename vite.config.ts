import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import dsv from '@rollup/plugin-dsv'

import purgecss from '@fullhuman/postcss-purgecss'

const plugins = [svelte(), dsv()]

// https://vitejs.dev/config/
export default defineConfig(({ command, mode, ssrBuild }) => {
  // Only run PurgeCSS in production builds
  if (command === 'build') {
    return {
      plugins,
      css: {
        postcss: {
          plugins: [
            purgecss({
              content: ['./**/*.html', './**/*.svelte'],
              safelist: ['pre', 'code']
            })
          ]
        }
      },
      base: './'
    }
  } else {
    return {
      plugins,
      server: {
        // CORS-free local dev: point the app's "API BASE URI" to this Vite server
        // (e.g. http://<LAN-IP>:5173) and proxy /v1/* to the upstream.
        proxy: {
          '/v1': {
            target: process.env.VITE_UPSTREAM_PROXY_TARGET || 'https://right.codes/codex',
            changeOrigin: true,
            secure: true
          }
        }
      }
    }
  }
})
