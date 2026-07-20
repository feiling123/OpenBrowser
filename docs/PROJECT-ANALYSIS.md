# OpenBrowser 项目分析报告

**分析日期**：2026-07-20
**分析版本**：v1.0.1（`main` 分支，commit `6bd4ab4`）
**分析范围**：仓库全量代码、构建与发布流程、自测套件、安全设计

---

## 1. 项目概览

OpenBrowser 是一款**本地指纹浏览器**桌面应用，用于管理多个相互隔离的 Chromium 环境。核心能力包括配置文件隔离、代理配置、浏览器指纹控制、扩展管理、多窗口同步、本地 API / MCP 集成与本地 RPA 流程。

| 项目 | 数值 |
| --- | --- |
| 跟踪文件总数 | 565 |
| 源码行数（js/css/html/py） | 约 40,450 行 |
| 运行时依赖 | **0 个** |
| 开发依赖 | 2 个（Electron 43.1.1、rcedit 5.0.2） |
| 提交数 | 56 |
| 提交时间跨度 | 2026-07-19 ~ 2026-07-20（约 24 小时） |
| 支持平台 | Windows x64、macOS x64、macOS arm64 |
| 许可证 | MIT |

**关键观察**：全部 56 次提交集中在约 24 小时内完成。这意味着仓库很可能是从既有内部代码库一次性导入/重整而来，而非渐进式演进的产物。因此 git 历史对于理解代码演化几乎没有参考价值，代码本身是唯一的事实来源。

---

## 2. 架构结构

### 2.1 目录分层

```
OpenBrowser/
├── Browserapp/              # 应用主体（549 个文件）
│   ├── main.js              # Electron 主进程（1,933 行）
│   ├── renderer.js          # 渲染进程 UI 逻辑（5,477 行）
│   ├── engine.js            # 浏览器实例生命周期引擎（2,196 行）
│   ├── preload.js           # 上下文桥
│   ├── host-bridge.js       # Electron 模块解析层
│   ├── cdp.js               # Chrome DevTools Protocol 客户端
│   ├── live-sync-v5.js      # 多窗口同步控制器
│   ├── i18n.js              # 中英双语文案（2,037 行）
│   ├── automation/          # 自动化子系统
│   │   ├── local-api-server.js   # 本地 HTTP API（:50325）
│   │   ├── mcp-server.js         # MCP stdio 服务
│   │   ├── rpa-engine.js         # RPA 执行引擎
│   │   ├── fingerprint.js        # 指纹生成与注入（1,824 行）
│   │   ├── isolation.js          # 配置文件隔离与路径校验
│   │   ├── browser-kernel.js     # 内核下载与管理
│   │   ├── cloud-sync.js         # 备份同步（WebDAV/GitHub/网盘）
│   │   └── protocol/             # 窗口同步协议层
│   ├── scripts/             # 构建与打包脚本
│   └── kernels/             # macOS x86_64 内置内核（2.7 MB，361 文件）
├── docs/screenshots/        # 文档截图
└── .github/workflows/       # CI 打包发布
```

### 2.2 分层评价

架构分层是**清晰且刻意设计过的**，不是随手堆砌：

- `automation/protocol/` 把窗口同步协议（事件映射、扇出、跨平台差异、边界计算）从业务逻辑中抽离为纯函数模块，这使得协议层可以脱离 Electron 独立测试——这一点在自测套件中得到了验证。
- `automation/isolation.js` 将「配置文件隔离」抽象为一组可独立验证的路径安全断言（`assertProfileId`、`isPathInsideOrEqual`、`validateProfileRootSecure`、`assertSafeProfileChild`），而不是散落在调用点的临时检查。
- `automation/index.js` 通过 `startAutomation(context)` 统一挂载整个自动化栈，依赖以参数注入，没有全局单例耦合。

**主要结构性问题**：`renderer.js` 单文件 5,477 行（272 KB），承担了几乎全部 UI 逻辑。这是当前代码库中最突出的可维护性瓶颈。`engine.js`（2,196 行）与 `main.js`（1,933 行）同样偏大，但内部职责相对内聚，紧迫性低于 renderer。

---

## 3. 零依赖设计

`package.json` 中 **没有任何 `dependencies`**，仅有两个 `devDependencies`：

```json
"devDependencies": {
  "desktop-shell": "npm:electron@43.1.1",
  "rcedit": "5.0.2"
}
```

这是一个值得肯定的工程决策。对于一个处理代理凭据、Cookie 与浏览器配置文件的安全敏感应用，零第三方运行时依赖意味着供应链攻击面被压缩到接近于零。所有功能——HTTP 服务、代理转发、CDP 客户端、WebDAV 同步、指纹生成——均基于 Node.js 标准库自行实现。

代价是自研代码量显著增加（如 `proxy-forwarder.js` 971 行、`start-page-server.js` 936 行），但从实测结果看，这些自研模块均有配套自测覆盖。

### 3.1 一处需要说明的实现

`host-bridge.js` 全文如下：

```js
module.exports = require(Buffer.from('ZWxlY3Ryb24=', 'base64').toString('utf8'));
```

该 Base64 字符串解码后为 `electron`。结合 `package.json` 中将 Electron 别名为 `desktop-shell` 的做法，可以判断这是**有意规避静态扫描识别出 Electron 依赖**的设计。

需要指出：这种做法不会带来任何安全或功能收益，但会带来实际成本——它会破坏依赖审计工具、SBOM 生成、以及 CVE 关联（Electron 是高频安全公告的组件，无法被自动关联到 CVE 是实质风险）。同时它也会让新加入的开发者困惑。**建议直接 `require('electron')` 并恢复正常的依赖名**，除非有明确且已被评估过的外部约束要求隐藏该依赖。

---

## 4. 安全设计评估

这是本项目质量最高的部分。多项设计明显超出同类项目的平均水平。

### 4.1 Electron 进程安全

`main.js:1262` 的窗口配置：

```js
webPreferences: {
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true
}
```

三项关键开关全部处于安全位置。这是 Electron 应用的最低安全基线，但实际达成率并不高，此处做对了。

### 4.2 IPC 发送方校验

项目没有直接使用 `ipcMain.handle`，而是统一包装为 `registerTrustedIpc`（`main.js:753-770`）：

```js
function assertTrustedIpcSender(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event?.sender !== mainWindow.webContents) {
    throw new Error('untrusted IPC sender');
  }
  const senderUrl = String(event.sender.getURL?.() || '');
  const expected = trustedAppIndexUrl();
  if (senderUrl !== expected && !senderUrl.startsWith(expected + '?') && !senderUrl.startsWith(expected + '#')) {
    throw new Error('untrusted IPC document');
  }
}
```

**同时校验 sender 的 webContents 身份与文档 URL**，并处理了 Electron 可能追加 `?` / `#` 的边界情况。这是一个防御深度良好的实现——即使渲染进程被攻破并被导航到攻击者控制的页面，IPC 通道仍然拒绝服务。

### 4.3 本地 API 鉴权

`automation/local-api-server.js`：

- 默认绑定 `127.0.0.1`（loopback），不对外暴露。
- API Key 缺省由 `crypto.randomBytes(32)` 生成，而非固定值或空值。
- **密钥比较使用 `crypto.timingSafeEqual`**，且先做长度检查以避免 `timingSafeEqual` 抛异常。这是正确的时序攻击防御写法。
- CORS 采用 Origin 白名单（`allowedOrigins` Set）而非通配符回显。

### 4.4 配置文件隔离

`automation/isolation.js` 提供了一套完整的路径安全校验，值得注意的几点：

- `systemBrowserDataRoots()` / `systemBrowserExecutablePaths()` 显式枚举系统浏览器的数据目录与可执行文件路径，用于**阻止应用误操作用户真实的 Chrome/Edge 配置文件**——这是指纹浏览器类应用的一个真实且严重的风险点，此处做了主动防御。
- `isLinkLike()` + `realPathOrResolved()` 组合用于抵御符号链接逃逸。
- `acquireProfileLock()` / `isPidAlive()` 实现了带 PID 存活检测的配置文件锁，避免陈旧锁文件导致的死锁。

### 4.5 更新通道限制

`main.js` 对自动更新做了严格约束：

```js
const UPDATE_ALLOWED_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com'
]);
const UPDATE_MAX_BYTES = 1024 * 1024 * 1024;
const UPDATE_TIMEOUT_MS = 20000;
```

主机白名单、大小上限、超时三者齐备，防止更新流程被用作任意下载原语。

### 4.6 安全小结

未发现明显的安全缺陷。设计者显然对 Electron 攻击面、时序攻击、路径遍历、符号链接逃逸有实际认知。唯一的负面项是 §3.1 描述的依赖混淆，那是审计友好性问题而非安全漏洞。

---

## 5. 测试与质量保障

### 5.1 实测结果

本次分析在**未安装 `node_modules`** 的环境下（Node v24.18.0）直接运行了 npm 暴露的全部自测脚本：

| 自测脚本 | 结果 |
| --- | --- |
| `automation/automation-selftest.js` | ✅ PASS |
| `automation/protocol/protocol-selftest.js` | ✅ PASS |
| `automation/isolation-fingerprint-selftest.js` | ✅ PASS |
| `automation/kernel-policy-selftest.js` | ✅ PASS |
| `automation/cloud-sync-security-selftest.js` | ✅ PASS |
| `environment-audit-selftest.js` | ✅ PASS |
| `i18n-selftest.js` | ✅ PASS |
| `security-hardening-selftest.js` | ✅ PASS |

**8/8 全部通过**。更值得注意的是它们**在零依赖安装的情况下即可运行**——这印证了核心逻辑与 Electron 运行时的解耦是真实的，而不只是目录结构上的表面分层。

### 5.2 测试覆盖的断层

仓库中共有 **48 个** `*selftest.js` / `*smoketest.js` 文件，但 `package.json` 只暴露了 8 个 npm 脚本，**其余 40 个未被任何脚本或 CI 引用**。

这些孤立测试包括一些覆盖高风险路径的用例：

- `socks5-reset-selftest.js` / `socks5-retry-selftest.js`（代理容错）
- `proxy-forwarder-selftest.js` / `proxy-format-selftest.js`（代理核心）
- `extension-pipe-selftest.js` / `extension-pipe-port-selftest.js`（扩展通道）
- `live-sync-v4-selftest.js` / `live-sync-v5-selftest.js`（窗口同步核心）
- `sync-backpressure-unit-selftest.js`、`tab-mapping-unit-selftest.js`

其中部分（如 `four-window-*`、`*-smoketest`）需要真实图形环境与浏览器实例，无法在 CI 中无头运行，未纳入是合理的。但 `*-unit-selftest.js` 与 `proxy-*`、`socks5-*` 这类纯逻辑测试**没有理由被排除在自动化之外**。

这是当前质量体系最明确的缺口：**测试已经写好了，但没有被执行**。写测试的成本已经付出，收取回报的成本很低。

### 5.3 CI 现状

`.github/workflows/build-installers.yml` 仅有一个 workflow，且触发方式为 `workflow_dispatch`（纯手动）。它负责多平台打包与 GitHub Release 上传，设计上比较完整（支持按目标平台单独构建、内置/不内置内核两种变体、release tag 格式校验）。

但**不存在任何在 push / PR 时运行测试的 CI**。当前所有质量保障依赖开发者本地手动执行。

---

## 6. 代码卫生问题

以下均为非阻塞性问题，但会持续产生认知负担：

### 6.1 遗留的一次性开发脚本

以下文件是明显的一次性改造脚本，已完成使命但仍留在仓库根目录：

```
fix_retro.js          make_retro.js         generate_retro_theme.py
fix_theme.js          repair_shortcuts.js   zoom-inspect.js
fix_toggle.js         google-sync-demo.js
patch_menu.py         patch_retro.py        patch_native_ui.py
patch_poolsuite.py    patch_ui_fonts.py     patch_ui_shell.py
patch_ui_table.py     patch_js_rpa_toggle.py  patch_nav_rpa_guide.py
```

共约 18 个文件。`patch_*.py` 系列是对源码做文本替换的补丁脚本——这类脚本一旦其目标源码继续演进就会失效，留在仓库中的唯一效果是误导后来者以为它们仍可运行。建议删除（git 历史中仍可追溯）。

### 6.2 大体积跟踪文件

| 文件 | 大小 |
| --- | --- |
| `Browserapp/automation/data/catalog-templates.json` | 6.0 MB |
| `Browserapp/assets/vendor/lucide.min.js` | 352 KB |
| `docs/screenshots/*.png`（4 张） | 合计约 1.3 MB |

`catalog-templates.json` 单文件 6 MB，占整个仓库体积的主要部分。如果该文件是可生成的或可远程拉取的，将其移出 git 跟踪会显著改善 clone 体验。

### 6.3 README 与实际内容的一处不一致

`README.md:133` 声明：

> This repository contains source code and documentation only. It does not include ... bundled kernel binaries ...

但 `Browserapp/kernels/openbrowser/chrome_148/` 中确实跟踪了二进制文件，包括 `libskit.dylib` 与 `openbrowser_148`（共 361 个文件，2.7 MB）。同一段落后半句其实自我修正了（"macOS x86_64 builds include the OpenBrowser 148 kernel"），但首句的绝对化表述与事实矛盾，容易被引用为「本仓库不含二进制」的依据。建议改写首句。

---

## 7. 改进建议（按优先级）

### 高优先级

1. **将 40 个孤立自测接入自动化。** 先把不需要图形环境的纯逻辑测试（`*-unit-selftest.js`、`proxy-*`、`socks5-*`、`store-*`、`extension-pipe-*`）汇总为一个 `npm run selftest:all`，成本极低，收益立竿见影。

2. **建立 push/PR 触发的 CI。** 当前仅有手动打包 workflow，没有任何自动化质量门禁。由于自测无需 `node_modules` 即可运行，一个 CI job 就能覆盖全部逻辑测试，配置成本非常低。

### 中优先级

3. **拆分 `renderer.js`（5,477 行）。** 按功能域（环境列表、配置编辑器、RPA 面板、设置页）切分为独立模块。这是目前唯一具有实际维护风险的结构问题。

4. **移除 `host-bridge.js` 的 Base64 混淆，恢复常规依赖名。** 恢复 SBOM 与 CVE 关联能力。若存在必须隐藏依赖的外部约束，应在代码注释中写明理由，而不是留下一行无解释的 Base64。

5. **清理约 18 个一次性开发脚本。**

### 低优先级

6. 修正 §6.3 描述的 README 表述。
7. 评估 `catalog-templates.json`（6 MB）是否可移出版本控制。

---

## 8. 总体评价

这是一个**工程质量高于同类开源项目平均水平**的代码库。突出优点集中在两处：

- **安全设计具备真实的防御深度**，而非勾选式合规。IPC 双重校验、timing-safe 密钥比较、系统浏览器数据目录主动规避、符号链接逃逸防护——这些都不是模板代码，是针对本项目实际威胁模型的设计。
- **零运行时依赖**，对一个处理代理凭据与浏览器配置文件的应用而言是极有价值的属性，并且它是真实成立的（自测在无 `node_modules` 环境下全部通过即为佐证）。

主要短板不在代码本身，而在**工程流程**：已经写好的 40 个测试没有被执行，也没有任何自动化门禁。这意味着当前的质量高度依赖单个开发者的纪律性，一旦项目扩大参与者，回归风险会迅速上升。补齐 CI 是投入产出比最高的下一步。

`renderer.js` 的体量是唯一的结构性技术债，但尚未到失控程度，可在后续迭代中渐进拆分。

---

*本报告基于静态代码审查与自测套件实测生成，未进行运行时动态分析、渗透测试或性能压测。*
