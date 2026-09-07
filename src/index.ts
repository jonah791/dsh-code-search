/**
 * dsh-code-search：本地代码/文件智能检索。
 * 封装系统 rg（ripgrep），默认排除 node_modules/.pnpm/dist/build/coverage/.git 等噪音，
 * 支持路径锚点/文件类型过滤/快速定位文件。
 * 2026-09-03 主人「增强本地检索工具」→ 决策：复用本机 rg 内核做高层封装（零新依赖、不加常驻服务）。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { execFile } from 'node:child_process'

export const name = 'agent-code-search'
export const inject = ['tools'] as const

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

/** spawn rg 并收集 stdout/stderr。rg 无匹配时 exit code=1 但不算错误。 */
function runRg(rgPath: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile(rgPath, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      let code = 0
      if (err) {
        const maybe = (err as { code?: unknown }).code
        code = typeof maybe === 'number' ? maybe : 1
      }
      resolvePromise({ code, stdout, stderr })
    })
  })
}

interface SearchArgs {
  pattern: string
  path?: string
  include?: string
  exclude?: string
  maxResults?: number
}

interface SearchMatch {
  path: string
  lineNo: number
  text: string
  error?: string
}

/** code_search 实现：默认排除噪音，返回匹配行。用 rg --json 解析（Windows 盘符安全）。 */
async function searchCode(args: SearchArgs, cfg: Config): Promise<{ count: number; results: SearchMatch[] }> {
  const rg = cfg.rgPath || 'rg'
  const root = args.path || cfg.defaultPath
  const excludes = [...cfg.noiseExcludes]
  if (args.exclude) excludes.push('!' + args.exclude)
  const argv: string[] = ['--json', '--color', 'never']
  for (const e of excludes) argv.push('--glob', e)
  if (args.include) argv.push('--glob', args.include)
  argv.push('--regexp', args.pattern, root)
  const { code, stdout, stderr } = await runRg(rg, argv)
  if (stderr && code !== 1) return { count: 0, results: [{ path: '', lineNo: 0, text: '', error: stderr.slice(0, 500) }] }
  const results: SearchMatch[] = []
  const cap = args.maxResults ?? 50
  for (const line of stdout.split('\n')) {
    if (!line.trim() || results.length >= cap) continue
    try {
      const rec = JSON.parse(line) as { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } }
      if (rec.type !== 'match' || !rec.data) continue
      results.push({
        path: rec.data.path?.text ?? '',
        lineNo: rec.data.line_number ?? 0,
        text: (rec.data.lines?.text ?? '').replace(/\n$/, ''),
      })
    } catch { /* 非 JSON 行跳过 */ }
  }
  return { count: results.length, results }
}

interface LocateArgs {
  term: string
  path?: string
  include?: string
  maxResults?: number
}

/** code_locate 实现：rg --files-with-matches 只列文件。 */
async function locateFile(args: LocateArgs, cfg: Config): Promise<{ count: number; files: string[] }> {
  const rg = cfg.rgPath || 'rg'
  const root = args.path || cfg.defaultPath
  const argv: string[] = ['--files-with-matches', '--color', 'never']
  for (const e of cfg.noiseExcludes) argv.push('--glob', e)
  if (args.include) argv.push('--glob', args.include)
  argv.push('--regexp', args.term, root)
  const { code, stdout, stderr } = await runRg(rg, argv)
  if (stderr && code !== 1) return { count: 0, files: [] }
  const files = stdout.split('\n').filter((l) => l.trim())
  const cap = args.maxResults ?? 30
  return { count: files.length, files: files.slice(0, cap) }
}

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('agent-code-search')

  ctx.tools.register(defineTool({
    name: 'code_search',
    description: '智能全文检索（rg 封装）：默认排除 node_modules/.pnpm/dist/build/coverage/.git 等噪音目录。可指定根路径（缺省 E:/alice）、include/exclude glob 过滤、正则模式。比通用 grep 更适合搜大仓源码（排除噪音+输出精简）。',
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
          results: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (_a: unknown, v: { count?: number; results?: Array<{ path?: string; lineNo?: number; text?: string; error?: string }> }) => {
        if (v.results?.[0]?.error) return [{ type: 'text', text: 'code_search 错误: ' + v.results[0].error }]
        const lines = (v.results ?? []).map((r) => (r.path ? `${r.path}:${r.lineNo ?? ''}: ${r.text ?? ''}` : JSON.stringify(r)))
        return [{ type: 'text', text: `共 ${v.count ?? 0} 匹配（显示 ${lines.length}）\n` + lines.join('\n') }]
      },
    },
    async execute(args: SearchArgs): Promise<any> {
      return searchCode(args, config)
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
        },
      },
      render: (_a: unknown, v: { count?: number; files?: string[] }) => [{ type: 'text', text: `共 ${v.count ?? 0} 个文件\n` + (v.files ?? []).join('\n') }],
    },
    async execute(args: LocateArgs) {
      return locateFile(args, config)
    },
  }))

  logger.info('dsh-code-search 就绪（rg=' + (config.rgPath || 'rg(PATH)') + '）')
}
