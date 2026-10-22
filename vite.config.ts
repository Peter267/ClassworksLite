import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { devKV } from './server/dev-kv-plugin'

// 构建产物为静态资源，需与 /api/* 同源部署（Pages Functions / Worker / Vercel Functions）。
// 数据读写走 /api/kv：本地开发由 devKV 插件落到 .data/kv.json。
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [react(), tailwindcss(), devKV(env)],
    build: {
      target: 'es2022',
      cssCodeSplit: false,
      rollupOptions: {
        output: {
          manualChunks: {
            vendor: ['react', 'react-dom'],
          },
        },
      },
    },
    server: {
      port: 3031,
      host: true,
    },
    preview: {
      port: 3032,
    },
  }
})
