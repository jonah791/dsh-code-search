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
import {
  classifyRgOutcome, resolveRgPath, buildSearchArgv, buildLocateArgv,
  parseRgJsonLines, parseFileList, rgFailureResult,
} from './rg.js'
import type { SearchArgs, LocateArgs, SearchMatch } from './rg.js'

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

/** spawn rg 并收集 stdout/stderr。rg 无匹配时 exit code=1 但不算错误。
 *  退出码归类交给纯函数 `classifyRgOutcome`——**spawn 层失败（ENOENT/EACCES）与信号终止不再被
 *  当成「无匹配」**（修复前：`err.code` 为字符串时被归一为 1，与 rg 的「无匹配」哨兵同形）。 */
function runRg(rgPath: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string; failure: string | null }> {
  return new Promise((resolvePromise) => {
    execFile(rgPath, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const { code, failure } = classifyRgOutcome(err, stderr)
      resolvePromise({ code, stdout, stderr, failure })
    })
  })
}

/** code_search 实现：默认排除噪音，返回匹配行。用 rg --json 解析（Windows 盘符安全）。
 *  纯逻辑（argv 拼装 / 输出解析 / 退出码归类）在 `src/rg.ts`，此处只做接线。 */
async function searchCode(args: SearchArgs, cfg: Config): Promise<{ count: number; results: SearchMatch[] }> {
  const { stdout, failure } = await runRg(resolveRgPath(cfg), buildSearchArgv(args, cfg))
  if (failure) return rgFailureResult(failure)
  const results = parseRgJsonLines(stdout, args.maxResults ?? 50)
  return { count: results.length, results }
}

/** code_locate 实现：rg --files-with-matches 只列文件。
 *  **失败不再静默**：spawn 失败/非零退出码回 `error`（修复前与「无匹配」同形：`{count:0, files:[]}`）。 */
async function locateFile(args: LocateArgs, cfg: Config): Promise<{ count: number; files: string[]; error?: string }> {
  const { stdout, failure } = await runRg(resolveRgPath(cfg), buildLocateArgv(args, cfg))
  if (failure) return { count: 0, files: [], error: failure }
  const { total, files } = parseFileList(stdout, args.maxResults ?? 30)
  return { count: total, files }
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
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: { count?: number; files?: string[]; error?: string }) => {
        if (v.error) return [{ type: 'text', text: 'code_locate 错误: ' + v.error }]
        return [{ type: 'text', text: `共 ${v.count ?? 0} 个文件\n` + (v.files ?? []).join('\n') }]
      },
    },
    async execute(args: LocateArgs) {
      return locateFile(args, config)
    },
  }))

  logger.info('dsh-code-search 就绪（rg=' + (config.rgPath || 'rg(PATH)') + '）')
}
