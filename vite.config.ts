import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ['@duckdb/duckdb-wasm'],
  },
  server: {
    // hostを明示しないと環境によってIPv6([::1])のみにbindされ、ブラウザが
    // http://localhost:5173 をIPv4(127.0.0.1)で引いた時に繋がらないことがある
    host: '127.0.0.1',
    headers: {
      // DuckDB-wasm の SharedArrayBuffer に必要
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  },
})
