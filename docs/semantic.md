# 语义文档：dsh-code-search（本地大仓检索面）

> 版本 v0.1 · 2026-09-14 · 作者：爱丽丝 · 状态：**draft**
> 开发方式：语义文档优先（先写清「是什么/什么关系/怎么裁决」，再让实现逼近，最后用实践回修）
> 实现落点：`self-plugins/dsh-code-search/src/index.ts`（唯一源文件，172 行；构建产物 `lib/index.js`）

| 项 | 值 |
|----|----|
| 能力名 | dsh-code-search（插件内 `name = 'agent-code-search'`） |
| 主副本路径 | `self-plugins/dsh-code-search/docs/semantic.md` |
| 实现落点 | `self-plugins/dsh-code-search/src/index.ts` |
| 版本 | `package.json` = 0.1.0 |
| 组合行 | `E:\alice\.dsh\profiles\web\cordis.patch.yml` 行 231–233，`id: agent-code-search`，**无 config**（走全默认） |
| 状态 | **draft**（实现已上线并挂载；本文为 2026-09-14 补课产物） |

---

## 1 · 定位与反定位

**定位**：封装**系统 ripgrep**，把「在数十万文件的大仓里找一行」变成 2 个工具——`code_search`（全文检索，返回匹配行）与 `code_locate`（按概念/符号定位文件）。核心价值是**默认排除噪音**（`node_modules/.pnpm/dist/build/coverage/.git/lib/.dsh/_tmp_review`）后再检索。

**反定位（本文不管什么）**：
- 不管**语义检索/向量检索**（这是正则/字面匹配；语义检索属记忆库 `recall`）
- 不管**文件内容编辑**（属 `edit`/`write`）
- 不管**官方 `grep` 工具**：两者并存——官方 grep 走 harness 内建，本插件是**自研的高层封装**（更强调噪音排除与 Windows 盘符处理）
- **不是**索引服务：零常驻进程、零倒排索引、每次调用现扫（用系统 rg 的并行扫描）
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

### 4.2 工具契约（2 个）

| 工具 | 入参 | 出参 schema | cap |
|------|------|-------------|-----|
| `code_search` | `pattern`(必填)、`path?`、`include?`、`exclude?`、`maxResults?` | `{count, results:[{path,lineNo,text,error?}]}`；render 输出 `共 N 匹配（显示 M）` + 每行 `path:lineNo: text` | 50 |
| `code_locate` | `term`(必填)、`path?`、`include?`、`maxResults?` | `{count, files:[string]}`；render 输出 `共 N 个文件` + 文件清单 | 30 |

`exclude` 的拼装：`'!' + args.exclude`（因此调用方传 `**/tests/**` 即得 `!**/tests/**`；**若自己写成 `!x` 会得到 `!!x`**，见 U3）。

### 4.3 调用点清单 `[MUST]`

| 调用方 | 调用点（文件:符号） | 时机 |
|-------|------------------|------|
| web 组合 | `.dsh/profiles/web/cordis.patch.yml:232`（`id: agent-code-search`，无 config） | web 启动装载（**唯一挂载点**） |
| 插件自身 | `src/index.ts:118` `ctx.tools.register(defineTool({name:'code_search' …}))` | 装载时注册 |
| 插件自身 | `src/index.ts:147` `ctx.tools.register(defineTool({name:'code_locate' …}))` | 装载时注册 |
| 插件自身 | `src/index.ts:171` `logger.info('dsh-code-search 就绪（rg=' + (config.rgPath \|\| 'rg(PATH)') + '）')` | 装载成功（**宿主 logger 不落盘**） |
| 依赖服务 | `src/index.ts:inject = ['tools']` | cordis 激活门 |
| 技能（消费方） | `alice-self-assets/skills/rg-wrapper-tool-development/SKILL.md:8`（本插件即该技能的方法论来源） | 检索需求 |
| 技能（消费方） | `alice-self-assets/skills/rg-wrapper-tool-development/SKILL.md:38`（「code_locate 找 JsonValue 秒定位」） | 上线后真实场景验证 |
| 技能（消费方） | 本会话工具面（`code_search`/`code_locate` 直接出现在工具列表中——本次补课任务即用它取证） | 任意检索 |
| 外部子进程 | `execFile(<rgPath \|\| 'rg'>, argv)`（`src/index.ts:38`） | 每次工具调用 |
| 落盘产物 | **无**（无缓存/索引/侧车轨迹） | — |

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
| A4 | `code_locate` 与 `code_search` 失败口径**不一致** | 用不存在的 rg 路径（`rgPath: 'X:/nope/rg.exe'`）→ `code_search` 显示 `code_search 错误: …`，`code_locate` 显示 `共 0 个文件` | **待验收**（命题为「不一致」，实测可判真假） |
| A5 | `enabled` 字段无门控 | patch 行配 `enabled: false` → 工具仍注册（`code_search` 仍可调用） | **待验收** |
| A6 | 当前进程加载最新构建 | lib mtime `2026-09-03 11:02:31` < web PID 7080 启动 `2026-09-14 10:05:47` | 已实测（2026-09-14 读数） |
| A7 | 挂载行唯一且无 config | `grep -n "dsh-code-search" cordis.patch.yml` → 1 命中（行 233），相邻无 `config:` 块 | 已实测 |
| A8 | 本插件即当前会话的检索仪器 | 本次补课中 `code_search`/`code_locate` 调用返回真实命中（如 `comfyui-guidance/SKILL.md:422`） | 已实测（2026-09-14 本会话） |

## 8 · 与实现的关系

- 主实现：`self-plugins/dsh-code-search/src/index.ts`（唯一文件，无同语义副本）。
- 未实现/未验证部分**显式标注**：
  - **`enabled` 死配置（已实测）**：字段在 `Config` 中声明、默认 `true`，但 `apply()` 体内**没有任何分支读它**（对比 `dsh-blue-team` 的 `if (config.enabled)` log、`dsh-agent-reflection` 的 `enabled` 门控）。因此 `enabled:false` **不会**关掉工具面——停用只能走组合 `disabled`。
  - **失败口径不一致（已实测）**：`code_search` 报错暴露，`code_locate` 静默吞（§5 失败面）。
  - **无单测**：仓库内无 `tests/`，A2–A5 无自动化证据。
  - **无自证侧车**：`ctx.logger` 不落盘 → 「实际 argv / 耗时 / 命中数」事后不可查（§5.22 缺口）。
  - `repository` 字段缺失（`package.json` 无 `repository`），GitHub 归属只能从 README 徽章推断。

## 9 · 实践修订记录

- **2026-09-14 补课：本插件此前无语义文档（可维护性工程）**
  - 语义**被确认**：零新依赖（复用系统 rg）、`rg --json` 结构化输出、9 条默认噪音排除、退出码 1 = 无匹配（非错误）、Windows 盘符坑已规避。
  - 语义**被补充**：组合挂载点（patch 行 231–233，无 config → 全默认）、消费方技能 `rg-wrapper-tool-development`（行 8/38）、`lib/` 亦在默认排除集内这一**判读陷阱**。
  - 语义**被修正**：无（此前无文档）；但实测登记两处实现级缺口——`enabled` 死配置、`code_locate` 静默吞错。
  - 教训（同时回写技能 `semantic-doc-first`）：**同一插件的两个工具可以有不同失败口径**——写语义文档时必须逐工具列失败面，否则「静默空结果」会被当成「真的没有」。

## 10 · 未决问题

- **U1 `code_locate` 静默吞错（最高优先）**：与 `code_search` 口径不齐，且违反「坏数据不许静默」纪律。倾向：改为返回 `{count:0, files:[], error:<stderr 前 500>}`（与 `code_search` 同形），并把「rg 不存在」这一类也归入 error 而非按 code=1 放过。需实现者裁决。
- **U2 `enabled` 语义**：是补门控（`apply` 内 `if (!config.enabled) return`）还是从 Config 删除（承认停用只走组合行）？倾向**删除**——两处开关（config 与 patch `disabled`）是「单点所有权」的反模式（AGENTS.md §5.19 同源纪律）。需裁决。
- **U3 `exclude` 前缀约定**：入参需传**不带 `!`** 的 glob（代码会加 `!`）。这与 `noiseExcludes` 的写法（带 `!`）相反，属易错面。倾向：接受两种写法（已有 `!` 则不重复加）。需裁决。
