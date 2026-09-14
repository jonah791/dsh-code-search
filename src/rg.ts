/**
 * rg（ripgrep）封装层——**纯逻辑**：argv 拼装 + 输出解析 + 退出码归类。
 *
 * 从 `src/index.ts` 抽出（行为与原实现逐条对齐），**无 IO**：`execFile` 调用留在 index.ts，
 * 本模块只处理「已经拿到的」参数与输出，因此可离线单测（`tests/rg.test.mjs`）。
 *
 * 安全不变量：**用户输入只能进 argv 数组，绝不拼进 shell 字符串**——
 * `execFile(rg, args)` 不经 shell，故 `--regexp` 中的任何字符都不具备命令语义。
 */

/** 本模块需要的最小配置面（`index.ts` 的 `Config` 结构上满足它） */
export interface RgConfig {
  rgPath: string
  defaultPath: string
  noiseExcludes: string[]
}

export interface SearchArgs {
  pattern: string
  path?: string
  include?: string
  exclude?: string
  maxResults?: number
}

export interface LocateArgs {
  term: string
  path?: string
  include?: string
  maxResults?: number
}

export interface SearchMatch {
  path: string
  lineNo: number
  text: string
  error?: string
}

/** rg 的 `--json` 记录形状（只声明用到的字段） */
interface RgJsonRecord {
  type?: string
  data?: {
    path?: { text?: string }
    line_number?: number
    lines?: { text?: string }
  }
}

/** rg 可执行路径：空配置回落 PATH 上的 `rg` */
export function resolveRgPath(cfg: RgConfig): string {
  return cfg.rgPath || 'rg'
}

/** 搜索根路径：空参数回落配置默认根 */
export function resolveRoot(path: string | undefined, cfg: RgConfig): string {
  return path || cfg.defaultPath
}

/** 组装排除 glob 列表：配置噪音排除 + （可选）调用方额外排除（自动补 `!` 前缀） */
export function buildExcludes(cfg: RgConfig, exclude?: string): string[] {
  const excludes = [...cfg.noiseExcludes]
  if (exclude) excludes.push('!' + exclude)
  return excludes
}

/** code_search 的 argv：`--json --color never` + 排除 globs + include glob + regexp 模式 + 根路径。
 *  **顺序即语义**：rg 的 glob 后者覆盖前者，故 exclude 先入、include 后入 =
 *  include 命中时可**覆盖**噪音排除（如 `include='*.ts'` 会重新纳入 node_modules 下的 .ts）。 */
export function buildSearchArgv(args: SearchArgs, cfg: RgConfig): string[] {
  const argv: string[] = ['--json', '--color', 'never']
  for (const e of buildExcludes(cfg, args.exclude)) argv.push('--glob', e)
  if (args.include) argv.push('--glob', args.include)
  argv.push('--regexp', args.pattern, resolveRoot(args.path, cfg))
  return argv
}

/** code_locate 的 argv：`--files-with-matches --color never` + 噪音排除 globs + include + regexp + 根路径 */
export function buildLocateArgv(args: LocateArgs, cfg: RgConfig): string[] {
  const argv: string[] = ['--files-with-matches', '--color', 'never']
  for (const e of cfg.noiseExcludes) argv.push('--glob', e)
  if (args.include) argv.push('--glob', args.include)
  argv.push('--regexp', args.term, resolveRoot(args.path, cfg))
  return argv
}

/** rg 调用结果归类：**把「spawn 层失败」与「rg 退出码 1 = 无匹配」严格分开**。
 *
 *  已证实缺陷（修复前）：`err.code` 为字符串（`ENOENT`/`EACCES`）时被归一为数值 1——
 *  而 1 正是 rg 的「无匹配」哨兵，且 `stderr` 为空 ⇒ 调用方条件 `stderr && code !== 1` 不成立
 *  ⇒ **「rg 不存在」被伪装成「无匹配」**（静默空结果）。
 */
export function classifyRgOutcome(err: unknown, stderr: string): { code: number; failure: string | null } {
  if (!err) return { code: 0, failure: null }
  const e = err as { code?: unknown; signal?: unknown; message?: unknown }
  if (typeof e.code === 'string') {
    return {
      code: 1,
      failure: `rg 无法执行（${e.code}）：${String(e.message ?? e.code)}——请确认 rg 已安装，或用 Config.rgPath 指定绝对路径`,
    }
  }
  const code = typeof e.code === 'number' ? e.code : 1
  if (typeof e.signal === 'string') {
    return { code, failure: `rg 被信号终止（${e.signal}）${stderr ? '：' + stderr.slice(0, 500) : ''}` }
  }
  // rg 退出码 1 = 「无匹配」，不是错误；其余非零退出码配 stderr 才算失败
  return { code, failure: stderr && code !== 1 ? stderr.slice(0, 500) : null }
}

/** 解析 rg `--json` 输出为匹配列表。
 *  - 空行 / 非 JSON 行 / 非 `match` 记录**静默跳过**（rg 会夹带 begin/end/summary 记录）
 *  - 达到 `cap` 后**仍在遍历**（只是不再收集）——保持原实现的短路语义
 *  - 缺字段（`path`/`line_number`/`lines`）按 `''` / `0` 兜底，行尾单个 `\n` 被剥掉 */
export function parseRgJsonLines(stdout: string, cap: number): SearchMatch[] {
  const results: SearchMatch[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim() || results.length >= cap) continue
    try {
      const rec = JSON.parse(line) as RgJsonRecord
      if (rec.type !== 'match' || !rec.data) continue
      results.push({
        path: rec.data.path?.text ?? '',
        lineNo: rec.data.line_number ?? 0,
        text: (rec.data.lines?.text ?? '').replace(/\n$/, ''),
      })
    } catch { /* 非 JSON 行跳过 */ }
  }
  return results
}

/** 解析 `--files-with-matches` 输出（一行一文件）。
 *  **真实语义（不对称）**：`total` 是**未截断**的总数，`files` 才是截断后的列表——
 *  故 `total` 可大于 `files.length`（render 显示「共 N 个文件」而只列前 cap 个）。
 *  另注：负数 `cap` 走 `Array.slice(0, 负数)` 会**从尾部丢弃**而不是返回空。 */
export function parseFileList(stdout: string, cap: number): { total: number; files: string[] } {
  const files = stdout.split('\n').filter((l) => l.trim())
  return { total: files.length, files: files.slice(0, cap) }
}

/** code_search 的失败外壳（`results[0].error` 是 render 判错用的哨兵） */
export function rgFailureResult(message: string): { count: number; results: SearchMatch[] } {
  return { count: 0, results: [{ path: '', lineNo: 0, text: '', error: message }] }
}
