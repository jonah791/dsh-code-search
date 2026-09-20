# 语义文档：dsh-code-search（本地大仓检索面）

> 版本 v0.3 · 2026-09-20（初版 2026-09-14）· 作者：爱丽丝 · 状态：**implemented**
> 开发方式：语义文档优先（先写清「是什么/什么关系/怎么裁决」，再让实现逼近，最后用实践回修）
> 实现落点：`self-plugins/dsh-code-search/src/`（`index.ts` 接线与 IO + `rg.ts` 纯逻辑 + `trace.ts` 自证轨迹 + `symbols.ts` 符号识别 + `graph.ts` 引用图层；构建产物 `lib/`）

| 项 | 值 |
|----|----|
| 能力名 | dsh-code-search（插件内 `name = 'agent-code-search'`） |
| 主副本路径 | `self-plugins/dsh-code-search/docs/semantic.md` |
| 实现落点 | `self-plugins/dsh-code-search/src/`（5 个源文件） |
| 版本 | `package.json` = 0.3.0 |
| 组合行 | `E:\alice\.dsh\profiles\web\cordis.patch.yml`，`id: agent-code-search`，**无 config**（走全默认） |
| 状态 | **implemented**（v0.3 已部署并线上实测；v0.2 的「3 工具」契约已被本版取代） |
| 修订摘要 | v0.3（2026-09-20）：新增 `code_impact`（引用面/影响分析）——**导入归属 + 导出链可达性**的文件级精确反向引用图，零新增依赖；v0.2（2026-09-20）：新增 `code_symbols`、`code_search` 诚实计数；v0.1：`code_search` + `code_locate` |

---

## 1 · 定位与反定位

**定位**：封装**系统 ripgrep**，把「在大仓里找一个符号」变成 **4 个视角**：
- `code_search`——**文本视角**：全文检索，返回匹配行（默认排除噪音）；
- `code_locate`——**文件视角**：按概念/符号定位文件清单；
- `code_symbols`——**结构视角**：一次调用拿到目录里定义了哪些符号（先给地图，再读文件）；
- `code_impact`——**关系视角**：「改这个符号，谁会受影响」——定义点 + 精确引用者 + 未证实提及。

前三者回答「**在哪**」，`code_impact` 回答「**改了会怎样**」。核心价值是**默认排除噪音**（`node_modules/.pnpm/dist/build/coverage/.git/lib/.dsh/_tmp_review`），以及**不需要编译器**就能给出文件级精确的引用关系。

### 1.1 定位的参照物：与 ripwire 的能力对照（实测口径）

`code_impact` 的动机来自 [ripwire](https://github.com/redhat-et/ripwire)（redhat-et，C++23 写的「AI 上下文的 ripgrep」，提供 `--callers`/`--impact`/`--affected`/`--test-gate` 等命令）。对照如下：

| 维度 | ripwire 0.6.1 | 本插件 `code_impact` |
|------|---------------|---------------------|
| 解析层 | tree-sitter（**语法级**） | 导入归属 + 包名映射 + re-export 链可达性（**文件级精确**，TS/ESM） |
| 同名消歧 | 靠名字匹配，`name-based` 级边自述为「猜」 | 靠**导入来源**消歧——同名符号各归各家（A27 尸体测试） |
| 索引成本 | 全量重建（实测 deepseek-harness 12072 文件 **61.2 s**） | 每次现扫（实测 3198 文件 **744 ms** 建图） |
| 依赖 | C++23 编译；**Windows 无原生 release** | **零新增依赖**（Node 内置 + 系统 rg） |
| 粒度 | 函数级调用边 + Personalized PageRank 排序 | **文件级**（无调用点级、无排序） |
| 语言 | 21 种 | TS/JS 族（图）；5 族（符号识别） |

**诚实结论**：本工具**不是** ripwire 的全面替代——它没有函数级调用边、没有 PageRank 排序、没有 21 语言支持。它超越的是**单一维度**：在 TS/ESM 仓上，「谁引用了这个符号」可以**零依赖、亚秒、文件级精确**地回答，且每条边带**可核对的来源**，而不是靠名字猜。

**反定位（本文不管什么）**：
- 不管**语义检索/向量检索**（这是正则/字面匹配；语义检索属记忆库 `recall`）
- 不管**文件内容编辑**（属 `edit`/`write`）
- 不管**官方 `grep` 工具**：两者并存——官方 grep 走 harness 内建，本插件是**自研的高层封装**（更强调噪音排除与 Windows 盘符处理）
- **不是**索引服务：零常驻进程、零倒排索引、每次调用现扫（用系统 rg 的并行扫描）
- **不是**函数级调用图：`code_impact` 的粒度是**文件**，不回答「在第几行调用、调了几次」
- **不是**二进制/压缩包检索器（rg 语义如下）

## 2 · 术语表

| 术语 | 含义 |
|------|------|
| rg | ripgrep 可执行文件；本机 15+，`rgPath` 为空时走 PATH 解析 `rg` |
| 噪音排除 | `noiseExcludes` 里的 `!` 前缀 glob（rg 的负向 glob 语法），默认 9 条 |
| 匹配行 | `code_search` 的输出单元（`path:lineNo: text`），来自 `rg --json` 的 `type === 'match'` 记录 |
| 定位 | `code_locate` = `--files-with-matches`，只回文件清单不回行内容 |
| 退出码 1 | rg 的「无匹配」约定——**不是错误**（代码显式排除 `code !== 1` 判错） |
| 生效判据 | 「当前 web 进程真的在跑这份构建」的进程级判据（见 §6） |

## 3 · 概念模型

```
爱丽丝 / 技能（rg-wrapper-tool-development 等）
   │  code_search{pattern, path?, include?, exclude?, maxResults?}
   │  code_locate{term, path?, include?, maxResults?}
   ▼
dsh-code-search · apply(ctx, config)
   ▼ runRg(cfg.rgPath || 'rg', argv)  execFile(maxBuffer 64MB, windowsHide:true)
   │     err.code 为数字则取之，否则 1
   ├─ code_search  argv = [--json, --color never, (--glob 噪音排除…), (--glob include)?,
   │                        (--glob '!'+exclude)?, --regexp <pattern>, <root>]
   │     ├─ stderr 非空 且 code !== 1 → 返回单条 {path:'',lineNo:0,text:'',error} → render 显示「code_search 错误: …」
   │     ├─ 逐行 JSON.parse，只取 type==='match' 的记录
   │     └─ cap = maxResults ?? 50
   └─ code_locate  argv = [--files-with-matches, --color never, (--glob 噪音排除…), (--glob include)?,
                            --regexp <term>, <root>]
         ├─ stderr 非空 且 code !== 1 → **返回 {count:0, files:[]}（静默）** ← 见 §5 / U1
         └─ cap = maxResults ?? 30
```

不变量（invariants）：
1. **I1 默认排噪音**：任何调用都至少带 `noiseExcludes` 的 9 条负向 glob（可用「在 `node_modules` 里造一个唯一串，检索应 0 命中」一次测量判真假）。
2. **I2 无匹配不是错误**：rg 退出码 1 → 正常返回空结果，不报错（`stderr && code !== 1` 才判错）。
3. **I3 结果有上限**：`code_search` 默认 ≤50 条、`code_locate` 默认 ≤30 条，避免撑爆上下文。
4. **I4 Windows 盘符安全**：走 `rg --json`（结构化）而非解析文本行——dst 注释明示这是为了规避 Windows 盘符解析坑。
5. **I5 只读**：两个工具对文件系统只读（不写缓存、不建索引、不落盘）。

## 4 · 契约

### 4.1 配置（`Config`）

| 字段 | 类型 | 默认 | 语义 |
|------|------|------|------|
| `enabled` | boolean | `true` | **声明了但 `apply()` 内未使用**（无门控；停用只能靠组合行 `disabled`）——见 §8 / U2 |
| `defaultPath` | string | `E:/alice` | `path` 缺省时的检索根 |
| `rgPath` | string | `''` | 空 → 用 `'rg'` 走 PATH |
| `noiseExcludes` | string[] | `['!**/node_modules/**','!**/.pnpm/**','!**/dist/**','!**/build/**','!**/coverage/**','!**/.git/**','!**/lib/**','!**/.dsh/**','!**/_tmp_review/**']` | 负向 glob（注意含 **`lib`**——构建产物默认不被检索） |

### 4.2 工具契约（4 个）

| 工具 | 入参 | 出参 schema | cap |
|------|------|-------------|-----|
| `code_search` | `pattern`(必填)、`path?`、`include?`、`exclude?`、`maxResults?` | `{count, total, truncated, noiseGlobs, noisePolicy, results:[{path,lineNo,text,error?}]}`；render 头部 `共 N 匹配（未截断）` 或 `共 ≥N 匹配（截断：显示 M / 至少 N）` + `模式=regex \| 噪音排除=K 条（策略）`，其后每行 `path:lineNo: text` | 50 |
| `code_locate` | `term`(必填)、`path?`、`include?`、`maxResults?` | `{count, files:[string]}`；render `共 N 个文件`（截断时 `共 N 个文件（显示 M）`）+ 文件清单 | 30 |
| `code_symbols` | `path?`、`include?`、`exclude?`、`maxFiles?`、`maxSymbols?` | `{count, files, total, truncated, mode, symbols:[{path,kind,name,lineNo,sig}], error?}`；render `符号地图（mode=regex 正则近似，非 AST）：扫描 F 文件 / S 符号（已截断?）` + 按文件分组 `kind name (L行号)` | 文件 40 / 符号 300 |
| `code_impact` | `symbol`(必填)、`path?`、`include?`、`exclude?`、`maxFiles?`、`maxResults?` | `{count, exact, unverifiedCount, scanned, files, truncated, mode, defs:[{path,lineNo}], refs:[{path,how,via?}], unverified:[{path,lines}], error?}`；render `引用面（mode=import-graph：导入归属 + 导出链可达性）：扫描 N 文件 \| 精确引用 M \| 未证实 K`，随后定义点清单（**为空时披露三种成因**，见下）+ 每个引用者一行 `[how] path ← '模块说明符'` | 文件 4000 / 每档 30 |

**`code_impact` 的诚实分级词汇表（`how` 字段，闭集）**——这是本工具的核心纪律：每条边都要说清「我凭什么认为它引用了」：

| `how` | 含义 | 精度 |
|-------|------|------|
| `import-direct` | 该文件的 import（或 re-export）子句显式列出该符号，且来源解析到**定义文件本身** | 精确 |
| `import-chain` | 来源解析到**再导出者**，沿 re-export 链可达定义文件 | 精确（链路上每跳都是显式 import/export） |
| `same-file` | 引用与定义在同一文件内（排除定义行本身） | 精确 |
| `name-only` | 正文出现该名字但**无导入关系可证**——可能是同名符号、注释或字符串 | **未经证实**，单独成档 |

末档**永不混入**引用者计数：`count` 只数前三档，`unverifiedCount` 单独给——把「猜的」和「证的」分开放，是 ripwire 的 `provenance` 分级教给本插件的做法。

**`code_impact` 的静默归零披露**：定义文件若落在 `maxFiles` 之外，`definingSet` 会为空 ⇒ 所有引用退化为 `unverified`，输出看起来像「没人引用它」。故 render 在 **定义点为 0** 时显式列出三种成因（符号名不符 / 被截断 / 由动态方式引入），不让这种失效静默。

**`code_search` 的诚实计数（2026-09-20 新增，`total`/`truncated`）**：`count` 是**实际收集条数**（≤cap），
`total` 是 rg 输出里 `match` 记录的**真实总数**。修复前 render 把截断值当「共 N」⇒ 有 500 处命中时显示「共 50 匹配」，
读者会以为只有 50 处。现在截断时显示 `共 ≥N`，并显式写「截断」。
代价：达到 cap 后**仍要解析剩余记录**才能数准（大输出时 JSON 解析量上升，属诚实计数的必要成本）。

**`code_symbols` 的诚实边界**：符号识别是**逐行正则近似**（TS/JS、Python、Rust、Go、Markdown 标题），
**不是 AST**——多行签名、宏、代码生成、装饰器改写认不全；输出带 `mode=regex` 标注，
触顶（文件/符号/单文件 512 KB）时 `truncated=true` 并在 render 里显示「已截断」。**不认识的语言不猜**（零符号，不报错）。

`exclude` 的拼装：`'!' + args.exclude`（因此调用方传 `**/tests/**` 即得 `!**/tests/**`；**若自己写成 `!x` 会得到 `!!x`**，见 U3）。

### 4.3 调用点清单 `[MUST]`

| 调用方 | 调用点（文件:符号） | 时机 |
|-------|------------------|------|
| web 组合 | `.dsh/profiles/web/cordis.patch.yml:232`（`id: agent-code-search`，无 config） | web 启动装载（**唯一挂载点**） |
| 插件自身 | `src/index.ts:124` `ctx.tools.register(defineTool({name:'code_search' …}))` | 装载时注册 |
| 插件自身 | `src/index.ts:154` `ctx.tools.register(defineTool({name:'code_locate' …}))` | 装载时注册 |
| 插件自身 | `src/index.ts:190` `logger.info('dsh-code-search 就绪（rg=' + (config.rgPath \|\| 'rg(PATH)') + '）')` | 装载成功（**宿主 logger 不落盘**） |
| 插件自身 | `src/index.ts:89` `traced(...)` —— **两个工具执行体的唯一收口**（观测层单点落笔，见 §4.4） | 每次工具调用 |
| 插件自身 | `src/index.ts:183` `codeSearchTrace({phase:'boot' …})` | `apply()` 装载（进程级构建自报，Q1） |
| 依赖服务 | `src/index.ts:inject = ['tools']` | cordis 激活门 |
| 技能（消费方） | `alice-self-assets/skills/rg-wrapper-tool-development/SKILL.md:8`（本插件即该技能的方法论来源） | 检索需求 |
| 技能（消费方） | `alice-self-assets/skills/rg-wrapper-tool-development/SKILL.md:38`（「code_locate 找 JsonValue 秒定位」） | 上线后真实场景验证 |
| 技能（消费方） | 本会话工具面（`code_search`/`code_locate` 直接出现在工具列表中——本次补课任务即用它取证） | 任意检索 |
| 外部子进程 | `execFile(<rgPath \|\| 'rg'>, argv)`（`src/index.ts:57`） | 每次工具调用 |
| 落盘产物 | `<DSH_HOME>/code-search-trace.jsonl`（自证侧车，2026-09-14 批次 S4-A 新增，见 §4.4） | 每次 `apply()` + 每次工具调用 |

### 4.4 自证轨迹契约（`<DSH_HOME>/code-search-trace.jsonl`）`[MUST]`

**动机**：本插件修过一个静默失效缺陷——`rg` 不存在时 `code_search` 报「0 匹配」，与「真的没有」同形。
修复只保证「这一次」；**让同类问题下次一眼可见**才是语义层需求（AGENTS.md §5.22 规则 1）。

- **落盘路径**：`<DSH_HOME>/code-search-trace.jsonl`（`DSH_HOME` 环境变量优先，缺省 `<homedir>/.dsh`；
  解析走 `src/trace.ts:resolveHome` **单一真源**）。追加式 JSONL，一行一事件。
- **阶段枚举**（`CodeSearchTracePhase`，闭集）：`boot`（`apply()` 时的进程级构建自报）
  → `search`（`code_search`）→ `locate`（`code_locate`）。**无自由阶段字符串**。
- **行 schema**（字段固定，`boot` 行用中性值填充，`tail` 后可直接读列）：

  | 字段 | 含义 | 回答哪一问 |
  |------|------|-----------|
  | `atMs` | 写入时刻（ms epoch） | 时间线 join |
  | `phase` | `boot` / `search` / `locate` | Q2 谁发起 |
  | `build` | `<version>@<模块 mtime ms>` | **Q1 线上跑的是哪个构建** |
  | `op` | `code_search` / `code_locate` / `apply` | Q2 谁发起 |
  | `query` | pattern/term（**脱敏 + 截断 120**） | Q2 输入侧 |
  | `root` / `include` / `exclude` | 生效的检索范围 | Q2/Q4 |
  | `noiseGlobs` | 生效的噪音排除 glob 条数 | Q4 |
  | `noisePolicy` | `strict` / `include-overridden` / `none` | **Q4 噪音排除真的生效了吗** |
  | `maxResults` | 结果上限（search 缺省 50 / locate 缺省 30） | Q4 预算 |
  | `exitCode` | rg 退出码（`-1` = 未执行到子进程） | **Q3 断在哪一段** |
  | `count` | 命中数（匹配数 / 文件数） | Q4 结果质量 |
  | `durationMs` | rg 全量子进程耗时 | Q5 |
  | `ok` | 成功与否（**无匹配也 `true`**，只有失败才 `false`） | **Q3** |
  | `error?` | 失败原因（spawn 分类 / 信号终止 / stderr 前 500） | Q3 断点分类 |

- **不变量**：① **`exitCode=1` 且 `ok=false` 只可能是失败**，绝不等同「无匹配」（`ok=true, count=0`）；
  ② **`query` 落盘前必经 `redactQuery`**——凭据形状串一个字符都不落盘（§7 A16 有尸体测试）；
  ③ **观测绝不反噬主流程**：`appendTraceEntry` 全部 IO 失败吞错并返回 `false`，业务异常原样重抛。
- **调用点清单**：`src/index.ts:89 traced()`（唯一收口，包住两个执行体）+ `src/index.ts:183` boot 行。
  **新增工具必须经 `traced()` 落笔**——绕开它 = 悄悄制造新的观测盲区。
- **查询方式**：`tail -3 <DSH_HOME>/code-search-trace.jsonl`（最近三次检索的五问）。

## 5 · 边界与信任

- **能力边界 ≠ 沙箱**：`pattern` 是**正则**，可触发灾难性回溯（ReDoS 型）在极端模式上拖住 rg；rg 自身有软保护但不承诺。另：`lib/` 被默认排除——**「找不到」有时是排除规则的功劳而非事实**（判读结果时须记住这一点）。
- 不越界清单：不写文件、不建索引、不联网、不缓存、不解析二进制内容、不做语义排序（结果顺序 = rg 行序）。
- 失败面（**两条工具口径不一致，已实测**）：
  - `code_search`：rg 报错（stderr 非空且 code ≠ 1）→ **返回一条 `{path:'',lineNo:0,text:'',error:<stderr 前 500>}`**，render 显示 `code_search 错误: …`（**拒绝 + 报错**）。
  - `code_locate`：同样条件下 → **`{count:0, files:[]}`**（**静默返回空清单**，`src/index.ts:109`）。违反「坏数据不许静默」纪律：调用方无法区分「真没有」与「rg 挂了」。登记为 §10 U1 的最高优先修补项。
  - js-yaml 式容错：非 JSON 行（如 rg 的启动告警）→ `catch { /* 非 JSON 行跳过 */ }`（**静默跳过**，由 I2 语义兜住，可接受）。
  - 进程级异常（execFile 抛错，如 rg 不存在）→ `err.code` 非数字时按 code=1 处理 → **等同「无匹配」**，也会静默成空结果——与上一条同源风险。

## 6 · 与既有机制的关系

- **与官方 `grep` 工具的关系**：并存、互补。官方 grep 覆盖通用检索；本插件追加「噪音排除 + 盘符安全 + 结果上限 + 定位语义」四层策略，是 AGENTS.md §5.22「排障即升级工具」类工作的主力仪器。
- **与技能的关系**：`rg-wrapper-tool-development` 是本插件的开发方法论沉淀（含 Windows 盘符坑、`rg --json` 结构化、噪音排除设计），**改本插件前先读该技能**。
- **组合变更纪律（§5.11）**：改源码 = 组合变更；改 `defaultPath/rgPath/noiseExcludes` = 配置变更（`plugin_configure`，自带预检 + 哨兵重启）。
- **生效判据（改代码后怎么证明真的生效）**：
  1. 进程级：`self-plugins/dsh-code-search/lib/index.js` mtime 必须早于 3080 监听进程启动时间。本轮实测：lib = `2026-09-03 11:02:31`，web（PID 7080）启动 = `2026-09-14 10:05:47` → **已生效**。
  2. 环境级：`rg --version` 在 PATH 中可用（`rgPath` 未配置，完全依赖 PATH——**rg 不在 PATH 时工具面整体静默退化**）。
  3. 工具级：`code_locate term=runPreflightCore include=*.ts` 返回非空文件清单（一次真实调用即判真假）。
- **回退（出问题怎么退）**：
  1. 组合级：`plugin_stop dsh-code-search` / 删 patch 行 → 立即失去工具面（官方 `grep` 工具仍在，检索能力不断档）。
  2. 配置级：`defaultPath`/`rgPath` 填错（如指向不存在的 rg）→ 改回 `''`（走 PATH）+ `E:/alice`；走 `plugin_configure`。
  3. 代码级：`git -C E:/alice/self-plugins/dsh-code-search log --oneline` → `git revert <sha>` → `pnpm build` → 预检 → 哨兵重启。

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据（单测名/命令/日志行/HTTP） | 状态 |
|---|-----------|------------------------------|------|
| A1 | 工具面恰为 2 个（`code_search`、`code_locate`） | 会话工具列表命中 2；源码 `ctx.tools.register` 计数 = 2 | 已实测（源码计数） |
| A2 | 默认排噪音（I1） | 在 `node_modules` 内写唯一串 `ZZQQ_MARKER_1` → `code_search pattern=ZZQQ_MARKER_1` 返回 `count:0` | **待验收** |
| A3 | 无匹配不报错（I2） | `code_search pattern=ZZQQ_NOT_EXIST_9527` → `count:0` 且无 `error` 字段 | **待验收** |
| A4 | `code_locate` 与 `code_search` 失败口径**一致**（原命题「不一致」已随 2026-09-14 修复翻转） | `rgPath: 'X:/nope/rg.exe'` → `code_search` 显示 `code_search 错误: rg 无法执行（ENOENT）…`；`code_locate` 显示 `code_locate 错误: …`。**原命题本身写错了**：修复前 `code_search` 在 ENOENT 下**也不报错**（stderr 为空 ⇒ 条件不成立 ⇒ 当作空匹配），见 §9 | **已由单测覆盖**（离线判据）+ 待线上复验 |
| A5 | `enabled` 字段无门控 | patch 行配 `enabled: false` → 工具仍注册（`code_search` 仍可调用） | **待验收** |
| A6 | 当前进程加载最新构建 | lib mtime `2026-09-03 11:02:31` < web PID 7080 启动 `2026-09-14 10:05:47` | 已实测（2026-09-14 读数） |
| A7 | 挂载行唯一且无 config | `grep -n "dsh-code-search" cordis.patch.yml` → 1 命中（行 233），相邻无 `config:` 块 | 已实测 |
| A8 | 本插件即当前会话的检索仪器 | 本次补课中 `code_search`/`code_locate` 调用返回真实命中（如 `comfyui-guidance/SKILL.md:422`） | 已实测（2026-09-14 本会话） |
| A9 | spawn 层失败（ENOENT/EACCES）与信号终止**不伪装成「无匹配」** | `npm test` → `tests/rg.test.mjs:classifyRgOutcome` 四条失败路径断言（ENOENT/EACCES-EISDIR/SIGTERM/超长 stderr 截断）；**证伪证据见 §9**（旧逻辑同样本判 `failure=null`） | **已实测（2026-09-14，33/33 pass）** |
| A10 | argv 拼装与输出解析有离线单测（含失败/退化路径） | `npm test` → `tests/rg.test.mjs` 26 例：空模式/空 include/损坏 JSON 行/缺字段/`cap=0`/负数 cap/空输出 | **已实测（2026-09-14）** |
| A11 | 用户输入不得经 shell 解析（注入面守卫） | `npm test` → `tests/shell-contract.test.mjs`：扫描 `src/*.ts` 无 `exec(`/`spawn(`/`execSync`/`spawnSync`/`shell:true`；**尸体样本**（三种坏形态）先证明扫描器会命中 | **已实测（2026-09-14）** |
| A12 | `rg.ts` 保持纯逻辑（可离线单测） | `npm test` → 断言 `src/rg.ts` 不含 `child_process`；`execFile(rgPath, args, …)` 第二参必须是 argv 数组（非拼接字符串） | **已实测（2026-09-14）** |
| A13 | 每次检索落一行自证轨迹（五问可一条命令答） | `npm test` → `tests/trace.test.mjs:离线组合` 真写出两行；线上：`tail -3 $DSH_HOME/code-search-trace.jsonl` 可读 `build/phase/op/query/exitCode/count/durationMs/ok` | **待线上验收**（离线已锁；本批不部署，由派发者统一部署） |
| A14 | **失败与「无匹配」在轨迹里可辨**（原缺陷的判据面） | `npm test` → `classifyTraceOutcome` 六类样本：成功(`ok=true,count=3`)、无匹配(`exitCode=1` → **`ok=true,count=0`**)、ENOENT(`ok=false`)、SIGKILL(`ok=false`)、结果体内嵌 error、抛错 | **已实测（离线）** |
| A15 | 观测绝不反噬主流程（IO 失败不抛） | `npm test` → `尸体测试：父路径是普通文件 → 返回 false 且不抛`（断言 `assert.doesNotThrow` + `=== false`） | **已实测** |
| A16 | **凭据不落盘**（隐私红线，含尸体测试） | `npm test` → `隐私尸体测试`：喂 `sk-live-…`/`ghp_…`/`api_key=hunter2secret`/`Authorization: Bearer <32位>` 四种 pattern → 断言落盘原文里 `includes(secret) === false`，且 `[redacted]` 确实出现（排除「没写进去」的假绿） | **已实测** |
| A17 | 噪音排除策略在轨迹里可辨（含 include 覆盖） | `npm test` → `describeQueryScope` + `noisePolicyOf`：`strict` / `include-overridden` / `none` 三态；离线组合断言 include 存在时判 `include-overridden`（对应 §10 U4 语义） | **已实测** |
| A18 | `build` 自报能回答「线上跑哪个构建」 | `npm test` → `buildStamp`：`1.2.3@<mtime>`；读不到版本退化为 `unknown@<mtime>`（不抛） | **已实测** |
| A19 | `code_symbols` 在工具面且返回符号清单 | 会话工具列表含 `code_symbols`；对 `dsh-life-core/src`（include `*.ts`，maxFiles 8）线上实测返回 **8 文件 / 77 符号**，按文件分组 | **已实测（2026-09-20）** |
| A20 | 符号识别压得住误报（形态约束生效） | 同目标同参数前后对照：修前 **243** 符号（含 `const dir`/`const text`/`method mkdirSync`/`method saveState` 等局部量与调用）→ 修后 **77**，局部 const 与方法调用误报 **0** | **已实测（2026-09-20，前后对照）** |
| A21 | `code_search` 头部给**真实总数**而非截断值 | `code_search{pattern:'defineTool', include:'*.ts', maxResults:5}` → 头部 `共 ≥325 匹配（截断：显示 5 / 至少 325）`（修前显示「共 5 匹配（显示 5）」） | **已实测（2026-09-20）** |
| A22 | 头部披露匹配模式与噪音排除策略 | 同上调用 → `模式=regex \| 噪音排除=9 条（include-overridden）`——「include 覆盖了噪音排除」这一陷阱对读者可见 | **已实测（2026-09-20）** |
| A23 | 未知语言不猜 | `npm test` → `extractSymbols(…, 'txt')` 返回零符号且 `truncated=false`（不是报错） | **已实测（单测）** |
| A24 | 触顶如实披露 | `npm test` → 10 行输入 + `maxSymbols=3` → `symbols.length=3, truncated=true`；刚好用满上限不算截断 | **已实测（单测）** |
| A25 | `code_impact` 在工具面，且一次调用给出定义点 / 精确引用者 / 未证实提及三档 | 线上调用 `code_impact{symbol:'defineTool', path:'…\\deepseek-harness\\packages', include:'*.ts'}` → render 头部 `扫描 3198 文件 \| 精确引用 47 \| 未证实 11`，定义点 2 条带行号（`schema.ts:545` / `tools.spec.ts:2762`） | **已实测（2026-09-20 线上）** |
| A26 | 三层解析齐备：相对路径 / 包名映射 / re-export 链可达性 | 三层各自单独可证伪——① 单测 `resolveModule` 四态（rel / pkg-entry / pkg-sub / unresolved-pkg）；② 包名映射实测 298 个 package.json；③ 探测对照：只认相对路径时 45 个引用**精确归零**，补包名后仍 0/58，补导出链后 **45/58**（其中 43 个靠链） | **已实测（2026-09-20，三层逐层对照）** |
| A27 | 同名符号靠**导入归属**消歧（尸体测试：名字匹配式实现在此会混淆） | `npm test` → `尸体测试：同名符号靠导入归属消歧`：两个包各有 `handle()`，`use1` 只能归 `p1`、`use2` 只能归 `p2`，`unverified` 为 0 | **已实测（单测）** |
| A28 | **再导出者本身也是引用者**（原实现漏算，修正有前后对照） | 修正后线上读数（同 A25 参数）：精确 **47**、未证实 **11**；修正前（探测脚本版）为 45 / 12——差的那一笔正是 `core/tools/src/index.ts` 的 `defineTool,` re-export 行 | **已实测（2026-09-20 前后对照）** |
| A29 | 定义点为 0 时**披露成因**（静默归零不再无声） | render 分支：`defs.length === 0` → 输出「可能是①符号名不符 ②被 maxFiles 截断 ③由 re-export/动态方式引入」；`npm test` 覆盖空图退化（零结果不抛） | **已实测（2026-09-20，源码分支 + 单测）** |

## 8 · 与实现的关系

- 主实现：`self-plugins/dsh-code-search/src/`（`index.ts` 接线与 IO + `rg.ts` 纯逻辑层 + `trace.ts` 自证轨迹层（纯函数 + 薄 IO，2026-09-14 新增），无同语义副本）。
- 未实现/未验证部分**显式标注**：
  - **`enabled` 死配置（已实测）**：字段在 `Config` 中声明、默认 `true`，但 `apply()` 体内**没有任何分支读它**（对比 `dsh-blue-team` 的 `if (config.enabled)` log、`dsh-agent-reflection` 的 `enabled` 门控）。因此 `enabled:false` **不会**关掉工具面——停用只能走组合 `disabled`。
  - **失败口径已统一（2026-09-14 修复）**：`code_search` 与 `code_locate` 现在都在 spawn 失败/非零退出码时暴露 `error`（此前 `code_locate` 静默吞、`code_search` 在 ENOENT 下同样静默——两者同形）。
  - **单测（2026-09-14 补课已补，批次 S4-A 再加轨迹面）**：`tests/rg.test.mjs`（26）+ `tests/shell-contract.test.mjs`（7）+ `tests/trace.test.mjs`（**18**，批次 S4-A 新增）= **51/51 全过**；`npm test` 一条命令可复跑。A2–A5 仍需**真实 rg + 真实磁盘**的线上验收（离线单测不能替代），但 argv 拼装、输出解析、退出码归类、注入面、**自证轨迹面**已机器锁死。
  - **自证侧车已补（2026-09-14 批次 S4-A）**：`<DSH_HOME>/code-search-trace.jsonl`（§4.4）。此前 `ctx.logger` 不落盘 ⇒「实际 argv / 耗时 / 命中数 / rg 失败分类」事后不可查（§5.22 缺口）；现在 `tail` 一行即可回答五问。**仍待线上验收**：本批不部署（由派发者统一部署），轨迹行尚未在真实 web 进程里产出。
  - `repository` 字段缺失（`package.json` 无 `repository`），GitHub 归属只能从 README 徽章推断。

## 9 · 实践修订记录

- **2026-09-20 · v0.3：从「借鉴 ripwire」到「在单一维度上超越」——`code_impact` 引用图层** —— 主人指令「超越ripwire」
  - **动机与定位**：v0.2 只借鉴了两条**思路**（先给地图、诚实计数），而 ripwire 的**核心能力**是调用图与影响面
    （`--callers`/`--impact`/`--affected`），本插件此前完全没有。v0.3 的目标是**在 TS/ESM 仓这一个维度上**给出
    比它更精确的答案，而**不假装全面超越**（它仍有函数级调用边、PageRank 排序、21 语言支持——对照表写进 §1.1）。
  - **失败阶梯（本轮最有价值的产物）**：三层解析**不是设计出来的，是被实测一层层逼出来的**——
    ① 只认相对路径 ⇒ 45 个引用**精确归零**（真实 monorepo 的引用几乎全走裸包名 `@scope/pkg`）；
    ② 补了包名映射（扫 298 个 package.json 建 name→dir）仍 **0/58**——因为 import 落到**包入口** `index.ts`，
    而定义在 `schema.ts`，入口只是 **re-export** 它；
    ③ 补了 **re-export 链可达性**（BFS 沿 `export {X} from` / `export * from`）后 **45/58 精确**，其中 **43 个靠导出链**才成立。
    **教训：在真实仓上「解析不到」往往不是算法错，而是对仓形态的假设错**——而假设错一次精确率就是 0，
    0 又与「真的没有引用」同形，正是本插件一直在防的那类静默失效。
  - **语义被修正（假阴性，由双向核对暴露）**：抽查降级档时发现 `core/tools/src/index.ts` 的 `defineTool,`
    是 **re-export 清单**——**再导出者本身也是引用者**（它依赖被导出的符号），此前漏算。
    修正后线上实测：精确 45→**47**、未证实 12→**11**（那一笔从降级档移进精确档，前后对照即为证据）。
  - **语义被补充（静默归零披露）**：定义文件若被 `maxFiles` 截断在扫描范围外，`definingSet` 为空 ⇒
    **所有引用退化成 `unverified`**，输出看起来像「没人引用它」。两处处置：缺省 `maxFiles` 2000→**4000**
    （实测 DSH packages 有 3623 个 .ts/.tsx）+ render 在**定义点为 0 时列出三种成因**。
  - **实测读数**（`E:\alice\deepseek-harness\packages`，3198 文件）：建图 **744 ms**（对照 ripwire 在 12072 文件上 61.2 s）；
    线上调用 `code_impact{defineTool}` → 扫描 3198 文件 / **精确引用 47** / 未证实 11 / 定义点 2（带行号）。
  - **可测试性**：逻辑全在 `src/graph.ts` 的**纯函数**里（文件存在性由调用方注入 `fileExists` ⇒ 不碰磁盘），
    配 `tests/graph.test.mjs` **11 条**；含**同名消歧尸体测试**（两个包各有一个 `handle()`：按名字匹配会把
    引用同时归到两个定义，按导入归属只能各归各家）——这条就是「为什么这条路比名字匹配强」的机器判据。
  - **测试首跑 3 红的三分类**：① 注释掉的 `import` 被正则当真引用（**实现该修** ⇒ 加行首注释过滤）；
    ② `parseReexports` 两趟正则令输出顺序不忠实于源码（**实现该修** ⇒ 按 index 排序）；
    ③ `candidatePaths` 的断言写错（**我的预期错** ⇒ 对 `.ts` 写入断言「去扩展名形态」本就不成立，改为验证 `.js`→`.ts` 映射）。

- **2026-09-20 · v0.2：借鉴 ripwire 思路做两项增强（符号地图 + 诚实计数）** —— 主人指令「借鉴思路增强本地插件」
  - **语义被补充（新工具）**：`code_symbols` 补上**结构视角**（此前只有字符串视角 `code_search` 与文件视角 `code_locate`）——
    「先给地图，再读文件」：一次调用拿到目录里定义了哪些 function/class/interface/type/const 及行号，省掉逐个 read。
    诚实标注随输出走：`mode=regex`（正则近似，非 AST）+ 触顶时 `已截断`。
  - **语义被修正（我自己的实现缺陷，被线上实测抓出）**：首版符号识别把 TS/JS 的**函数内局部 const**（`const dir = …`）
    与**缩进的方法调用**（`mkdirSync(dir, {…})`、`saveState(state)`）都当成了定义 ⇒ 对 8 个文件报出 **243** 个「符号」，
    大半是噪音。根因：正则下「模块级定义」与「局部量/调用」**完全同形**，唯一可分的形态是
    **行首缩进**（`const` 只收顶格）与**行尾字符**（方法定义以 `{` 收尾，调用以 `)`/`;` 收尾）。
    加这两条形态约束后降到 **77** 符号，误报 0（A20 前后对照）。
  - **教训**：**正则近似法的质量不取决于正则写得多全，而取决于有没有用「形态约束」把同形的高频噪音分开**。
    不做这一步的产物比「没有工具」更坏——它看起来丰富，实际是流水账，还会消耗读者的注意力。
  - **语义被补充（诚实计数）**：`code_search` 的「共 N」此前是**截断值**（`count` = 实际收集条数）——
    500 处命中时显示「共 50 匹配」，读者会以为只有 50 处。改为 `total`（rg 输出里 match 记录的真实总数）+ `truncated`，
    render 截断时写 `共 ≥N`。**代价显式**：达 cap 后仍需解析剩余记录才能数准（诚实计数不是免费的）。
  - **行为变更清单**：① `code_search` 出参加 `total`/`truncated`/`noiseGlobs`/`noisePolicy`（schema 与 render 同步）；
    ② 轨迹加 `symbols` 阶段与 `total`/`truncated` 可选字段；③ 新工具 `code_symbols`；④ 新源文件 `src/symbols.ts` + `tests/symbols.test.mjs`。
    **正常路径的既有输出语义不变**（`code_search` 的匹配行、`code_locate` 的清单逐字未变），仅头部多一行披露。
  - **部署**：`tsc` 构建 → `npm test` **69/69 过** → `preflight_check(full)` → 哨兵重启（两轮：首版部署 + 误报修复部署），
    每轮都以**线上真实调用**复验（A19–A22）。

- **2026-09-14 · 静默失败缺陷：rg 缺失被伪装成「无匹配」（已修 + 加机器守卫）**
  - **症状**：`rg` 不在 PATH（或 `Config.rgPath` 指向不存在的文件）时，`code_search` 返回 `{count:0}`、
    render 显示「共 0 匹配（显示 0）」——**与「真的没有匹配」完全同形**。整个插件的检索能力静默失效。
  - **根因**：`runRg` 把 `err.code` 归一为 `typeof code === 'number' ? code : 1`。spawn 层失败时
    `err.code` 是**字符串**（`ENOENT`/`EACCES`）⇒ 归一成 **1**，而 1 正是 rg 的「无匹配」哨兵；
    且此类失败 `stderr` 为空 ⇒ 调用方条件 `stderr && code !== 1` 不成立 ⇒ 判为成功空结果。
    **两个独立信号（退出码、stderr）在这条路径上同时失效，这就是静默的成因。**
  - **证伪证据（修前）**：同一 `{code:'ENOENT', message:'spawn rg ENOENT'}` 样本，
    旧逻辑 `code=1`、判为失败 `false`；新逻辑 `failure='rg 无法执行（ENOENT）：spawn rg ENOENT——请确认 rg 已安装，或用 Config.rgPath 指定绝对路径'`。
  - **修复**：抽出 `src/rg.ts:classifyRgOutcome(err, stderr)`——**spawn 层失败（字符串 code）与信号终止
    单列为 failure**，与「rg 退出码 1 = 无匹配」严格分开；`code_locate` 同步回 `error`（口径统一）。
  - **语义被补充（新不变量）**：**「执行失败」与「没有结果」必须是两个可区分的返回**；
    退出码归类由 `tests/rg.test.mjs` 覆盖 ENOENT / EACCES / EPERM / EISDIR / SIGTERM / 无 code 六类样本。
  - **行为变更清单（本次两处，均已列出理由）**：① `code_search` 在 spawn 失败/信号终止时由「空结果」
    改为「error 哨兵」；② `code_locate` 新增可选 `error` 字段（schema 加 `error: {type:'string'}` + render 分支）。
    **正常路径产物不变**（`code===0` 无错误对象时两工具输出逐字节一致）。

- **2026-09-14 · 逻辑可测试化（纯函数抽取，零行为变更）**
  - **语义被确认**：`buildSearchArgv`/`buildLocateArgv`/`parseRgJsonLines`/`parseFileList` 的语义从
    `index.ts` 闭包搬入 `src/rg.ts`（无 IO），逐条对齐原实现。
  - **语义被补充（两条此前无人知道的真实语义）**：
    ① **include 排在 exclude 之后** → rg「后置 glob 覆盖前置」⇒ `include='*.ts'` 会把 `node_modules` 下的
    `.ts` 重新纳入，与工具描述「默认排除噪音」**表面矛盾**（既定语义，登记 §10 U4）；
    ② **两工具的 cap 语义不对称**：`code_search` 的 `cap<0` 返回空，`code_locate` 的 `cap<0` 走
    `slice(0,-n)` **从尾部丢弃**（登记 §10 U5）。
  - **语义被修正（我自己的预期错）**：本轮无（33 条首跑全绿；blue-team 侧出现过同类事件，已记在该仓 §9）。

- **2026-09-14 补课：本插件此前无语义文档（可维护性工程）**
  - 语义**被确认**：零新依赖（复用系统 rg）、`rg --json` 结构化输出、9 条默认噪音排除、退出码 1 = 无匹配（非错误）、Windows 盘符坑已规避。
  - 语义**被补充**：组合挂载点（patch 行 231–233，无 config → 全默认）、消费方技能 `rg-wrapper-tool-development`（行 8/38）、`lib/` 亦在默认排除集内这一**判读陷阱**。
  - 语义**被修正**：无（此前无文档）；但实测登记两处实现级缺口——`enabled` 死配置、`code_locate` 静默吞错。
  - 教训（同时回写技能 `semantic-doc-first`）：**同一插件的两个工具可以有不同失败口径**——写语义文档时必须逐工具列失败面，否则「静默空结果」会被当成「真的没有」。

- **2026-09-14 · 批次 S4-A：自证轨迹层（观测层新增，业务行为零变更）**
  - **语义被补充（新不变量）**：**「执行失败」与「没有结果」不仅要返回值可辨，还要落盘可辨**——
    轨迹行的 `ok` 与 `exitCode` 必须能在 `exitCode=1` 时区分「rg 缺失」与「真的没匹配」
    （前者 `ok=false` + `error`，后者 `ok=true, count=0`）。这正是上一轮修复的判据在**证据层**的延伸：
    返回值只能回答「这一次」，轨迹才能回答「昨晚那次到底是哪种」。
  - **语义被补充（真实语义）**：`redactQuery` 的两条规则**串联命中**——`Authorization: Bearer abc.def`
    实测输出 `Authorization=[redacted] [redacted]`（Bearer 规则先擦 token，键值对规则再擦键值），
    属**过度擦除**（安全方向）。首版单测按「一次擦净」写预期 ⇒ 失败；判定为**我的预期错**，
    改预期并在测试注释里写明真实语义（技能 C11）。
  - **语义被确认**：新增 `traced()` 单点收口后，两个工具执行体的业务体**逐字未变**——
    仅签名多一个观测出口 `meta`（`RgRunMeta`）并由 `runRg` 填充 `exitCode/failure`；
    正常路径产物、argv 拼装、失败口径全部不变（**行为变更清单：无**）。
  - **教训**：观测层的「单点收口」不只是省事——本插件有两个执行体，若各改一处，
    下一个新增工具就会悄悄成为新的观测盲区（半吊子防线，缺陷形状 D1 的同源）。
- **2026-09-14 · 批次 S4-A：隐私红线（pattern 本身可能是凭据）**
  - **语义被补充**：`query` 是用户输入的**检索模式**，而排查「这个 key 在哪被硬编码」时
    用户会直接把 key 当模式搜 ⇒ **检索轨迹天然是凭据泄露面**。故 `redactQuery` 在落盘前按形状擦除
    （键值对 / `sk-`·`ghp_`·`github_pat_`·`AKIA` 前缀 / `Bearer` / ≥32 位高熵串），
    并配**隐私尸体测试**（断言原文搜不到凭据串，且 `[redacted]` 确实出现）。

## 10 · 未决问题

- **U1 `code_locate` 静默吞错（✅ 已闭环 2026-09-14）**：原倾向「改为返回 `{count:0, files:[], error:<stderr 前 500>}`，
  并把「rg 不存在」归入 error 而非按 code=1 放过」——**已按此实现**（`classifyRgOutcome` + schema 加 `error`）。
  闭环依据：`tests/rg.test.mjs` 的 ENOENT/EACCES/SIGTERM 失败路径断言 + `tests/shell-contract.test.mjs` 的结构守卫（A9/A11）。**遗留**：需一次线上复验（把 `config.rgPath` 指向不存在路径，确认两工具都显示「错误」）。
- **U2 `enabled` 语义**：是补门控（`apply` 内 `if (!config.enabled) return`）还是从 Config 删除（承认停用只走组合行）？倾向**删除**——两处开关（config 与 patch `disabled`）是「单点所有权」的反模式（AGENTS.md §5.19 同源纪律）。需裁决。
- **U3 `exclude` 前缀约定**：入参需传**不带 `!`** 的 glob（代码会加 `!`）。这与 `noiseExcludes` 的写法（带 `!`）相反，属易错面。倾向：接受两种写法（已有 `!` 则不重复加）。需裁决。
- **U4 include 与噪音排除的优先级（2026-09-14 补课实测登记）**：argv 中 include 排在 excludes **之后**，
  而 rg「后置 glob 覆盖前置」⇒ `include='*.ts'` 会把 `node_modules/**/*.ts` 重新纳入，
  与工具描述「默认排除 node_modules」表面矛盾。**当前行为已由单测钉住（改动即红）**；倾向：
  要么把 include 排到 excludes 之前（需评估是否破坏「显式 include 应优先」的用法），要么在工具描述里写明该例外。需裁决。
- **U5 `maxResults` 负数语义两工具不对称（2026-09-14 补课实测登记）**：`code_search` 的 `cap<0` → 空结果；
  `code_locate` 的 `cap<0` → `slice(0,-n)` **从尾部丢弃**（不是空）。倾向：统一为「负数视为 0，返回空」
  （保守：不返回任何结果比返回一个被静默截尾的列表更可解释）。需裁决。
- **U6 `redactQuery` 的擦除阈值可能过度（2026-09-14 批次 S4-A 登记）**：第 5 条规则
  `[A-Za-z0-9+/=_-]{32,}` 会把任何 ≥32 位连续此类字符的快照擦成 `[redacted]`——
  长路径片段（如 `alice/self-plugins/dsh-code-search`）、长标识符也会中招，导致 `query` 字段
  对「复现一次检索」的用途打折。**只登记不改**：隐私红线的方向是**宁可过度**，
  且 Q3（断在哪一段）由 `exitCode`/`ok`/`error` 承担，不依赖 `query`。倾向：
  若后续实测发现 Q2 复现能力受损，改为「保留首尾各 4 字符 + 中间擦除」的**部分可辨**策略。
- **U7 轨迹文件无轮转（2026-09-14 批次 S4-A 登记）**：`code-search-trace.jsonl` 为纯追加，
  无 `keepLines` 上界——本插件调用频率高（补课任务单轮可达数十次），长期可能膨胀。
  倾向：参考 `dsh-plugin-bootreport` 的「有界裁剪（`keepLines + 50`）」加一个上限，
  且断言写「有界」而非「恰好等于」。需裁决是否本轮补。

## 附 · 快速取证命令

```bash
# Q1–Q5 一条命令（最近三次检索）
tail -3 "$DSH_HOME/code-search-trace.jsonl"
# 只看失败笔次（Q3 断点分类）
grep '"ok":false' "$DSH_HOME/code-search-trace.jsonl" | tail -5
# 只看噪音排除被 include 覆盖的笔次（U4 的真实影响面）
grep '"noisePolicy":"include-overridden"' "$DSH_HOME/code-search-trace.jsonl" | tail -5
```
