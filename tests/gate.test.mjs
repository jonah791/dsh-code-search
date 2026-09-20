/**
 * gate.ts 离线单测——porcelain 解析 / 噪音过滤 / 测试识别 / 反向可达 / 包归属 / 命令挑选 / 闸门整合。
 *
 * 全部不碰磁盘、不调 git（git 输出由夹具直接构造）。路径统一用 `/` 风格构造，
 * 同时用 Windows 形态样本验证**分隔符规范化**——夹具不得依赖运行平台（本仓库踩过的坑）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildReverseIndex, isNoisePath, isTestFile, isUnexpandedDir,
  packageRootOf, parsePorcelain, pickTestCommand, reverseReachable, testGate,
} from '../lib/gate.js'

const G = (defs, imports = [], reexports = []) => ({ defs: new Set(defs), imports, reexports })
const imp = (source, names, resolved, how = 'rel') => ({ source, names, resolved, how })

test('parsePorcelain：M / ?? / rename 取新路径 / 引号剥离 / 尾斜杠保留', () => {
  const out = parsePorcelain([
    ' M src/a.ts',
    '?? src/new.ts',
    '?? .profile/',
    'R  old/x.ts -> new/x.ts',
    ' M "path with space.ts"',
    'D  gone.ts',
    '',
  ].join('\n'))
  assert.equal(out.length, 6)
  assert.deepEqual(out[0], { status: 'M', path: 'src/a.ts' })
  assert.deepEqual(out[1], { status: '??', path: 'src/new.ts' })
  assert.deepEqual(out[2], { status: '??', path: '.profile/' })
  assert.deepEqual(out[3], { status: 'R', path: 'new/x.ts' })
  assert.deepEqual(out[4], { status: 'M', path: 'path with space.ts' })
  assert.deepEqual(out[5], { status: 'D', path: 'gone.ts' })
})

test('parsePorcelain 退化：空输出 / 短行 / 空路径全部跳过，不抛', () => {
  assert.deepEqual(parsePorcelain(''), [])
  assert.deepEqual(parsePorcelain('\n\n'), [])
  assert.deepEqual(parsePorcelain('M\n'), [])
})

test('isNoisePath：噪音片段命中（含根级 `.dsh`）', () => {
  for (const p of ['.dsh/x.json', 'a/node_modules/b.ts', 'src/lib/c.js', 'x/dist/y.js', 'p/_tmp_review/z.ts']) {
    assert.equal(isNoisePath(p), true, p)
  }
  for (const p of ['src/index.ts', 'libs/a.ts', 'tests/b.mjs']) {
    assert.equal(isNoisePath(p), false, p)
  }
})

test('isUnexpandedDir：只认尾斜杠（git 对未追踪目录只给目录名）', () => {
  assert.equal(isUnexpandedDir('profiles/'), true)
  assert.equal(isUnexpandedDir('profiles'), false)
})

test('isTestFile：命名约定（故意取宽——多跑比漏跑便宜）', () => {
  for (const p of ['src/a.test.ts', 'src/a.spec.mjs', 'tests/foo.mjs', 'pkg/__tests__/x.js', 'test/b.ts']) {
    assert.equal(isTestFile(p), true, p)
  }
  for (const p of ['src/a.ts', 'src/latest.ts', 'src/test-utils.ts', 'testdata/x.ts', 'src/b.tests.ts']) {
    assert.equal(isTestFile(p), false, p)
  }
})

test('buildReverseIndex + reverseReachable：反向可达、环安全、触顶披露', () => {
  const g = new Map([
    ['/r/a.ts', G(['a'], [imp('./b.js', ['b'], '/r/b.ts')])],
    ['/r/b.ts', G(['b'], [imp('./c.js', ['c'], '/r/c.ts')])],
    ['/r/c.ts', G(['c'])],
    ['/r/x.ts', G([], [imp('./y.js', ['y'], '/r/y.ts')])],
    ['/r/y.ts', G([], [imp('./x.js', ['x'], '/r/x.ts')])],
  ])
  const rev = buildReverseIndex(g)
  assert.deepEqual([...rev.get('/r/c.ts')], ['/r/b.ts'])

  const r1 = reverseReachable(['/r/c.ts'], rev)
  assert.deepEqual([...r1.reached].sort(), ['/r/a.ts', '/r/b.ts', '/r/c.ts'])
  assert.equal(r1.truncated, false)

  // 环：A↔B 必须终止而不是死循环
  const r2 = reverseReachable(['/r/x.ts'], rev)
  assert.deepEqual([...r2.reached].sort(), ['/r/x.ts', '/r/y.ts'])

  const r3 = reverseReachable(['/r/c.ts'], rev, 2)
  assert.equal(r3.truncated, true, '触顶必须如实标记')
})

test('packageRootOf：最长前缀匹配 + 分隔符规范化（跨平台）', () => {
  const dirs = ['/repo', '/repo/packages/a', '/repo/packages/a/sub']
  assert.equal(packageRootOf('/repo/packages/a/src/x.ts', dirs), '/repo/packages/a')
  assert.equal(packageRootOf('/repo/packages/a/sub/y.ts', dirs), '/repo/packages/a/sub')
  assert.equal(packageRootOf('/other/z.ts', dirs), null)
  // Windows 形态的输入与包目录：规范化后必须能匹配上
  assert.equal(packageRootOf('C:\\repo\\packages\\a\\src\\x.ts', ['C:/repo/packages/a']), 'C:/repo/packages/a')
  assert.equal(packageRootOf('/repo/x.ts', []), null)
})

test('pickTestCommand：优先 test / 退化返回 null（不编造）', () => {
  assert.equal(pickTestCommand({ scripts: { test: 'node --test' } }), 'node --test')
  assert.equal(pickTestCommand({ scripts: { 'test:unit': 'vitest run' } }), 'vitest run')
  assert.equal(pickTestCommand({ scripts: { test: '   ' } }), null)
  assert.equal(pickTestCommand({ scripts: {} }), null)
  assert.equal(pickTestCommand({}), null)
  assert.equal(pickTestCommand(null), null)
  assert.equal(pickTestCommand('nope'), null)
})

test('testGate 整合：改动 → 反向可达 → 测试与包归属', () => {
  const g = new Map([
    ['/repo/src/core.ts', G(['core'])],
    ['/repo/src/mid.ts', G([], [imp('./core.js', ['core'], '/repo/src/core.ts')])],
    ['/repo/tests/core.test.mjs', G([], [imp('../src/mid.js', ['mid'], '/repo/src/mid.ts')])],
    ['/repo/other/untouched.ts', G([])],
  ])
  const pkgDirs = new Map([['repo', '/repo']])
  const r = testGate([{ status: 'M', path: 'src/core.ts' }], g, pkgDirs)
  assert.deepEqual(r.changed, ['src/core.ts'])
  assert.equal(r.affected.length, 3)
  assert.deepEqual(r.tests, ['/repo/tests/core.test.mjs'])
  assert.equal(r.testPackages.length, 1)
  assert.equal(r.testPackages[0].dir, '/repo')
  assert.deepEqual(r.unmapped, [])
  assert.equal(r.truncated, false)
})

test('testGate：噪音过滤 / 未追踪目录分离 / 删除文件不参与 / 无测试时披露 unmapped', () => {
  const g = new Map([['/repo/src/a.ts', G(['a'])]])
  const r = testGate([
    { status: 'M', path: 'src/a.ts' },
    { status: 'M', path: '.dsh/trace.jsonl' },
    { status: '??', path: 'profiles/' },
    { status: 'D', path: 'src/gone.ts' },
  ], g, new Map())
  assert.deepEqual(r.changed, ['src/a.ts'], '噪音与未展开目录不得出现在改动集里')
  assert.deepEqual(r.unexpanded, ['profiles/'], '未追踪目录必须如实披露而不是静默丢弃')
  assert.deepEqual(r.tests, [])
  assert.deepEqual(r.unmapped, ['src/a.ts'], '无测试覆盖时 unmapped 必须诚实给出')
})

test('testGate：改动自身是测试文件时必须跑自己（即便不在图里）', () => {
  const g = new Map([['/repo/tests/x.test.mjs', G([])]])
  const r = testGate([{ status: 'M', path: 'tests/x.test.mjs' }], g, new Map([['p', '/repo']]))
  assert.deepEqual(r.tests, ['/repo/tests/x.test.mjs'])
})

test('testGate 退化：无改动 / 空图 → 零结果不抛', () => {
  const r = testGate([], new Map(), new Map())
  assert.deepEqual(r.changed, [])
  assert.deepEqual(r.tests, [])
  assert.deepEqual(r.unexpanded, [])
  assert.equal(r.truncated, false)
})
