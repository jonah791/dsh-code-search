<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 本地代码/文件智能检索：封装系统 rg（ripgrep），默认排除 node_modules/.pnpm/dist/build/coverage/.git/lib/.dsh 等 9 条噪音目录；五个视角——code_search（文本：全文检索，rg --json 结构化防 Windows 盘符坑）+ code_locate（文件：--files-with-matches 定位）+ code_symbols（结构：符号地图）+ code_impact（关系：引用面/影响分析，导入归属 + 导出链可达性）+ code_test_gate（行动：测试闸门，git 改动 → 反向可达 → 该跑的命令）；每次调用落一行自证轨迹
  inject: 'tools'
  tools: code_search,code_locate,code_symbols,code_impact,code_test_gate
  runtime: host-only
  envDeps: 系统 rg（ripgrep 可执行文件，rgPath 为空时走 PATH；无 rg 则工具显式报错而非静默空结果）；code_test_gate 另需 git 在 PATH
  boundary: pattern 是正则（极端模式可拖住 rg 的 ReDoS 类风险）；lib/ 默认排除——「找不到」有时是排除规则的功劳而非事实；code_impact 只认 ESM 显式导入（动态 import()/require() 认不得），粒度是**文件**不是调用点；code_test_gate 的 git 只看**它所在那个仓**（子仓内部改动在主仓视角是 gitlink，看不到），未追踪目录不展开；纯只读（不写文件/不建索引/不联网）
  compat: cordis ^4.0.1 / schemastery ^3.18.1-rc.1 / dsh-tools ^0.1.0-rc.6
-->
# dsh-code-search

<p align="center">
  <a href="https://github.com/jonah791/dsh-code-search"><img src="https://img.shields.io/badge/version-0.4.0-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-93%20passed-brightgreen" alt="tests">
</p>

**一句话**：给 agent 一个「懂大仓」的检索面——封装**系统 ripgrep**，按**五个视角**回答关于代码的问题：`code_search`（**文本**：谁包含这段字）+ `code_locate`（**文件**：X 在哪个文件）+ `code_symbols`（**结构**：这个目录定义了哪些符号）+ `code_impact`（**关系**：改这个符号会波及谁）+ `code_test_gate`（**行动**：这批改动该跑什么）。

**为什么值得用**：通用 `grep` 搜大仓的痛点是噪音（`node_modules` 里成千上万假命中）与 Windows 盘符解析坑。本插件零新依赖复用系统 rg 内核，`--json` 结构化输出规避盘符坑；并且**拒绝一切静默失效**——「rg 不存在」显式报错而不是伪装成「0 匹配」，「共 N 匹配」给的是**真实总数**而非截断值，「谁引用了它」按**来源分级**而不是靠名字猜。

## 能力

| 工具 | 视角 | 用途 |
|------|------|------|
| `code_search` | 文本 | 智能全文检索（rg 封装）：正则模式、根路径（缺省 `<工作区>`）、`include`/`exclude` glob 过滤、结果上限（缺省 50）。头部披露**真实总数**与截断状态（`共 ≥325 匹配（截断：显示 5 / 至少 325）`）+ 匹配模式与噪音排除策略；其后每行 `path:lineNo: text` |
| `code_locate` | 文件 | 按概念/符号定位文件（rg `--files-with-matches` 语义）：排除噪音后返回文件清单（上限 30） |
| `code_symbols` | 结构 | **符号地图**（v0.2）：列出目录/glob 下定义了哪些 `function`/`class`/`interface`/`type`/`const`/方法及其行号，按文件分组——先看结构再决定读哪个文件。逐行正则近似（`mode=regex`），支持 TS/JS、Python、Rust、Go、Markdown 标题 |
| `code_impact` | **关系** | **引用面/影响分析**（v0.3）：给定符号名 → **定义点**（带行号）+ **精确引用者**（能沿 import / 包名 / re-export 链追到定义文件）+ **未证实提及**（正文出现但无导入关系可证）。回答「改它会波及谁」 |
| `code_test_gate` | **行动** | **测试闸门**（v0.4）：读 git 改动集 → 沿引用图**反向可达**（谁依赖这些改动）→ 挑出其中的测试 → 按包归组并给出**可直接执行的测试命令**。回答「这批改动该跑什么」 |

## 测试闸门（v0.4）——从「会波及谁」到「该跑什么」

`code_impact` 的输入是**一个符号**，而真实改动是**一批文件**；闸门把这一步接成闭环：

```text
git 改动集 → 反向可达（谁依赖它们）→ 其中的测试 → 按包读 scripts.test → 可直接执行的命令
```

**它诚实的三种「空白」**（都不会被静默吞掉）：

| 情形 | 输出 | 为什么这样处理 |
|------|------|--------------|
| 改动**没有测试盯着它** | 计入 `unmapped` | 这是最有价值的信号而非错误——它在说「你改了这个，但没有测试覆盖它」 |
| 未追踪**目录**（`?? dir/`） | 计入 `unexpanded` | git 只给目录名，内部文件拿不到 ⇒ 不假装分析过 |
| 子仓内部改动（主仓视角） | 需**对目标仓分别调用** | 主仓把 `self-plugins/*` 当 gitlink，看不到子仓内部文件 |

**`lib-map`：一条容易被忽略的断边。** TS 工程里测试通常 import **编译产物**（`../lib/symbols.js`），而 `lib/` 在默认噪音排除内 ⇒ 图里没有 `lib/` 节点 ⇒ 「源码 → 测试」的边**断在产物目录**，表现为「改了源码，闸门却说没有测试盯着它」。处置是按目录约定把 `/lib/` 映回 `/src/`（标 `how: 'lib-map'` 与直接命中区分，**真实存在的文件优先于映射推断**）。修复前后同参数对照：受影响 **12→14**、测试 **3→5**、未映射 **8→4**。

## 引用面（v0.3）——为什么它比名字匹配准

`code_impact` 不用 tree-sitter，也不用编译器。它利用一个被忽视的事实：**TS/ESM 的 `import` 子句同时携带符号名与来源**——所以「谁引用了 X」可以靠**导入归属**回答，而不是靠全文匹配名字。三层解析缺一不可（这三层**不是设计出来的，是被实测一层层逼出来的**）：

| 层 | 解决什么 | 缺了它会怎样（实测） |
|----|---------|-------------------|
| ① 相对路径 | `import { X } from './rg.js'` → 解析到 `rg.ts`（TS 的 `.js`→`.ts` 映射） | —— |
| ② 包名映射 | `import { X } from '@scope/pkg'` → 扫各 `package.json` 的 `name` 映射到包目录 | **45 个引用精确归零**——真实 monorepo 的引用几乎全走裸包名 |
| ③ re-export 链 | `index.ts` 常只是 `export { X } from './schema.js'`，定义在别处 ⇒ 从 import 目标沿导出链 BFS 找定义 | 补了②仍 **0/58**；补上③后 **45/58**，其中 **43 个靠这一层**才成立 |

**每条边带来源分级**（诚实词汇表，闭集）：

| `how` | 含义 | 精度 |
|-------|------|------|
| `import-direct` | import（或 re-export）子句显式列出该符号，来源解析到**定义文件本身** | 精确 |
| `import-chain` | 来源解析到**再导出者**，沿 re-export 链可达定义文件 | 精确 |
| `same-file` | 引用与定义同文件（排除定义行本身） | 精确 |
| `name-only` | 正文出现该名字但**无导入关系可证**（可能是同名/注释/字符串） | **未经证实**，单独成档、**不混入引用计数** |

**实测**（`deepseek-harness/packages`，3198 个 .ts）：建图 **744 ms**；`code_impact{defineTool}` → 精确引用 **47** / 未证实 11 / 定义点 2（带行号）。**只认 ESM 显式导入**——动态 `import()`、`require()`、字符串拼的模块名会落进 `unverified` 档；粒度是**文件**，不回答「第几行调用、调了几次」。

**失败与「没有」严格分离**：`rg` 不在 PATH / `rgPath` 指向不存在 / 子进程被杀 → 返回 `error`（`code_search 错误: …`）；无匹配 → `ok` 结果 `count:0`，不报错。`code_impact` 的**定义点为 0** 时显式列出三种成因（符号名不符 / 被 `maxFiles` 截断 / 由动态方式引入），不让「定义没扫到 ⇒ 引用全降级」这种失效静默。

## 快速开始

**1) 装依赖**：

```jsonc
"dsh-code-search": "link:<工作区>/self-plugins/dsh-code-search"
```

**2) 挂组合**（可选 `defaultPath` 指向你的工作区；无 config 则全默认）：

```yaml
- id: agent-code-search
  name: dsh-code-search
  config:
    defaultPath: <工作区>   # 缺省检索根路径
```

**3) 30 秒验证**：
- `code_locate {term:'defineTool', include:'*.ts'}` → 期望非空文件清单且无 `error`；
- `code_search {pattern:'ZZQQ_NOT_EXIST_9527'}` → 期望 `count:0` 且**不带 error 字段**（无匹配 ≠ 失败）；
- `code_impact {symbol:'defineTool', include:'*.ts'}` → 期望「定义点 N / 精确引用 M / 未证实 K」三档分明。

若前两工具都带 error，说明 `rg` 不在 PATH。

## 配置

| 项 | 默认 | 说明 |
|----|------|------|
| `defaultPath` | `<工作区>`（源码默认即部署工作区） | `path` 缺省时的检索根路径 |
| `rgPath` | `''` | rg 可执行路径；空 = `'rg'` 走 PATH（**rg 不在 PATH 时工具面显式报错，不静默**） |
| `noiseExcludes` | 9 条负向 glob | `!**/node_modules/**`、`!**/.pnpm/**`、`!**/dist/**`、`!**/build/**`、`!**/coverage/**`、`!**/.git/**`、`!**/lib/**`、`!**/.dsh/**`、`!**/_tmp_review/**`（注意 **`lib/` 也在排除集**——构建产物默认不被检索） |
| `enabled` | `true` | **已知缺口：死配置**——`apply()` 内无任何分支读它，`enabled: false` 不关工具面；停用请走组合级 `disabled: true` |

> 文件清单来自 `rg --files`，因此**继承 rg 的 `.gitignore` 语义**：被仓库忽略的目录（如某些 monorepo 的 submodule）不会进入检索面。

## 落盘与自证（出问题时先看这里）

每次 `apply()` + 每次工具调用落一行 JSONL 到 **`<DSH_HOME>/code-search-trace.jsonl`**（阶段闭集：`boot` / `search` / `locate` / `symbols` / `impact`；写盘吞错绝不反噬检索）：

| 字段 | 含义 |
|------|------|
| `atMs` / `phase` | 写入时刻；`boot`（装载时构建自报）/ `search` / `locate` / `symbols` / `impact` |
| `build` / `op` | `<版本>@<模块 mtime ms>`（① 线上跑的是哪个构建）；工具名 / `apply` |
| `query` / `root` / `include` / `exclude` | 检索输入（**先脱敏再落盘：redactQuery 擦凭据形状**）+ 生效范围 |
| `noiseGlobs` / `noisePolicy` | 生效排除条数；`strict` / `include-overridden` / `none`（**噪音排除真的生效了吗**） |
| `exitCode` / `maxResults` | rg 退出码（`-1` = 未执行到子进程）；结果/文件上限 |
| `count` / `total` / `truncated` | 命中数；真实总数（诚实计数）；是否截断 |
| `durationMs` / `ok` / `error` | 耗时；`无匹配也 ok=true`（只有失败才 `false`）；失败原因 |

**一条命令答五问**：

```bash
tail -3 "$DSH_HOME/code-search-trace.jsonl"
# ① 跑的是哪个构建 → build = "<版本>@<模块 mtime ms>"（boot 行即装载自报）
# ② 谁发起/调了什么 → phase + op + query（脱敏后）+ root/include/exclude
# ③ 断在哪一段      → exitCode + ok（ok=false 才是失败；exitCode=1 且 ok=true = 真无匹配）+ error 分类
# ④ 结果质量/预算   → count + total + truncated + maxResults + noisePolicy
# ⑤ 耗时           → durationMs
```

隐私：`query` 是用户输入的检索模式，排查「key 在哪硬编码」时会直接拿 key 当模式搜——落盘前经 `redactQuery` 按形状擦除（键值对 / token 前缀 / Bearer / 长高熵串），有尸体测试钉住。

## 生效判据与回退

**生效判据**（三选一，按可靠性排序）：
1. `lib/index.js` 的 mtime**早于** web 进程（3080 监听进程）的启动时间 ⇒ 进程在跑当前构建；
2. 生态级：`plugin_boot_status`（`dsh-plugin-bootreport`）返回 `liveNow` 含本插件；
3. 行为级：`code_locate term=<本仓任一符号> include=*.ts` 返回非空文件清单（一次真实调用即判真假；注意先确认 `rg --version` 可用——`rgPath` 未配置时完全依赖 PATH）。

> 注意：**重新构建 ≠ 生效**——产物 mtime 新只证明「构建过」，进程启动时间晚于产物 mtime 才算「在跑它」。

**回退**（三档）：
- 源码级：`git -C self-plugins/dsh-code-search revert <commit>` → 重新构建 → 预检 → 哨兵重启；
- 组合级：preset 给 `agent-code-search` 行加 `disabled: true`（或删行）→ 工具面消失，**官方 `grep` 工具仍在，检索能力不断档**；
- 运行期：无持久业务状态（纯只读、无缓存；轨迹文件可随时删除）。

## 测试

```bash
npm test        # = node --test "tests/*.test.mjs"
```

**93 例离线测试**（`rg.test.mjs` 26 + `shell-contract.test.mjs` 7 + `trace.test.mjs` 18 + `symbols.test.mjs` 18 + `graph.test.mjs` 12 + `gate.test.mjs` 12），全部不依赖网络与真实磁盘（纯函数 + 桩），**Windows 与 WSL 双平台各跑一次均全绿**。覆盖：
- `rg.test.mjs` — rg 纯逻辑：argv 拼装（空模式/空 include/cap 边界）、`--json` 行解析（损坏行/缺字段）、**`classifyRgOutcome` 六类失败样本**（ENOENT/EACCES/EPERM/EISDIR/SIGTERM/无 code）；
- `shell-contract.test.mjs` — **注入面守卫**：扫描 `src/*.ts` 无 shell 执行形态（带尸体样本证明扫描器会命中）、`rg.ts` 保持纯净（无 `child_process`）、`execFile` 第二参必须是 argv 数组；
- `trace.test.mjs` — 轨迹层：`classifyTraceOutcome` 六类样本、**隐私尸体测试**（凭据形状落盘前必被擦除）、观测不反噬（不可写路径 → `false` 且不抛）、`buildStamp` 退化路径；
- `symbols.test.mjs` — 符号识别：TS/JS+Python/Rust/Go/MD 形态、注释行不认、**形态约束压误报**（局部 `const` 与缩进方法调用不收）、触顶如实标注；
- `graph.test.mjs` — **引用图层**：子句解析（含 `type`/别名/`export * as`）、`resolveModule` 四态（rel/pkg-entry/pkg-sub/unresolved）、`findDefiner` 沿链可达与**环安全**、`impactOf` 四档归类不重复计数、**同名消歧尸体测试**，以及 **`lib-map` 产物→源码约定映射**（含「直接命中优先于映射」的顺序判据）。
- `gate.test.mjs` — **测试闸门层**：porcelain 五态解析（rename 取**新**路径、未追踪目录保留尾斜杠）、噪音过滤、未展开目录分离、测试识别正反例、反向可达含**环安全与触顶披露**、最长前缀包归属、命令挑选退化、闸门整合、空输入不抛；含**跨平台分隔符**样本。

## 设计要点

- **「执行失败」与「没有结果」两个可区分返回**：rg 的退出码 1 是「无匹配」约定（**不是错误**），而 spawn 层失败（`err.code` 是字符串 `ENOENT`/`EACCES`）曾被归一成 1，与「无匹配」同形 ⇒ 检索能力静默失效。现在 `classifyRgOutcome` 把 spawn 失败/信号终止单列为 `failure`；轨迹层再钉一层。
- **诚实计数**：「共 N」给**真实总数**（`total`），截断时写 `共 ≥N`——把截断值当总数会让读者以为「只有 50 处」。
- **引用要靠来源、不靠名字**：同名符号在名字匹配下会互相污染；按导入归属则各归各家（有尸体测试钉住）。
- **近似法要配形态约束**：正则下「模块级定义」与「函数内局部量」完全同形，能把它们分开的是**行首缩进**与**行尾字符**——不加这一步的产物看起来丰富，实际是流水账。
- **rg --json 而非文本解析（Windows 盘符坑）**：结构化输出才是安全的解析入口。
- **include 排在 excludes 之后**：rg「后置 glob 覆盖前置」⇒ `include='*.ts'` 会重新纳入 `node_modules/**/*.ts`——既定语义，轨迹的 `noisePolicy` 会标 `include-overridden`。
- **零新依赖**：复用系统 rg（零常驻服务、零索引、每次现扫）；引用图也不用编译器——`graph.ts` 是纯函数（文件存在性由调用方注入）。
- **观测单点收口**：五个工具执行体都经 `traced()` 落笔——新增工具若绕开它，就悄悄制造新的观测盲区。
- **闸门给命令、不给清单**：`code_test_gate` 读各包 `package.json` 的 `scripts.test` 直接产出可执行命令——「该跑什么」比「影响了哪些文件」更接近行动；读不到就留空，**不编造**。

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：定位与反定位（含与 ripwire 的能力对照表）、工具/轨迹契约、诚实分级词汇表、失败面（逐工具）、可证伪验收清单（A1–A33）、实践修订记录、未决问题（U1–U7） |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| 技能 `rg-wrapper-tool-development` | 本插件的开发方法论沉淀（Windows 盘符坑 / `rg --json` / 噪音排除设计），改本插件前先读它 |
| 技能 `plugin-maintainability` | 插件可维护性工程（自证轨迹 / 失败与无匹配分离 / 观测不反噬） |
| [ripwire](https://github.com/redhat-et/ripwire) | 引用面能力的**参照物**（C++23 / tree-sitter / PageRank）——`code_impact` 的定位与边界见 semantic.md §1.1 |

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态。
