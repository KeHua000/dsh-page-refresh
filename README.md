# dsh-page-refresh

改完 Harness 的客户端插件之后，页面自己变新——不用再手动按 F5。

![icon](./icon.svg)

## 它解决什么

Harness 的 Host 侧其实已经在盯着每个插件的 `client.js`：文件一变就重新合成 bundle（`dsh-client-hmr` 每 500ms 轮询一次）。但浏览器里跑着的还是旧代码，除非你自己刷新页面。

这个插件补的就是最后一步：

- 每 2.5 秒比对一次服务端 bundle 指纹（`GET /page-refresh/state` 的 `rev`）与页面启动时记下的 `window.__DSH_BOOT__.rev`；
- 两者不同 = 有插件产物更新 → 先让 Host 重新合成（`GET /page-refresh/recompose`），再整页刷新；
- 侧栏底部有一个刷新按钮，随时可以手动来一次；
- 「设置 → 通用」里有一个**自动刷新开关**，不想要自动刷新就关掉，按钮仍然能用；
- 助手自己也能刷新：它有一个 `refresh_page` 工具，需要的时候（比如刚改完插件、页面上的代码已经旧了）会主动让页面重载一次，走的是同一条 SSE 通道，不用等你按按钮。

## 安装

**方式一：链接（推荐）**

1. Harness → 设置 → 插件 → 安装；
2. 粘贴这一版的 tgz 链接（见 Releases 页）；
3. 装完后**手动刷新一次页面**，插件本身才会加载。之后就交给它自己了。

**方式二：本地目录**

把仓库下到本地，在同一个安装入口填这个目录的绝对路径（会以 `link:` 方式安装，之后改代码即时生效）。

## 行为细节

| 项目 | 行为 |
| --- | --- |
| 检测周期 | 2.5 秒 |
| 触发条件 | 服务端 `rev` 与页面启动时的 `rev` 不同 |
| 自动刷新冷却 | 15 秒，避免连锁刷新 |
| 后台标签页 | 先挂起，切回前台再刷新 |
| 开关位置 | 设置 → 通用 → 「页面自动刷新」 |
| 开关存储 | 浏览器 localStorage（`dsh-page-refresh.auto`，默认开） |
| 手动按钮 | 侧栏底部（齿轮上方），有更新时按钮上会亮一个小圆点 |
| 助手触发 | 工具 `refresh_page`（`reason` 会显示在页面上），或 `GET /page-refresh/reload?reason=…` |
| 通道 | `GET /page-refresh/events`（SSE，`ready` + `reload` 两种帧）；断线由 EventSource 自动重连，重连期间靠 2.5 秒轮询的 `seq` 兜底 |

## 边界

- 只对**客户端产物（client bundle）变化**生效。纯 Host 侧（`index.js`）的改动需要重启插件或重开 Harness，本插件不会因此刷新页面。
- 需要 `clientModules.graph().rev` 与 `window.__DSH_BOOT__.rev`，即 0.2.2-rc.1 一代及更新的 Harness。
- 刷新是整页刷新：对话与 session 都保留，React 组件的临时状态（输入框草稿以外的展开/折叠之类）会丢。
- 自动刷新只对**rev 稳定下来**的情况生效（连续 3 次轮询看到同一个新 rev，约 7.5 秒），同一个 rev 最多刷一次，两次自动刷新至少隔 60 秒——这样改代码时不会连环刷。助手手动 `refresh_page` 不走这套限流，说刷就刷。

## English

`dsh-page-refresh` reloads the Harness web UI when a client plugin bundle changes. The host already recomposes bundles on file changes; this plugin closes the loop in the browser: it compares the served bundle revision against `window.__DSH_BOOT__.rev`, asks the host to recompose, then reloads the page. A sidebar button triggers the same flow manually, and a switch under Settings → General turns automatic reloading off. The assistant can also ask for a reload through the `refresh_page` tool (delivered over server-sent events at `GET /page-refresh/events`). Requires Harness 0.2.2-rc.1 or newer.

## License

MIT
