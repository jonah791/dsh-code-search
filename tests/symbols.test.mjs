/**
 * symbols.ts 纯函数套件（离线、无 IO、不 spawn 任何进程）。
 * 覆盖：正常形态（TS/JS/Python/Rust/Go/Markdown）+ 退化路径（注释行、关键字误报、未知扩展名、上限截断）。
 * 每个断言都钉住一条**可证伪**的形态——近似法的诚实边界（多行签名/宏认不出）在契约里声明，不在此处假装。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractSymbols, extOf, familyOf, matchSymbol, rulesFor } from '../lib/symbols.js'

/* ── 扩展名与语言族 ── */

test('extOf: 取扩展名（大小写/路径分隔符/无扩展名/隐藏文件）', () => {
  assert.equal(extOf('E:/alice/src/index.ts'), 'ts')
  assert.equal(extOf('E:\\alice\\src\\INDEX.TS'), 'TS')
  assert.equal(extOf('noext'), '')
  assert.equal(extOf('.gitignore'), '', '点开头的隐藏文件不算有扩展名')
  assert.equal(extOf('a/b/c.test.mjs'), 'mjs')
})

test('familyOf: 各语言族分派 + 未知回落 unknown（不认识就不猜）', () => {
  assert.equal(familyOf('.ts'), 'tsjs')
  assert.equal(familyOf('tsx'), 'tsjs')
  assert.equal(familyOf('py'), 'python')
  assert.equal(familyOf('rs'), 'rust')
  assert.equal(familyOf('go'), 'go')
  assert.equal(familyOf('md'), 'markdown')
  assert.equal(familyOf('txt'), 'unknown')
  assert.equal(familyOf(''), 'unknown')
})

test('rulesFor: 未知族返回空表（空表 ⇒ 零符号，而不是乱猜）', () => {
  assert.equal(rulesFor('unknown').length, 0)
  assert.ok(rulesFor('tsjs').length > 0)
})

/* ── 正常形态 ── */

test('matchSymbol: TS/JS 定义形态全认（class/interface/type/enum/function/const/method）', () => {
  assert.deepEqual(matchSymbol('export class Foo {', 'tsjs'), { kind: 'class', name: 'Foo' })
  assert.deepEqual(matchSymbol('export default abstract class Bar', 'tsjs'), { kind: 'class', name: 'Bar' })
  assert.deepEqual(matchSymbol('export interface Cfg {', 'tsjs'), { kind: 'interface', name: 'Cfg' })
  assert.deepEqual(matchSymbol('export type X = string', 'tsjs'), { kind: 'type', name: 'X' })
  assert.deepEqual(matchSymbol('const enum E {', 'tsjs'), { kind: 'enum', name: 'E' })
  assert.deepEqual(matchSymbol('export async function run() {', 'tsjs'), { kind: 'function', name: 'run' })
  assert.deepEqual(matchSymbol('function* gen() {', 'tsjs'), { kind: 'function', name: 'gen' })
  assert.deepEqual(matchSymbol('export const CONFIG = z.object({', 'tsjs'), { kind: 'const', name: 'CONFIG' })
  assert.deepEqual(matchSymbol('  async execute(args) {', 'tsjs'), { kind: 'method', name: 'execute' })
})

test('matchSymbol: Python / Rust / Go 形态', () => {
  assert.deepEqual(matchSymbol('async def handle(self):', 'python'), { kind: 'def', name: 'handle' })
  assert.deepEqual(matchSymbol('class Store:', 'python'), { kind: 'class', name: 'Store' })
  assert.deepEqual(matchSymbol('pub async fn run(&self) {', 'rust'), { kind: 'function', name: 'run' })
  assert.deepEqual(matchSymbol('pub struct Foo {', 'rust'), { kind: 'struct', name: 'Foo' })
  assert.deepEqual(matchSymbol('impl Display for Foo {', 'rust'), { kind: 'impl', name: 'Foo' })
  assert.deepEqual(matchSymbol('func (s *Svc) Run() error {', 'go'), { kind: 'function', name: 'Run' })
  assert.deepEqual(matchSymbol('type Room struct {', 'go'), { kind: 'type', name: 'Room' })
})

test('matchSymbol: Markdown 标题取标题文本（组 2），井号数不限', () => {
  assert.deepEqual(matchSymbol('## 二 · 契约', 'markdown'), { kind: 'section', name: '二 · 契约' })
  assert.deepEqual(matchSymbol('# 标题', 'markdown'), { kind: 'section', name: '标题' })
  assert.equal(matchSymbol('正文不是标题', 'markdown'), null)
})

/* ── 退化路径（近似法的诚实边界） ── */

test('matchSymbol: 注释行不认（行首 // / * / -- / Python #）', () => {
  assert.equal(matchSymbol('// function commented() {', 'tsjs'), null)
  assert.equal(matchSymbol(' * export class Ghost {', 'tsjs'), null)
  assert.equal(matchSymbol('/* class Blocked {', 'tsjs'), null)
  assert.equal(matchSymbol('-- select 1', 'tsjs'), null)
  assert.equal(matchSymbol('# def commented():', 'python'), null)
  assert.notEqual(matchSymbol('# 标题', 'markdown'), null, 'Markdown 的 # 是标题不是注释')
})

test('matchSymbol: 控制流关键字不误认为方法（黑名单生效）', () => {
  for (const kw of ['if', 'for', 'while', 'switch', 'catch', 'return', 'await', 'new', 'typeof']) {
    assert.equal(matchSymbol(`  ${kw} (x) {`, 'tsjs'), null, `${kw} 不应被认成方法`)
  }
  assert.notEqual(matchSymbol('  realMethod (x) {', 'tsjs'), null, '普通方法仍要认出来')
})

test('matchSymbol: 未知族/空行/纯缩进 → null（不猜）', () => {
  assert.equal(matchSymbol('function foo() {', 'unknown'), null)
  assert.equal(matchSymbol('', 'tsjs'), null)
  assert.equal(matchSymbol('   ', 'tsjs'), null)
  assert.equal(matchSymbol('const', 'tsjs'), null, '缺名字的定义不认')
})

test('matchSymbol: 形态约束①——函数内局部 const 不收（只收顶格模块级）', () => {
  assert.notEqual(matchSymbol('const Config = z.object({', 'tsjs'), null, '顶格 const = 模块级定义')
  assert.notEqual(matchSymbol('export const CONFIG = 1', 'tsjs'), null)
  assert.equal(matchSymbol('  const dir = lifeCoreDir()', 'tsjs'), null, '缩进 2 的局部 const 不收（实测噪音源）')
  assert.equal(matchSymbol('\tconst x = 1', 'tsjs'), null, 'Tab 缩进（折 4 空格）同样不收')
})

test('matchSymbol: 形态约束②——缩进的方法调用不收，只收以 { 收尾的方法定义', () => {
  assert.equal(matchSymbol('  mkdirSync(dir, { recursive: true })', 'tsjs'), null, '调用以 ) 收尾 → 不收')
  assert.equal(matchSymbol('  saveState(state)', 'tsjs'), null)
  assert.notEqual(matchSymbol('  async execute(args) {', 'tsjs'), null, '方法定义以 { 收尾 → 收')
})

/* ── 抽取与上限 ── */

test('extractSymbols: 逐行抽取，行号 1-based，一行只认一个定义', () => {
  const lines = [
    "import { a } from './a.js'",
    'export class Foo {',
    '  bar() {',
    '    return 1',
    '  }',
    '}',
    'export const X = 1',
  ]
  const { symbols, truncated } = extractSymbols(lines, 'ts')
  assert.deepEqual(symbols.map((s) => [s.kind, s.name, s.lineNo]), [
    ['class', 'Foo', 2],
    ['method', 'bar', 3],
    ['const', 'X', 7],
  ])
  assert.equal(truncated, false)
})

test('extractSymbols: 上限截断必须如实返回 truncated=true（诚实标注）', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `export function f${i}() {`)
  const { symbols, truncated } = extractSymbols(lines, 'ts', 3)
  assert.equal(symbols.length, 3)
  assert.equal(truncated, true, '触顶必须披露')
  const exact = extractSymbols(lines.slice(0, 3), 'ts', 3)
  assert.equal(exact.truncated, false, '刚好用满上限不算截断')
})

test('extractSymbols: 未知扩展名 → 零符号（不是报错）', () => {
  const { symbols, truncated } = extractSymbols(['function foo() {'], 'txt')
  assert.deepEqual(symbols, [])
  assert.equal(truncated, false)
})

test('extractSymbols: sig 截断到 160 字符且 trim 过（不把整行灌进输出）', () => {
  const long = 'export function ' + 'a'.repeat(400) + '() {'
  const { symbols } = extractSymbols([long], 'ts')
  assert.equal(symbols.length, 1)
  assert.ok((symbols[0].sig ?? '').length <= 160)
  assert.equal(symbols[0].sig, symbols[0].sig.trim())
})
