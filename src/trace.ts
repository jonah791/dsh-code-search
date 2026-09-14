/**
 * 检索自证轨迹（可维护性 S4 证据层 · 2026-09-14 批次 S4-A）。
 *
 * 动机：本插件刚修过一个**静默失效**缺陷——`rg` 不存在时 `err.code` 是字符串，被归一成 `1`
 * （= rg 的「无匹配」哨兵，且 stderr 为空）⇒ **整个检索能力静默失效却报「0 结果」**。
 * 这类问题的共性：**失败与成功同形**，日志全干净。修复只能保证「这一次」不再发生；
 * 要让它**下次一眼可见**，必须有落盘证据层（AGENTS.md §5.22 规则 1）。
 *
 * 修法：每次检索落一行 JSONL 侧车——`<DSH_HOME>/code-search-trace.jsonl`。
 * 阶段枚举：`boot`（进程级构建自报）→ `search`（code_search）→ `locate`（code_locate）。
 *
 * 轨迹回答的五问（技能 plugin-maintainability 判据）：
 *   Q1 线上跑哪个构建 → `build`（`<version>@<模块 mtime ms>`）
 *   Q2 谁发起         → `phase` + `op`（哪个工具）+ `query`（pattern/term 摘要）
 *   Q3 断在哪一段      → `exitCode` + `ok` + `error`（**spawn 失败 / 信号终止 / 非零退出码分类**）
 *   Q4 结果质量        → `count`（命中文件数/匹配数）+ `noisePolicy`（噪音排除是否被 include 覆盖）
 *   Q5 耗时与预算      → `durationMs`（rg 全量子进程耗时）
 *
 * 观测绝不反噬主流程（技能 C4）：全部 IO 失败吞错并返回 `false`——写不进去也不影响检索。
 *
 * @module dsh-code-search/trace
 */
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 阶段枚举：一次进程从 boot 起，每次检索一行。 */
export type CodeSearchTracePhase = 'boot' | 'search' | 'locate'

/** 噪音排除策略（Q4：排除真的生效了吗，还是被 include 覆盖重新纳入）。 */
export type NoisePolicy = 'strict' | 'include-overridden' | 'none'

/** 一行检索轨迹。字段**固定**（boot 行用中性值填充），便于 `tail` 后直接读列。 */
export interface CodeSearchTraceEntry {
  /** 写入时刻（ms epoch）。 */
  atMs: number
  phase: CodeSearchTracePhase
  /** 构建标识 `<version>@<模块 mtime ms>`（Q1）。 */
  build: string
  /** 工具名（`code_search` / `code_locate` / `apply`）。 */
  op: string
  /** pattern / term（截断 120，Q2 输入侧）。 */
  query: string
  /** 搜索根路径（缺省回落 `Config.defaultPath`）。 */
  root: string
  /** include glob（空串=未指定）。 */
  include: string
  /** 调用方额外 exclude glob（空串=未指定）。 */
  exclude: string
  /** 生效的噪音排除 glob 条数。 */
  noiseGlobs: number
  /** 噪音排除策略（见 `NoisePolicy`）。 */
  noisePolicy: NoisePolicy
  /** 结果上限（`maxResults` 或其缺省值；boot 行 0）。 */
  maxResults: number
  /** rg 退出码（-1 = 未执行到子进程，如 boot 行或 rg 无法执行）。 */
  exitCode: number
  /** 命中数（搜索结果数 / 文件数，Q4 量级）。 */
  count: number
  /** 检索耗时（ms；boot=0）。 */
  durationMs: number
  /** 是否成功（**失败与「无匹配」严格区分**：无匹配也 ok=true 且 count=0）。 */
  ok: boolean
  /** 失败原因（spawn 失败分类 / 信号终止 / rg stderr）。 */
  error?: string
}

/** 本模块需要的最小配置面（`index.ts` 的 `Config` 结构上满足它）。 */
export interface TraceConfig {
  defaultPath: string
  noiseExcludes: string[]
}

/** 一次检索的参数摘要来源（`SearchArgs` / `LocateArgs` 的结构上界）。 */
export interface TraceArgs {
  pattern?: string
  term?: string
  path?: string
  include?: string
  exclude?: string
  maxResults?: number
}

/** 参数摘要（`describeQueryScope` 的产物；boot 行也能复用同一形状）。 */
export interface QueryScope {
  root: string
  include: string
  exclude: string
  noiseGlobs: number
  noisePolicy: NoisePolicy
  maxResults: number
}

/** 解析 DSH_HOME：环境变量优先，缺省 `<homedir>/.dsh`（单一真源——**不要在多处各写一份**）。 */
export function resolveHome(
  env: Record<string, string | undefined> = process.env,
  fallback = homedir(),
): string {
  const raw = env['DSH_HOME']
  return raw !== undefined && raw.trim() !== '' ? raw : join(fallback, '.dsh')
}

/** 轨迹文件路径（纯函数）。 */
export function codeSearchTracePath(home: string): string {
  return join(home, 'code-search-trace.jsonl')
}

/** 文件 mtime（ms；不可得为 0）。 */
export function mtimeOf(file: string): number {
  try {
    return Math.round(statSync(file).mtimeMs)
  } catch {
    return 0
  }
}

/** 从 `<file>` 所在包的 package.json 读版本（读不到返回空串，不抛）。 */
export function readPackageVersion(file: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(file), '..', 'package.json'), 'utf8')) as {
      version?: string
    }
    return typeof pkg.version === 'string' ? pkg.version : ''
  } catch {
    return ''
  }
}

/** 构建标识 `<version>@<模块 mtime ms>`（版本缺失退化为 `unknown@<mtime>`）。 */
export function buildStamp(file: string, version = ''): string {
  return version !== '' ? `${version}@${String(mtimeOf(file))}` : `unknown@${String(mtimeOf(file))}`
}

/** 文本截断（摘要用；超长补省略号，避免把整段 pattern 灌进轨迹）。 */
export function truncate(text: string, max = 120): string {
  return text.length <= max ? text : text.slice(0, max) + '…'
}

/**
 * 凭据脱敏（纯函数，**隐私红线**）：检索的 pattern **本身可能就是凭据**——
 * 排查「这个 key 在哪被硬编码」时，用户会直接把 key 当模式搜。
 * 故落盘前按形状擦除，而不是信任调用方。
 * 覆盖：显式键值对（`token=` / `password:` / `Authorization:`）、常见厂商前缀
 * （`sk-` / `ghp_` / `github_pat_` / `AKIA`）、`Bearer`、以及 ≥32 位的高熵串。
 */
export function redactQuery(text: string): string {
  return text
    // Bearer 令牌（先于键值对规则：`Authorization: Bearer X` 里的 token 也要被吞掉）
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    // 显式键值对：键名是凭据语义词，值一律擦除
    .replace(/(?<![A-Za-z0-9])(api[_-]?key|token|secret|password|passwd|passphrase|authorization)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    // 常见厂商前缀
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g, '[redacted]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{16,}/g, '[redacted]')
    .replace(/\bAKIA[0-9A-Z]{12,}/g, '[redacted]')
    // 高熵裸串（≥32 位连续 base64/hex 类字符）
    .replace(/[A-Za-z0-9+/=_-]{32,}/g, '[redacted]')
}

/**
 * 噪音排除策略判定（纯函数，Q4 关键判据）：
 * `rg.ts` 的 argv 顺序语义是「**glob 后者覆盖前者**」——include 排在噪音排除之后，
 * 故 `include='*.ts'` 会**重新纳入** node_modules 下的 .ts 文件。
 * 轨迹必须能区分「真排除了」与「排除被 include 覆盖」，否则同形无法归因。
 */
export function noisePolicyOf(noiseGlobs: number, includeOverride: boolean): NoisePolicy {
  if (noiseGlobs <= 0) return 'none'
  return includeOverride ? 'include-overridden' : 'strict'
}

/** 参数摘要（纯函数）：根路径回落 / include / exclude / 噪音条数 / 策略 / 上限缺省值。 */
export function describeQueryScope(args: TraceArgs, cfg: TraceConfig, op: 'search' | 'locate'): QueryScope {
  const include = args.include ?? ''
  const noiseGlobs = cfg.noiseExcludes.length
  return {
    root: args.path || cfg.defaultPath,
    include,
    // `code_locate` 的 argv 不含调用方 exclude（`buildLocateArgv` 只吃 cfg.noiseExcludes）
    exclude: op === 'search' ? args.exclude ?? '' : '',
    noiseGlobs,
    noisePolicy: noisePolicyOf(noiseGlobs, include !== ''),
    maxResults: args.maxResults ?? (op === 'search' ? 50 : 30),
  }
}

/** 业务结果的最小观测面（`searchCode` / `locateFile` 的返回结构上界）。 */
export interface TraceOutcomeInput {
  count?: number
  results?: Array<{ error?: string }>
  files?: string[]
  error?: string
}

/** 子进程观测面（由 `runRg` 填充；纯观测，不参与任何业务判定）。 */
export interface RgRunMeta {
  exitCode: number
  failure: string | null
}

/**
 * 结果归类（纯函数）：**成功 / 无匹配 / 失败三者可辨**（这正是原缺陷的修复面）。
 * 判据优先级：抛错 > `meta.failure`（spawn 层分类）> 结果体内嵌 error。
 * 无匹配（exitCode=1，无 failure）⇒ `ok=true, count=0`——**不得与失败同形**。
 */
export function classifyTraceOutcome(
  result: TraceOutcomeInput | undefined,
  meta: RgRunMeta,
  thrown?: unknown,
): { ok: boolean; count: number; error?: string } {
  const count = result?.count ?? result?.files?.length ?? result?.results?.length ?? 0
  if (thrown !== undefined && thrown !== null) {
    return { ok: false, count: 0, error: '抛错: ' + messageOf(thrown) }
  }
  const failure = meta.failure ?? result?.error ?? result?.results?.[0]?.error ?? null
  if (failure !== null && failure !== '') return { ok: false, count, error: failure }
  return { ok: true, count }
}

/** 错误对象 → 人话（非 Error 输入也不抛）。 */
export function messageOf(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.message
  return String(thrown)
}

/** 稳定序列化（键序固定 + 单行 JSON）。 */
export function serializeTraceEntry(entry: CodeSearchTraceEntry): string {
  const ordered: CodeSearchTraceEntry = {
    atMs: entry.atMs,
    phase: entry.phase,
    build: entry.build,
    op: entry.op,
    query: entry.query,
    root: entry.root,
    include: entry.include,
    exclude: entry.exclude,
    noiseGlobs: entry.noiseGlobs,
    noisePolicy: entry.noisePolicy,
    maxResults: entry.maxResults,
    exitCode: entry.exitCode,
    count: entry.count,
    durationMs: entry.durationMs,
    ok: entry.ok,
    ...(entry.error !== undefined ? { error: entry.error } : {}),
  }
  return JSON.stringify(ordered)
}

/** 容错解析：坏行/半行/空行跳过，不抛。 */
export function parseTraceEntries(text: string): CodeSearchTraceEntry[] {
  const out: CodeSearchTraceEntry[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    try {
      const parsed = JSON.parse(line) as CodeSearchTraceEntry
      if (typeof parsed.atMs === 'number' && typeof parsed.phase === 'string') out.push(parsed)
    } catch {
      continue
    }
  }
  return out
}

/** 读轨迹文件；缺失/不可读返回空数组（诊断工具的安全入口）。 */
export function readTraceEntries(path: string): CodeSearchTraceEntry[] {
  try {
    return parseTraceEntries(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
}

/** 追加一行（失败即吞并返回 false：观测绝不反噬检索）。 */
export function appendTraceEntry(path: string, entry: CodeSearchTraceEntry): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, serializeTraceEntry(entry) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

/** 记一笔检索轨迹（薄接线：补 atMs，路径缺省 `<DSH_HOME>/code-search-trace.jsonl`）。 */
export function codeSearchTrace(
  entry: Omit<CodeSearchTraceEntry, 'atMs'>,
  opts: { path?: string; home?: string; now?: number } = {},
): boolean {
  const path = opts.path ?? codeSearchTracePath(opts.home ?? resolveHome())
  return appendTraceEntry(path, { atMs: opts.now ?? Date.now(), ...entry })
}
