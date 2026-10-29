/**
 * 日志模块的冷测试。
 *
 * 为什么值得单独测：日志代码跑在**失败路径**上，它自己抛错会把真正的故障掩盖掉。
 * 这里锁住三件事：级别过滤、永不抛、以及 describe 对循环引用/Error 的稳健性。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LEVELS, createLog, describe as describeValue } from '../lib/log.mjs'

/** 收集日志行的假 logger。 */
function collector() {
  const lines = []
  const make = (level) => (line) => lines.push({ level, line })
  return {
    lines,
    logger: { error: make('error'), warn: make('warn'), info: make('info'), debug: make('debug') },
    text: () => lines.map((entry) => entry.line).join('\n'),
  }
}

test('L1 级别过滤：选中级别及以下才输出', () => {
  const cases = [
    ['silent', []],
    ['error', ['error']],
    ['warn', ['error', 'warn']],
    ['info', ['error', 'warn', 'info']],
    ['debug', ['error', 'warn', 'info', 'debug']],
  ]
  for (const [level, expected] of cases) {
    const sink = collector()
    const log = createLog(sink.logger, level)
    log.error('e')
    log.warn('w')
    log.info('i')
    log.debug('d')
    assert.deepEqual(
      sink.lines.map((entry) => entry.level),
      expected,
      `level=${level} 的过滤结果不符`,
    )
  }
})

test('L2 非法级别退回 info，不抛', () => {
  const sink = collector()
  const log = createLog(sink.logger, 'verbose-please')
  assert.equal(log.level, 'info')
  log.info('ok')
  assert.equal(sink.lines.length, 1)
})

test('L3 每一行都带插件前缀与级别标签', () => {
  const sink = collector()
  const log = createLog(sink.logger, 'debug')
  log.info('mounted', { shellDialect: 'pwsh' })
  assert.match(sink.text(), /^\[background-terminal\] \[info\] mounted/)
  assert.match(sink.text(), /shellDialect: "pwsh"/)
})

test('L4 结构化的值被渲染成可读文本', () => {
  const log = createLog(collector().logger, 'debug')
  assert.equal(log.describe(undefined), 'undefined')
  assert.equal(log.describe(null), 'null')
  assert.equal(log.describe('x'), '"x"')
  assert.equal(log.describe(3), '3')
  assert.equal(log.describe(new Error('boom')), 'Error: boom')
  assert.equal(log.describe(['a', 'b']), '["a", "b"]')
  assert.match(log.describe({ a: 1, b: 'x' }), /a: 1/)
})

test('L5 describe 在循环引用与自引用对象上不抛', () => {
  const loop = { name: 'loop' }
  loop.self = loop
  const rendered = describeValue(loop)
  assert.match(rendered, /name: "loop"/)
  // 不做完整 JSON 序列化，所以不会因循环引用抛 TypedError
  assert.ok(rendered.length < 500, '渲染结果不得爆炸式增长')
})

test('L6 取属性的 getter 抛错时也不影响其它字段渲染', () => {
  const hostile = {
    get boom() {
      throw new Error('getter exploded')
    },
    fine: 1,
  }
  const rendered = describeValue(hostile)
  assert.match(rendered, /fine: 1/)
  assert.match(rendered, /读取失败/)
})

test('L7 logger 抛错或缺失时日志器自己绝不抛', () => {
  const hostileLogger = {
    info() {
      throw new Error('logger is broken')
    },
    warn() {
      throw new Error('logger is broken')
    },
    error() {
      throw new Error('logger is broken')
    },
    debug() {
      throw new Error('logger is broken')
    },
  }
  const log = createLog(hostileLogger, 'debug')
  assert.doesNotThrow(() => {
    log.error('a')
    log.warn('b')
    log.info('c')
    log.debug('d')
  })

  const noLogger = createLog(undefined, 'info')
  assert.doesNotThrow(() => noLogger.info('no logger at all'))
})

test('L8 LEVELS 是唯一事实来源，顺序即级别高低', () => {
  assert.deepEqual([...LEVELS], ['silent', 'error', 'warn', 'info', 'debug'])
})

/**
 * 对象图自身键的快照（按路径记录），用于断言 describe 对入参零副作用。
 * WeakSet 防环；只读键与值，不写任何东西。
 */
function ownKeySnapshot(value, path = '$', out = {}, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return out
  if (seen.has(value)) return out
  seen.add(value)
  out[path] = Object.getOwnPropertyNames(value).sort()
  for (const key of Object.keys(value)) {
    ownKeySnapshot(value[key], `${path}.${key}`, out, seen)
  }
  return out
}

test('L9 describe 渲染循环引用后，任何层级都不得留下内部标记', () => {
  // 循环判定曾经靠在被渲染对象上写 `__bgtermCircular`，返回前只删顶层：
  // 嵌套层级（这里的 leaf）会把内部记账字段泄漏给调用方。
  const leaf = { name: 'leaf' }
  leaf.self = leaf
  const root = { a: { b: leaf }, other: 1 }
  const loop = { name: 'loop' }
  loop.self = loop

  const before = ownKeySnapshot({ root, loop })

  assert.doesNotThrow(() => describeValue(root))
  const renderedRoot = describeValue(root)
  const renderedLoop = describeValue(loop)

  assert.match(renderedRoot, /name: "leaf"/)
  assert.match(renderedRoot, /\[Circular\]/)
  assert.match(renderedLoop, /\[Circular\]/)
  // 键集合前后一致：只清理顶层、或完全不清理，都会在这里变红
  assert.deepEqual(ownKeySnapshot({ root, loop }), before, 'describe 不得修改入参对象图')
  assert.equal(
    Object.prototype.hasOwnProperty.call(leaf, '__bgtermCircular'),
    false,
    '嵌套对象上不得残留循环引用标记',
  )
})

test('L10 同一对象出现在两个分支（有向无环图）各渲染一次，不得判成循环', () => {
  const shared = { name: 'shared' }
  const root = { left: shared, right: shared }
  const before = ownKeySnapshot(root)

  const rendered = describeValue(root)

  assert.equal((rendered.match(/"shared"/g) ?? []).length, 2, '两个分支必须各渲染一次')
  assert.doesNotMatch(rendered, /\[Circular\]/, '共享（非祖先）对象不是循环')
  assert.deepEqual(ownKeySnapshot(root), before, 'describe 不得修改入参对象图')
})
