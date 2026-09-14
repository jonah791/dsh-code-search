/**
 * 进程调用契约守卫（回归测试 · 尸体测试）。
 *
 * 不变量：**用户输入只能进 argv 数组，绝不拼进 shell 字符串**。
 * 本插件把 `pattern`/`term`/`path`/`include`/`exclude` 直接传给 rg——
 * 只要坚持 `execFile(bin, argvArray)`（不经 shell），这些字符串就不具备命令语义。
 * 一旦有人改成 `exec()` / `shell: true` / `execSync()`，注入面立刻打开。
 *
 * 守卫自带尸体样本（见「尸体测试」）——证明扫描器在坏源码上确实会报错，不是摆设。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'src')

/** 禁止的进程调用形态（会引入 shell 解析 = 命令注入面） */
const FORBIDDEN = [
  { name: 'shell:true', re: /shell\s*:\s*true/ },
  { name: 'exec(', re: /\bexec\s*\(/ },
  { name: 'execSync(', re: /\bexecSync\s*\(/ },
  { name: 'execFileSync(', re: /\bexecFileSync\s*\(/ },
  { name: 'spawnSync(', re: /\bspawnSync\s*\(/ },
  { name: 'spawn(', re: /\bspawn\s*\(/ },
]

/** 纯扫描器：输入 `{文件名: 源码}`，输出违规行清单（无 IO，便于尸体测试复用） */
function scanSources(sources) {
  const offenders = []
  for (const [file, src] of Object.entries(sources)) {
    src.split('\n').forEach((line, i) => {
      const t = line.trim()
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
      for (const { name, re } of FORBIDDEN) {
        if (re.test(line)) offenders.push(`${file}:${i + 1}: [${name}] ${t}`)
      }
    })
  }
  return offenders
}

function readSources() {
  const out = {}
  for (const f of readdirSync(srcDir)) {
    if (f.endsWith('.ts')) out[f] = readFileSync(join(srcDir, f), 'utf8')
  }
  return out
}

/* ── 尸体测试：证明扫描器有牙齿 ── */

test('尸体测试：扫描器在坏样本上确实报错（shell:true / exec( / spawnSync）', () => {
  const bad = {
    'a.ts': "execFile('rg', args, { shell: true })",
    'b.ts': "exec('rg --regexp ' + userInput, cb)",
    'c.ts': "spawnSync('powershell', ['-c', x])",
  }
  const offenders = scanSources(bad)
  assert.equal(offenders.length, 3, '三种坏形态都必须被抓到')
  assert.match(offenders[0], /\[shell:true\]/)
  assert.match(offenders[1], /\[exec\(\]/)
  assert.match(offenders[2], /\[spawnSync\(\]/)
})

test('尸体测试：扫描器对合法 execFile 形态不误报（排除假阳性）', () => {
  assert.deepEqual(scanSources({ 'ok.ts': "execFile('rg', argv, { maxBuffer: 1024, windowsHide: true })" }), [])
  assert.deepEqual(scanSources({ 'comment.ts': '// exec( 仅出现在注释里' }), [], '注释行不算违规')
})

/* ── 真实源码守卫 ── */

test('真实源码：不得出现 shell 解析形态（exec/spawn/shell:true）', () => {
  const offenders = scanSources(readSources())
  assert.deepEqual(offenders, [], `用户输入可能经 shell 解析（命令注入面）：\n${offenders.join('\n')}`)
})

test('前提守卫：本插件确实在调 execFile（否则本契约不适用）', () => {
  const sources = readSources()
  assert.ok(
    Object.values(sources).some((s) => /\bexecFile\s*\(/.test(s)),
    'src/ 内必须存在 execFile 调用——否则本守卫测的不是真实调用面',
  )
})

test('真实源码：进程调用只发生在 index.ts（rg.ts 保持纯逻辑、无进程调用）', () => {
  const rg = readFileSync(join(srcDir, 'rg.ts'), 'utf8')
  assert.ok(!/child_process/.test(rg), 'rg.ts 不得引入 child_process——它必须是可离线单测的纯模块')
})

test('结构守卫：rg 调用的参数是 argv 数组而非拼接字符串', () => {
  const idx = readFileSync(join(srcDir, 'index.ts'), 'utf8')
  // 真实形态：execFile(rgPath, args, {...}) —— 第二个参数必须是数组变量，不是字符串拼接
  assert.match(idx, /execFile\(\s*rgPath\s*,\s*args\s*,/, 'execFile 第二参必须是 argv 数组变量')
  assert.ok(!/execFile\([^)]*\+/.test(idx), 'execFile 参数不得出现字符串拼接')
})
