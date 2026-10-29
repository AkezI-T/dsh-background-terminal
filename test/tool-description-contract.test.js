/**
 * 工具说明契约冷测试（lib/index.js 注册出去的 description 文本）。
 *
 * 为什么值得单测：模型能看到的只有 description。说明里没写清的语义
 * （truncated / lossy / nextCursor / SIGINT 的中断语义 / 外部验证看不见）就等于没有——
 * 调用方只能靠猜，这正是本 P0 要收口的那类缺陷。
 *
 * 做法：用最小假 ctx 调 apply()，捕获 ctx.tools.register 收到的**定义对象**，
 * 直接断言注册出去的 description 文本。比 grep lib/index.js 源文本强：源文本断言
 * 会被注释、别处的字符串、以及"注册代码根本没接线"骗过。
 *
 * 断言局限（别把这条测试当行为验证）：
 *   1. 只证明**注册的说明文本**符合契约，不证明运行时行为与说明相符
 *      （说明可以撒谎：例如 nextCursor 实际不是绝对位置，本测试看不出来）；
 *   2. 不证明活体宿主里模型看到的就是这份文本（ESM 缓存 / 宿主未重启）；
 *   3. 语义断言的口径是"含该关键字的那些行（bullet）里出现该语义"，与本仓库既有风格
 *      （description 数组按行 join）一致；若实现把一条 bullet 折成多行会误报失败，
 *      按失败信息调整措辞即可，不必改断言方向。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../lib/index.js'

const SHELL = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'

/**
 * 只挂载、不派生：任何真实 IO 入口都直接抛错，保证本文件全冷。
 * 配置形态与 test/index.test.js 的 mountPlugin 一致（显式 host 后端，不碰真 PTY）。
 */
function mountToolDefinitions() {
  const tools = new Map()
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    subprocess: {
      spawnTerminal() {
        throw new Error('本文件只读工具说明，不得派生 PTY')
      },
    },
    sandboxPolicy: {
      defaultMode: 'workspace-write',
      resolve: () => ({ mode: 'workspace-write', workspaceRoot: 'F:/ws' }),
    },
    sessionProjections: { stateOf: () => 'workspace-write' },
    jobs: {
      start() {
        throw new Error('本文件只读工具说明，不得注册 job')
      },
    },
    get: () => undefined,
  }

  const runtime = apply(ctx, { shellPath: SHELL, shellDialect: 'pwsh', ptyBackend: 'host' })
  // 挂载会起一个 unref 的清扫定时器；测试里不需要它，显式关掉。
  runtime.shutdown()
  return tools
}

const TOOLS = mountToolDefinitions()

/** 取注册出去的说明文本；工具没注册就直接失败，而不是让断言在 undefined 上打滑。 */
function descriptionOf(name) {
  const definition = TOOLS.get(name)
  assert.ok(definition, `工具 ${name} 未注册`)
  assert.equal(typeof definition.description, 'string', `${name}.description 必须是字符串`)
  assert.notEqual(definition.description.trim(), '', `${name}.description 不得为空`)
  return definition.description
}

/** 说明里含 token 的那些行（同一条 bullet；说明是 description 数组按行 join 出来的）。 */
function bulletsOf(text, token) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.includes(token))
    .join('\n')
}

/**
 * 断言 token 所在 bullet 解释了要求的语义。
 * @param {string} text 说明全文
 * @param {string} token 关键字（必须出现）
 * @param {RegExp[]} patterns 命中任一即通过——只收真能表达该语义的措辞，不做无条件放宽
 * @param {string} meaning 该语义的人话描述（失败信息里带上）
 */
function assertSemantic(text, token, patterns, meaning) {
  const bullet = bulletsOf(text, token)
  assert.notEqual(bullet, '', `说明必须出现 ${token}（要解释：${meaning}）`)
  assert.ok(
    patterns.some((pattern) => pattern.test(bullet)),
    `${token} 的说明必须解释「${meaning}」；实际那一行是：${bullet}`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 守卫：断言打在真文本上
// ─────────────────────────────────────────────────────────────────────────────

test('D1 两个工具的说明都注册到了、非空且互不相同（防止断言打在空串/串台的文本上）', () => {
  const read = descriptionOf('terminal_read')
  const signal = descriptionOf('terminal_signal')
  assert.notEqual(read, signal, '两个工具的说明不得是同一份文本（串台会让后面的断言失去意义）')
  assert.match(read, /read/i, 'terminal_read 的说明应当是在讲"读"')
  assert.match(signal, /signal/i, 'terminal_signal 的说明应当是在讲"信号"')
})

// ─────────────────────────────────────────────────────────────────────────────
// terminal_read：truncated / lossy / nextCursor
// ─────────────────────────────────────────────────────────────────────────────

test('D2 terminal_read 说明解释 truncated：本次读取被上限截断、后面还有内容', () => {
  assertSemantic(
    descriptionOf('terminal_read'),
    'truncated',
    [
      /truncat\w*[^.]{0,160}(cap|limit|maxoutputchars|more|remain|incomplete|partial)/i,
      /(cap|limit|maxoutputchars|more output|remain|incomplete|partial)[^.]{0,160}truncat/i,
    ],
    'truncated = 本次读取被上限（maxOutputChars / readCount）截断，还有未读内容——不是"没有输出了"',
  )
})

test('D3 terminal_read 说明解释 lossy：输出在读到之前已被环缓冲覆盖', () => {
  assertSemantic(
    descriptionOf('terminal_read'),
    'lossy',
    [
      /lossy[^.]{0,160}(overwrit|lost|drop|discard|evict|gap)/i,
      /(overwrit|lost|drop|discard|evict)[^.]{0,160}lossy/i,
    ],
    'lossy = 输出在读之前已被环缓冲覆盖（数据丢了），gapBefore 标出缺口起点',
  )
})

test('D4 terminal_read 说明解释 nextCursor 是绝对位置，且不得与输出总量相减（本 P0 重点）', () => {
  const text = descriptionOf('terminal_read')

  assertSemantic(
    text,
    'nextCursor',
    [
      /nextcursor[^.]{0,160}absolute/i,
      /absolute[^.]{0,160}nextcursor/i,
      /nextcursor[^.]{0,160}(not a (per-read )?(count|relative)|not relative)/i,
    ],
    'nextCursor 是绝对位置/绝对游标，不是本次读取的字节数',
  )

  // 光说"绝对"不够：调用方最容易犯的错就是拿它去和输出总量相减，
  // 所以说明必须显式禁止这个动作。
  const bullet = bulletsOf(text, 'nextCursor')
  assert.ok(
    [
      /(never|avoid|do not|don't|must not|should not|cannot|can't|is wrong|would be wrong|no need to)[^.]{0,100}(subtract|minus|deduct)/i,
      /(subtract|minus|deduct)\w*[^.]{0,100}(is wrong|would be wrong|incorrect|misleading)/i,
    ].some((pattern) => pattern.test(bullet)),
    `nextCursor 的说明必须明确禁止"与输出总量相减"；实际那一行是：${bullet}`,
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// terminal_signal：SIGINT 语义 + 外部验证的视野边界
// ─────────────────────────────────────────────────────────────────────────────

test('D5 terminal_signal 说明解释 SIGINT 的中断语义：打断前台命令、shell 本体存活', () => {
  assertSemantic(
    descriptionOf('terminal_signal'),
    'SIGINT',
    [
      /sigint[^.]{0,160}interrupt/i,
      /interrupt\w*[^.]{0,160}sigint/i,
      /sigint[^.]{0,160}(foreground command|foreground process)/i,
    ],
    'SIGINT 打断前台命令/前台进程组，而 shell 会话本身存活可续用',
  )
})

test('D6 terminal_signal 说明声明「外部验证不在插件视野」（进程树/端口不在观测范围内）', () => {
  const text = descriptionOf('terminal_signal')

  // 措辞不冻结，只收真正表达了"看不到外部"的几种说法。
  const patterns = [
    /(outside|beyond)[^.]{0,40}(the )?plugin'?s?[^.]{0,40}(view|visibility|scope|reach|sight)/i,
    /(not|isn'?t|never|no)[^.]{0,40}(in|within)[^.]{0,20}plugin'?s?[^.]{0,30}(view|visibility|scope|reach|sight)/i,
    /plugin[^.]{0,60}(cannot|can'?t|does not|doesn'?t|never|has no)[^.]{0,40}(observe|see|verify|confirm|know|inspect|watch)/i,
    /(process tree|ports?|listening|external (side|state|verification))[^.]{0,160}(not|never|cannot|can'?t|beyond|outside|invisible|unobservable|out of)/i,
    /(invisible|unobservable|out of (the )?(plugin'?s )?(view|sight|reach))/i,
  ]
  assert.ok(
    patterns.some((pattern) => pattern.test(text)),
    `terminal_signal 的说明必须声明外部验证不在此插件的视野内（进程树/端口它看不到）；\n实际说明是：\n${text}`,
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// P1-READ-1：peekTail / outputFinal / unreadBytes 的说明面
// ─────────────────────────────────────────────────────────────────────────────

test('D7 terminal_read 的 schema 暴露 peekTail（字符数，number）', () => {
  // 局限：只证明这个入参**注册出去了**，不证明它的运行时行为与说明一致。
  const definition = TOOLS.get('terminal_read')
  assert.ok(definition, 'terminal_read 未注册')
  const peekTail = definition.parameters?.properties?.peekTail
  assert.ok(peekTail, 'terminal_read 必须暴露 peekTail 入参（P1-READ-1）')
  assert.equal(peekTail.type, 'number', 'peekTail 是字符数，类型必须是 number')
})

test('D8 terminal_read 说明出现 peekTail / outputFinal / unreadBytes，且解释 outputFinal 的含义', () => {
  const text = descriptionOf('terminal_read')
  for (const token of ['peekTail', 'outputFinal', 'unreadBytes']) {
    assert.ok(text.includes(token), `terminal_read 的说明必须出现 ${token}`)
  }

  assertSemantic(
    text,
    'outputFinal',
    [
      /outputfinal[^.]{0,200}(true|false)[^.]{0,160}(settle|end|drain|no more|final|complete|finish)/i,
      /outputfinal[^.]{0,200}(settle|end|drain|no more|final|complete|finish)[^.]{0,160}(true|false)/i,
      /outputfinal[^.]{0,200}means/i,
    ],
    'outputFinal 的含义：流是否已终结、还会不会有新字节（只有 true 才能声称读全）',
  )
})

test('D9 terminal_read 说明解释 peekTail：只读快照、不推进游标，且忽略 waitMs', () => {
  const text = descriptionOf('terminal_read')
  assert.ok(text.includes('peekTail'), '说明必须出现 peekTail')

  // 作用域 = 所有提到 peekTail 的 bullet（说明是数组按行 join）。同一条 bullet 内允许跨句：
  // "先说只读快照、后说忽略 waitMs"是自然写法，用句号边界卡会误判（本测试第一版就这么误判过）。
  const window = bulletsOf(text, 'peekTail')
  assert.ok(
    [
      /peektail[\s\S]{0,300}?(does not|doesn'?t|never|without|no)[\s\S]{0,80}?(advance|move|consum)/i,
      /peektail[\s\S]{0,300}?(cursor|read cursor)[\s\S]{0,100}?(untouched|unchanged|unaffected|not advanced|stays?|remains?)/i,
      /peektail[\s\S]{0,300}?(snapshot|copy)[\s\S]{0,120}?(without|not|never)[\s\S]{0,60}?(consum|advanc)/i,
      /(cursor|read cursor)[\s\S]{0,120}?(untouched|unchanged|unaffected|not advanced)[\s\S]{0,300}?peektail/i,
    ].some((pattern) => pattern.test(window)),
    `peekTail 必须被说明为"只读快照、绝不推进增量游标"；实际是：\n${window}`,
  )

  assert.ok(
    [
      /(ignores?|ignoring|ignored)[^.;]{0,60}?waitms/i,
      /waitms[^.;]{0,80}?(ignored|is not used|does not apply|no effect|not used|never waits?)/i,
      /(never waits?|does not wait|no wait)[^.;]{0,60}?/i,
    ].some((pattern) => pattern.test(window)),
    `peekTail 必须被说明为忽略 waitMs；实际是：\n${window}`,
  )
})

test('D10 terminal_read 说明把 unreadBytes 说成剩余量的唯一正确来源，并禁止去减 outputBytes 与 nextCursor', () => {
  const text = descriptionOf('terminal_read')
  // 作用域同 D9：所有提到 unreadBytes 的 bullet，允许同一条 bullet 内跨句。
  const window = bulletsOf(text, 'unreadBytes')
  assert.notEqual(window, '', '说明必须出现 unreadBytes')

  assert.ok(
    [
      // 契约要的是"剩余量到 unreadBytes 去读"，不要求字面上出现 only/unique——
      // 强求字面措辞是自造约束（本测试第一版就这么误判过 1510 行）。
      /unreadbytes[\s\S]{0,240}?(only|sole|single|authoritative|correct|right|reliable)[\s\S]{0,100}?(source|way|place|number|answer)/i,
      /unreadbytes[\s\S]{0,200}?to (learn|know|tell|see|find|read)[\s\S]{0,80}?(what|how much|remain|left|unread)/i,
    ].some((pattern) => pattern.test(window)),
    `unreadBytes 必须被说明为"还剩多少"的正确来源；实际是：\n${window}`,
  )

  // ST-03 的坑正在这里：拿 outputBytes 减 nextCursor 去估剩余量。说明必须点名这两个字段。
  assert.ok(
    window.includes('outputBytes') && window.includes('nextCursor'),
    `unreadBytes 的说明必须点名 outputBytes 与 nextCursor（别去减它们）；实际是：\n${window}`,
  )
  assert.ok(
    [
      /(do not|don'?t|never|instead of|rather than|not)[\s\S]{0,120}?(subtract|minus|deduct|difference)/i,
      /(subtract|minus|deduct)\w*[\s\S]{0,120}?(is wrong|would be wrong|incorrect|misleading|not)/i,
    ].some((pattern) => pattern.test(window)),
    `unreadBytes 的说明必须明确禁止"用 outputBytes 减 nextCursor"；实际是：\n${window}`,
  )
})
