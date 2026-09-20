/**
 * 引用图层——**纯函数、零 IO**（文件存在性由调用方注入，故可离线单测）。
 *
 * ## 为什么需要它（动机）
 * `code_symbols` 回答「定义了哪些符号」，但不回答**「改这个符号，谁会受影响」**——
 * 后者才是改动前的关键问题。ripwire 的 `--impact` / `--affected` 正是干这个的，
 * 它用 tree-sitter 抽取**名字**再匹配（provenance 分级里的 `name-based` 即「猜的」）。
 *
 * ## 本模块的路线（与 tree-sitter 的本质差别）
 * TS/ESM 的 `import` 子句**同时携带符号名与来源**，因此「谁引用了 X」不需要靠名字匹配：
 * ① **相对路径**：`from './rg.js'` → 解析到真实文件（TS 的 `.js`→`.ts` 映射是标准做法）；
 * ② **包名**：`from '@scope/pkg/sub'` → 经各 package.json 的 `name` 映射到包目录——
 *    monorepo 里绝大多数引用走这条路（**实测：只认相对路径时 45 个引用精确归零**）；
 * ③ **re-export 链**：入口 `index.ts` 常只是 `export { X } from './schema.js'`，
 *    定义在别处 ⇒ 从 import 目标沿导出链做**可达性搜索**，找到真正定义 X 的文件
 *    （**实测：45 个精确归属里 43 个靠这一层才成立**）。
 *
 * 于是得到的是**文件级精确**的引用关系，零依赖、无编译器、毫秒级。
 *
 * ## 诚实边界（不假装比实际更强）
 * - **文件级**，不是**调用点级**：粒度是「哪个文件引用了它」，不含「在第几行调用、调了几次」；
 *   函数级调用图（ripwire 有）**不在本模块能力内**。
 * - **只覆盖 ESM 显式导入**：动态 `import()`、`require()`、字符串拼接的模块名、
 *   `export default` 后再具名追踪，都认不全 ⇒ 一律落入 `name-only` 降级档（**未经证实**）。
 * - **语言**：只服务 TS/JS 族（图）；其他语言没有 import 语义解析。
 * - **同名消歧**：靠 import 来源区分（这正是相对名字匹配的优势所在）；
 *   但对「同一文件里定义又引用」「全局同名无导入」仍会退化到降级档。
 */

import { dirname, join, resolve } from 'node:path'

/** 源文件扩展名集合（解析候选与扫描口径共用）。 */
export const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] as const

/** 路径解析的结果分类（**诚实词汇表**：读者能看见这一条怎么来的）。 */
export type ResolveHow = 'rel' | 'pkg-entry' | 'pkg-sub' | 'unresolved-pkg' | 'unresolved'

/** 一条 import 语句的原始形态。 */
export interface RawImport {
  /** `from '…'` 里的模块说明符。 */
  source: string
  /** 该 import 子句引入的名字（已处理 `as` 别名，取本地名）。 */
  names: string[]
}

/** 一条 re-export 语句的原始形态。 */
export interface RawReexport {
  source: string
  /** 具名再导出的名字（`export * ` 时为空数组）。 */
  names: string[]
  /** 通配再导出（`export * from`）——传播全部名字。 */
  star: boolean
}

/** 图中一个文件节点。 */
export interface GraphFile {
  defs: ReadonlySet<string>
  imports: ReadonlyArray<RawImport & { resolved: string | null; how: ResolveHow }>
  reexports: ReadonlyArray<RawReexport & { resolved: string | null; how: ResolveHow }>
}

/** 引用者档位（**诚实分级**：前两档是精确的，第三档是未经证实的）。 */
export type ReferrerHow = 'import-direct' | 'import-chain' | 'same-file'

export interface Referrer {
  path: string
  how: ReferrerHow
  /** 该引用者用的模块说明符（`import-direct` / `import-chain` 有）。 */
  via?: string
  /** 经 re-export 链命中时的中间文件（定义文件在链尾，此处给出路径便于核对）。 */
  chain?: string[]
}

/** 影响面结果。 */
export interface ImpactResult {
  /** 定义该符号的文件（可能多于一个：同名定义）。 */
  definitions: string[]
  /** 精确档：能沿 import/re-export 关系追到定义文件的引用者。 */
  referrers: Referrer[]
  /** 降级档：正文出现该名字但**无导入关系可证**——可能是同名/注释/字符串（未经证实）。 */
  unverified: Array<{ path: string; lines: number }>
  /** 参与扫描的文件数。 */
  scanned: number
}

/** 把子句里的名字拆出来：`A, B as C, type D` → `['A','C','D']`。 */
export function namesInClause(clause: string): string[] {
  const names = new Set<string>()
  const braced = clause.match(/\{([^}]*)\}/)
  if (braced !== null && braced[1] !== undefined) {
    for (const part of braced[1].split(',')) {
      const cleaned = part.trim().replace(/^type\s+/, '')
      if (cleaned === '') continue
      const asParts = cleaned.split(/\s+as\s+/)
      const local = (asParts[1] ?? asParts[0] ?? '').trim()
      if (local !== '') names.add(local)
    }
  }
  // default / namespace 形态（`import X from`、`import * as ns from`）：取紧邻 from 前的标识符
  const head = clause.replace(/\{[^}]*\}/, ' ').replace(/[,\s]+/g, ' ').trim()
  for (const token of head.split(' ')) {
    const t = token.trim()
    if (t === '' || t === '*' || t === 'as' || t === 'type') continue
    names.add(t)
  }
  return [...names]
}

/** 剔除**行首注释行**再解析（`//` / `*` / `/*` 开头）。
 *  动机（单测实测）：注释掉的 import 会被正则当成真引用——
 *  `// import { X } from './nope.js'` 曾让 parseImports 多收一条（期望 3、实收 4）。
 *  只做行首级判定，不实现块注释状态机（近似法的已知代价：行尾注释里的 import 仍会被收）。 */
function withoutCommentLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trimStart()
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
    })
    .join('\n')
}

/** 解析全部 import 语句（含 `import type`；`import()` 动态导入**不在此列**，见诚实边界）。 */
export function parseImports(text: string): RawImport[] {
  const out: RawImport[] = []
  const re = /import\s+(?:type\s+)?([^'"]*?)\s*from\s*['"]([^'"]+)['"]/g
  for (const m of withoutCommentLines(text).matchAll(re)) {
    const clause = m[1]
    const source = m[2]
    if (clause === undefined || source === undefined) continue
    out.push({ source, names: namesInClause(clause.trim()) })
  }
  return out
}

/** 解析全部 re-export 语句。
 *  `export * as ns from` 是**命名空间再导出**，不传播名字可达性 ⇒ 不收（避免把 ns 误判成全体传播）。
 *  **结果按源码出现顺序**：两趟正则分别收具名与通配，故按 `index` 排序还原——
 *  否则调用方看到的顺序与源文件不符，核对时无从对照。 */
export function parseReexports(text: string): RawReexport[] {
  const clean = withoutCommentLines(text)
  const hits: Array<{ at: number; value: RawReexport }> = []
  for (const m of clean.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const body = m[1]
    const source = m[2]
    if (body === undefined || source === undefined) continue
    hits.push({ at: m.index ?? 0, value: { source, names: namesInClause('{' + body + '}'), star: false } })
  }
  for (const m of clean.matchAll(/export\s*\*\s*(?:as\s+\w+\s*)?from\s*['"]([^'"]+)['"]/g)) {
    const whole = m[0]
    const source = m[1]
    if (whole === undefined || source === undefined) continue
    if (/\*\s*as\s+\w+/.test(whole)) continue
    hits.push({ at: m.index ?? 0, value: { source, names: [], star: true } })
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.value)
}

/** 候选真实路径（含 basePath 本身——已带扩展名的写入如 `./schema.ts` 曾因此漏解析）。 */
export function candidatePaths(basePath: string): string[] {
  const stripped = basePath.replace(/\.(js|mjs|cjs|jsx)$/, '')
  const cands: string[] = [basePath, stripped]
  for (const ext of SOURCE_EXTS) {
    cands.push(stripped + ext)
    cands.push(basePath + ext)
  }
  for (const ext of ['.ts', '.tsx', '.js']) cands.push(join(stripped, 'index' + ext))
  return cands
}

/** 模块说明符 → 包名（`@scope/pkg/sub/x` → `@scope/pkg`；`pkg/x` → `pkg`）。 */
export function packageNameOf(source: string): string {
  const parts = source.split('/')
  return source.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? source)
}

/**
 * 解析模块说明符为真实文件路径（**两条路**：相对路径 / 包名）。
 * @param fileExists 注入的存在性判定——**IO 由调用方承担**，本函数保持纯粹可单测。
 * @param pkgDirs 包名 → 包目录（由调用方扫描各 package.json 的 `name` 建好）。
 */
export function resolveModule(
  fromFile: string,
  source: string,
  fileExists: (p: string) => boolean,
  pkgDirs: ReadonlyMap<string, string>,
): { path: string | null; how: ResolveHow } {
  if (source.startsWith('.')) {
    const base = resolve(dirname(fromFile), source)
    return { path: candidatePaths(base).find(fileExists) ?? null, how: 'rel' }
  }
  const pkgName = packageNameOf(source)
  const pkgDir = pkgDirs.get(pkgName)
  if (pkgDir === undefined) return { path: null, how: 'unresolved-pkg' }
  const rest = source.slice(pkgName.length).replace(/^\//, '')
  if (rest === '') {
    const entry = candidatePaths(join(pkgDir, 'src', 'index')).concat(candidatePaths(join(pkgDir, 'index')))
    return { path: entry.find(fileExists) ?? null, how: 'pkg-entry' }
  }
  return { path: candidatePaths(join(pkgDir, ...rest.split('/'))).find(fileExists) ?? null, how: 'pkg-sub' }
}

/**
 * 定义可达性：从 `entry` 出发沿 re-export 边 BFS，找**真正定义** `symbol` 的文件。
 * 返回链上文件序列（含 entry 与命中文件）供核对；不可达返回 null。
 * 环安全：`visited` 保证每个文件只进一次。
 */
export function findDefiner(
  symbol: string,
  entry: string,
  graph: ReadonlyMap<string, GraphFile>,
): { file: string; chain: string[] } | null {
  const visited = new Set<string>()
  const queue: Array<{ file: string; chain: string[] }> = [{ file: entry, chain: [entry] }]
  while (queue.length > 0) {
    const cur = queue.shift()
    if (cur === undefined) break
    if (visited.has(cur.file)) continue
    visited.add(cur.file)
    const node = graph.get(cur.file)
    if (node === undefined) continue
    if (node.defs.has(symbol)) return { file: cur.file, chain: cur.chain }
    for (const rx of node.reexports) {
      if (rx.resolved === null) continue
      if (!rx.star && !rx.names.includes(symbol)) continue
      queue.push({ file: rx.resolved, chain: [...cur.chain, rx.resolved] })
    }
  }
  return null
}

/** 词边界命中（`$` 需转义，否则 `foo$bar` 这类标识符会误判）。 */
export function mentionsSymbol(text: string, symbol: string): number {
  const safe = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`\\b${safe}\\b`)
  let n = 0
  for (const line of text.split('\n')) if (re.test(line)) n += 1
  return n
}

/**
 * 影响面：给定符号，算出定义点、**精确引用者**与**未证实提及**。
 *
 * 判定顺序（先精确后降级，一命中即归类，不重复计数）：
 * ① import 子句含该符号 → 来源解析到定义文件（`import-direct`）
 *   或沿 re-export 链可达定义文件（`import-chain`）；
 * ② 定义文件自身内部还有引用（`same-file`，排除定义行本身）；
 * ③ 以上都不是但正文出现该名字 → `unverified`（**可能是同名/注释/字符串**）。
 */
export function impactOf(
  symbol: string,
  graph: ReadonlyMap<string, GraphFile>,
  texts: ReadonlyMap<string, string>,
): ImpactResult {
  const definitions = [...graph.entries()].filter(([, g]) => g.defs.has(symbol)).map(([f]) => f)
  const definingSet = new Set(definitions)
  const referrers: Referrer[] = []
  const unverified: Array<{ path: string; lines: number }> = []

  for (const [file, node] of graph) {
    let hit: Referrer | null = null
    for (const imp of node.imports) {
      if (!imp.names.includes(symbol) || imp.resolved === null) continue
      if (definingSet.has(imp.resolved)) {
        hit = { path: file, how: 'import-direct', via: imp.source }
        break
      }
      const via = findDefiner(symbol, imp.resolved, graph)
      if (via !== null) {
        hit = { path: file, how: 'import-chain', via: imp.source, chain: via.chain }
        break
      }
    }
    // 再导出者本身也是**引用者**（它依赖被导出的符号）——曾漏算，实测由假阴性核对暴露
    if (hit === null) {
      for (const rx of node.reexports) {
        if (rx.resolved === null) continue
        if (rx.star) {
          if (definingSet.has(rx.resolved)) { hit = { path: file, how: 'import-direct', via: rx.source }; break }
          continue
        }
        if (!rx.names.includes(symbol)) continue
        if (definingSet.has(rx.resolved)) { hit = { path: file, how: 'import-direct', via: rx.source }; break }
        const via = findDefiner(symbol, rx.resolved, graph)
        if (via !== null) { hit = { path: file, how: 'import-chain', via: rx.source, chain: via.chain }; break }
      }
    }
    if (hit !== null) { referrers.push(hit); continue }

    const text = texts.get(file)
    if (text === undefined) continue
    const lines = mentionsSymbol(text, symbol)
    if (lines === 0) continue
    if (definingSet.has(file)) {
      // 定义行本身计 1 次命中；同文件内另有引用才算「引用者」
      if (lines > 1) referrers.push({ path: file, how: 'same-file' })
      continue
    }
    unverified.push({ path: file, lines })
  }

  return { definitions, referrers, unverified, scanned: graph.size }
}
