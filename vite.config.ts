import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { devKV } from './server/dev-kv-plugin'

// 构建产物为纯静态资源，可部署到任意 CDN / Serverless 平台。
// 云同步走 /api/kv：生产环境由 Cloudflare Functions / Worker / Vercel 提供，
// 本地开发由 devKV 插件落到 .data/kv.json。
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
