# NOTICE

ClassworksLite 是 [Classworks](https://github.com/Moonrend/Classworks) 的 Serverless 重写版本。

- 上游项目：Classworks — 适用于班级大屏的作业板小工具
- 上游作者：SunWuyuan / ZeroCat 社区
- 上游许可：GNU Affero General Public License v3.0

本项目复用了上游的信息架构、界面文案、交互范式与数据键名（`classworks-data-YYYYMMDD`、
`classworks-list-main`、`classworks-config-subject`），前端与后端均为重新实现：

| 部分 | 上游实现 | 本项目实现 |
| --- | --- | --- |
| 前端框架 | Vue 3 + Vuetify 3 | React 19 + Tailwind CSS 4（复刻 Material 3 视觉） |
| 后端 | Express 5 + Prisma + PostgreSQL + Socket.IO | 单个 Serverless 函数 + KV / Redis |
| 实时同步 | Socket.IO 长连接 | 轮询 + BroadcastChannel |
| 噪音监测 | `@wydev/noise-core` | Web Audio API 本地实现（`src/lib/noise.ts`） |
| 构建 | Vite + pnpm monorepo | Vite + npm 单包 |

以下文件直接来自上游或上游工具链：

- `src/vendor/uaf/browser.js`：UAF PDF 浏览器 bundle（AGPL-3.0）
- `public/uaf/HarmonyOS_Sans_SC_*.ttf`、`public/uaf/hb-subset.wasm`：UAF 导出所需字体与子集化 WASM
- 界面文案与设置项描述：沿用上游 `settings.js` 与各 `.vue` 组件

依据 AGPL-3.0，本项目同样以 AGPL-3.0 发布，完整许可文本见 `LICENSE`。
