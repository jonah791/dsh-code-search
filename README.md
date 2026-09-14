<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 本地代码/文件智能检索：封装系统 rg（ripgrep），默认排除 node_modules/.pnpm/dist/build/coverage/.git/lib/.dsh 等 9 条噪音目录，code_search（全文检索，rg --json 结构化防 Windows 盘符坑）+ code_locate（--files-with-matches 定位文件）；每次检索落一行自证轨迹
  inject: 'tools'
  tools: code_search,code_locate
  runtime: host-only
  envDeps: 系统 rg（ripgrep 可执行文件，rgPath 为空时走 PATH；无 rg 则两工具显式报错而非静默空结果）
  boundary: pattern 是正则（极端模式可拖住 rg 的 ReDoS 类风险）；lib/ 默认排除——「找不到」有时是排除规则的功劳而非事实；纯只读（不写文件/不建索引/不联网）
  compat: cordis ^4.0.1 / schemastery ^3.18.1-rc.1 / dsh-tools ^0.1.0-rc.6
-->
# dsh-code-search

<p align="center">
  <a href="https://github.com/jonah791/dsh-code-search"><img src="https://img.shields.io/badge/version-0.1.0-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-51%20passed-brightgreen" alt="tests">
</p>

**一句话**：给 agent 一个「懂大仓」的检索工具——封装**系统 ripgrep**，默认排除 `node_modules`/`.pnpm`/`dist`/`build`/`coverage`/`.git`/`lib`/`.dsh` 等噪音后检索，2 个工具：`code_search`（全文检索返回匹配行）+ `code_locate`（按概念定位「X 在哪个文件」）。

**为什么值得用**：通用 `grep` 搜大仓的痛点是噪音（`node_modules` 里成千上万的假命中）与 Windows 盘符路径解析坑。本插件零新依赖复用系统 rg 内核，`--json` 结构化输出规避盘符坑，结果带上限不撑爆上下文；且「rg 不存在」**显式报错**而不是伪装成「0 匹配」——检索能力有没有生效，一眼可辨（每次检索还落一行 `code-search-trace.jsonl` 自证轨迹）。

## 能力

| 工具 | 用途 |
|------|------|
| `code_search` | 智能全文检索（rg 封装）：正则模式、根路径（缺省 `<工作区>`）、`include`/`exclude` glob 过滤、结果上限（缺省 50）。返回 `共 N 匹配` + `path:lineNo: text` 行 |
| `code_locate` | 按概念/符号定位文件（rg `--files-with-matches` 语义）：排除噪音后返回文件清单（上限 30），用于「X 在哪个文件」的快速定位 |

**失败与「没有」严格分离**：`rg` 不在 PATH / `rgPath` 指向不存在 / 子进程被杀 → 返回 `error`（`code_search 错误: …`）；无匹配 → `ok` 结果 `count:0`，不报错。

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

**3) 30 秒验证**：调 `code_locate {term:'defineTool', include:'*.ts'}` → 期望返回非空文件清单且无 `error`；再调 `code_search {pattern:'ZZQQ_NOT_EXIST_9527'}` → 期望 `count:0` 且**不带 error 字段**（无匹配 ≠ 失败）。若两工具都带 error，说明 `rg` 不在 PATH。

## 配置

| 项 | 默认 | 说明 |
|----|------|------|
| `defaultPath` | `<工作区>`（源码默认即部署工作区） | `path` 缺省时的检索根路径 |
| `rgPath` | `''` | rg 可执行路径；空 = `'rg'` 走 PATH（**rg 不在 PATH 时工具面显式报错，不静默**） |
| `noiseExcludes` | 9 条负向 glob | `!**/node_modules/**`、`!**/.pnpm/**`、`!**/dist/**`、`!**/build/**`、`!**/coverage/**`、`!**/.git/**`、`!**/lib/**`、`!**/.dsh/**`、`!**/_tmp_review/**`（注意 **`lib/` 也在排除集**——构建产物默认不被检索） |
| `enabled` | `true` | **已知缺口：死配置**——`apply()` 内无任何分支读它，`enabled: false` 不关工具面；停用请走组合级 `disabled: true` |

## 落盘与自证（出问题时先看这里）

每次 `apply()` + 每次工具调用落一行 JSONL 到 **`<DSH_HOME>/code-search-trace.jsonl`**（阶段闭集：`boot` / `search` / `locate`；写盘吞错绝不反噬检索）：

| 字段 | 含义 |
|------|------|
| `atMs` / `phase` | 写入时刻；`boot`（装载时构建自报）/ `search` / `locate` |
| `build` / `op` | `<版本>@<模块 mtime ms>`（① 线上跑的是哪个构建）；`code_search` / `code_locate` / `apply` |
| `query` / `root` / `include` / `exclude` | 检索模式（**先脱敏再落盘：redactQuery 擦凭据形状**）+ 生效范围 |
| `noiseGlobs` / `noisePolicy` | 生效排除条数；`strict` / `include-overridden` / `none`（**噪音排除真的生效了吗**） |
| `exitCode` / `maxResults` | rg 退出码（`-1` = 未执行到子进程）；结果上限 |
| `count` / `durationMs` / `ok` / `error` | 命中数；rg 子进程耗时；`无匹配也 ok=true`（只有失败才 `false`）；失败原因 |

**一条命令答五问**：

```bash
tail -3 "$DSH_HOME/code-search-trace.jsonl"
# ① 跑的是哪个构建 → build = "<版本>@<模块 mtime ms>"（boot 行即装载自报）
# ② 谁发起/调了什么 → phase + op + query（脱敏后）+ root/include/exclude
# ③ 断在哪一段      → exitCode + ok（ok=false 才是失败；exitCode=1 且 ok=true = 真无匹配）+ error 分类
# ④ 结果质量/预算   → count + maxResults + noisePolicy（include 是否覆盖了噪音排除）
# ⑤ 耗时           → durationMs（rg 全量子进程耗时）
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

**51 例离线测试**（`tests/rg.test.mjs` 26 + `tests/shell-contract.test.mjs` 7 + `tests/trace.test.mjs` 18），覆盖：
- `rg.test.mjs` — rg 纯逻辑：argv 拼装（空模式/空 include/cap 边界）、`--json` 行解析（损坏行/缺字段）、**`classifyRgOutcome` 六类失败样本**（ENOENT/EACCES/EPERM/EISDIR/SIGTERM/无 code——修复的「rg 缺失被伪装成无匹配」缺陷）；
- `shell-contract.test.mjs` — **注入面守卫**：扫描 `src/*.ts` 无 shell 执行形态（带尸体样本证明扫描器会命中）、`rg.ts` 保持纯净（无 `child_process`）、`execFile` 第二参必须是 argv 数组；
- `trace.test.mjs` — 轨迹层：`classifyTraceOutcome` 六类样本（区分失败与无匹配）、**隐私尸体测试**（凭据形状落盘前必被擦除且 `[redacted]` 确实出现）、观测不反噬（不可写路径 → `false` 且不抛）、`buildStamp` 退化路径。

**无网络依赖**；跑通业务需要系统 `rg` 在 PATH（或 `rgPath` 指向真实 rg）+ 真实磁盘——单测不依赖（纯函数与桩）。

## 设计要点

- **「执行失败」与「没有结果」两个可区分返回**：rg 的退出码 1 是「无匹配」约定（**不是错误**），而 spawn 层失败（`err.code` 是字符串 `ENOENT`/`EACCES`）曾被归一成 1，与「无匹配」同形 ⇒ 检索能力静默失效。现在 `classifyRgOutcome` 把 spawn 失败/信号终止单列为 `failure`，两工具口径统一回 `error`；轨迹层再钉一层（`exitCode=1 且 ok=false` 只可能是失败）。
- **rg --json 而非文本解析（Windows 盘符坑）**：Windows 下盘符会被误判为文本行边界，结构化输出才是安全的解析入口（技能 `rg-wrapper-tool-development` 的教训）。
- **include 排在 excludes 之后**：rg「后置 glob 覆盖前置」⇒ `include='*.ts'` 会重新纳入 `node_modules/**/*.ts`——与「默认排噪音」表面矛盾，是既定语义（轨迹的 `noisePolicy` 会标出 `include-overridden`，判读结果时注意）。
- **零新依赖**：复用系统 rg（零常驻服务、零索引、每次现扫）；宿主 logger 不落盘 ⇒ 自证轨迹是唯一证据层。
- **观测单点收口**：两个工具执行体都经 `traced()` 落笔——新增工具若绕开它，就悄悄制造新的观测盲区。

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：定位与反定位、工具/轨迹契约、失败面（逐工具）、可证伪验收清单（A1–A18）、实践修订记录（静默失败缺陷 + 轨迹层 + 隐私红线）、未决问题（U1–U7） |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| 技能 `rg-wrapper-tool-development` | 本插件的开发方法论沉淀（Windows 盘符坑 / `rg --json` / 噪音排除设计），改本插件前先读它 |
| 技能 `plugin-maintainability` | 插件可维护性工程（自证轨迹 / 失败与无匹配分离 / 观测不反噬） |

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态。