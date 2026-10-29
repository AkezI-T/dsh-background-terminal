/**
 * 「读全判据」的冷测试（P1-READ-1）。
 *
 * 契约来源：冻结契约 P1-READ-1。它要兑现目标文档的 D5/D6，并把 **ST-03**（两个字节数
 * 对不上）从根上消灭——"还剩多少"必须来自 `unreadBytes`，而不是让调用方拿
 * `outputBytes` 去减 `nextCursor`。
 *
 * 本文件覆盖**投影层与单一来源**：
 *   - 两个导出纯函数 `outputFinalOf` / `unreadBytesOf` 的真值表与边界；
 *   - `SESSION_STATE_FIELDS` 末尾两个顶层字段（`unreadBytes`、`outputFinal`）的映射；
 *   - 快照与两个导出函数**同口径**（单一来源在投影层的证据）；
 *   - `lib/index.js` 是否 import 复用它们（源文本断言，局限见下）。
 *
 * 诚实声明（不写清楚就会被当成行为验证）：
 *   1. 投影层测试证明不了**运行时行为**：快照对不对 ≠ `terminal_read` 返回得对；
 *   2. `peekTail` 的运行时行为（只读不消费、忽略 `waitMs`、返回 `tail`/`peek:true`）
 *      必须用假 PTY 驱动集成层才看得见，属集成层用例，**本文件不测**；
 *   3. 「index.js 是否复用」只看**源文本**：它证明不了运行时真的调用了这两个函数
 *      （import 写好却另走一条自算分支，源文本断言看不出），也证明不了别的模块没各写一份。
 *      行为级的单一来源由集成层用例覆盖。
 *
 * 反向判别力（本轮改动前的实测快照，2026-10-05 17:23）：`peekTail` / `unreadBytes` /
 * `outputFinal` 在 `lib/` 与 `test/` 里的出现次数为 **0**（只出现在 docs 里，
 * `docs/HANDOVER.md` 当时还写着"目标态待建，今天不存在"），`SESSION_STATE_FIELDS` 末项是
 * `commandStateTrustworthy`，两个导出函数根本不存在——所以下面 R1~R7 在改动前必然全红。
 *
 * 全冷：纯函数与文本读取，不创建进程、不联网、不碰文件系统（除了读自己仓库的源文本）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { SESSION_STATE_FIELDS, outputFinalOf, snapshotSession, unreadBytesOf } from '../lib/session-state.mjs'

/** 只带契约需要的那一个观测面的假 pump。 */
function fakePump(totalBytes) {
  return { totalBytes: () => totalBytes }
}

/**
 * 合成 record：只放契约关心的字段，避免夹具自己引入未定义语义。
 * @param {{phase?:string, outputEnded?:boolean, pump?:object, cursor?:object}} [parts]
 */
function recordOf(parts = {}) {
  const record = { id: 'term-1' }
  if (parts.phase !== undefined) record.phase = parts.phase
  if (parts.outputEnded !== undefined) record.outputEnded = parts.outputEnded
  if (parts.pump !== undefined) record.pump = parts.pump
  if (parts.cursor !== undefined) record.cursor = parts.cursor
  return record
}

/**
 * 「phase 已落定」用本模块既有的定义（SETTLED_PHASES）：exited / killed / failed /
 * cleanup-failed —— 契约里的"已落定"指的就是这个既有概念，不是新造的一套。
 */
const SETTLED = ['exited', 'killed', 'failed', 'cleanup-failed']
const UNSETTLED = ['running', 'spawning', 'stopping']

// ─────────────────────────────────────────────────────────────────────────────
// 字段表与两个导出判据
// ─────────────────────────────────────────────────────────────────────────────

test('R1 unreadBytes / outputFinal 按契约顺序连续出现（本断言只锚相对顺序）', () => {
  // **全队规则**：字段表位置断言一律用 indexOf 锚**相对顺序**，不用 slice(-N)——
  // 绝对末位归"最新的那份契约"管；每追加一轮字段，钉末位的写法就会自伤一次
  // （R1 在 P1-GEN-1 追加 commandGeneration 时被打红过，那正是这个写法的问题）。
  const at = SESSION_STATE_FIELDS.indexOf('unreadBytes')
  assert.notEqual(at, -1, 'unreadBytes 必须在字段表里')
  assert.deepEqual(
    SESSION_STATE_FIELDS.slice(at, at + 2),
    ['unreadBytes', 'outputFinal'],
    '两个字段必须连续且按此顺序',
  )
  assert.ok(
    at > SESSION_STATE_FIELDS.indexOf('commandStateTrustworthy'),
    '必须追加在 P0-INT-1 三字段之后（顺序即契约）',
  )
  assert.equal(new Set(SESSION_STATE_FIELDS).size, SESSION_STATE_FIELDS.length, '字段表不得有重复项')
})

test('R2 两个判据是导出函数（契约要求它们是单一来源的两个名字）', () => {
  assert.equal(typeof outputFinalOf, 'function', 'outputFinalOf 必须从 lib/session-state.mjs 导出')
  assert.equal(typeof unreadBytesOf, 'function', 'unreadBytesOf 必须从 lib/session-state.mjs 导出')
})

// ─────────────────────────────────────────────────────────────────────────────
// outputFinalOf：读全的两个条件
// ─────────────────────────────────────────────────────────────────────────────

test('R3 outputFinalOf 真值表：outputEnded 与「已落定」两个条件都要满足；无 pump 是唯一例外', () => {
  for (const phase of SETTLED) {
    assert.equal(outputFinalOf(recordOf({ phase })), true, `${phase} + 无 pump：连缓冲都不存在，确实不会再有输出`)
    assert.equal(
      outputFinalOf(recordOf({ phase, pump: fakePump(100), outputEnded: true })),
      true,
      `${phase} + 流已结束 → 可以声称读全`,
    )
    assert.equal(
      outputFinalOf(recordOf({ phase, pump: fakePump(100), outputEnded: false })),
      false,
      `${phase} 但 PTY 还没 drain → 还不能说读全`,
    )
  }

  for (const phase of UNSETTLED) {
    assert.equal(
      outputFinalOf(recordOf({ phase, pump: fakePump(100), outputEnded: true })),
      false,
      `${phase} + 流已结束：会话没落定，仍可能再产出 → false`,
    )
    assert.equal(outputFinalOf(recordOf({ phase })), false, `${phase} + 无 pump：phase 未落定 → false`)
  }

  // 缺观测一律 false：不敢声称读全（false 是"不敢说"，不是"确实没读完"）
  for (const record of [recordOf({}), recordOf({ pump: fakePump(10) }), recordOf({ phase: 'running', outputEnded: true })]) {
    assert.equal(outputFinalOf(record), false, '缺观测 → false')
  }

  // 类型纪律：任何入参形态都必须返回真正的 boolean，不得 null/undefined
  for (const record of [undefined, null, recordOf({}), recordOf({ phase: 'exited' }), recordOf({ phase: 'running', outputEnded: true })]) {
    assert.equal(typeof outputFinalOf(record), 'boolean', `outputFinalOf(${JSON.stringify(record)}) 必须返回 boolean`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// unreadBytesOf：剩余量的唯一正确来源
// ─────────────────────────────────────────────────────────────────────────────

test('R4 unreadBytesOf：总量减游标并 clamp 到 0；无 pump 写 null（不写 0 假装读完）', () => {
  assert.equal(unreadBytesOf(recordOf({}), { offset: 0 }), null, '无 pump → null（这个观测值不存在）')
  assert.equal(unreadBytesOf(undefined, undefined), null, '没有记录 → 无 pump → null，且不得抛错')
  assert.equal(unreadBytesOf(recordOf({ pump: fakePump(100) }), { offset: 40 }), 60, '还剩 60 字节')
  assert.equal(unreadBytesOf(recordOf({ pump: fakePump(100) }), { offset: 100 }), 0, '已读到总量 → 0')
  // 游标超过总量（ring 丢过旧数据、或偏移口径不一致）：clamp 到 0，绝不报负数
  assert.equal(unreadBytesOf(recordOf({ pump: fakePump(100) }), { offset: 150 }), 0, '游标超过总量 → 0，不报负数')
  // 契约没有规定 cursor 缺失的形态，这里只守住"不毁掉调用方"这一条底线
  assert.doesNotThrow(() => unreadBytesOf(recordOf({ pump: fakePump(100) }), undefined), 'cursor 缺失不得抛错')
})

// ─────────────────────────────────────────────────────────────────────────────
// 投影层
// ─────────────────────────────────────────────────────────────────────────────

test('R5 投影与两个导出函数同口径（单一来源在投影层的证据）', () => {
  const records = [
    recordOf({ phase: 'running' }),
    recordOf({ phase: 'running', pump: fakePump(500), cursor: { offset: 120 }, outputEnded: false }),
    recordOf({ phase: 'exited', pump: fakePump(500), cursor: { offset: 500 }, outputEnded: true }),
    recordOf({ phase: 'killed', pump: fakePump(80), cursor: { offset: 200 }, outputEnded: true }),
    recordOf({ phase: 'cleanup-failed', pump: fakePump(80), cursor: { offset: 10 } }),
  ]

  for (const record of records) {
    const snapshot = snapshotSession(record, { now: () => 2_000 })
    assert.equal(
      snapshot.unreadBytes,
      unreadBytesOf(record, record.cursor),
      `快照 unreadBytes 必须与 unreadBytesOf 同口径（${record.phase}）`,
    )
    assert.equal(
      snapshot.outputFinal,
      outputFinalOf(record),
      `快照 outputFinal 必须与 outputFinalOf 同口径（${record.phase}）`,
    )
  }
})

test('R6 投影如实上报：unreadBytes 缺观测写 null，outputFinal 缺观测写 false', () => {
  const withPump = snapshotSession(recordOf({ phase: 'running', pump: fakePump(300), cursor: { offset: 100 } }), {
    now: () => 2_000,
  })
  assert.equal(withPump.unreadBytes, 200)
  assert.equal(withPump.outputFinal, false, '会话还在 running → 没读完')

  const noPumpSettled = snapshotSession(recordOf({ phase: 'failed' }), { now: () => 2_000 })
  assert.equal(noPumpSettled.unreadBytes, null, '没有 pump 就没有"还剩多少"这个观测值')
  assert.equal(noPumpSettled.outputFinal, true, '无 pump + 已落定 → 确实不会再有输出')

  const noPumpRunning = snapshotSession(recordOf({ phase: 'running' }), { now: () => 2_000 })
  assert.equal(noPumpRunning.unreadBytes, null)
  assert.equal(noPumpRunning.outputFinal, false, '缺观测 → false，不猜"读全了"')

  for (const snapshot of [withPump, noPumpSettled, noPumpRunning]) {
    assert.equal(typeof snapshot.outputFinal, 'boolean', 'outputFinal 必须是 boolean')
    assert.ok(Object.hasOwn(snapshot, 'unreadBytes'), '字段必须存在（值为 null 也不能缺省）')
    assert.ok(Object.hasOwn(snapshot, 'outputFinal'), '字段必须存在（值为 false 也不能缺省）')
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 单一来源：lib/index.js 必须 import 复用
// ─────────────────────────────────────────────────────────────────────────────

test('R7 lib/index.js import 复用两个判据，且不另写一份（源文本断言，局限见文件头）', async () => {
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')

  const importStatement = source.match(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/session-state\.mjs['"]/)
  assert.ok(importStatement, 'lib/index.js 必须从 ./session-state.mjs import')
  const imported = importStatement[1].split(',').map((name) => name.trim())

  for (const name of ['outputFinalOf', 'unreadBytesOf']) {
    assert.ok(imported.includes(name), `index.js 必须 import ${name}（契约：单一来源，不得各写一份）`)
  }

  // 排除"import 了但自己又实现一份"——这是最容易骗过纯 import 断言的一条路径。
  for (const name of ['outputFinalOf', 'unreadBytesOf']) {
    const localDefinition = new RegExp(`(?:function|const|let|var)\\s+${name}\\b`)
    assert.equal(localDefinition.test(source), false, `index.js 不得自己定义 ${name}`)
  }
})
