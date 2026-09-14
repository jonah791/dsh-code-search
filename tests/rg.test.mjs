/**
 * rg.ts 纯函数套件（离线、无 IO、不 spawn 任何进程）。
 * 覆盖：正常路径 + 失败/退化路径（空值、非法输入、损坏行、边界 cap、spawn 层失败）——后者是 S6 判据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveRgPath, resolveRoot, buildExcludes, buildSearchArgv, buildLocateArgv,
  classifyRgOutcome, parseRgJsonLines, parseFileList, rgFailureResult,
} from '../lib/rg.js'

const CFG = {
  rgPath: '',
  defaultPath: 'E:/alice',
  noiseExcludes: ['!**/node_modules/**', '!**/.git/**'],
}

/* ── 路径解析 ── */

test('resolveRgPath/resolveRoot: 正常路径取配置值', () => {
  assert.equal(resolveRgPath({ ...CFG, rgPath: 'C:\\tools\\rg.exe' }), 'C:\\tools\\rg.exe')
  assert.equal(resolveRgPath(CFG), 'rg', '空配置回落 PATH 上的 rg')
  assert.equal(resolveRoot('D:/x', CFG), 'D:/x')
})

test('resolveRoot: 退化输入——undefined/空串回落 defaultPath', () => {
  assert.equal(resolveRoot(undefined, CFG), 'E:/alice')
  assert.equal(resolveRoot('', CFG), 'E:/alice')
})

/* ── 排除 glob 拼装 ── */

test('buildExcludes: 配置噪音 + 调用方额外排除（自动补 ! 前缀）', () => {
  assert.deepEqual(buildExcludes(CFG, '**/tests/**'), ['!**/node_modules/**', '!**/.git/**', '!**/tests/**'])
})

test('buildExcludes: 退化输入——空 exclude 不追加；已带 ! 的 exclude 会变成 !!（真实语义）', () => {
  assert.deepEqual(buildExcludes(CFG, undefined), CFG.noiseExcludes)
  assert.deepEqual(buildExcludes(CFG, ''), CFG.noiseExcludes, '空串为假值，不追加')
  assert.deepEqual(buildExcludes(CFG, '!**/x/**'), [...CFG.noiseExcludes, '!!**/x/**'], '不做幂等保护——调用方不应自带 !')
  assert.deepEqual(buildExcludes({ ...CFG, noiseExcludes: [] }, 'a'), ['!a'], '空噪音表也必须能工作')
})

/* ── argv 拼装（顺序即语义） ── */

test('buildSearchArgv: 结构 = --json --color never → 排除 globs → include → --regexp 模式 根路径', () => {
  const argv = buildSearchArgv({ pattern: 'foo', include: '*.ts', exclude: '**/tests/**' }, CFG)
  assert.deepEqual(argv, [
    '--json', '--color', 'never',
    '--glob', '!**/node_modules/**', '--glob', '!**/.git/**', '--glob', '!**/tests/**',
    '--glob', '*.ts',
    '--regexp', 'foo', 'E:/alice',
  ])
})

test('buildSearchArgv: 真实语义——include 排在 exclude 之后（rg 后置 glob 覆盖前置）', () => {
  const argv = buildSearchArgv({ pattern: 'a', include: '*.ts' }, CFG)
  assert.ok(argv.lastIndexOf('--glob') > argv.indexOf('!**/node_modules/**'),
    'include 必须晚于噪音排除——即 include 命中时可重新纳入 node_modules（此为既定语义，已在 §10 登记）')
})

test('buildSearchArgv: 退化输入——空模式仍进 argv；空 include/exclude 省略该 glob', () => {
  const argv = buildSearchArgv({ pattern: '' }, CFG)
  assert.deepEqual(argv.slice(-3), ['--regexp', '', 'E:/alice'], '空模式按原样透传（rg 自行报错）')
  assert.equal(argv.filter((a) => a === '--glob').length, CFG.noiseExcludes.length, '空 include/exclude 不得产生额外 glob')
})

test('buildSearchArgv: 恶意模式不逃逸——只能作为 --regexp 的**独立 argv 元素**', () => {
  const evil = 'x"; rm -rf / #'
  const argv = buildSearchArgv({ pattern: evil }, CFG)
  assert.equal(argv[argv.indexOf('--regexp') + 1], evil, '模式必须原样作为一个 argv 元素（不经 shell，无命令语义）')
})

test('buildLocateArgv: 结构 = --files-with-matches --color never → 噪音 globs → include → --regexp 词 根路径', () => {
  const argv = buildLocateArgv({ term: 'foo', include: '*.ts', path: 'D:/r' }, CFG)
  assert.deepEqual(argv, [
    '--files-with-matches', '--color', 'never',
    '--glob', '!**/node_modules/**', '--glob', '!**/.git/**',
    '--glob', '*.ts',
    '--regexp', 'foo', 'D:/r',
  ])
})

test('buildLocateArgv: 不变量——locate 不接收 exclude，永远只带配置噪音表', () => {
  assert.equal(buildLocateArgv({ term: 'x' }, CFG).filter((a) => a === '--glob').length, CFG.noiseExcludes.length)
})

/* ── classifyRgOutcome：退出码归类（本插件的核心判据） ── */

test('classifyRgOutcome: 正常路径——无错误 = 退出码 0 且无失败', () => {
  assert.deepEqual(classifyRgOutcome(null, ''), { code: 0, failure: null })
})

test('classifyRgOutcome: 正常路径——非零退出码 + stderr = 失败（诊断上抛）', () => {
  const r = classifyRgOutcome({ code: 2 }, 'regex parse error')
  assert.equal(r.code, 2)
  assert.equal(r.failure, 'regex parse error')
})

test('classifyRgOutcome: 退化路径——退出码 1 是「无匹配」哨兵，stderr 非空也不算失败', () => {
  assert.deepEqual(classifyRgOutcome({ code: 1 }, 'some warning'), { code: 1, failure: null })
  assert.deepEqual(classifyRgOutcome({ code: 1 }, ''), { code: 1, failure: null })
})

test('classifyRgOutcome: 失败路径——spawn 层失败（ENOENT）必须报错，不得伪装成「无匹配」', () => {
  const r = classifyRgOutcome({ code: 'ENOENT', message: 'spawn rg ENOENT' }, '')
  assert.equal(r.code, 1)
  assert.ok(r.failure, '修复前此处 failure 为 null → rg 缺失被静默当成空结果（已证伪的缺陷）')
  assert.match(r.failure, /rg 无法执行（ENOENT）/)
  assert.match(r.failure, /Config\.rgPath/, '错误串必须给出下一步动作')
})

test('classifyRgOutcome: 失败路径——EACCES 等其它字符串错误码同样归类为失败', () => {
  for (const code of ['EACCES', 'EPERM', 'EISDIR']) {
    const r = classifyRgOutcome({ code, message: `${code} boom` }, '')
    assert.ok(r.failure, `${code} 必须报错`)
  }
})

test('classifyRgOutcome: 失败路径——信号终止（SIGTERM）算失败，即使 stderr 为空', () => {
  const r = classifyRgOutcome({ signal: 'SIGTERM' }, '')
  assert.equal(r.code, 1)
  assert.match(r.failure, /rg 被信号终止（SIGTERM）/)
  assert.match(classifyRgOutcome({ signal: 'SIGKILL' }, 'killed').failure, /：killed/)
})

test('classifyRgOutcome: 退化路径——无 code 无 signal 的错误对象按退出码 1 处理（真实语义）', () => {
  assert.deepEqual(classifyRgOutcome({}, 'noise'), { code: 1, failure: null })
  assert.deepEqual(classifyRgOutcome(undefined, 'noise'), { code: 0, failure: null })
})

test('classifyRgOutcome: 边界——stderr 超长被截到 500 字符', () => {
  const r = classifyRgOutcome({ code: 2 }, 'x'.repeat(900))
  assert.equal(r.failure.length, 500)
})

/* ── parseRgJsonLines：--json 输出解析 ── */

const J = (o) => JSON.stringify(o)

test('parseRgJsonLines: 正常路径——只收 match 记录，剥掉行尾换行', () => {
  const stdout = [
    J({ type: 'begin', data: {} }),
    J({ type: 'match', data: { path: { text: 'a.ts' }, line_number: 3, lines: { text: 'hello\n' } } }),
    J({ type: 'context', data: {} }),
    J({ type: 'end', data: {} }),
  ].join('\n')
  assert.deepEqual(parseRgJsonLines(stdout, 50), [{ path: 'a.ts', lineNo: 3, text: 'hello' }])
})

test('parseRgJsonLines: 失败路径——非 JSON 行 / 空行 / 半截 JSON 全部跳过，不抛', () => {
  const stdout = ['not json', '', '   ', '{"type":"match","data":{"path":{"text":"ok"}}}', '{broken']
    .join('\n')
  assert.deepEqual(parseRgJsonLines(stdout, 50), [{ path: 'ok', lineNo: 0, text: '' }])
})

test('parseRgJsonLines: 退化路径——空输出 / 缺字段按默认值兜底', () => {
  assert.deepEqual(parseRgJsonLines('', 50), [])
  assert.deepEqual(
    parseRgJsonLines(J({ type: 'match', data: {} }), 50),
    [{ path: '', lineNo: 0, text: '' }],
  )
  assert.deepEqual(parseRgJsonLines(J({ data: {} }), 50), [], 'type 非 match 一律忽略')
  assert.deepEqual(parseRgJsonLines(J({ type: 'match' }), 50), [], '无 data 一律忽略')
})

test('parseRgJsonLines: 边界——cap 截断；cap=0 与负数 cap 均返回空（与 locate 的负数语义不同！）', () => {
  const stdout = [1, 2, 3].map((n) => J({ type: 'match', data: { path: { text: `f${n}` } } })).join('\n')
  assert.equal(parseRgJsonLines(stdout, 2).length, 2)
  assert.equal(parseRgJsonLines(stdout, 0).length, 0)
  assert.equal(parseRgJsonLines(stdout, -1).length, 0, 'cap<0 时 results.length>=cap 恒真 → 空')
})

/* ── parseFileList：--files-with-matches 输出解析 ── */

test('parseFileList: 正常路径——一行一文件，过滤空行', () => {
  assert.deepEqual(parseFileList('a.ts\nb.ts\n\n', 10), { total: 2, files: ['a.ts', 'b.ts'] })
})

test('parseFileList: 真实语义——total 未截断、files 截断（两者可不等）', () => {
  const r = parseFileList('a\nb\nc\nd', 2)
  assert.equal(r.total, 4)
  assert.deepEqual(r.files, ['a', 'b'])
})

test('parseFileList: 退化路径——空输出 / cap=0', () => {
  assert.deepEqual(parseFileList('', 10), { total: 0, files: [] })
  assert.deepEqual(parseFileList('\n\n', 10), { total: 0, files: [] })
  assert.deepEqual(parseFileList('a\nb', 0), { total: 2, files: [] })
})

test('parseFileList: 失败路径——负数 cap 走 slice(0,-n)，从尾部丢弃而非返回空（真实语义，已登记 §10）', () => {
  assert.deepEqual(parseFileList('a\nb\nc', -1), { total: 3, files: ['a', 'b'] })
})

/* ── rgFailureResult：失败外壳 ── */

test('rgFailureResult: 失败哨兵形状（count=0 + results[0].error，供 render 判错）', () => {
  const r = rgFailureResult('boom')
  assert.equal(r.count, 0)
  assert.equal(r.results.length, 1)
  assert.equal(r.results[0].error, 'boom')
  assert.equal(r.results[0].path, '')
})
