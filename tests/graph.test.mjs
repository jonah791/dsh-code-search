/**
 * graph.ts 离线单测——纯函数层：子句解析 / 路径解析 / 导出链可达性 / 影响面分档。
 *
 * **全部不碰磁盘**（文件存在性由注入的 `fileExists` 提供），故 Windows 与 WSL 双平台都跑绿。
 * 路径断言一律经 `resolve()` 归一（裸 `/r/...` 在 Windows 会变成 `C:\r\...`，
 * 直接硬编码字符串会让夹具依赖运行平台——这是本仓库踩过的夹具坑）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import {
  candidatePaths, findDefiner, impactOf, mentionsSymbol, namesInClause,
  packageNameOf, parseImports, parseReexports, resolveModule,
} from '../lib/graph.js'

test('namesInClause：具名 / 别名 / type 前缀 / default / namespace', () => {
  assert.deepEqual(namesInClause('{ A, B as C, type D }').sort(), ['A', 'C', 'D'])
  assert.deepEqual(
    namesInClause('ToolRuntime, { RUN_CODE_NAME, defineTool }').sort(),
    ['RUN_CODE_NAME', 'ToolRuntime', 'defineTool'],
  )
  assert.deepEqual(namesInClause('* as ns'), ['ns'])
  assert.deepEqual(namesInClause('X'), ['X'])
})

test('parseImports：相对 / 包名 / type 导入 / default+具名混写', () => {
  const text = [
    "import { a, b } from './x.js'",
    "import type { T } from '@scope/pkg'",
    "import Def, { N } from '../y/z.ts'",
    "// import { notARealOne } from './nope.js'",
  ].join('\n')
  const out = parseImports(text)
  assert.equal(out.length, 3)
  assert.equal(out[0].source, './x.js')
  assert.deepEqual(out[0].names.sort(), ['a', 'b'])
  assert.deepEqual(out[1].names, ['T'])
  assert.deepEqual(out[2].names.sort(), ['Def', 'N'])
})

test('parseReexports：具名 / 通配收；`export * as ns` 不收（不传播名字可达性）', () => {
  const out = parseReexports([
    "export { X, Y as Z } from './a.js'",
    "export * from './b.js'",
    "export * as ns from './c.js'",
    "export type { T } from './d.js'",
  ].join('\n'))
  assert.equal(out.length, 3)
  assert.deepEqual(out[0].names.sort(), ['X', 'Z'])
  assert.equal(out[1].star, true)
  assert.equal(out[2].source, './d.js')
  assert.deepEqual(out[2].names, ['T'])
})

test('candidatePaths：已带扩展名的写入必须能解析（v2 漏洞的尸体样本）', () => {
  const cands = candidatePaths('/r/src/schema.ts')
  assert.ok(cands.includes('/r/src/schema.ts'), 'basePath 本身必须在候选里——否则 `./schema.ts` 解析失败')
  // TS 的 ESM 惯例：源码写 `./x.js`，实体是 `x.ts`——这条映射是三类解析里最常用的一条
  const jsCands = candidatePaths('/r/src/rg.js')
  assert.ok(jsCands.includes('/r/src/rg.ts'), '.js 写入必须能映射到 .ts 实体')
  assert.ok(jsCands.includes('/r/src/rg.js'), '.js 写入自身也在候选里')
  assert.ok(jsCands.some((c) => c.endsWith('index.ts')), '目录形态应能落到 index.ts')
})

test('packageNameOf：scoped 与平包', () => {
  assert.equal(packageNameOf('@scope/pkg/sub/x'), '@scope/pkg')
  assert.equal(packageNameOf('@scope/pkg'), '@scope/pkg')
  assert.equal(packageNameOf('pkg/x'), 'pkg')
  assert.equal(packageNameOf('pkg'), 'pkg')
})

test('resolveModule：相对 / 包入口 / 包子路径 / 未映射包（四态）', () => {
  const files = new Set([
    resolve('/r/src/rg.ts'), resolve('/r/src/index.ts'),
    resolve('/pkg/src/index.ts'), resolve('/pkg/src/sub/deep.ts'),
  ])
  const exists = (p) => files.has(p)
  const dirs = new Map([['kk', resolve('/pkg')]])
  const from = resolve('/r/src/a.ts')
  assert.deepEqual(resolveModule(from, './rg.js', exists, dirs), { path: resolve('/r/src/rg.ts'), how: 'rel' })
  assert.deepEqual(resolveModule(from, 'kk', exists, dirs), { path: resolve('/pkg/src/index.ts'), how: 'pkg-entry' })
  assert.deepEqual(resolveModule(from, 'kk/src/sub/deep', exists, dirs), { path: resolve('/pkg/src/sub/deep.ts'), how: 'pkg-sub' })
  assert.deepEqual(resolveModule(from, 'nope', exists, dirs), { path: null, how: 'unresolved-pkg' })
})

test('findDefiner：沿 re-export 链可达 / `export *` 传播 / 环安全 / 不可达', () => {
  const g = new Map()
  const node = (defs, reexports) => ({ defs: new Set(defs), imports: [], reexports })
  g.set('/e/index.ts', node([], [{ source: './schema.js', names: [], star: true, resolved: '/e/schema.ts', how: 'rel' }]))
  g.set('/e/schema.ts', node(['defineTool'], []))
  g.set('/e/named.ts', node([], [{ source: './deep.js', names: ['only'], star: false, resolved: '/e/deep.ts', how: 'rel' }]))
  g.set('/e/deep.ts', node(['only'], []))
  g.set('/c/a.ts', node([], [{ source: './b.js', names: ['X'], star: false, resolved: '/c/b.ts', how: 'rel' }]))
  g.set('/c/b.ts', node([], [{ source: './a.js', names: ['X'], star: false, resolved: '/c/a.ts', how: 'rel' }]))

  const star = findDefiner('defineTool', '/e/index.ts', g)
  assert.equal(star.file, '/e/schema.ts')
  assert.deepEqual(star.chain, ['/e/index.ts', '/e/schema.ts'])

  const named = findDefiner('only', '/e/named.ts', g)
  assert.equal(named.file, '/e/deep.ts')

  // 具名链**不**传播链上没列出的名字
  assert.equal(findDefiner('defineTool', '/e/named.ts', g), null)
  // 环里没有人定义 X：必须返回 null 而不是死循环
  assert.equal(findDefiner('X', '/c/a.ts', g), null)
  assert.equal(findDefiner('nope', '/e/index.ts', g), null)
})

test('impactOf：精确 / 经链 / 同文件 / 未证实 四档归类，且不重复计数', () => {
  const g = new Map()
  const texts = new Map()
  const put = (f, defs, imports, reexports = [], text = '') => {
    g.set(f, { defs: new Set(defs), imports, reexports })
    texts.set(f, text)
  }
  const imp = (source, names, resolved, how = 'rel') => ({ source, names, resolved, how })
  const rex = (source, names, resolved, star = false) => ({ source, names, star, resolved, how: 'rel' })

  put('/d/e.ts', ['foo'], [], [], 'export function foo() { return 1 }')
  put('/d/entry.ts', [], [imp('./e.js', ['foo'], '/d/e.ts')], [rex('./e.js', ['foo'], '/d/e.ts')])
  put('/a/direct.ts', [], [imp('./e.js', ['foo'], '/d/e.ts')], [], 'foo()')
  put('/a/chain.ts', [], [imp('pkg', ['foo'], '/d/entry.ts')], [], 'foo()')
  put('/a/same.ts', ['foo'], [], [], 'function foo(){}\nfoo()')
  put('/a/noise.ts', [], [], [], '// foo mentioned in a comment\nconst s = "foo"')
  put('/a/other.ts', [], [], [], 'const unrelated = 1')

  const r = impactOf('foo', g, texts)
  assert.deepEqual(r.definitions.sort(), ['/a/same.ts', '/d/e.ts'])
  const byPath = Object.fromEntries(r.referrers.map((x) => [x.path, x.how]))
  assert.equal(byPath['/a/direct.ts'], 'import-direct')
  assert.equal(byPath['/a/chain.ts'], 'import-chain')
  assert.equal(byPath['/a/same.ts'], 'same-file')
  // re-export 者本身**也是引用者**（它依赖被导出的符号）——曾漏算，由假阴性核对暴露
  assert.equal(byPath['/d/entry.ts'], 'import-direct')
  assert.deepEqual(r.unverified.map((u) => u.path), ['/a/noise.ts'])
  assert.equal(r.scanned, 7)
})

test('尸体测试：同名符号靠**导入归属**消歧（名字匹配式实现在此会混淆）', () => {
  const g = new Map()
  const texts = new Map()
  const imp = (source, names, resolved) => ({ source, names, resolved, how: 'rel' })
  g.set('/p1/index.ts', { defs: new Set(['handle']), imports: [], reexports: [] })
  g.set('/p2/index.ts', { defs: new Set(['handle']), imports: [], reexports: [] })
  g.set('/use1.ts', { defs: new Set(), imports: [imp('p1', ['handle'], '/p1/index.ts')], reexports: [] })
  g.set('/use2.ts', { defs: new Set(), imports: [imp('p2', ['handle'], '/p2/index.ts')], reexports: [] })
  for (const f of g.keys()) texts.set(f, 'handle')

  const r = impactOf('handle', g, texts)
  assert.deepEqual(r.definitions.sort(), ['/p1/index.ts', '/p2/index.ts'])
  const via = Object.fromEntries(r.referrers.map((x) => [x.path, x.via]))
  assert.equal(via['/use1.ts'], 'p1', '按名字匹配会同时归到两个定义，按导入归属只能归到一个')
  assert.equal(via['/use2.ts'], 'p2')
  assert.equal(r.unverified.length, 0)
})

test('mentionsSymbol：词边界（不误伤 foobar，命中 foo$bar）', () => {
  assert.equal(mentionsSymbol('foo\nfoobar\nfoo$bar', 'foo'), 2)
  assert.equal(mentionsSymbol('a.foo(b)\nfoo', 'foo'), 2)
  assert.equal(mentionsSymbol('nothing here', 'foo'), 0)
})

test('impactOf 退化：空图不抛，返回零结果（不是报错）', () => {
  const r = impactOf('x', new Map(), new Map())
  assert.deepEqual(r, { definitions: [], referrers: [], unverified: [], scanned: 0 })
})
