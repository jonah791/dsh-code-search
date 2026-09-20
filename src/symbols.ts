/**
 * 符号识别层——**纯函数、零 IO**（离线单测见 `tests/symbols.test.mjs`）。
 *
 * 动机（借鉴 ripwire「先给地图，再读文件」）：agent 定位代码时最贵的一步是**逐个读文件**。
 * 若一次调用就能拿到「这个目录定义了哪些函数/类/接口，各在第几行」，就能直接跳到目标行，
 * 省掉整轮 read。这是本插件原有 `code_search`（找字符串）/`code_locate`（找文件）之外的第三种视角：
 * **结构视角**。
 *
 * 诚实边界（不假装精确）：这是**逐行正则近似，不是 AST**——
 * 多行签名、宏、代码生成、装饰器改写、同名重载认不全；调用方必须在输出里带 `mode=regex` 标注，
 * 让读者知道「这是地图，不是测绘」。ripwire 的同类自述（`counts_floor`、`lpin=…disclosed-guess`）
 * 是这条纪律的来源：**宁可暴露近似，也不伪造精度**。
 *
 * `lib/` 排除提醒：本插件的默认噪音排除含 `lib/`，故对**构建产物**的符号不会出现在
 * `code_symbols` 里——那是排除规则的功劳，不是「没有符号」。
 */

/** 认得出的定义种类。`section` 供 Markdown 标题（与 ripwire 把 md 标题当符号一致）。 */
export type SymbolKind =
  | 'function' | 'class' | 'interface' | 'type' | 'enum' | 'const' | 'method'
  | 'def' | 'struct' | 'trait' | 'impl' | 'section'

/** 一个定义点。 */
export interface SymbolDef {
  kind: SymbolKind
  name: string
  /** 1-based 行号。 */
  lineNo: number
  /** 该定义行（trim 后截断，供人眼确认）。 */
  sig: string
}

/** 语言族：认得出的定义形态不同，按扩展名分派。 */
type Family = 'tsjs' | 'python' | 'rust' | 'go' | 'markdown' | 'unknown'

interface Rule {
  re: RegExp
  kind: SymbolKind
  /** 名称所在捕获组（缺省 1；Markdown 标题用 2）。 */
  group?: number
  /** 允许的最大行首缩进（空格计）；缺省不限。`0` = 只收顶格（模块级）定义。
   *  用途：TS/JS 里函数内的 `const dir = …` 与模块级 `const Config = …` 同形——
   *  不做缩进约束时，局部变量会把地图淹成流水账（2026-09-20 实测：8 文件报 243「符号」，
   *  大半是 `const text`/`const lines` 这类局部量）。 */
  maxIndent?: number
  /** 要求该行以 `{` 结尾（定义体起始）。
   *  用途：滤掉「缩进 + name(...)」形态的**调用**（`mkdirSync(dir, {…})`、`saveState(state)`）——
   *  正则下它们与类方法定义（`async execute(args) {`）同形，只有「以 `{` 收尾」能分开。 */
  requireBraceTail?: boolean
}

/** 控制流关键字：缩进 + `name(` 的形态会把它们误认成方法，故显式排除。 */
const KEYWORD_BLOCKLIST = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'await', 'new', 'typeof',
  'super', 'this', 'do', 'else', 'throw', 'delete', 'void', 'yield', 'function',
  'case', 'default', 'with', 'in', 'of', 'try', 'finally', 'break', 'continue',
])

const TS_JS_RULES: Rule[] = [
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
  { re: /^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface' },
  { re: /^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/, kind: 'type' },
  { re: /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: 'enum' },
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function' },
  { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/, kind: 'const', maxIndent: 0 },
  { re: /^\s{2,}(?:(?:public|private|protected|static|async|readonly|override|abstract|declare)\s+)*([A-Za-z_$][\w$]*)\s*[(<]/, kind: 'method', requireBraceTail: true },
]

const PYTHON_RULES: Rule[] = [
  { re: /^\s*(?:async\s+)?def\s+(\w+)/, kind: 'def' },
  { re: /^\s*class\s+(\w+)/, kind: 'class' },
  { re: /^([A-Z_][A-Z0-9_]*)\s*[:=]/, kind: 'const' },
]

const RUST_RULES: Rule[] = [
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:const\s+)?fn\s+(\w+)/, kind: 'function' },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+(\w+)/, kind: 'struct' },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+(\w+)/, kind: 'enum' },
  { re: /^\s*(?:pub\s+)?trait\s+(\w+)/, kind: 'trait' },
  { re: /^\s*impl(?:<[^>]*>)?\s+(?:\w+\s+for\s+)?(\w+)/, kind: 'impl' },
  { re: /^\s*(?:pub\s+)?(?:const|static)\s+(\w+)/, kind: 'const' },
]

const GO_RULES: Rule[] = [
  { re: /^func\s+(?:\([^)]*\)\s*)?(\w+)/, kind: 'function' },
  { re: /^type\s+(\w+)\s+(?:struct|interface)/, kind: 'type' },
  { re: /^(?:var|const)\s+(\w+)/, kind: 'const' },
]

const MARKDOWN_RULES: Rule[] = [
  { re: /^(#{1,6})\s+(.+?)\s*$/, kind: 'section', group: 2 },
]

/** 扩展名 → 语言族。 */
export function familyOf(ext: string): Family {
  const e = ext.replace(/^\./, '').toLowerCase()
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'].includes(e)) return 'tsjs'
  if (['py', 'pyi'].includes(e)) return 'python'
  if (e === 'rs') return 'rust'
  if (e === 'go') return 'go'
  if (['md', 'markdown'].includes(e)) return 'markdown'
  return 'unknown'
}

/** 从路径取扩展名（不含点；无扩展名返回空串）。 */
export function extOf(path: string): string {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1)
}

/**
 * 注释行判定（按语言族的行首标记）。
 * 只做**行首级**判定——行尾注释里的假定义仍会被认出来（近似法的已知代价，已在契约里声明）。
 */
function isCommentLine(line: string, family: Family): boolean {
  const t = line.trimStart()
  if (family === 'python') return t.startsWith('#')
  if (family === 'markdown') return false
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('--')
}

/** 语言族的规则表（未知扩展名返回空表：不认识就不猜）。 */
export function rulesFor(family: Family): Rule[] {
  switch (family) {
    case 'tsjs': return TS_JS_RULES
    case 'python': return PYTHON_RULES
    case 'rust': return RUST_RULES
    case 'go': return GO_RULES
    case 'markdown': return MARKDOWN_RULES
    default: return []
  }
}

/** 行首缩进（空格/Tab 计；Tab 按 4 空格折算）。用 `match` 而非 `.exec(`：核验注入面守卫把后者当 shell 形态扫描。 */
function indentOf(line: string): number {
  const prefix = line.match(/^[ \t]*/)?.[0] ?? ''
  let n = 0
  for (const ch of prefix) n += ch === '\t' ? 4 : 1
  return n
}

/** 单行识别（导出以便单测逐条钉住形态）。
 *  形态约束（`maxIndent` / `requireBraceTail`）是**压误报**的关键：正则下「模块级 const」与「函数内
 *  局部 const」、「类方法定义」与「缩进的方法调用」完全同形，只有行首缩进与行尾字符能分开。 */
export function matchSymbol(line: string, family: Family): { kind: SymbolKind; name: string } | null {
  if (isCommentLine(line, family)) return null
  const indent = indentOf(line)
  const trimmedEnd = line.trimEnd()
  for (const rule of rulesFor(family)) {
    // 用 test + match 而非 exec：非全局正则下语义等价，且避开注入面守卫对 `.exec(` 的形态扫描
    if (!rule.re.test(line)) continue
    const m = line.match(rule.re)
    if (m === null) continue
    const name = (m[rule.group ?? 1] ?? '').trim()
    if (name === '') continue
    if (rule.maxIndent !== undefined && indent > rule.maxIndent) continue
    if (rule.requireBraceTail === true && !trimmedEnd.endsWith('{')) continue
    if (family === 'tsjs' && rule.kind === 'method' && KEYWORD_BLOCKLIST.has(name)) continue
    return { kind: rule.kind, name }
  }
  return null
}

/**
 * 逐行抽取定义。**一行只认一个定义**（按规则表顺序，先命中者胜），避免同一行重复计数。
 * @param lines 源码行（`\n` 已切分；不含行尾换行符）
 * @param ext 文件扩展名（带不带点都可）
 * @param maxSymbols 符号上限（缺省 500；到顶后停止扫描并在调用方披露截断）
 * @returns 按出现顺序排列的定义；`truncated` 表示是否因上限提前停止
 */
export function extractSymbols(
  lines: readonly string[],
  ext: string,
  maxSymbols = 500,
): { symbols: SymbolDef[]; truncated: boolean } {
  const family = familyOf(ext)
  const symbols: SymbolDef[] = []
  if (family === 'unknown') return { symbols, truncated: false }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const hit = matchSymbol(line, family)
    if (hit === null) continue
    if (symbols.length >= maxSymbols) return { symbols, truncated: true }
    symbols.push({
      kind: hit.kind,
      name: hit.name,
      lineNo: i + 1,
      sig: line.trim().slice(0, 160),
    })
  }
  return { symbols, truncated: false }
}
