# ClassworksLite 功能检查报告

检查日期：2026-10-18。检查范围：项目根目录的 ClassworksLite；`_reference` 为上游参考资料，未作为本项目实现进行验收。

**结论：基础功能可运行，但不能认定所有功能均可用。** 构建、正常本地读写、常规编辑、考试管理、UAF 正常日期 PDF 往返等已通过；离线改动、并发保存、日期切换、名单/科目编辑和晚自习自动报告存在已复现的问题，应先处理可能丢失数据的项。

本次未修改业务源码、未部署、未接入真实云存储。新增报告与验证脚本位于 `docs/` 和 `.workbuddy/audit/`；构建更新了 `dist/`。HTTP 写入只使用 `.workbuddy/audit/.data/kv.json` 中的专用测试键，验证后已删除该键。真实班级数据未用于测试。

## 验证方式与边界

| 验证层级 | 执行内容 | 结果 |
| --- | --- | --- |
| 类型检查与生产构建 | `npm run build`，包含 `tsc --noEmit` 和 Vite build | 通过，退出码 0 |
| 实际本地 HTTP | 预览服务器上的 `/`、`/settings`、`/list`、`/exams`、入口 JS/CSS、manifest、图标、UAF 字体/WASM、health、KV CRUD/前缀查询/错误输入 | 通过 |
| 实际 React 渲染 | 真实 `react-dom/server` 渲染四个主要路由 | 4/4 通过；这是组件树渲染验证，不代表浏览器挂载与操作通过 |
| 组件回调检查 | 当前源码转译，使用轻量 hook harness 驱动编辑、名单、科目、考试、随机点名、设置、消息 | 59 项，54 通过、5 失败；5 次失败对应3类问题：出勤断点、自定义操作缺失、列表出勤统计 |
| 数据/API 边界 | 当前源码在隔离 VM 中运行，内存 storage/fetch/KV 替身控制离线和请求完成顺序 | 11 场景，4 通过、7 失败场景；详见数据报告 |
| UAF | 实际加载三种本地字体和 WASM，生成有效 PDF 后再解析和导入 | 24,401 字节 PDF；中文、换行、标签、日期合并及冲突保留通过 |
| 噪音/计时 | 真实组件和服务源码，模拟 AudioContext、授权 promise、时钟和 timer | 正常采样与基础计时通过；自动时段、取消、校准、结束显示及计次边界失败 |
| PWA 缓存逻辑 | 实际 `public/sw.js` 在隔离 Cache/fetch VM 中运行 | 缓存导航和已拦截资源可离线；首次安装未预缓存 JS/CSS，UAF 资源不缓存 |
| 一言外部依赖xiu'fu | 从本地执行环境只读请求主接口和备用接口 | 两者均 HTTP 200，有预期句子字段，CORS 为 `*`；未在真实浏览器执行 |
| 真实浏览器实操 | 两次尝试连接内置浏览器，并请求打开本地预览 | 浏览器 webview attach 超时；未完成真实浏览器验收 |

项目当前没有 `test` 或 `lint` 脚本，本次不是运行已有全量测试套件。各脚本覆盖可能重叠，不能把上述数量相加当作功能通过率。

## 功能覆盖

“部分通过”表示正常路径已执行，但相关边界存在问题。“待实操”表示源码或模拟检查不能替代真实设备验证。

| 功能 | 当前状态 | 检查说明 |
| --- | --- | --- |
| 作业卡片、换行分条、空科目三种显示方式 | 部分通过 | 卡片/按钮/移动 chip 组件分支通过；真实瀑布流、跟随高光、更新发光与各屏幕视觉待实操 |
| 作业编辑、自动保存 | 部分通过 | 关闭提交、Ctrl+Enter、无改动不重复提交通过；输入时停顿2秒并不保存；异步保存和切日期有丢失风险 |
| 粘贴、粘贴并完成、数字键盘、常用字 | 部分通过 | 模拟剪贴板回调通过，插入/删除代码路径已审查；真实权限、光标与软键盘体验待实操 |
| 自定义卡片 | 有缺口 | 正文编辑有实现；改名/删除回调未被编辑组件使用，空卡片无法通过清空删除 |
| 出勤统计与登记 | 部分通过 | 单人互斥、搜索、重置通过；批量状态不互斥、列表统计错误、800–959px入口缺失 |
| 学生名单 | 部分通过 | 逐条增删、文本解析、批量去重及空名单阻止通过；同一会话切批量编辑可覆盖刚刚新增/删除的名单 |
| 科目管理 | 部分通过 | 增加和移动排序通过；改名不迁移作业键，现有作业隐藏 |
| 时间卡片与全屏时钟 | 部分通过 | 组件可渲染，时钟实现已审查；真实全屏与显示体验待实操 |
| 倒计时与秒表 | 有问题 | 提示音回调、首次计次通过；倒计时完成文案不可见，秒表关闭重开后计次可为负数 |
| 一言 | 部分通过 | 两个在线接口当前可达，内置句子兜底有实现；浏览器刷新、离线和超时体验待实操 |
| 随机点名 | 部分通过 | 按姓名/学号、姓名状态排除及结果去重通过；随机排序有明显偏置，数量/学号上限与设置不一致 |
| 考试看板 | 部分通过 | 新增、编辑、删除、考场、日期分组和固定/取消固定回调通过；历史编辑保护可绕过 |
| 日期导航与复制到今天 | 部分通过 | 日期加载和补空缺有实现；连续导航响应可串日，保存失败/历史未上传仍导航丢数据；真实日期选择器体验待实操 |
| 历史保护 | 有问题 | 首页部分入口保护有效，保存确认与禁止编辑未统一覆盖所有入口 |
| 列表视图与打印 | 部分通过 | 真实组件树渲染、科目编辑目标、调用 `window.print` 通过；实到统计错误，真实打印版式待实操 |
| 消息记录 | 部分通过 | 新增、打开、关闭、清空、最多100条、铃铛订阅通过源码与回调检查；视觉待实操 |
| UAF 导出/导入 | 部分通过 | 实际 PDF 往返、导入合并和冲突保留通过；无效日历日期接受，文件/预览竞态静态可见；浏览器预览下载待实操 |
| 环境噪音监测 | 有问题 | 模拟正常采样、分贝基准、安静评分通过；自动报告、跨午夜、并发启动与校准取消失败 |
| 主题、字号、自定义背景 | 部分通过 | 设置写入和消费者有实现；部分开关无消费者、数值越界未拦截、恢复默认未重建同步客户端；真实对比度与布局待实操 |
| 防烧屏提示 | 有实现 | 按设置显示提示卡片；设置本身标为提示卡片，未把它当作真正移动像素的屏幕保护程序 |
| PWA 安装与离线打开 | 未通过完整验收 | 清单/图标/注册代码和已缓存资源回退有实现；首次安装资源未充分预缓存，UAF字体/WASM不缓存；真实安装/离线重开待实操 |
| 本地 KV、云端读写、离线队列 | 部分通过 | 本地实际 HTTP 和基本契约通过，显式 flush 通过；自动衔接和持久化边界可能丢数据 |
| 多标签/多设备同步 | 待实操 | BroadcastChannel 与15秒轮询有实现；真实多标签、可见性事件、跨设备冲突和云平台未验收 |
| Cloudflare/Vercel 部署 | 部分通过 | 适配器用模拟绑定检查通过；Worker部署脚本路径错误，真实绑定/环境变量/平台部署未执行 |

README 已明确设备聊天、紧急通知及上游账号/长连接体系为有意未实现或替换，未将这些列为本次缺陷。

## 优先处理：数据丢失或错写

| 编号 | 复现及影响 | 位置与证据 |
| --- | --- | --- |
| D1 | 云端模式断网保存，关闭页面，联网后重开。初始化先 GET，远端旧值会覆盖本地 pending；404 会删除唯一离线副本。实测 pending 从1变0，flush变0。 | `src/lib/kv.ts:138-145`；`data-api-results.json` |
| D2 | 连续切日期，让第二次请求先返回、第一次后返回。选择日期为 `20261020`，作业来自 `20261019`；后续保存可能把旧日作业写入新日。 | `src/lib/store.ts:202-219`；`data-api-results.json` |
| D3 | 手动保存第一版，响应回来前继续改为第二版。第一版响应无条件清 dirty，第二次保存不再发请求；页面第二版、落盘第一版。 | `src/lib/store.ts:415-434`；`data-api-results.json` |
| D4 | 保存收到401失败后切日期；或默认禁非当天自动保存时编辑历史、尚未上传便切日期。导航继续清 board/dirty，原改动丢失。 | `src/lib/store.ts:244-262`；`data-api-results.json`、`ui-logic-results.json` |
| D5 | 存储配额不足触发回收，最旧的 pending 也被淘汰；存储完全不可用时又静默返回成功。分别导致唯一离线副本消失或“保存成功”但读不到。 | `src/lib/cache.ts:62-77`；`data-api-results.json` |
| D6 | 同一名单弹窗先逐条新增王五，再切批量编辑直接保存。批量文本仍是打开时名单，新增王五消失；删除也可能被旧文本复活。 | `src/components/PeopleDialogs.tsx:25-33,64,80`；`ui-component-results.json` |
| D7 | 已有语文作业后改科目名为语文阅读。目录只读新键，旧作业保留在孤立键，首页/列表看不见。 | `src/lib/store.ts:464`、`src/pages/Home.tsx:97`；`ui-logic-results.json` |

## 其他已复现或静态确定的问题

| 编号 | 问题 | 验证方式与位置 |
| --- | --- | --- |
| F1 | 编辑框停顿2.5秒保存回调次数为0，关闭才提交；与README停顿2秒自动保存不一致。 | 实际组件回调；`src/components/EditDialog.tsx:77-81,178` |
| F2 | 批量迟到不清已有请假/不参与，同一学生落入多个状态，统计重复扣减。 | 实际 store；`src/lib/store.ts:363` |
| F3 | 列表实到忽略迟到是否计入出勤；三人一人迟到，默认首页2而列表3。 | 实际 store及组件；`src/pages/ListPage.tsx:19` |
| F4 | 默认800–959px既不是移动卡片分支也不是桌面侧栏分支，出勤统计和登记入口均消失。 | 宽度分支及组件；`src/pages/Home.tsx:61-62,89,505` |
| F5 | 非当天保存确认只在首页上传入口检查，出勤完成/列表保存/设置立即上传可直接保存。 | 静态调用链；`src/pages/Home.tsx:369`、`src/components/Attendance.tsx:208`、`src/pages/ListPage.tsx:113`、`src/pages/Settings.tsx:299` |
| F6 | 禁止历史编辑可被考试固定/移除和开发测试卡片入口绕过。 | 静态调用链；`src/pages/ExamBoard.tsx:132`、`src/pages/Home.tsx:466` |
| F7 | 恢复默认后界面 provider 为local，但实际客户端及store source仍cloud，后续请求仍可能访问云端。 | 实际 settings/store；`src/lib/settings.ts:509-519`、`src/lib/store.ts:544` |
| F8 | 自动刷新/间隔、编辑前刷新、动态排序、随机按钮显示、悬浮开关、增强触摸、两种保存提示文本等设置无实际行为消费者。 | 全项目引用审查；详见 `ui-audit.md` |
| F9 | 随机 comparator 排序偏置。固定种子四人取首位10万次，频数35846/14071/18913/31170，第一人约为第二人2.55倍。 | 同算法执行；`src/components/RandomPicker.tsx:83` |
| F10 | 随机人数设置允许20而组件最多10；学号设置允许999而对话框最多100；字号输入1000可写入，min/max没有在处理器校验。 | 实际 settings及边界审查；详见 `ui-audit.md` |
| F11 | 自定义卡片改名/删除props未使用，弹窗无相应控件；空卡片清空时两个空字符串相等，也不触发删除路径。 | 实际组件及静态链路；`src/components/EditDialog.tsx:26-34,77-81` |
| F12 | 自动启动噪音先以“自由监测”和55dB启动，后续不接管当前晚自习时段，配置65dB不采用，离开时段仍active；自由监测不生成报告。连续时段也不切会话。 | 实际TimeCard组件；`src/components/TimeCard.tsx:160-230`、`src/lib/noise.ts:380-382` |
| F13 | 两个未完成的start并发完成，stop后仍剩1个采样interval和未停止track；等待授权期间stop后，授权完成又变active。 | 模拟异步音频生命周期；`src/lib/noise.ts:239-301` |
| F14 | 自动校准中停止后，回调因analyser为空始终return，不完成、不清interval；UI可长期“校准中”。 | 模拟音频和timer；`src/lib/noise.ts:446-469` |
| F15 | 23:30开始、120分钟时段在00:30不命中，跨午夜后半段不会记录。 | 执行实际函数；`src/components/TimeCard.tsx:92-102` |
| F16 | 倒计时结束会发提示音，但running=false且remaining=0进入预设页，“时间到”分支不可见。 | 实际FullscreenClock组件；`src/components/TimeCard.tsx:645,730-745` |
| F17 | 秒表5秒计次后关闭重开，1秒计次显示 `-1:-4.00`，关闭未清lastLap。 | 实际FullscreenClock组件；`src/components/TimeCard.tsx:497-507,800-805` |
| F18 | UAF日期规范化接受不存在的 `2026-02-31`，未校验真实年月日。 | 实际函数；`src/lib/uafExport.ts:64-75` |
| F19 | UAF日期加载/文件解析/预览缺请求序号和取消；旧promise后返回可覆盖新选择，文件B标签可能对应文件A导入计划。 | 静态异步调用链，未真实浏览器延迟复现；`src/components/UafTransferDialog.tsx:132-149,172-202,234-246` |
| F20 | SW install只缓存HTML/manifest/favicon。首屏资源在SW注册前已下载，未由install缓存，首次打开后离线重开缺完整资源保障。 | 实际SW缓存VM；`public/sw.js:17-23`；真实浏览器离线重开仍未验证 |
| F21 | SW只缓存 `/assets/`，已在线使用的 `/uaf/`字体和WASM也不进Cache。浏览器普通HTTP缓存可能短期命中，但SW不能保证离线UAF导出。 | 实际SW缓存VM；`public/sw.js:75-81` |
| F22 | `deploy:worker` 指向不存在的 `worker/wrangler.toml`，实际配置在根目录。 | 文件路径检查；`package.json:15`；未执行部署 |

以上包含不同影响程度及不同验证层级，不建议以失败断言数量直接计算可用率。默认晚自习时段有重叠，但优先选哪段的产品规则不明确，未把“重叠时选择第一段”单独算作缺陷。

## 构建提示

- Vite提示 vendor 默认的 `../assets/NotoSansSC-Regular.otf`、`../assets/hb-subset.wasm` 不存在。实际UAF导出显式提供三个fontBytes和wasmUrl，真实PDF往返已通过，因此当前正常导出链路不被这两个警告阻断。
- UAF动态bundle约1.22MB，gzip约528KB，产生大chunk提示。首次导出所需三种字体合计约24.76MB；性能和低速网络体验尚未验收。

## 尚未完成的真实环境验收

- 浏览器页面挂载、点击流程、手机/平板/桌面真实布局、触控、主题对比度及极大字号；内置浏览器连接超时是工具阻碍，未据此判定页面打不开。
- 实际剪贴板权限、Fullscreen API、打印输出、PDF iframe预览、下载与文件选择器。
- 真实麦克风授权/拒绝、不同设备读数和校准、自动播放音频、隐藏页面长时间计时、晚自习连续归档。
- PWA实际安装、首次访问后断网重开、更新后的缓存升级、多标签即时同步、离线恢复事件。
- Cloudflare/Vercel真实环境、KV绑定/Upstash凭据、平台限制、不同设备同时修改；本次未部署或连接真实云。

## 证据与复核

| 文件 | 内容 |
| --- | --- |
| `H:/ClassworksLite/.workbuddy/audit/data-api-results.md` | 数据/API问题详述及复现 |
| `H:/ClassworksLite/.workbuddy/audit/data-api-results.json` | 数据竞态、离线和持久化证据 |
| `H:/ClassworksLite/.workbuddy/audit/ui-audit.md` | UI和设置引用审查 |
| `H:/ClassworksLite/.workbuddy/audit/ui-logic-results.json` | 出勤、科目、历史导航、默认恢复证据 |
| `H:/ClassworksLite/.workbuddy/audit/ui-component-results.json` | 输入自动保存及名单批量覆盖证据 |
| `H:/ClassworksLite/.workbuddy/audit/component-runtime-results.md` | 59项组件检查及4条真实React SSR路由 |
| `H:/ClassworksLite/.workbuddy/audit/uaf-noise-results.md` | UAF、噪音与时间工具详述 |
| `H:/ClassworksLite/.workbuddy/audit/uaf-noise-results.json` | PDF及模拟音频生命周期证据 |
| `H:/ClassworksLite/.workbuddy/audit/timecard-component-results.json` | 自动时段、计次和倒计时实际组件证据 |
| `H:/ClassworksLite/.workbuddy/audit/http-pwa-results.json` | 实际HTTP与SW缓存VM结果 |
| `H:/ClassworksLite/.workbuddy/audit/quote-api-results.json` | 一言接口当前只读请求结果 |
| `H:/ClassworksLite/.workbuddy/audit/uaf-roundtrip.uaf.pdf` | 实际生成的UAF样例 |

从项目根目录逐个运行：

```powershell
npm run build
node .workbuddy/audit/data-api-check.cjs
node .workbuddy/audit/ui-logic-audit.cjs
node .workbuddy/audit/ui-component-audit.cjs
node .workbuddy/audit/component-runtime-check.cjs
node .workbuddy/audit/uaf-noise-check.mjs
node .workbuddy/audit/timecard-component-check.mjs
node .workbuddy/audit/quote-api-check.mjs
```

这些是审查用脚本，部分脚本把预期失败记入JSON后以0退出，**退出码0不能理解为所有断言通过**。请读取结果中的pass/status。

HTTP/PWA脚本需要独立预览服务。在 `.workbuddy/audit` 工作目录启动下面服务，使开发KV只写测试目录；另一个终端在项目根执行检查：

```powershell
node H:/ClassworksLite/node_modules/vite/bin/vite.js preview H:/ClassworksLite --config H:/ClassworksLite/vite.config.ts --port 3137 --strictPort --host 127.0.0.1
```

```powershell
node .workbuddy/audit/http-pwa-check.mjs
```

本次完成检查与报告，未实施修复。建议修复顺序：数据保存与离线副本保护 → 日期与编辑请求隔离 → 名单/科目迁移 → 出勤与历史保护 → 噪音生命周期和自动归档 → PWA与其余设置/计时边界，然后进行真实浏览器和设备验收。

---

# 修复记录（2026-10-19）

按上一节的优先级实施修复，未改动原始审计证据：修复前的 JSON/Markdown 已备份到
`.workbuddy/audit/before-1018/`。修复后的行为断言脚本为 `.workbuddy/audit/verify-fixes.cjs`。

## 已修复

| 编号 | 修复内容 | 主要位置 |
| --- | --- | --- |
| D1 | 云端读取时若本地有 pending 副本则直接返回本地值；不再用远端旧值覆盖 | `src/lib/kv.ts` `CloudClient.get` |
| D2 | 云端 404 只清理已同步缓存，不删除唯一离线副本 | `src/lib/kv.ts` |
| D3 | 日期读取加序号，切换日期后丢弃过期响应 | `src/lib/store.ts` `loadBoard` |
| D4 | 保存期间产生的新编辑保持 dirty，保存结束后自动再次落盘 | `src/lib/store.ts` `save` |
| D5 | 保存失败或用户取消时不再切日期，改动保留在内存与本地 | `src/lib/store.ts` `goToDate` |
| D6 | 本地存储不可写时抛错，不再“保存成功”却读不到 | `src/lib/cache.ts`、`src/lib/kv.ts` |
| D7 | 配额回收只淘汰已同步记录，pending 副本受保护 | `src/lib/cache.ts` `cacheSet` |
| D8 | 学生名单批量编辑以进入批量模式时的名单为基准做增删合并 | `src/components/PeopleDialogs.tsx` |
| D9 | 科目改名自动迁移所有日期的作业键（同位置改名判定） | `src/lib/store.ts` `setSubjects` / `renameSubject` |
| F1 | 编辑框停顿 2 秒自动保存，提示文本改为读取设置 | `src/components/EditDialog.tsx` |
| F2 | 批量出勤互斥，一人只保留一种状态 | `src/lib/store.ts` `setAttendance` |
| F3 | 列表页实到复用 `attendanceStats`，与首页一致 | `src/pages/ListPage.tsx` |
| F4 | 800–959px 视口显示出勤卡片，不再出现入口真空 | `src/pages/Home.tsx` |
| F5 | 非当天保存确认收敛到 `store.save()`，所有入口统一 | `src/lib/store.ts` |
| F6 | 历史保护覆盖考试固定/移出与测试卡片入口 | `src/pages/Home.tsx`、`src/pages/ExamBoard.tsx` |
| F7 | 恢复默认广播事件；`getClient()` 惰性校正；provider 变更立即重建 | `src/lib/settings.ts`、`src/lib/kv.ts`、`src/lib/store.ts` |
| F9 | 随机点名改为 Fisher-Yates 洗牌，消除排序偏置 | `src/components/RandomPicker.tsx` |
| F10 | 数值设置按 min/max 收敛；抽取人数上限 10、学号上限 100 | `src/lib/settings.ts` |
| F11 | 自定义卡片提供重命名与删除；空白卡片关闭即删除 | `src/components/EditDialog.tsx` |
| F12 | 自动监测按当前时段启动并采用配置阈值；已在监测时切换时段；离开时段停止并归档 | `src/components/TimeCard.tsx` |
| F13 | 噪音 start/stop 增加代次防护，授权期间停止不会复活 | `src/lib/noise.ts` |
| F14 | 校准可被停止中断并回调失败，UI 不会永久停在“校准中” | `src/lib/noise.ts` `calibrate` |
| F15 | 时段匹配支持跨午夜；重叠时取开始时间最晚的一段 | `src/components/TimeCard.tsx` `activeSession` |
| F16 | 倒计时结束显示「时间到！」状态 | `src/components/TimeCard.tsx` |
| F17 | 关闭全屏时钟重置计次基准，重开首计次不为负 | `src/components/TimeCard.tsx` |
| F18 | UAF 拒绝 `2026-02-31` 这类不存在的日历日期 | `src/lib/uafExport.ts` |
| F19 | UAF 日期加载与文件解析加请求序号，旧结果不覆盖新选择 | `src/components/UafTransferDialog.tsx` |
| F20/F21 | SW 安装时解析外壳 HTML 预缓存入口资源；`/uaf/` 与 `/icons/` 纳入运行时缓存 | `public/sw.js`（版本升至 v2） |
| F22 | `deploy:worker` 指向根目录 `wrangler.toml` 并先构建 | `package.json` |
| F8（部分） | 编辑提示文本、自动刷新间隔已接入实际行为 | `src/components/EditDialog.tsx`、`src/lib/store.ts` |

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `tsc --noEmit` | 通过 |
| `vite build` | 通过（66 modules，`browser` chunk 1.22 MB / gzip 528 kB） |
| `.workbuddy/audit/verify-fixes.cjs` | 14/14 通过 |
| `component-runtime-check.cjs` | 59/59 通过（原 54/59） |
| `timecard-component-check.mjs` | 9/9 通过（原 4/9） |
| `uaf-noise-check.mjs` | 20/22 通过（原 14/22） |
| `ui-component-audit.cjs` | 输入 2500ms 内触发保存；批量保存保留新增学生 |
| `ui-logic-audit.cjs` | 批量出勤互斥、改名迁移、历史保存、设置收敛均符合预期 |
| `http-pwa-check.mjs` 等价检查 | `/uaf/` 在线使用后可离线命中（`verify-fixes.cjs` F21） |
| 本地预览冒烟 | `/`、`/settings`、`/api/health`、`/sw.js`、`/uaf/hb-subset.wasm` 均 200 |
| 900px 视口截图 | 出勤统计卡片正常显示 |

说明：

- `data-api-check.cjs` 的 7 个“缺陷复现”用例现在返回 `harness_error`，因为这些用例断言的是修复前的错误行为（例如“pending 应被覆盖”“保存应静默失败”）。这属于预期结果，不代表回归。该脚本已加 4 秒看门狗，避免未决请求挂住进程。
- `uaf-noise-check.mjs` 剩余 2 项（倒计时完成界面、秒表重开计次）在该脚本中是硬编码的旧控制流复现，并非读取源码；对应的真实组件检查已在 `timecard-component-check.mjs` 中 9/9 通过。
- `ui-logic-audit.cjs` 中“列表实到 3”“800–959 无入口”两行同样是脚本内写死的公式/矩阵，真实组件检查已通过。

## 仍未完成

- 真实浏览器与设备验收：触控、剪贴板权限、Fullscreen API、打印版式、PDF iframe 预览、麦克风实际读数、PWA 安装与离线重开、多标签同步。
- Cloudflare / Vercel 真实部署与绑定验证（本次未部署）。
- F8 剩余设置项：`display.dynamicSort`、`display.enhancedTouchMode`、`display.showRandomButton`、`edit.refreshBeforeEdit` 仍无消费者，需要产品层面确认语义后再接入或移除（`display.cardHoverEffect` 已接入）。

## 附：开发服务器性能修复

排查「dev 下 `/src/index.css` 请求 20 秒不返回、并阻塞整个服务器」时发现：Tailwind 4 的自动内容探测会扫描仓库内
`.workbuddy/`（约 1.4GB，含历史截图用的 Chrome 配置）与 `_reference/`（60MB），宽泛 glob 同样会命中这些目录。

改为显式限定源码范围后，CSS 转换从 **15–28 秒降到 0.41 秒（冷） / 7ms（缓存）**：

```css
@import 'tailwindcss' source(none);
@source '../index.html';
@source './App.tsx';
@source './main.tsx';
@source './components';
@source './pages';
@source './lib';
```

新增组件目录时需要同步补一条 `@source`，否则该目录里的 Tailwind 工具类不会生成。


