/**
 * pump / reader 的字节级冷测试。
 *
 * 全部用 Buffer 构造输入，重点是"序列被 chunk 边界切开"的两类：ANSI 控制序列与多字节 UTF-8。
 * 覆盖 FINAL.md §9 的 IO1 / IO4 / IO5 与 PLAN.md 的 B1 / B3 / B6 字节级断言。
 * 不创建真实进程、不碰文件系统、不联网。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createPump, GAP_NOTICE, DEFAULT_MAX_BUFFER_BYTES } from '../lib/pump.mjs'
import { createCursor, read } from '../lib/reader.mjs'

const FFFD = '\uFFFD'

/** text 中 needle 出现的次数。 */
function countOf(text, needle) {
  return text.split(needle).length - 1
}

// ─────────────────────────────────────────────────────────────────────────────
// IO1：顺序与不重复投喂
// ─────────────────────────────────────────────────────────────────────────────

test('IO1-1 多次 appendRaw 后 consume 顺序与输入一致，两次 consume 不重复投喂', () => {
  const pump = createPump()
  pump.appendRaw('a')
  pump.appendRaw(Buffer.from('bc'))
  pump.appendRaw(Buffer.from('中'))

  const cursor = createCursor()
  const first = read(pump, cursor, { budgetChars: 3 })
  assert.equal(first.text, 'abc')
  assert.equal(first.nextOffset, 3)
  assert.equal(first.consumedBytes, 3)
  assert.equal(first.lossy, false)
  assert.equal(first.gapBefore, undefined)
  assert.equal(first.truncated, true)

  const second = read(pump, cursor, { budgetChars: 16 })
  assert.equal(second.text, '中')
  assert.equal(second.nextOffset, 6)
  assert.equal(second.consumedBytes, 3)
  assert.equal(second.truncated, false)
  assert.equal(pump.totalBytes(), 6)

  const third = read(pump, cursor, { budgetChars: 16 })
  assert.equal(third.text, '')
  assert.equal(third.nextOffset, 6)
  assert.equal(third.consumedBytes, 0)
  assert.equal(third.lossy, false)
})

// ─────────────────────────────────────────────────────────────────────────────
// IO4：ANSI / UTF-8 跨 chunk
// ─────────────────────────────────────────────────────────────────────────────

test('IO4-1 ANSI 跨 chunk：半截 CSI 不输出，total 不含未闭合部分', () => {
  const pump = createPump()
  pump.appendRaw(Buffer.from('A\x1b['))
  assert.equal(pump.totalBytes(), 1) // 未闭合 CSI 不写 ring、不推进 total
  assert.equal(read(pump, createCursor(), { budgetChars: 16 }).text, 'A')

  pump.appendRaw(Buffer.from('31mB'))
  assert.equal(pump.totalBytes(), 2)
  const done = read(pump, createCursor(), { budgetChars: 16 })
  assert.equal(done.text, 'AB')
  assert.equal(done.consumedBytes, 2)
})

test('IO4-1b 逐字节 / 任意切点喂入混合序列，输出恒等于整体剥离结果', () => {
  const input = Buffer.from('A\x1b[31mB\x1b]0;title\x07C\x1b[0mD\x1b(0E\x1bPq\x1b\\F')
  const expected = 'ABCDEF'

  for (let cut = 0; cut <= input.length; cut += 1) {
    const pump = createPump()
    pump.appendRaw(input.subarray(0, cut))
    pump.appendRaw(input.subarray(cut))
    assert.equal(read(pump, createCursor(), { budgetChars: 64 }).text, expected, `2 段切点 cut=${cut}`)
  }

  const byByte = createPump()
  for (const b of input) byByte.appendRaw(Buffer.from([b]))
  assert.equal(read(byByte, createCursor(), { budgetChars: 64 }).text, expected)
  assert.equal(byByte.totalBytes(), expected.length)
})

test('IO4-2 UTF-8 跨 chunk：中 的 3 字节切成 2+1 不产生乱码，非 final 不提前吐 replacement', () => {
  const pump = createPump()
  const cursor = createCursor()
  pump.appendRaw(Buffer.from([0xE4, 0xB8]))
  assert.equal(pump.totalBytes(), 2) // 原始字节（含未完整尾部）已进 ring

  const before = read(pump, cursor, { budgetChars: 16 })
  assert.equal(before.text, '')
  assert.equal(before.consumedBytes, 0)
  assert.equal(before.nextOffset, 0)
  assert.equal(before.truncated, false)

  pump.appendRaw(Buffer.from([0xAD]))
  const after = read(pump, cursor, { budgetChars: 16 })
  assert.equal(after.text, '中')
  assert.equal(after.consumedBytes, 3)
  assert.equal(after.nextOffset, 3)

  // 1+2 切法同样完整
  const split12 = createPump()
  split12.appendRaw(Buffer.from([0xE4]))
  assert.equal(read(split12, createCursor(), { budgetChars: 16 }).text, '')
  split12.appendRaw(Buffer.from([0xB8, 0xAD]))
  assert.equal(read(split12, createCursor(), { budgetChars: 16 }).text, '中')

  // 四字节字符 4 个切点都完整
  const emoji = Buffer.from('🙂')
  for (let cut = 1; cut < emoji.length; cut += 1) {
    const p = createPump()
    const c = createCursor()
    p.appendRaw(emoji.subarray(0, cut))
    assert.equal(read(p, c, { budgetChars: 16 }).text, '', `cut=${cut}`)
    p.appendRaw(emoji.subarray(cut))
    assert.equal(read(p, c, { budgetChars: 16 }).text, '🙂', `cut=${cut}`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// B1：残缺前缀只替换一次
// ─────────────────────────────────────────────────────────────────────────────

test('B1-1 只输出残缺前缀 0xEF 0xBF 后 final：U+FFFD 恰好一次，二次 consume 不再出现', async () => {
  const pump = createPump()
  const cursor = createCursor()
  pump.appendRaw(Buffer.from([0xEF, 0xBF]))

  const before = read(pump, cursor, { budgetChars: 64 })
  assert.equal(countOf(before.text, FFFD), 0)
  assert.equal(before.nextOffset, 0)

  await pump.flush()

  const first = read(pump, cursor, { budgetChars: 64, final: true })
  assert.equal(first.text, FFFD)
  assert.equal(countOf(first.text, FFFD), 1)
  assert.equal(first.consumedBytes, 2)
  assert.equal(first.nextOffset, 2)

  const second = read(pump, cursor, { budgetChars: 64, final: true })
  assert.equal(second.text, '')
  assert.equal(countOf(second.text, FFFD), 0)
  assert.equal(second.nextOffset, 2)

  // 从 0 重读（例如新游标）也不重复产出替换字符
  const replay = read(pump, createCursor(), { budgetChars: 64, final: true })
  assert.equal(countOf(replay.text, FFFD), 0)
})

test('B1-2 完整 UTF-8 流在 final 下不产出任何替换字符', async () => {
  const pump = createPump()
  pump.appendRaw('中文')
  await pump.flush()
  const result = read(pump, createCursor(), { budgetChars: 64, final: true })
  assert.equal(result.text, '中文')
  assert.equal(countOf(result.text, FFFD), 0)
})

test('B1-3 非 final 永远不替换可补全的残缺尾部，补全后原样读出', () => {
  const pump = createPump()
  const cursor = createCursor()
  for (const b of [0xE4, 0xB8, 0xAD]) {
    pump.appendRaw(Buffer.from([b]))
    const r = read(pump, cursor, { budgetChars: 64 })
    if (b !== 0xAD) {
      assert.equal(r.text, '')
      assert.equal(countOf(r.text, FFFD), 0)
    } else {
      assert.equal(r.text, '中')
    }
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// IO5 / B3 / B6：ring 覆盖、字符边界截断
// ─────────────────────────────────────────────────────────────────────────────

test('IO5-1 ring 覆盖后 read：lossy + gapBefore，budget 不切半字符', () => {
  const pump = createPump({ maxBufferBytes: 8 })
  assert.equal(pump.appendRaw('abcdefgh').lostBytes, 0)
  const second = pump.appendRaw('中') // 3 字节挤掉最旧的 3 字节
  assert.equal(second.lostBytes, 3)
  assert.equal(pump.totalBytes(), 11)

  const cursor = createCursor()
  const first = read(pump, cursor, { budgetChars: 5 })
  assert.equal(first.lossy, true)
  assert.equal(first.gapBefore, 3)
  assert.equal(first.text, `${GAP_NOTICE}defgh`)
  assert.equal(first.consumedBytes, 5)
  assert.equal(first.nextOffset, 8)
  assert.equal(first.truncated, true)

  // budget 用尽处正好是一个 3 字节字符之前：剩下的字节留在 ring，下次完整读出
  const rest = read(pump, cursor, { budgetChars: 5 })
  assert.equal(rest.text, '中')
  assert.equal(rest.consumedBytes, 3)
  assert.equal(rest.nextOffset, 11)
  assert.equal(rest.lossy, false)
  assert.equal(rest.gapBefore, undefined)
  assert.equal(rest.truncated, false)
})

test('IO5-2 单次 append 超过 cap：只保留尾部，lostBytes 如实', () => {
  const pump = createPump({ maxBufferBytes: 4 })
  assert.equal(pump.appendRaw('abcdefgh').lostBytes, 4)
  assert.equal(pump.totalBytes(), 8)
  const r = read(pump, createCursor(), { budgetChars: 64 })
  assert.equal(r.lossy, true)
  assert.equal(r.gapBefore, 4)
  assert.equal(r.text, `${GAP_NOTICE}efgh`)
  assert.equal(r.nextOffset, 8)
})

test('B3-1 earliest 落在字符中间：从 earliest 宽松解码 + 固定首行提示 + lossy', () => {
  const pump = createPump({ maxBufferBytes: 4 })
  pump.appendRaw(Buffer.from('中A')) // 3 + 1 字节
  const evicted = pump.appendRaw('B') // 以 '中' 的首字节为代价
  assert.equal(evicted.lostBytes, 1)
  assert.equal(pump.totalBytes(), 5)

  const cursor = createCursor()
  const r = read(pump, cursor, { budgetChars: 64 })
  assert.equal(r.lossy, true)
  assert.equal(r.gapBefore, 1)
  assert.ok(r.text.startsWith(GAP_NOTICE))
  assert.equal(r.text, `${GAP_NOTICE}${FFFD}${FFFD}AB`) // 两个悬空续字节各自宽松解码
  assert.equal(r.consumedBytes, 4)
  assert.equal(r.nextOffset, 5)
})

test('B6-1 budget 截断后再读，剩余字符完整且字节账目精确', () => {
  const pump = createPump()
  pump.appendRaw('中文abc')
  const cursor = createCursor()

  const first = read(pump, cursor, { budgetChars: 2 })
  assert.equal(first.text, '中文')
  assert.equal(first.consumedBytes, 6)
  assert.equal(first.nextOffset, 6)
  assert.equal(first.truncated, true)

  const second = read(pump, cursor, { budgetChars: 2 })
  assert.equal(second.text, 'ab')
  assert.equal(second.nextOffset, 8)
  assert.equal(second.truncated, true)

  const third = read(pump, cursor, { budgetChars: 2 })
  assert.equal(third.text, 'c')
  assert.equal(third.nextOffset, 9)
  assert.equal(third.truncated, false)
})

test('B6-2 非法字节的字节账目精确（U+FFFD 只消耗 1 字节，不吞掉后续数据）', () => {
  const pump = createPump()
  pump.appendRaw(Buffer.from([0xFF, 0x41]))
  const cursor = createCursor()

  const first = read(pump, cursor, { budgetChars: 1 })
  assert.equal(first.text, FFFD)
  assert.equal(first.consumedBytes, 1)
  assert.equal(first.nextOffset, 1)
  assert.equal(first.truncated, true)

  const second = read(pump, cursor, { budgetChars: 1 })
  assert.equal(second.text, 'A')
  assert.equal(second.nextOffset, 2)
  assert.equal(second.truncated, false)
})

// ─────────────────────────────────────────────────────────────────────────────
// flush
// ─────────────────────────────────────────────────────────────────────────────

test('FLUSH-1 未闭合 ANSI 在 flush 时丢弃，已完整序列不受影响，flush 后不再写 ring', async () => {
  const pump = createPump()
  pump.appendRaw(Buffer.from('A\x1b[31mB'))
  pump.appendRaw(Buffer.from('\x1b]0;unterminated')) // OSC 未闭合
  assert.equal(pump.totalBytes(), 2)

  await pump.flush()
  assert.equal(pump.totalBytes(), 2)

  const r = read(pump, createCursor(), { budgetChars: 64, final: true })
  assert.equal(r.text, 'AB')

  const afterFlush = pump.appendRaw('ZZZ')
  assert.equal(afterFlush.lostBytes, 0)
  assert.equal(pump.totalBytes(), 2)
  assert.equal(read(pump, createCursor(), { budgetChars: 64, final: true }).text, 'AB')

  await pump.flush() // 幂等
  assert.equal(pump.totalBytes(), 2)
})

test('FLUSH-2 flush 后 final 读取能看到最后一批已 drain 的输出', async () => {
  const pump = createPump()
  const cursor = createCursor()
  pump.appendRaw(Buffer.from('line1\nli'))
  assert.equal(read(pump, cursor, { budgetChars: 64 }).text, 'line1\nli')
  pump.appendRaw(Buffer.from('ne2\n'))
  await pump.flush()
  const tail = read(pump, cursor, { budgetChars: 64, final: true })
  assert.equal(tail.text, 'ne2\n')
  assert.equal(tail.nextOffset, 12)
})

// ─────────────────────────────────────────────────────────────────────────────
// sink（Jobs 文本环）
// ─────────────────────────────────────────────────────────────────────────────

test('SINK-1 attach 后喂文本、detach 后不再喂、flush 调 sink.end()', async () => {
  const pump = createPump()
  const chunks = []
  let ends = 0

  const first = pump.attachSink({ write: (t) => chunks.push(t), end: () => { ends += 1 } })
  pump.appendRaw('hello')
  assert.deepEqual(chunks, ['hello'])

  first.detach()
  first.detach() // 幂等
  pump.appendRaw('world')
  assert.deepEqual(chunks, ['hello'])

  pump.attachSink({ write: (t) => chunks.push(t), end: () => { ends += 1 } })
  pump.appendRaw('!')
  assert.deepEqual(chunks, ['hello', '!'])

  await pump.flush()
  assert.equal(ends, 1) // 已 detach 的 sink 不再收到 end
  await pump.flush()
  assert.equal(ends, 1)
})

test('SINK-2 sink 流式解码跨 chunk 保留 UTF-8 尾部', async () => {
  const pump = createPump()
  const chunks = []
  let ends = 0
  pump.attachSink({ write: (t) => chunks.push(t), end: () => { ends += 1 } })

  pump.appendRaw(Buffer.from([0xE4, 0xB8]))
  assert.deepEqual(chunks, [])
  pump.appendRaw(Buffer.from([0xAD]))
  assert.deepEqual(chunks, ['中'])
  pump.appendRaw('X')
  assert.deepEqual(chunks, ['中', 'X'])

  // sink 与 ring 互不影响：ring 里是同一条 clean 字节流
  assert.equal(read(pump, createCursor(), { budgetChars: 64 }).text, '中X')

  await pump.flush()
  assert.equal(ends, 1)
  assert.deepEqual(chunks, ['中', 'X'])
})

test('SINK-3 sink 在 flush 时对残留半截字符产出恰好一次替换字符', async () => {
  const pump = createPump()
  const chunks = []
  let ends = 0
  pump.attachSink({ write: (t) => chunks.push(t), end: () => { ends += 1 } })

  pump.appendRaw(Buffer.from([0xEF, 0xBF]))
  assert.deepEqual(chunks, [])
  await pump.flush()
  assert.deepEqual(chunks, [FFFD])
  assert.equal(ends, 1)

  // 同一份原始字节在读取侧也只产出一次替换
  const r = read(pump, createCursor(), { budgetChars: 64, final: true })
  assert.equal(countOf(r.text, FFFD), 1)
})

// ─────────────────────────────────────────────────────────────────────────────
// ring 配置与入口校验
// ─────────────────────────────────────────────────────────────────────────────

test('RING-1 默认 cap、纯 ANSI chunk、非法参数', () => {
  assert.equal(DEFAULT_MAX_BUFFER_BYTES, 262_144)
  const pump = createPump()
  assert.equal(pump.totalBytes(), 0)
  assert.equal(pump.appendRaw(Buffer.from('')).lostBytes, 0)

  assert.equal(pump.appendRaw(Buffer.from('\x1b[2J')).lostBytes, 0) // 完整 CSI：无 clean 字节
  assert.equal(pump.totalBytes(), 0)
  assert.equal(read(pump, createCursor(), { budgetChars: 8 }).text, '')

  assert.throws(() => createPump({ maxBufferBytes: 0 }), /maxBufferBytes/)
  assert.throws(() => createPump({ maxBufferBytes: 1.5 }), /maxBufferBytes/)
  assert.throws(() => pump.consume(0, 0), /budgetChars/)
  assert.throws(() => pump.consume(0, 1.5), /budgetChars/)
  assert.throws(() => pump.consume(-1, 16), /fromOffset/)
  assert.throws(() => pump.appendRaw(42), /appendRaw/)
})

// ─────────────────────────────────────────────────────────────────────────────
// FUZZ：确定性伪随机切块 / 预算，锁死三条铁律
// ─────────────────────────────────────────────────────────────────────────────

test('FUZZ-1 随机切块 + 随机预算：无乱码、无丢字节、无重复、覆盖起点账目正确', async () => {
  const DATA = ['hello ', '中文测试', '🙂🚀', 'tab\tx\n', 'AB', 'ünïcödé', '日本語']
  const ANSI = ['\u001b[31m', '\u001b[0m', '\u001b]0;title\u0007', '\u001b(0', '\u001b[2J\u001b[H', '\u001bPq\u001b\\']
  // 期望文本按 token 构造，不依赖实现（ANSI token 都是完整序列，应被整体剥离）
  let seed = 987_654_321
  const rnd = (n) => {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fff_ffff
    return seed % n
  }

  for (let round = 0; round < 150; round += 1) {
    let expected = ''
    const raw = []
    for (let i = 0, steps = 1 + rnd(12); i < steps; i += 1) {
      if (rnd(2) === 0) {
        const data = DATA[rnd(DATA.length)]
        expected += data
        raw.push(Buffer.from(data, 'utf8'))
      } else {
        raw.push(Buffer.from(ANSI[rnd(ANSI.length)], 'utf8'))
      }
    }
    const stream = Buffer.concat(raw)
    if (stream.length === 0) continue
    const clean = Buffer.from(expected, 'utf8')
    const cap = 1 + rnd(9)
    const evicts = clean.length > cap
    const retainedStart = Math.max(0, clean.length - cap)
    const label = `round ${round} cap=${cap} total=${clean.length}`

    // (a) 任意切块喂入 → 输出与 total 与整体剥离结果一致
    const pump = createPump()
    for (let at = 0; at < stream.length;) {
      const size = 1 + rnd(5)
      pump.appendRaw(stream.subarray(at, at + size))
      at += size
    }
    assert.equal(pump.totalBytes(), clean.length, `total ${label}`)
    await pump.flush()
    const whole = pump.consume(0, 1_000_000, { final: true })
    assert.equal(whole.text, expected, `text ${label}`)
    assert.equal(whole.consumedBytes, clean.length, `consumed ${label}`)
    assert.equal(whole.truncated, false, `truncated ${label}`)

    // (b) 随机 budget 分段读：拼接等于一次读完，字节不重不漏
    const split = createPump()
    for (const buf of raw) split.appendRaw(buf)
    await split.flush()
    let offset = 0
    let acc = ''
    for (let guard = 0; guard < 3000; guard += 1) {
      const part = split.consume(offset, 1 + rnd(6), { final: true })
      acc += part.text
      offset = part.nextOffset
      if (part.consumedBytes === 0) break
    }
    assert.equal(acc, expected, `split ${label}`)
    assert.equal(offset, clean.length, `split offset ${label}`)

    // (c) 小 ring 覆盖：gap 账目正确，读出的是真流从 earliest 起的宽松解码
    const small = createPump({ maxBufferBytes: cap })
    for (let at = 0; at < stream.length;) {
      const size = 1 + rnd(4)
      small.appendRaw(stream.subarray(at, at + size))
      at += size
    }
    await small.flush()
    const total = small.totalBytes()
    const covered = small.consume(0, 1_000_000, { final: true })
    assert.equal(covered.lossy, evicts, `lossy ${label}`)
    assert.equal(covered.nextOffset, total, `next ${label}`)
    assert.equal(covered.consumedBytes, total - retainedStart, `covered consumed ${label}`)
    if (evicts) {
      assert.equal(covered.gapBefore, retainedStart, `gap ${label}`)
      const payload = covered.text.slice(GAP_NOTICE.length)
      let matched = false
      for (let s = 0; s <= 4 && retainedStart + s <= total; s += 1) {
        if (clean.subarray(retainedStart + s).toString('utf8') === payload.replace(/^\uFFFD+/, '')) {
          matched = true
          break
        }
      }
      assert.ok(matched, `suffix ${label} payload=${JSON.stringify(payload)}`)
    } else {
      assert.equal(covered.gapBefore, undefined, `gap ${label}`)
      assert.equal(covered.text, expected, `text ${label}`)
    }
  }
})

test('FUZZ-2 残缺尾部在任意 budget 切法下只替换一次且字节不丢', async () => {
  const TAILS = [[0xEF], [0xEF, 0xBF], [0xE4], [0xE4, 0xB8], [0xF0], [0xF0, 0x9F], [0xF0, 0x9F, 0x98]]
  let seed = 24_680
  const rnd = (n) => {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fff_ffff
    return seed % n
  }

  const makePump = async (tail) => {
    const pump = createPump()
    pump.appendRaw('data')
    for (const b of tail) pump.appendRaw(Buffer.from([b]))
    await pump.flush()
    return pump
  }

  for (let round = 0; round < 60; round += 1) {
    const tail = Buffer.from(TAILS[rnd(TAILS.length)])
    const label = `round ${round} tail=${JSON.stringify([...tail])}`
    const one = (await makePump(tail)).consume(0, 1_000_000, { final: true })
    assert.equal(countOf(one.text, FFFD), 1, `one ${label}`)
    assert.equal(one.consumedBytes, 4 + tail.length, `consumed ${label}`)

    const split = await makePump(tail)
    let offset = 0
    let acc = ''
    for (let guard = 0; guard < 100; guard += 1) {
      const part = split.consume(offset, 1 + rnd(4), { final: true })
      acc += part.text
      offset = part.nextOffset
      if (part.consumedBytes === 0) break
    }
    assert.equal(acc, one.text, `split ${label}`)
    assert.equal(countOf(acc, FFFD), 1, `split count ${label}`)
    assert.equal(offset, 4 + tail.length, `split offset ${label}`)
    // 已经替换过的尾部不再重复替换
    assert.equal(countOf(split.consume(0, 1_000_000, { final: true }).text, FFFD), 0, `replay ${label}`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// peek：只读快照（不推进任何游标）
// 依据 docs/terminal-notifications/OUTPUT_EVENTS_AND_LLM_WAKEUP.md §5：
// "通知尾部使用只读快照；若需要新增 peek API，应在 pump 层实现，
//  避免借用 reader 的消费函数"
// ─────────────────────────────────────────────────────────────────────────────

test('PEEK1 返回缓冲内容但不消费：后续 consume 仍能拿到全部', () => {
  const pump = createPump({ maxBufferBytes: 4096 })
  pump.appendRaw('hello world\r\n')

  const snap = pump.peek()
  assert.equal(snap.text, 'hello world\r\n')
  assert.equal(snap.fromOffset, 0)
  assert.equal(snap.toOffset, 13)
  assert.equal(snap.lossy, false)
  assert.equal(snap.truncated, false)
  assert.equal(snap.totalBytes, 13)

  // 关键：peek 没有推进任何东西 —— consume 依然拿到完整内容
  const consumed = pump.consume(0, 1000, {})
  assert.equal(consumed.text, 'hello world\r\n', 'peek 不得消费内容（否则会偷走模型该读到的输出）')
  // totalBytes 是累计写入量，与消费无关
  assert.equal(pump.totalBytes(), 13)
})

test('PEEK2 预算与 truncated', () => {
  const pump = createPump({ maxBufferBytes: 4096 })
  pump.appendRaw('abcdefghij')

  const small = pump.peek(0, 4)
  assert.equal(small.text, 'abcd')
  assert.equal(small.truncated, true)
  assert.equal(small.toOffset, 4, 'toOffset 应反映本次返回的字节数')

  const rest = pump.peek(4, 100)
  assert.equal(rest.text, 'efghij', '从任意偏移窥视')
  assert.equal(rest.truncated, false)
})

test('PEEK3 被覆盖后如实报告 lossy（不假装没丢）', () => {
  const pump = createPump({ maxBufferBytes: 8 })
  pump.appendRaw('0123456789ABCDEF') // 超出 8 字节 → 最早的被覆盖

  const snap = pump.peek(0, 1000)
  assert.equal(snap.lossy, true, '请求早于最早可用处必须报 lossy')
  assert.ok(snap.fromOffset > 0, 'fromOffset 应落在仍保留的最早位置')
  assert.ok(!snap.text.startsWith('0123'), '被覆盖的字节不应出现在快照里')
})

test('PEEK4 非 final 时不为残缺 UTF-8 尾部产生替换字符', () => {
  const pump = createPump({ maxBufferBytes: 4096 })
  // "中" 的前两字节，缺少第三字节 —— 属于可补全的残缺尾部
  pump.appendRaw(Buffer.from([0xe4, 0xb8]))

  const snap = pump.peek()
  assert.equal(countOf(snap.text, FFFD), 0, 'peek 不应提前产生 U+FFFD')

  // 补全后应能完整读到
  pump.appendRaw(Buffer.from([0xad]))
  assert.equal(pump.peek().text, '中')
})

test('PEEK5 空缓冲区与非法参数退回默认，不抛', () => {
  const pump = createPump({ maxBufferBytes: 4096 })
  const empty = pump.peek()
  assert.equal(empty.text, '')
  assert.equal(empty.totalBytes, 0)

  pump.appendRaw('data')
  // 非法 budget → 退回默认，不抛
  assert.doesNotThrow(() => pump.peek(0, -1))
  assert.doesNotThrow(() => pump.peek(0, 0))
  assert.doesNotThrow(() => pump.peek(-5, 100))
  assert.equal(pump.peek(0, -1).text, 'data')
})

// ─────────────────────────────────────────────────────────────────────────────
// 帧标记抑制：`__DSH_BGTERM_<nonce>_S__/_E__<code>` 是命令级 framing 的内部标记，
// 不该出现在正文里；但**退出码要保留**（它是有用信息）。
// ─────────────────────────────────────────────────────────────────────────────

/** 收一个 sink 收到的全部文本。 */
function collect(pump) {
  let text = ''
  pump.attachSink({ write: (t) => { text += t }, end: () => {} })
  return {
    get: () => text,
    /** 追加并返回此刻累积的 sink 文本。 */
    feed(chunk) { pump.appendRaw(chunk); return text },
  }
}

test('MK1 开始标记整行消失，结束标记保留退出码', () => {
  const pump = createPump({ maxBufferBytes: 4096 })
  const s = collect(pump)
  s.feed('__DSH_BGTERM_abc-123_S__\r\n')
  s.feed('command output\r\n')
  s.feed('__DSH_BGTERM_abc-123_E__0\r\n')
  const text = s.get()

  assert.ok(!text.includes('__DSH_BGTERM_'), `正文里不得残留标记：${JSON.stringify(text)}`)
  assert.match(text, /command output/, '命令输出必须保留')
  assert.match(text, /^0\r\n/m, '退出码必须保留（去掉标记、留下数字）')
})

test('MK2 标记跨 chunk 到达也能抑制（含逐字节切）', () => {
  // 标记可能被 PTY 的输出分片切开；逐字节喂是最严苛的切法。
  const pump = createPump({ maxBufferBytes: 4096 })
  const s = collect(pump)
  for (const ch of '__DSH_BGTERM_zzz_S__\r\nhello\r\n__DSH_BGTERM_zzz_E__7\r\n') s.feed(ch)
  const text = s.get()

  assert.ok(!text.includes('__DSH_BGTERM_'), `逐字节喂入后不得残留标记：${JSON.stringify(text)}`)
  assert.match(text, /hello/)
  assert.match(text, /^7\r\n/m, '退出码 7 必须保留')
})

test('MK3 cmdlet 退出码（pwsh cmdlet 没有数字码）保留为 cmdlet:ok/fail', () => {
  const pump = createPump({ maxBufferBytes: 4096 })
  const s = collect(pump)
  s.feed('__DSH_BGTERM_n_S__\r\nx\r\n__DSH_BGTERM_n_E__cmdlet:fail\r\n')
  const text = s.get()
  assert.ok(!text.includes('_S__'), '开始标记必须消失')
  assert.match(text, /cmdlet:fail/, 'cmdlet 退出码必须保留')
})

test('MK4 普通文本一字不动（含看起来像标记前缀的行）', () => {
  const pump = createPump({ maxBufferBytes: 4096 })
  const s = collect(pump)
  const plain = 'line one\r\nline two\r\n__DSH_BGTERM_READY__\r\nlast'
  s.feed(plain)
  // 就绪信标不是帧标记（没有 _S__/_E__），必须原样保留
  assert.equal(s.get(), plain, '非帧标记文本必须逐字原样放行')
})

test('MK5 ring 与 sink 拿到**同一份过滤后**字节（偏移与内容必须对齐）', () => {
  // 这是本实现最关键的约束，也是踩过的坑：`terminal_read` / `terminal_exec.output` 读的是
  // **ring**，只把 sink 过滤掉是不够的——那样 ring 里仍是原始字节、标记照样被读到。
  // 反过来把 ring 存成"过滤后的字符串再编码"又会让偏移漂移。
  //
  // 正确形态：过滤在**字节层**完成，ring 与 sink 共用同一份结果。
  const pump = createPump({ maxBufferBytes: 4096 })
  let sink = ''
  pump.attachSink({ write: (t) => { sink += t }, end: () => {} })
  pump.appendRaw('__DSH_BGTERM_abc_S__\r\nhi\r\n__DSH_BGTERM_abc_E__7\r\n')

  const cursor = createCursor()
  const ringText = read(pump, cursor, { budgetChars: 10_000 }).text

  assert.ok(!ringText.includes('__DSH_BGTERM_'), `ring 里不得残留标记：${JSON.stringify(ringText)}`)
  assert.ok(!sink.includes('__DSH_BGTERM_'), `sink 里不得残留标记：${JSON.stringify(sink)}`)
  assert.equal(ringText, sink, 'ring 与 sink 必须是同一份过滤后内容')
  assert.match(ringText, /hi/, '命令输出必须保留')
  // 偏移必须与**实际写入 ring 的字节数**一致（过滤后的长度，不是原始长度）
  assert.equal(cursor.offset, pump.totalBytes(), 'cursor 必须能推进到 totalBytes（账目一致）')
  assert.equal(
    pump.totalBytes(),
    Buffer.byteLength(ringText, 'utf8'),
    'ring 字节数必须等于过滤后内容的字节数（偏移基准）',
  )
})

test('MK6 真机形态：回显行带提示符，标记不在行首也必须被剥离', () => {
  // 这是真机上唯一真实的形态，也是最初漏掉的那一种：
  // PTY 会回显 shell 提示符 + 整条包装命令行，所以标记出现在**行中**：
  //   `PS C:\…>> [Console]::WriteLine("__DSH_BGTERM_…_S__"); <原命令>; …`
  // 按"行首匹配"写过滤器时，这类行一个都识别不到——真实输出里标记原样留着。
  const pump = createPump({ maxBufferBytes: 8192 })
  const s = collect(pump)
  const prompt = 'PS C:\\work>'
  s.feed(`${prompt}> [Console]::WriteLine("__DSH_BGTERM_n1_S__"); Write-Output "hi"; [Console]::WriteLine("__DSH_BGTERM_n1_E__")\r\n`)
  s.feed('__DSH_BGTERM_n1_S__\r\n')
  s.feed('hi\r\n')
  s.feed('__DSH_BGTERM_n1_E__cmdlet:ok\r\n')
  s.feed(`${prompt} `)

  const text = s.get()
  assert.ok(!text.includes('__DSH_BGTERM_'), `正文里不得残留标记（真机形态）：${JSON.stringify(text)}`)
  assert.match(text, /hi/, '命令输出必须保留')
  assert.match(text, /cmdlet:ok/, '纯结束标记行必须保留退出码')
})

test('MK7 带提示符的结束标记整行丢弃，不留下半截提示符正文', () => {
  // 结束标记紧跟提示符时（`PS F:\…> __…_E__0`），若只删标记会得到 `PS F:\…> 0`
  // 这种半截正文。退出码本身已在 terminal_state.lastCommandExitCode 里上报，
  // 正文里不必再留一份——整行去掉更干净。
  const pump = createPump({ maxBufferBytes: 8192 })
  const s = collect(pump)
  s.feed('PS F:\\ws> __DSH_BGTERM_n2_E__0\r\n')
  const text = s.get()
  assert.ok(!text.includes('__DSH_BGTERM_'), '不得残留标记')
  assert.doesNotMatch(text, /PS F:\\ws>/, '不得留下半截提示符')
})

test('MK8 提示符与普通输出一字不动（不误伤正文）', () => {
  const pump = createPump({ maxBufferBytes: 8192 })
  const s = collect(pump)
  const normal = 'PS F:\\ws> npm run build\r\nbuilding…\r\nPS F:\\ws> '
  s.feed(normal)
  assert.equal(s.get(), normal, '没有标记的行必须逐字原样放行')
})
