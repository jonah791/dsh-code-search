/**
 * dsh-code-search：本地代码/文件智能检索。
 * 封装系统 rg（ripgrep），默认排除 node_modules/.pnpm/dist/build/coverage/.git 等噪音，
 * 支持路径锚点/文件类型过滤/快速定位文件。
 * 2026-09-03 主人「增强本地检索工具」→ 决策：复用本机 rg 内核做高层封装（零新依赖、不加常驻服务）。
 * 2026-09-20 主人「借鉴 ripwire 思路增强本地插件」→ 两项：
 *   ① `code_search` 的**诚实计数**（`total`/`truncated`：把「共 N」从截断值改回真实总数）
 *      + 结果头部披露匹配模式与噪音排除策略（读者能看见「可能被排除规则吞掉」）；
 *   ② 新工具 `code_symbols`：给一个目录一张**符号地图**（先看结构、再决定读哪个文件），
 *      识别是逐行正则近似（`mode=regex`，不假装是 AST）。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  classifyRgOutcome, resolveRgPath, buildSearchArgv, buildLocateArgv, buildFilesArgv,
  parseRgJsonLines, parseFileList, rgFailureResult,
} from './rg.js'
import type { SearchArgs, LocateArgs, SymbolsArgs, SearchMatch } from './rg.js'
import { extOf, extractSymbols, familyOf } from './symbols.js'
import type { SymbolDef } from './symbols.js'
import { impactOf, parseImports, parseReexports, resolveModule } from './graph.js'
import type { GraphFile } from './graph.js'
import {
  buildStamp, classifyTraceOutcome, codeSearchTrace, describeQueryScope, noisePolicyOf,
  readPackageVersion, redactQuery, truncate,
} from './trace.js'
import type { QueryScope, RgRunMeta, TraceArgs } from './trace.js'

export const name = 'agent-code-search'
export const inject = ['tools'] as const

const OWN_FILE = fileURLToPath(import.meta.url)
/** 进程级构建自报 `<version>@<模块 mtime ms>`（Q1：线上跑的是哪个构建）。 */
const BUILD = buildStamp(OWN_FILE, readPackageVersion(OWN_FILE))

/** 单文件读取上限（符号扫描的保护阀：超大文件只读前 512 KB，并在输出里如实标注截断）。 */
const MAX_FILE_BYTES = 512 * 1024

export interface Config {
  enabled: boolean
  /** 缺省搜索根路径。 */
  defaultPath: string
  /** rg 可执行路径（缺省 'rg' 走 PATH）。 */
  rgPath: string
  /** 默认排除的噪音目录（glob）。 */
  noiseExcludes: string[]
}
export const Config = z.object({
  enabled: z.boolean().default(true),
  defaultPath: z.string().default('E:/alice'),
  rgPath: z.string().default(''),
  noiseExcludes: z.array(z.string()).default([
    '!**/node_modules/**', '!**/.pnpm/**', '!**/dist/**',
    '!**/build/**', '!**/coverage/**', '!**/.git/**',
    '!**/lib/**', '!**/.dsh/**', '!**/_tmp_review/**',
  ]),
})

/** spawn rg 并收集 stdout/stderr。rg 无匹配时 exit code=1 但不算错误。
 *  退出码归类交给纯函数 `classifyRgOutcome`——**spawn 层失败（ENOENT/EACCES）与信号终止不再被
 *  当成「无匹配」**（修复前：`err.code` 为字符串时被归一为 1，与 rg 的「无匹配」哨兵同形）。
 *  `meta` 是**纯观测出口**（调用方传入即被填充）：轨迹要能回答「断在哪一段」，
 *  而 exitCode/failure 只在子进程回调里可得，故在此收口填出，不改变任何业务分支。 */
function runRg(rgPath: string, args: string[], meta: RgRunMeta): Promise<{ code: number; stdout: string; stderr: string; failure: string | null }> {
  return new Promise((resolvePromise) => {
    execFile(rgPath, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const { code, failure } = classifyRgOutcome(err, stderr)
      meta.exitCode = code
      meta.failure = failure
      resolvePromise({ code, stdout, stderr, failure })
    })
  })
}

/** code_search 结果面（`total`/`truncated` 是诚实计数：`count` 为实际收集条数）。 */
interface SearchOutcome {
  count: number
  total: number
  truncated: boolean
  results: SearchMatch[]
}

/** code_search 实现：默认排除噪音，返回匹配行。用 rg --json 解析（Windows 盘符安全）。
 *  纯逻辑（argv 拼装 / 输出解析 / 退出码归类）在 `src/rg.ts`，此处只做接线。 */
async function searchCode(args: SearchArgs, cfg: Config, meta: RgRunMeta): Promise<SearchOutcome> {
  const { stdout, failure } = await runRg(resolveRgPath(cfg), buildSearchArgv(args, cfg), meta)
  if (failure) return { ...rgFailureResult(failure), total: 0, truncated: false }
  const { matches, total, truncated } = parseRgJsonLines(stdout, args.maxResults ?? 50)
  return { count: matches.length, total, truncated, results: matches }
}

/** code_locate 实现：rg --files-with-matches 只列文件。
 *  **失败不再静默**：spawn 失败/非零退出码回 `error`（修复前与「无匹配」同形：`{count:0, files:[]}`）。 */
async function locateFile(args: LocateArgs, cfg: Config, meta: RgRunMeta): Promise<{ count: number; files: string[]; error?: string }> {
  const { stdout, failure } = await runRg(resolveRgPath(cfg), buildLocateArgv(args, cfg), meta)
  if (failure) return { count: 0, files: [], error: failure }
  const { total, files } = parseFileList(stdout, args.maxResults ?? 30)
  return { count: total, files }
}

/** 一条符号地图行（工具输出面）。索引签名是工具 `output` 类型（`Record<string, JsonValue>`）要求的形状。 */
interface SymbolRow extends SymbolDef {
  path: string
  [key: string]: string | number
}

/** code_symbols 结果面。 */
interface SymbolsOutcome {
  count: number
  files: number
  total: number
  truncated: boolean
  mode: string
  symbols: SymbolRow[]
  error?: string
}

/** code_symbols 实现：rg `--files` 挑文件 → 逐文件读 → 正则抽定义（先给地图，再读文件）。
 *  **保护阀**：文件数（`maxFiles`，缺省 40）、符号数（`maxSymbols`，缺省 300）、单文件 512 KB。
 *  任一触顶都会在 `truncated` 里如实披露——截断是事实，不是错误。 */
async function collectSymbols(
  args: SymbolsArgs & { maxSymbols?: number },
  cfg: Config,
  meta: RgRunMeta,
): Promise<SymbolsOutcome> {
  const { stdout, failure } = await runRg(resolveRgPath(cfg), buildFilesArgv(args, cfg), meta)
  if (failure) {
    return { count: 0, files: 0, total: 0, truncated: false, mode: 'regex', symbols: [], error: failure }
  }
  const { total, files } = parseFileList(stdout, args.maxFiles ?? 40)
  const symbolCap = args.maxSymbols ?? 300
  const rows: SymbolRow[] = []
  let scanned = 0
  let truncated = total > files.length
  for (const file of files) {
    if (rows.length >= symbolCap) { truncated = true; break }
    const ext = extOf(file)
    if (familyOf(ext) === 'unknown') continue
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch { continue /* 读不到就跳过——不因单文件失败毁掉整张地图 */ }
    scanned += 1
    if (text.length > MAX_FILE_BYTES) { text = text.slice(0, MAX_FILE_BYTES); truncated = true }
    const { symbols, truncated: hitCap } = extractSymbols(text.split('\n'), ext, symbolCap - rows.length)
    for (const s of symbols) rows.push({ ...s, path: file })
    if (hitCap) { truncated = true; break }
  }
  return { count: rows.length, files: scanned, total, truncated, mode: 'regex', symbols: rows }
}

/** `code_impact` 的参数面（符号 + 扫描范围 + 显示上限）。 */
export interface ImpactArgs extends SymbolsArgs {
  symbol: string
  maxResults?: number
}

/** 定义点行（带行号，供「跳到定义」）。 */
interface DefRow {
  path: string
  lineNo: number
  [key: string]: string | number
}

/** 未经证实的提及（正文出现该名字，但**无导入关系可证**——可能是同名、注释或字符串）。 */
interface UnverifiedRow {
  path: string
  lines: number
  [key: string]: string | number
}

/** code_impact 结果面。
 *  ⚠ `refs` 用 `Record<string, string>` 而非带可选属性的接口：工具 `output` 面要求
 *  `Record<string, JsonValue>`，而可选属性（`via?`）含 `undefined`，**过不了该校验**
 *  （tsc 实测报「'string' index signatures are incompatible … 'undefined' is not assignable to 'JsonValue'」）。
 *  故 `via` 缺省写空串、由 render 决定是否显示。 */
interface ImpactOutcome {
  count: number
  exact: number
  unverifiedCount: number
  scanned: number
  files: number
  truncated: boolean
  mode: string
  defs: DefRow[]
  refs: Array<Record<string, string>>
  unverified: UnverifiedRow[]
  error?: string
}

/** `code_impact`：给定符号 → 定义点 + **精确引用者** + 未证实提及。
 *
 *  与 `code_symbols` 的分工：符号地图答「定义在哪」，本工具答**「改它会波及谁」**。
 *  精度来自**导入归属**（相对路径 / 包名映射 / re-export 链可达性）而非名字匹配——
 *  这是 TS/ESM 仓上**不需要编译器**即可得到的文件级精确（探测实测：3198 文件 744 ms 建图，
 *  45 个引用里 **43 个靠导出链**才定位到定义文件；只认相对路径时精确归零）。
 *
 *  **诚实边界**（随输出走，不假装更强）：只认 ESM 显式导入——动态 `import()`、`require()`、
 *  字符串拼接的模块名都认不得，这些一律落入 `unverified` 档；粒度是**文件**不是调用点。 */
async function buildImpact(args: ImpactArgs, cfg: Config, meta: RgRunMeta): Promise<ImpactOutcome> {
  const failed = (error: string): ImpactOutcome => ({
    count: 0, exact: 0, unverifiedCount: 0, scanned: 0, files: 0, truncated: false,
    mode: 'import-graph', defs: [], refs: [], unverified: [], error,
  })

  // 缺省 4000：实测 DSH packages 有 3623 个 .ts/.tsx——**定义文件被截断在范围外会让精确归属静默归零**
  // （`definingSet` 为空 ⇒ 所有引用降级成 unverified，看起来像「没有引用」）。故缺省值按最大真实仓留余量。
  const maxFiles = args.maxFiles ?? 4000
  const { stdout, failure } = await runRg(resolveRgPath(cfg), buildFilesArgv(args, cfg), meta)
  if (failure !== null) return failed(failure)
  const { total, files } = parseFileList(stdout, maxFiles)
  const truncated = total > files.length

  // 包名映射（monorepo 引用解析的前提）：另列 package.json 读 `name`。
  const pkgDirs = new Map<string, string>()
  const pkgRun = await runRg(resolveRgPath(cfg), buildFilesArgv({ path: args.path, include: 'package.json' }, cfg), meta)
  if (pkgRun.failure === null) {
    for (const p of parseFileList(pkgRun.stdout, 400).files) {
      try {
        const pkg = JSON.parse(await readFile(p, 'utf8')) as { name?: unknown }
        if (typeof pkg.name === 'string' && pkg.name !== '') pkgDirs.set(pkg.name, dirname(p))
      } catch { /* 坏 package.json 跳过：不因单个文件毁掉整张图 */ }
    }
  }

  // 路径规范化：rg 输出与 path.join 的分隔符形态可能不同，两种都登记（否则图会静默空掉）
  const absOf = new Map<string, string>()
  const fileSet = new Set<string>()
  for (const f of files) {
    const abs = resolve(f)
    absOf.set(f, abs)
    fileSet.add(abs)
    fileSet.add(abs.replace(/\\/g, '/'))
  }
  const fileExists = (p: string): boolean => fileSet.has(p) || fileSet.has(p.replace(/\\/g, '/'))

  const graph = new Map<string, GraphFile>()
  const texts = new Map<string, string>()
  const defLines = new Map<string, number>()
  let scanned = 0
  for (const f of files) {
    const abs = absOf.get(f) ?? resolve(f)
    let text: string
    try { text = await readFile(f, 'utf8') } catch { continue /* 读不到就跳过 */ }
    scanned += 1
    if (text.length > MAX_FILE_BYTES) text = text.slice(0, MAX_FILE_BYTES)
    const { symbols } = extractSymbols(text.split('\n'), extOf(f), 500)
    const defs = new Set<string>()
    for (const s of symbols) {
      defs.add(s.name)
      if (s.name === args.symbol && !defLines.has(abs)) defLines.set(abs, s.lineNo)
    }
    const edge = (src: string): { resolved: string | null; how: GraphFile['imports'][number]['how'] } => {
      const r = resolveModule(abs, src, fileExists, pkgDirs)
      return { resolved: r.path === null ? null : resolve(r.path), how: r.how }
    }
    graph.set(abs, {
      defs,
      imports: parseImports(text).map((i) => ({ ...i, ...edge(i.source) })),
      reexports: parseReexports(text).map((r) => ({ ...r, ...edge(r.source) })),
    })
    texts.set(abs, text)
  }

  const found = impactOf(args.symbol, graph, texts)
  const cap = args.maxResults ?? 30
  return {
    count: found.referrers.length,
    exact: found.referrers.length,
    unverifiedCount: found.unverified.length,
    scanned,
    files: files.length,
    truncated,
    mode: 'import-graph',
    defs: found.definitions.map((p) => ({ path: p, lineNo: defLines.get(p) ?? 0 })),
    refs: found.referrers.slice(0, cap).map((r) => {
      const row: Record<string, string> = { path: r.path, how: r.how }
      if (r.via !== undefined) row['via'] = r.via
      return row
    }),
    unverified: found.unverified.slice(0, cap).map((u) => ({ path: u.path, lines: u.lines })),
  }
}

/**
 * 轨迹观测收口（**单一落笔点**）：两个工具执行体都经此包装，
 * 避免「在 N 处手改、漏一处就是新缺陷」（可维护性纪律 5）。
 * 业务异常**原样重抛**（观测层不吞业务错），轨迹先记一笔失败再抛。
 */
async function traced<A extends TraceArgs, R extends { count: number; total?: number; truncated?: boolean }>(
  phase: 'search' | 'locate' | 'symbols' | 'impact',
  op: string,
  args: A,
  scope: QueryScope,
  run: (args: A, meta: RgRunMeta) => Promise<R>,
): Promise<R> {
  const meta: RgRunMeta = { exitCode: -1, failure: null }
  const startedAtMs = Date.now()
  let result: R | undefined
  let thrown: unknown = null
  try {
    result = await run(args, meta)
  } catch (err) {
    thrown = err
  }
  const outcome = classifyTraceOutcome(result, meta, thrown === null ? undefined : thrown)
  codeSearchTrace({
    phase, build: BUILD, op,
    query: truncate(redactQuery(args.pattern ?? args.term ?? args.symbol ?? '')),
    ...scope,
    exitCode: meta.exitCode,
    count: outcome.count,
    durationMs: Date.now() - startedAtMs,
    ok: outcome.ok,
    ...(result?.total !== undefined ? { total: result.total } : {}),
    ...(result?.truncated !== undefined ? { truncated: result.truncated } : {}),
    ...(outcome.error !== undefined ? { error: outcome.error } : {}),
  })
  if (thrown !== null) throw thrown
  return result as R
}

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('agent-code-search')

  ctx.tools.register(defineTool({
    name: 'code_search',
    description: '智能全文检索（rg 封装）：默认排除 node_modules/.pnpm/dist/build/coverage/.git 等噪音目录。可指定根路径（缺省 E:/alice）、include/exclude glob 过滤、正则模式。比通用 grep 更适合搜大仓源码（排除噪音+输出精简）。结果头部披露真实总数（截断时显示「≥N」）与噪音排除策略。',
    parameters: {
      pattern: { type: 'string', required: true, description: '正则或字面模式（rg 语法）' },
      path: { type: 'string', description: '搜索根路径（缺省 E:/alice）' },
      include: { type: 'string', description: '文件名 glob 过滤（如 *.ts）' },
      exclude: { type: 'string', description: '额外排除 glob（如 **/tests/**）' },
      maxResults: { type: 'number', description: '结果上限（缺省 50）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          count: { type: 'number' },
          total: { type: 'number' },
          truncated: { type: 'boolean' },
          noiseGlobs: { type: 'number' },
          noisePolicy: { type: 'string' },
          results: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (a: unknown, v: { count?: number; total?: number; truncated?: boolean; noiseGlobs?: number; noisePolicy?: string; results?: Array<{ path?: string; lineNo?: number; text?: string; error?: string }> }) => {
        if (v.results?.[0]?.error) return [{ type: 'text', text: 'code_search 错误: ' + v.results[0].error }]
        const lines = (v.results ?? []).map((r) => (r.path ? `${r.path}:${r.lineNo ?? ''}: ${r.text ?? ''}` : JSON.stringify(r)))
        const shown = v.count ?? 0
        const total = v.total ?? shown
        const head = total > shown
          ? `共 ≥${total} 匹配（截断：显示 ${shown} / 至少 ${total}）`
          : `共 ${shown} 匹配（未截断）`
        const scopeLine = `模式=regex | 噪音排除=${v.noiseGlobs ?? 0} 条（${v.noisePolicy ?? 'strict'}）`
        return [{ type: 'text', text: `${head} | ${scopeLine}\n` + lines.join('\n') }]
      },
    },
    async execute(args: SearchArgs): Promise<any> {
      const scope = describeQueryScope(args, config, 'search')
      const out = await traced('search', 'code_search', args, scope, (a, meta) => searchCode(a, config, meta))
      return { ...out, noiseGlobs: scope.noiseGlobs, noisePolicy: scope.noisePolicy }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'code_locate',
    description: '按概念/符号定位文件：搜哪些文件包含某词（rg --files-with-matches 语义），排除噪音后返回文件清单——用于「X 在哪个文件」的快速定位。',
    parameters: {
      term: { type: 'string', required: true, description: '定位词（如 anonymousUserId / runPreflightCore）' },
      path: { type: 'string', description: '搜索根路径（缺省 E:/alice）' },
      include: { type: 'string', description: '文件名 glob 过滤（如 *.ts）' },
      maxResults: { type: 'number', description: '上限（缺省 30）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          count: { type: 'number' },
          files: { type: 'array', items: { type: 'string' } },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: { count?: number; files?: string[]; error?: string }) => {
        if (v.error) return [{ type: 'text', text: 'code_locate 错误: ' + v.error }]
        const listed = v.files?.length ?? 0
        const head = (v.count ?? 0) > listed ? `共 ${v.count ?? 0} 个文件（显示 ${listed}）` : `共 ${v.count ?? 0} 个文件`
        return [{ type: 'text', text: head + '\n' + (v.files ?? []).join('\n') }]
      },
    },
    async execute(args: LocateArgs) {
      return traced('locate', 'code_locate', args, describeQueryScope(args, config, 'locate'),
        (a, meta) => locateFile(a, config, meta))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'code_symbols',
    description: '符号地图（先给地图，再读文件）：列出一个目录/glob 下**定义了哪些函数/类/接口/类型/常量**及其行号，按文件分组。用于「我该读哪个文件」的快速定向，省掉逐个 read。识别是逐行正则近似（TS/JS/Python/Rust/Go/Markdown），非 AST——输出带 mode=regex 标注。',
    parameters: {
      path: { type: 'string', description: '搜索根路径（缺省 E:/alice）' },
      include: { type: 'string', description: '文件名 glob 过滤（如 *.ts）' },
      exclude: { type: 'string', description: '额外排除 glob（如 **/tests/**）' },
      maxFiles: { type: 'number', description: '扫描文件上限（缺省 40）' },
      maxSymbols: { type: 'number', description: '符号上限（缺省 300）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          count: { type: 'number' },
          files: { type: 'number' },
          total: { type: 'number' },
          truncated: { type: 'boolean' },
          mode: { type: 'string' },
          symbols: { type: 'array', items: { type: 'object', additionalProperties: true } },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: { count?: number; files?: number; truncated?: boolean; mode?: string; symbols?: Array<{ path?: string; kind?: string; name?: string; lineNo?: number }>; error?: string }) => {
        if (v.error) return [{ type: 'text', text: 'code_symbols 错误: ' + v.error }]
        const rows = v.symbols ?? []
        const head = `符号地图（mode=${v.mode ?? 'regex'} 正则近似，非 AST）：扫描 ${v.files ?? 0} 文件 / ${v.count ?? 0} 符号`
          + (v.truncated ? '（**已截断**——提高 maxFiles/maxSymbols 可看更多）' : '')
        const byFile = new Map<string, string[]>()
        for (const r of rows) {
          const key = r.path ?? ''
          const list = byFile.get(key) ?? []
          list.push(`  ${String(r.kind ?? '?').padEnd(9)} ${r.name ?? '?'}  (L${r.lineNo ?? 0})`)
          byFile.set(key, list)
        }
        const body = [...byFile.entries()].map(([p, list]) => p + '\n' + list.join('\n')).join('\n')
        return [{ type: 'text', text: head + (body ? '\n' + body : '') }]
      },
    },
    async execute(args: SymbolsArgs & { maxSymbols?: number }) {
      return traced('symbols', 'code_symbols', args, describeQueryScope(args, config, 'symbols'),
        (a, meta) => collectSymbols(a, config, meta))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'code_impact',
    description: '引用面/影响分析（「改这个符号会波及谁」）：给定符号名，返回**定义点** + **精确引用者**（能沿 import / 包名 / re-export 链追到定义文件的）+ **未证实提及**（正文出现该名字但无导入关系可证，可能是同名/注释/字符串）。精度来自**导入归属**而非名字匹配——TS/ESM 仓上无需编译器。边界：只认 ESM 显式导入（动态 import()/require() 认不得），粒度是**文件**不是调用点。改动前的第三步：先看定义（code_symbols）、再看波及面（本工具）。',
    parameters: {
      symbol: { type: 'string', required: true, description: '符号名（如 defineTool / classifyRgOutcome）' },
      path: { type: 'string', description: '搜索根路径（缺省 E:/alice）' },
      include: { type: 'string', description: '文件名 glob 过滤（如 *.ts）' },
      exclude: { type: 'string', description: '额外排除 glob（如 **/tests/**）' },
      maxFiles: { type: 'number', description: '扫描文件上限（缺省 2000）' },
      maxResults: { type: 'number', description: '每档显示上限（缺省 30）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          count: { type: 'number' },
          exact: { type: 'number' },
          unverifiedCount: { type: 'number' },
          scanned: { type: 'number' },
          files: { type: 'number' },
          truncated: { type: 'boolean' },
          mode: { type: 'string' },
          defs: { type: 'array', items: { type: 'object', additionalProperties: true } },
          refs: { type: 'array', items: { type: 'object', additionalProperties: true } },
          unverified: { type: 'array', items: { type: 'object', additionalProperties: true } },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: { count?: number; unverifiedCount?: number; scanned?: number; truncated?: boolean; mode?: string; defs?: Array<{ path?: string; lineNo?: number }>; refs?: Array<{ path?: string; how?: string; via?: string }>; unverified?: Array<{ path?: string; lines?: number }>; error?: string }) => {
        if (v.error) return [{ type: 'text', text: 'code_impact 错误: ' + v.error }]
        const head = `引用面（mode=${v.mode ?? 'import-graph'}：导入归属 + 导出链可达性）：扫描 ${v.scanned ?? 0} 文件`
          + ` | 精确引用 ${v.count ?? 0} | 未证实 ${v.unverifiedCount ?? 0}`
          + (v.truncated ? '（**扫描已截断**——提高 maxFiles 可覆盖更多）' : '')
        const parts = [head]
        const defs = v.defs ?? []
        if (defs.length > 0) {
          parts.push(`定义点 ${defs.length}：`)
          for (const d of defs) parts.push(`  ${d.path ?? '?'}:${d.lineNo ?? 0}`)
        } else {
          // **静默归零的披露**：定义不在扫描范围内时，精确归属会全部退化成 unverified，
          // 读者若不被告知会读成「没人引用它」。这里把三种成因一次讲清。
          parts.push('定义点 0——扫描范围内没有该符号的定义：可能是①符号名不符（含大小写）②被 maxFiles 截断（上面若标「扫描已截断」即属此类）③它由 re-export / 动态方式引入（此时下方「精确引用」仍可能成立）')
        }
        const refs = v.refs ?? []
        parts.push(`精确引用者 ${v.count ?? 0}（按导入关系可追到定义文件${refs.length < (v.count ?? 0) ? `，显示前 ${refs.length}` : ''}）：`)
        for (const r of refs) parts.push(`  [${r.how ?? '?'}] ${r.path ?? '?'}${r.via !== undefined ? `  ← '${r.via}'` : ''}`)
        const unv = v.unverified ?? []
        if (unv.length > 0) {
          parts.push(`未证实提及 ${v.unverifiedCount ?? unv.length}（正文出现该名字但**无导入关系可证**——可能是同名/注释/字符串，改前请自行核对）：`)
          for (const u of unv) parts.push(`  [name-only] ${u.path ?? '?'}  (${u.lines ?? 0} 行)`)
        }
        return [{ type: 'text', text: parts.join('\n') }]
      },
    },
    async execute(args: ImpactArgs) {
      return traced('impact', 'code_impact', args, describeQueryScope(args, config, 'impact'),
        (a, meta) => buildImpact(a, config, meta))
    },
  }))

  // 进程级构建自报（Q1）：boot 行用中性值填充，字段与检索行完全同形（tail 后可直接读列）。
  codeSearchTrace({
    phase: 'boot', build: BUILD, op: 'apply', query: '', root: config.defaultPath,
    include: '', exclude: '', noiseGlobs: config.noiseExcludes.length,
    noisePolicy: noisePolicyOf(config.noiseExcludes.length, false), maxResults: 0,
    exitCode: -1, count: 0, durationMs: 0, ok: true,
  })

  logger.info('dsh-code-search 就绪（rg=' + (config.rgPath || 'rg(PATH)') + '）')
}
