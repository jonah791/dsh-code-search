/**
 * 检索轨迹单测（跑 lib 产物，不拉 cordis 依赖树）。
 *
 * 覆盖：纯函数（路径/脱敏/截断/噪音策略/参数摘要/结果归类/序列化/解析）
 * + 真实落盘与回读 + 退化路径（坏行/半行/空文件/缺失文件/目录误当文件）
 * + **尸体测试**（父路径是普通文件 → false 且不抛）
 * + **隐私尸体测试**（喂含凭据的 pattern → 落盘行里搜不到那些串）
 * + 一条离线组合（真 argv 拼装 + 参数摘要 → 轨迹行能回答「噪音排除生效了吗 / 断在哪一段」）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSearchArgv } from '../lib/rg.js'
import {
  appendTraceEntry,
  buildStamp,
  classifyTraceOutcome,
  codeSearchTrace,
  codeSearchTracePath,
  describeQueryScope,
  mtimeOf,
  noisePolicyOf,
  parseTraceEntries,
  readPackageVersion,
  readTraceEntries,
  redactQuery,
  resolveHome,
  serializeTraceEntry,
  truncate,
} from '../lib/trace.js'

const tmp = mkdtempSync(join(tmpdir(), 'code-search-trace-test-'))
const CFG = { defaultPath: 'E:/alice', noiseExcludes: ['!**/node_modules/**', '!**/.git/**'] }
const base = (entry) => ({
  atMs: 1_700_000_000_000,
  phase: 'search',
  build: '0.1.0@123',
  op: 'code_search',
  query: 'runPreflightCore',
  root: 'E:/alice',
  include: '',
  exclude: '',
  noiseGlobs: 2,
  noisePolicy: 'strict',
  maxResults: 50,
  exitCode: 0,
  count: 3,
  durationMs: 42,
  ok: true,
  ...entry,
})

test('resolveHome：DSH_HOME 优先，空白/缺失回退 <homedir>/.dsh', () => {
  assert.equal(resolveHome({ DSH_HOME: 'E:/alice/.dsh' }, '/home/x'), 'E:/alice/.dsh')
  assert.equal(resolveHome({ DSH_HOME: '  ' }, '/home/x'), join('/home/x', '.dsh'))
  assert.equal(resolveHome({}, '/home/x'), join('/home/x', '.dsh'))
})

test('codeSearchTracePath：锚定 DSH_HOME 下的单一文件名', () => {
  assert.equal(codeSearchTracePath('/h/.dsh'), join('/h/.dsh', 'code-search-trace.jsonl'))
})

test('truncate：短串原样，超长补省略号（不把整段 pattern 灌进轨迹）', () => {
  assert.equal(truncate('abc', 5), 'abc')
  assert.equal(truncate('abcdef', 3), 'abc…')
  assert.equal(truncate(''), '')
})

test('redactQuery：显式键值对 / 厂商前缀 / Bearer / 高熵串全部擦除，普通模式保留', () => {
  assert.equal(redactQuery('token=abcdef123'), 'token=[redacted]')
  assert.equal(redactQuery('password: hunter2'), 'password=[redacted]')
  // 真实语义（实测）：两条规则**串联命中**——Bearer 规则先把 `abc.def` 擦成 `[redacted]`，
  // 键值对规则再把剩下的 `Authorization: Bearer` 擦一遍 ⇒ 尾部留下一个多余的 `[redacted]`。
  // 这是**过度擦除**（安全方向），不是缺陷；只是输出形状与「一次擦净」的直觉不同。
  assert.equal(redactQuery('Authorization: Bearer abc.def'), 'Authorization=[redacted] [redacted]')
  assert.equal(redactQuery('Bearer sk-live-abcdefgh'), 'Bearer [redacted]')
  assert.equal(redactQuery('sk-abcdefgh1234'), '[redacted]')
  assert.equal(redactQuery('ghp_ABCDEFGHIJKLMNOPQRSTUV'), '[redacted]')
  assert.equal(redactQuery('github_pat_11ABCDEFG0abcdefghij'), '[redacted]')
  assert.equal(redactQuery('AKIAIOSFODNN7EXAMPLE'), '[redacted]')
  assert.equal(redactQuery('a'.repeat(40)), '[redacted]')
  // 普通检索模式不得被误伤（Q2 保真）
  assert.equal(redactQuery('runPreflightCore'), 'runPreflightCore')
  assert.equal(redactQuery('export function \\w+\\('), 'export function \\w+\\(')
})

test('noisePolicyOf：无噪音排除=none；有排除=strict；include 覆盖=include-overridden', () => {
  assert.equal(noisePolicyOf(0, false), 'none')
  assert.equal(noisePolicyOf(0, true), 'none')
  assert.equal(noisePolicyOf(9, false), 'strict')
  assert.equal(noisePolicyOf(9, true), 'include-overridden')
})

test('describeQueryScope（search）：根回落 / 噪音条数 / include 覆盖语义 / 上限缺省 50', () => {
  const s = describeQueryScope({ pattern: 'x' }, CFG, 'search')
  assert.equal(s.root, 'E:/alice')
  assert.equal(s.noiseGlobs, 2)
  assert.equal(s.noisePolicy, 'strict')
  assert.equal(s.maxResults, 50)
  const over = describeQueryScope({ pattern: 'x', include: '*.ts' }, CFG, 'search')
  // 真语义：rg glob 后者覆盖前者 ⇒ include 可重新纳入 node_modules 下的 .ts
  assert.equal(over.noisePolicy, 'include-overridden')
  const withExclude = describeQueryScope({ pattern: 'x', path: 'E:/tmp', exclude: '**/tests/**', maxResults: 5 }, CFG, 'search')
  assert.equal(withExclude.root, 'E:/tmp')
  assert.equal(withExclude.exclude, '**/tests/**')
  assert.equal(withExclude.maxResults, 5)
})

test('describeQueryScope（locate）：不吃调用方 exclude（argv 只含 cfg.noiseExcludes），上限缺省 30', () => {
  const s = describeQueryScope({ term: 'x', exclude: '**/tests/**' }, CFG, 'locate')
  assert.equal(s.exclude, '')
  assert.equal(s.maxResults, 30)
  assert.equal(s.noisePolicy, 'strict')
})

test('classifyTraceOutcome：成功 / 无匹配 / 失败三者可辨（原缺陷的判据面）', () => {
  const ok = classifyTraceOutcome({ count: 3 }, { exitCode: 0, failure: null })
  assert.deepEqual(ok, { ok: true, count: 3 })
  // rg 退出码 1 = 无匹配：**ok=true 且 count=0**，不得与失败同形
  const noMatch = classifyTraceOutcome({ count: 0 }, { exitCode: 1, failure: null })
  assert.deepEqual(noMatch, { ok: true, count: 0 })
  // spawn 层失败（ENOENT）：ok=false + error 归口
  const enoent = classifyTraceOutcome(
    { count: 0, results: [{ error: 'rg 无法执行（ENOENT）' }] },
    { exitCode: 1, failure: 'rg 无法执行（ENOENT）' },
  )
  assert.equal(enoent.ok, false)
  assert.match(enoent.error, /ENOENT/)
  // 结果体内嵌 error（locate 的外壳）
  const located = classifyTraceOutcome({ count: 0, files: [], error: 'rg 被信号终止（SIGKILL）' }, { exitCode: -1, failure: null })
  assert.equal(located.ok, false)
  assert.match(located.error, /SIGKILL/)
  // 兜底：只有 results[0].error（search 外壳）
  const outer = classifyTraceOutcome({ count: 0, results: [{ error: 'boom' }] }, { exitCode: 2, failure: null })
  assert.equal(outer.ok, false)
  assert.equal(outer.error, 'boom')
  // 抛错：观测层也要留证（且不吞掉 count 判定）
  const thrown = classifyTraceOutcome(undefined, { exitCode: -1, failure: null }, new Error('kaboom'))
  assert.equal(thrown.ok, false)
  assert.match(thrown.error, /kaboom/)
  assert.equal(classifyTraceOutcome(undefined, { exitCode: -1, failure: null }, 'plain').ok, false)
  // 无结果对象也不崩（退化输入）
  assert.deepEqual(classifyTraceOutcome(undefined, { exitCode: 0, failure: null }), { ok: true, count: 0 })
})

test('serializeTraceEntry：单行 + 键序固定 + error 缺省不污染', () => {
  const line = serializeTraceEntry(base({}))
  assert.equal(line.includes('\n'), false)
  assert.deepEqual(Object.keys(JSON.parse(line)), [
    'atMs', 'phase', 'build', 'op', 'query', 'root', 'include', 'exclude', 'noiseGlobs',
    'noisePolicy', 'maxResults', 'exitCode', 'count', 'durationMs', 'ok',
  ])
  const withErr = JSON.parse(serializeTraceEntry(base({ ok: false, error: 'rg 无法执行（ENOENT）' })))
  assert.equal(Object.keys(withErr).at(-1), 'error')
  assert.equal(withErr.error, 'rg 无法执行（ENOENT）')
})

test('parseTraceEntries：坏行/半行/空行/null/字符串全部跳过，不抛', () => {
  const good = serializeTraceEntry(base({}))
  const text = ['', good, '  ', '{"atMs":1,"phase":"search"', '{"phase":"search"}', 'null', '"str"', '###'].join('\n')
  const parsed = parseTraceEntries(text)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].op, 'code_search')
})

test('readTraceEntries：缺失文件/目录误当文件 → 空数组（不抛）', () => {
  assert.deepEqual(readTraceEntries(join(tmp, 'nope', 'code-search-trace.jsonl')), [])
  assert.deepEqual(readTraceEntries(tmp), [])
})

test('appendTraceEntry：正常追加可回读；空文件读回空数组', () => {
  const path = join(tmp, 'ok', 'code-search-trace.jsonl')
  const emptyPath = join(tmp, 'empty-trace.jsonl')
  writeFileSync(emptyPath, '', 'utf8')
  assert.deepEqual(readTraceEntries(emptyPath), [])
  assert.equal(appendTraceEntry(path, base({ phase: 'boot', op: 'apply' })), true)
  assert.equal(appendTraceEntry(path, base({ phase: 'locate', op: 'code_locate', count: 7 })), true)
  const back = readTraceEntries(path)
  assert.deepEqual(back.map((e) => e.phase), ['boot', 'locate'])
  assert.equal(back[1].count, 7)
  assert.equal(readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '').length, 2)
})

test('尸体测试：父路径是普通文件 → 返回 false 且不抛（观测不反噬检索）', () => {
  const blocker = join(tmp, 'blocker')
  writeFileSync(blocker, 'not a dir', 'utf8')
  assert.doesNotThrow(() => {
    assert.equal(appendTraceEntry(join(blocker, 'code-search-trace.jsonl'), base({})), false)
    assert.equal(codeSearchTrace(base({}), { path: join(blocker, 'code-search-trace.jsonl'), now: 1 }), false)
  })
})

test('codeSearchTrace：注入 now 落一行；不可写路径返回 false', () => {
  const path = join(tmp, 'thin', 'code-search-trace.jsonl')
  // 契约：atMs 由 codeSearchTrace 注入（entry 里传的会被覆盖——base() 是给纯序列化用的夹具）
  const { atMs, ...withoutAt } = base({ phase: 'locate', op: 'code_locate' })
  assert.equal(atMs, 1_700_000_000_000)
  assert.equal(codeSearchTrace(withoutAt, { path, now: 42 }), true)
  const [line] = readTraceEntries(path)
  assert.equal(line.atMs, 42)
  assert.equal(line.op, 'code_locate')
  assert.equal(codeSearchTrace(withoutAt, { path: join(tmp, 'blocker', 'x.jsonl'), now: 43 }), false)
})

test('隐私尸体测试：含凭据的 pattern 落盘后搜不到凭据串（红线）', () => {
  const path = join(tmp, 'privacy', 'code-search-trace.jsonl')
  const secrets = ['sk-live-9f8e7d6c5b4a3210', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'hunter2secret', 'AbCdEf0123456789AbCdEf0123456789']
  const queries = [
    'sk-live-9f8e7d6c5b4a3210',
    'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    'api_key=hunter2secret',
    'Authorization: Bearer AbCdEf0123456789AbCdEf0123456789',
  ]
  for (const q of queries) {
    assert.equal(codeSearchTrace(base({ query: truncate(redactQuery(q)) }), { path, now: 1 }), true)
  }
  const raw = readFileSync(path, 'utf8')
  for (const s of secrets) {
    assert.equal(raw.includes(s), false, '凭据不得落盘: ' + s)
  }
  assert.match(raw, /\[redacted\]/)  // 擦除确实发生了（不是「没写进去」的假绿）
  const lines = parseTraceEntries(raw)
  assert.equal(lines.length, queries.length)
})

test('构建自证：buildStamp/readPackageVersion/mtimeOf（版本读不到退化为 unknown@mtime）', () => {
  const root = join(tmp, 'pkg')
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }), 'utf8')
  const self = join(root, 'lib', 'index.js')
  writeFileSync(self, '// x', 'utf8')
  assert.equal(readPackageVersion(self), '1.2.3')
  assert.ok(mtimeOf(self) > 0)
  assert.equal(buildStamp(self, '1.2.3'), '1.2.3@' + String(mtimeOf(self)))
  assert.equal(buildStamp(join(root, 'missing.js'), ''), 'unknown@0')
})

test('离线组合：真 argv 拼装 + 参数摘要 → 轨迹行回答「噪音排除生效了吗 / 断在哪一段」', () => {
  const path = join(tmp, 'combo', 'code-search-trace.jsonl')
  // ① 正常检索：exclude 先入、include 后入（rg glob 后者覆盖前者）
  const args = { pattern: 'runPreflightCore', path: 'E:/alice', maxResults: 10 }
  const argv = buildSearchArgv(args, CFG)
  assert.deepEqual(argv.slice(0, 3), ['--json', '--color', 'never'])
  assert.equal(argv.filter((a) => a === '--glob').length, 2) // 只有噪音排除
  const scope = describeQueryScope(args, CFG, 'search')
  assert.equal(codeSearchTrace({
    phase: 'search', build: '0.1.0@1', op: 'code_search', query: args.pattern,
    ...scope, exitCode: 0, count: 2, durationMs: 30, ok: true,
  }, { path, now: 100 }), true)
  const [ok] = readTraceEntries(path)
  assert.equal(ok.noisePolicy, 'strict')          // 噪音真的排除了
  assert.equal(ok.exitCode, 0)                    // 子进程真的跑到了
  assert.equal(ok.count, 2)
  assert.equal(ok.ok, true)
  // ② 静默失效形状（原缺陷）：rg 不存在 → 退出码被归一为 1（= 无匹配哨兵）
  const failArgv = buildSearchArgv({ pattern: 'x' }, CFG)
  assert.ok(failArgv.length > 0) // argv 构造正常，失败只在 spawn 层
  const outcome = classifyTraceOutcome(
    { count: 0, results: [{ error: 'rg 无法执行（ENOENT）' }] },
    { exitCode: 1, failure: 'rg 无法执行（ENOENT）' },
  )
  assert.equal(codeSearchTrace({
    phase: 'search', build: '0.1.0@1', op: 'code_search', query: 'x',
    ...describeQueryScope({ pattern: 'x' }, CFG, 'search'),
    exitCode: 1, count: outcome.count, durationMs: 5, ok: outcome.ok, error: outcome.error,
  }, { path, now: 101 }), true)
  const [, bad] = readTraceEntries(path)
  // 关键：exitCode=1 时 ok=false（若轨迹只记 exitCode，就会与「无匹配」同形——这正是补课动机）
  assert.equal(bad.ok, false)
  assert.match(bad.error, /ENOENT/)
  assert.equal(bad.exitCode, 1)
})

test('cleanup', () => {
  rmSync(tmp, { recursive: true, force: true })
})
