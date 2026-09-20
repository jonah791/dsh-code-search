/**
 * 测试闸门层——**纯函数、零 IO**（git 输出由调用方取好传入，文件存在性同样注入）。
 *
 * ## 动机
 * `code_impact` 回答「改这个符号会波及谁」，但**改动通常是一组文件**，而人要的是
 * 「**该跑哪些测试**」。这一步把它接成闭环：改动的文件集 → 反向可达（谁依赖它们）
 * → 其中哪些是测试 → 按包归组 → 给出**可直接执行的测试命令**。
 * 参照物是 ripwire 的 `--test-gate`；差别在于本模块把**执行**也给出了（命令而非仅清单）。
 *
 * ## 为什么值得单独一层（而不是塞进 code_impact）
 * 判定逻辑全是可离线单测的纯函数（porcelain 解析 / 噪音过滤 / 测试识别 / 反向可达 /
 * 包归属 / 命令挑选），一旦混进 IO 就只能靠集成测试——这与本插件既有的
 * 「纯逻辑抽模块 + 离线单测」纪律一致（见 `src/rg.ts` 与 `src/graph.ts`）。
 *
 * ## 诚实边界
 * - **仓边界**：git 只能看到**它所在那个仓**的改动。主仓里 `self-plugins/*` 是 gitlink，
 *   子仓内部的文件级改动**在主仓视角不可见**——故调用方须对目标仓分别调用（本模块不递归子仓）。
 * - **未追踪目录**（`?? dir/`）只给出目录名而非内部文件，**不展开**（展开成本不可控），
 *   而是计入 `unexpanded` 如实披露。
 * - **测试识别是命名约定**（`*.test.*` / `*.spec.*` / `tests/` 目录），不是构建系统语义：
 *   跑测试更贵，所以取**宽**（宁可多跑，不可漏跑）。
 */

import type { GraphFile } from './graph.js'

/** 一条 git 改动（porcelain 解析产物）。 */
export interface ChangeEntry {
  /** 归一后的状态（`M` / `A` / `D` / `R` / `??` …）。 */
  status: string
  /** 仓内相对路径（POSIX 分隔符；未追踪目录保留尾斜杠）。 */
  path: string
}

/** 噪音路径标记（片段匹配；把「排除 glob」化简为「路径含该片段」，如 node_modules 目录）。
 *  ⚠ 本条注释**故意不写 glob 原文**：glob 里的 `**` 紧跟 `/` 会组成 `*` + `/`，
 *  在块注释内即**提前闭合注释**（tsc 实测报 `Cannot find name 'node_modules'`）。 */
export const NOISE_MARKERS = [
  '/node_modules/', '/.pnpm/', '/dist/', '/build/', '/coverage/',
  '/.git/', '/lib/', '/.dsh/', '/_tmp_review/',
] as const

/**
 * 解析 `git status --porcelain` 输出。
 * 格式：`XY PATH`，rename 为 `XY ORIG -> PATH`（**取新路径**——闸门关心「现在在哪」）；
 * 路径可能被引号包裹（含空格/特殊字符时 git 会加引号）。
 */
export function parsePorcelain(stdout: string): ChangeEntry[] {
  const out: ChangeEntry[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.length < 4) continue
    const code = line.slice(0, 2).replace(/\s+$/, '')
    let path = line.slice(3)
    const arrow = path.indexOf(' -> ')
    if (arrow >= 0) path = path.slice(arrow + 4)
    path = path.replace(/^"(.*)"$/, '$1').replace(/\\/g, '/')
    if (path === '') continue
    out.push({ status: code.trim() === '' ? '??' : code.trim(), path })
  }
  return out
}

/** 噪音路径判定（片段匹配，与插件的 `noiseExcludes` 语义同向）。 */
export function isNoisePath(relPath: string, markers: readonly string[] = NOISE_MARKERS): boolean {
  const p = '/' + relPath.replace(/\\/g, '/')
  return markers.some((m) => p.includes(m))
}

/** 未追踪目录（`?? dir/`）：git 不展开内部文件 ⇒ 无法建图，须计入「未展开」而非静默丢弃。 */
export function isUnexpandedDir(relPath: string): boolean {
  return relPath.endsWith('/')
}

/** 测试文件识别（**命名约定**，故意取宽：多跑比漏跑便宜）。 */
export function isTestFile(relPath: string): boolean {
  const p = relPath.replace(/\\/g, '/')
  const base = p.slice(p.lastIndexOf('/') + 1)
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(base)) return true
  return /(^|\/)(tests?|__tests__)\//.test(p)
}

/** 反向索引：被依赖文件 → 依赖它的文件集合（由出边图翻面）。 */
export function buildReverseIndex(graph: ReadonlyMap<string, GraphFile>): Map<string, Set<string>> {
  const rev = new Map<string, Set<string>>()
  const add = (from: string, to: string): void => {
    const set = rev.get(to)
    if (set === undefined) rev.set(to, new Set([from]))
    else set.add(from)
  }
  for (const [file, node] of graph) {
    for (const imp of node.imports) if (imp.resolved !== null) add(file, imp.resolved)
    for (const rx of node.reexports) if (rx.resolved !== null) add(file, rx.resolved)
  }
  return rev
}

/**
 * 反向可达：从种子出发，沿「谁依赖我」一直往上找（BFS）。
 * `maxNodes` 是保护阀——大仓里改动一个底层文件可能触达全图，到顶即停（调用方需披露）。
 */
export function reverseReachable(
  seeds: readonly string[],
  rev: ReadonlyMap<string, Set<string>>,
  maxNodes = 5000,
): { reached: Set<string>; truncated: boolean } {
  const reached = new Set<string>(seeds)
  const queue: string[] = [...seeds]
  while (queue.length > 0) {
    const cur = queue.shift()
    if (cur === undefined) break
    for (const dep of rev.get(cur) ?? []) {
      if (reached.has(dep)) continue
      if (reached.size >= maxNodes) return { reached, truncated: true }
      reached.add(dep)
      queue.push(dep)
    }
  }
  return { reached, truncated: false }
}

/** 文件 → 所属包目录（取**最长前缀**匹配：嵌套包时选最具体的那一个）。
 *  比较前把分隔符统一规范化为 `/`——**Windows 与 WSL 双平台行为一致**（夹具不得依赖运行平台）。 */
export function packageRootOf(file: string, pkgDirs: Iterable<string>): string | null {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const target = norm(file)
  let best: string | null = null
  for (const dir of pkgDirs) {
    const d = norm(dir)
    if (!target.startsWith(d + '/')) continue
    if (best === null || d.length > best.length) best = d
  }
  return best
}

/** 包 → 测试命令（读 `package.json` 的 `scripts`；取不到返回 null——**不编造**）。 */
export function pickTestCommand(pkg: unknown): string | null {
  if (pkg === null || typeof pkg !== 'object') return null
  const scripts = (pkg as { scripts?: unknown }).scripts
  if (scripts === null || typeof scripts !== 'object') return null
  for (const key of ['test', 'test:unit', 'test:ci', 'check']) {
    const v = (scripts as Record<string, unknown>)[key]
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  return null
}

/** 闸门结果面（供工具层直接序列化）。 */
export interface GateResult {
  /** 改动文件（已过滤噪音）。 */
  changed: string[]
  /** 未展开的未追踪目录（诚实披露：这些路径的内部文件未参与分析）。 */
  unexpanded: string[]
  /** 反向可达的全部文件（含改动自身）。 */
  affected: string[]
  /** 受影响的测试文件。 */
  tests: string[]
  /** 测试文件 → 所属包目录。 */
  testPackages: Array<{ dir: string; files: string[]; command: string | null }>
  /** 改动里**没有映射到任何测试**的部分（诚实的空白，不是「没有影响」）。 */
  unmapped: string[]
  /** 反向可达是否触顶。 */
  truncated: boolean
}

/**
 * 闸门主判定（纯函数）：改动集 + 图 + 包映射 → 该跑的测试与命令。
 *
 * 判定顺序：噪音过滤 → 未追踪目录分离 → 反向可达 → 测试识别（**改动自身是测试也算**，
 * 它必须跑自己）→ 按包归组 → 命令挑选。
 */
export function testGate(
  changes: readonly ChangeEntry[],
  graph: ReadonlyMap<string, GraphFile>,
  pkgDirs: ReadonlyMap<string, string>,
  opts: { noiseMarkers?: readonly string[]; maxNodes?: number } = {},
): GateResult {
  const markers = opts.noiseMarkers ?? NOISE_MARKERS
  const changed: string[] = []
  const unexpanded: string[] = []
  for (const c of changes) {
    if (c.status === 'D') continue /* 删除的文件没有可分析的依赖面 */
    if (isNoisePath(c.path, markers)) continue
    if (isUnexpandedDir(c.path)) { unexpanded.push(c.path); continue }
    changed.push(c.path)
  }

  // 图里的键是绝对路径、改动是仓内相对路径 ⇒ 用**后缀**匹配把两者接上。
  // 比较前统一规范化分隔符（`\` → `/`）：硬编码某一种会让另一边**静默匹配不上**（跨平台夹具坑）。
  const norm = (p: string): string => p.replace(/\\/g, '/')
  const seeds: string[] = []
  const matchedChanged: string[] = []
  for (const rel of changed) {
    const target = norm(rel)
    let hit: string | null = null
    for (const key of graph.keys()) {
      if (norm(key).endsWith(target)) { hit = key; break }
    }
    if (hit !== null) { seeds.push(hit); matchedChanged.push(rel) }
  }

  const rev = buildReverseIndex(graph)
  const { reached, truncated } = reverseReachable(seeds, rev, opts.maxNodes ?? 5000)

  const tests: string[] = []
  for (const abs of reached) {
    const rel = matchedChanged.find((c) => norm(abs).endsWith(norm(c)))
    if (isTestFile(abs) || (rel !== undefined && isTestFile(rel))) tests.push(abs)
  }
  // 改动自身是测试文件时必须跑自己——即便它因新建等原因不在图里
  for (const rel of matchedChanged) {
    if (!isTestFile(rel)) continue
    const abs = seeds.find((s) => norm(s).endsWith(norm(rel)))
    if (abs !== undefined && !tests.includes(abs)) tests.push(abs)
  }
  tests.sort()

  const dirs = [...pkgDirs.values()]
  const grouped = new Map<string, string[]>()
  for (const t of tests) {
    const key = packageRootOf(t, dirs) ?? '(未归属包)'
    const list = grouped.get(key)
    if (list === undefined) grouped.set(key, [t])
    else list.push(t)
  }
  const testPackages = [...grouped.entries()]
    .map(([dir, files]) => ({ dir, files, command: null as string | null }))
    .sort((a, b) => a.dir.localeCompare(b.dir))

  // `unmapped` 的语义是「**这一条改动**没有任何测试盯着它」——故按改动**逐个**算可达集，
  // 而不是拿合并后的全局可达集（后者只能回答「这批改动整体有没有测试」，
  // 会把「A 有测试、B 没有」误报成「都有人管」）。图里没有的改动无法分析，如实计入。
  const unmapped = changed.filter((rel) => {
    const seed = seeds.find((s) => norm(s).endsWith(norm(rel)))
    if (seed === undefined) return true
    for (const f of reverseReachable([seed], rev, opts.maxNodes ?? 5000).reached) {
      if (isTestFile(f)) return false
    }
    return true
  })

  return {
    changed,
    unexpanded,
    affected: [...reached].sort(),
    tests,
    testPackages,
    unmapped,
    truncated,
  }
}
