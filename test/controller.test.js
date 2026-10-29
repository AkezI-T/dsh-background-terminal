/**
 * controller.mjs 冷测试（假 PTY / 假 spawn / 假 admission，不起真实进程）。
 * 用例编号对应 FINAL.md §16.1 的 C1-C7、I4。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { makeFakePty, makeFakeSpawn, deferred } from './helpers/fake-ctx.mjs'
import { createController } from '../lib/controller.mjs'

const CONFIG = { cols: 120, rows: 30, disposeGraceMs: 3000 }
const LEGAL_JOB_STATUS = ['completed', 'failed', 'killed']

/** 让出若干轮微任务/宏任务，观察“尚未落定”的中间态。 */
function tick() {
  return new Promise((resolve) => setImmediate(resolve))
}

/** 最小假 record：形状与 records.mjs 的 createRecord 一致（四事实位 + 四 deferred）。 */
function makeRecord(overrides = {}) {
  const counts = { outcomeResolves: 0 }
  const outcomeGate = deferred()
  const resolveOutcome = outcomeGate.resolve
  outcomeGate.resolve = (value) => {
    counts.outcomeResolves += 1
    return resolveOutcome(value)
  }

  const record = {
    id: 'term-1',
    owner: { id: 'agent-1' },
    phase: 'reserved',
    abort: new AbortController(),
    spawnAttempted: false,
    spawnFinished: false,
    ptyCreated: false,
    ptyExited: false,
    cancelRequested: null,
    startGate: deferred(),
    outcomeGate,
    spawnSettled: deferred(),
    cleanupSettled: deferred(),
    terminal: { exitCode: null, signal: null, detail: 'starting' },
    ...overrides,
  }
  return { record, counts }
}

function harness(options = {}) {
  const spawn = options.spawn ?? makeFakeSpawn(options.spawnOpts)
  const released = []
  const retained = []
  const flushCalls = []
  const terminateReasons = []
  const logs = []
  const published = []

  const admission = {
    released,
    retained,
    release(record) {
      released.push(record.id)
    },
    enterRetention(record) {
      retained.push(record.id)
    },
  }

  const deps = {
    spawnTerminal: options.spawnTerminal ?? spawn.spawnTerminal,
    admission,
    lifecycle: { closed: false },
    terminateRecord: async (record, reason) => {
      terminateReasons.push(reason)
      await record.handle.terminate()
    },
    flushPump: async (record) => {
      flushCalls.push(record.id)
    },
    log: (message) => {
      logs.push(message)
    },
    config: CONFIG,
    onPublished: (record, handle) => {
      published.push({ record, handle })
      record.session = { id: record.id, jobId: record.jobId }
      return record.session
    },
    ...options.deps,
  }

  const controller = createController(deps)
  const { record, counts } = makeRecord(options.recordOverrides)

  return {
    spawn,
    admission,
    deps,
    controller,
    record,
    counts,
    released,
    retained,
    flushCalls,
    terminateReasons,
    logs,
    published,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// I4：begin 记忆化
// ─────────────────────────────────────────────────────────────────────────────

test('I4 begin 记忆化：spawnTerminal 恰好一次，重复 begin 返回同一 Promise', async () => {
  const h = harness()

  const first = h.controller.begin(h.record, ['bash', '-i'])
  const second = h.controller.begin(h.record, ['bash', '-i'])
  assert.equal(first, second, 'begin 必须记忆化并返回同一个 Promise')

  await h.record.startGate.promise
  assert.equal(h.record.phase, 'running')
  assert.equal(h.spawn.spawnCalls.length, 1, 'spawnTerminal 恰好一次')
  assert.equal(h.published.length, 1, 'onPublished 恰好一次')
  assert.equal(h.published[0].handle, h.spawn.lastPty.handle)

  const spec = h.spawn.spawnCalls[0]
  assert.deepEqual(spec.argv, ['bash', '-i'])
  assert.equal(spec.graceMs, CONFIG.disposeGraceMs)
  assert.equal(spec.cols, CONFIG.cols)
  assert.equal(spec.rows, CONFIG.rows)
  assert.equal(spec.terminalType, 'xterm-256color')
  assert.equal(spec.signal, h.record.abort.signal)

  await h.controller.cancel(h.record, 'test done')
  await first
  assert.equal(h.spawn.spawnCalls.length, 1, '收口过程不得再次 spawn')
})

test('I4c begin 接受 index.js 的 {argv,cwd,cols,rows} 形态', async () => {
  const h = harness()

  const beginPromise = h.controller.begin(h.record, { argv: ['bash', '-i'], cwd: 'F:/ws', cols: 100, rows: 40 })
  await h.record.startGate.promise

  const spec = h.spawn.spawnCalls[0]
  assert.deepEqual(spec.argv, ['bash', '-i'])
  assert.equal(spec.cwd, 'F:/ws')
  assert.equal(spec.cols, 100)
  assert.equal(spec.rows, 40)
  assert.equal(spec.graceMs, CONFIG.disposeGraceMs)

  await h.controller.cancel(h.record, 'test done')
  await beginPromise
})

test('I4b 插件已卸载（lifecycle.closed）→ begin 不 spawn，按取消收口', async () => {
  const h = harness({ deps: { lifecycle: { closed: true } } })

  await h.controller.begin(h.record, ['bash'])

  assert.equal(h.spawn.spawnCalls.length, 0)
  assert.equal(h.record.cancelRequested, 'plugin teardown')
  assert.equal((await h.record.outcomeGate.promise).status, 'killed')
  assert.deepEqual(h.released, ['term-1'])
  await h.record.cleanupSettled.promise
})

// ─────────────────────────────────────────────────────────────────────────────
// C1 补充：未经 begin 的 setup-failed
// ─────────────────────────────────────────────────────────────────────────────

test('C1b setup-failed（未经 begin）：startGate 落定、Jobs failed、容量释放、不 flush', async () => {
  const h = harness()

  await h.controller.finish(h.record, { origin: 'setup-failed', error: new Error('confine failed') })

  const outcome = await h.record.outcomeGate.promise
  assert.equal(outcome.status, 'failed')
  assert.match(outcome.detail, /confine failed/)
  assert.equal(h.record.phase, 'failed')
  assert.equal(h.controller.attempts(h.record), 0, '无 PTY 不进入清理')
  assert.deepEqual(h.released, ['term-1'])
  assert.deepEqual(h.retained, ['term-1'])
  assert.deepEqual(h.flushCalls, [], '没有泵就不调 flushPump')
  await h.record.cleanupSettled.promise
  await assert.rejects(() => h.record.startGate.promise)
})

// ─────────────────────────────────────────────────────────────────────────────
// C2：spawn 抛错 → no-pty
// ─────────────────────────────────────────────────────────────────────────────

test('C2 spawn 抛错 → no-pty 收口：Jobs failed、不进 cleanup-failed、容量释放', async () => {
  const h = harness({ spawnOpts: { rejectWith: new Error('spawn boom') } })

  await h.controller.begin(h.record, ['bash'])
  const outcome = await h.record.outcomeGate.promise

  assert.equal(outcome.status, 'failed')
  assert.match(outcome.detail, /spawn boom/)
  assert.equal(h.record.phase, 'failed')
  assert.equal(h.record.spawnAttempted, true)
  assert.equal(h.record.spawnFinished, true)
  assert.equal(h.record.ptyCreated, false)
  assert.notEqual(h.record.phase, 'cleanup-failed')
  assert.equal(h.controller.attempts(h.record), 0)
  assert.deepEqual(h.terminateReasons, [], '没有 handle 不得调用 terminate')
  assert.deepEqual(h.released, ['term-1'])
  assert.deepEqual(h.retained, ['term-1'])
  await h.record.cleanupSettled.promise
  await assert.rejects(() => h.record.startGate.promise)
})

test('C2b onPublished 抛错 → publish-failed：PTY 被终止、Jobs failed、容量释放', async () => {
  const h = harness({
    deps: {
      onPublished: () => {
        throw new Error('publish boom')
      },
    },
  })

  const beginPromise = h.controller.begin(h.record, ['bash'])
  const outcome = await h.record.outcomeGate.promise

  assert.equal(outcome.status, 'failed')
  assert.match(outcome.detail, /publish boom/)
  assert.equal(h.record.phase, 'failed')
  assert.equal(h.spawn.lastPty.state.terminated, 1, '已创建的 PTY 必须被终止')
  assert.equal(h.controller.attempts(h.record), 1)
  assert.deepEqual(h.released, ['term-1'])
  await h.record.cleanupSettled.promise
  await beginPromise
  await assert.rejects(() => h.record.startGate.promise)
})

// ─────────────────────────────────────────────────────────────────────────────
// C3：spawn 未落定时取消
// ─────────────────────────────────────────────────────────────────────────────

test('C3 spawn 未落定时 cancel：等 spawnSettled、迟到的 handle 必须终止、期间不释放', async () => {
  const h = harness({ spawnOpts: { manual: true, ignoreAbort: true } })

  const beginPromise = h.controller.begin(h.record, ['bash'])
  await tick()
  assert.equal(h.record.phase, 'spawning')
  assert.equal(h.spawn.pendingCount(), 1)

  let spawnSettled = false
  h.record.spawnSettled.promise.then(() => {
    spawnSettled = true
  })

  const cancelPromise = h.controller.cancel(h.record, 'job_kill')
  await tick()

  assert.equal(h.record.cancelRequested, 'job_kill')
  assert.equal(spawnSettled, false, 'spawn 未落定前屏障不得通过')
  assert.deepEqual(h.released, [], 'spawn 未落定时绝不释放容量')
  assert.deepEqual(h.retained, [])
  assert.equal(h.spawn.spawnCalls.length, 1)

  const pty = makeFakePty({ pid: 777 })
  h.spawn.resolveNext(pty)
  await cancelPromise
  await beginPromise
  await h.record.outcomeGate.promise

  assert.equal(spawnSettled, true)
  assert.equal(h.record.ptyCreated, true)
  assert.equal(pty.state.terminated, 1, '迟到的 handle 必须恰好终止一次')
  assert.equal(h.controller.attempts(h.record), 1)
  assert.equal(h.record.phase, 'killed')
  assert.deepEqual(h.released, ['term-1'])
  assert.deepEqual(h.retained, ['term-1'])
  await h.record.cleanupSettled.promise
})

test('C3b spawn 前取消：不调用 spawnTerminal，晚到的 begin 也不得 spawn', async () => {
  const h = harness()

  await h.controller.cancel(h.record, 'owner release')
  const outcome = await h.record.outcomeGate.promise

  assert.equal(outcome.status, 'killed')
  assert.equal(h.record.phase, 'killed')
  assert.equal(h.spawn.spawnCalls.length, 0)
  assert.deepEqual(h.released, ['term-1'])

  await h.controller.begin(h.record, ['bash'])
  assert.equal(h.spawn.spawnCalls.length, 0, '取消后的 begin 不得 spawn')
  assert.equal(h.counts.outcomeResolves, 1)
  await h.record.cleanupSettled.promise
  await assert.rejects(() => h.record.startGate.promise)
})

// ─────────────────────────────────────────────────────────────────────────────
// C4：自然退出 / 退出码 / 信号
// ─────────────────────────────────────────────────────────────────────────────

test('C4a 自然退出 exitCode 0 → completed + exited，退出码落到 terminal.exitCode', async () => {
  const h = harness()
  const beginPromise = h.controller.begin(h.record, ['bash'])
  await h.record.startGate.promise
  h.record.served = true // 集成层在观察到就绪信标时置位：这个 shell 真正服役过

  h.spawn.lastPty.exit(0)
  const outcome = await h.record.outcomeGate.promise

  assert.equal(outcome.status, 'completed')
  assert.equal(h.record.phase, 'exited')
  assert.equal(h.record.terminal.exitCode, 0)
  assert.equal(h.record.terminal.signal, null)
  assert.match(h.record.terminal.detail, /exit code 0/)
  assert.equal(h.spawn.lastPty.state.terminated, 0, '已确认退出则无需 terminate')
  assert.deepEqual(h.released, ['term-1'])
  await h.record.cleanupSettled.promise
  await beginPromise
})

test('C4b 非 0 退出码 → failed + exited，退出码不丢失', async () => {
  const h = harness()
  const beginPromise = h.controller.begin(h.record, ['bash'])
  await h.record.startGate.promise
  h.record.served = true

  h.spawn.lastPty.exit(3)
  const outcome = await h.record.outcomeGate.promise

  assert.equal(outcome.status, 'failed')
  assert.equal(h.record.phase, 'exited')
  assert.equal(h.record.terminal.exitCode, 3)
  assert.equal(h.record.terminal.signal, null)
  assert.equal(h.spawn.lastPty.state.terminated, 0)
  await h.record.cleanupSettled.promise
  await beginPromise
})

test('C4c 信号退出 → killed，信号落到 terminal.signal', async () => {
  const h = harness()
  const beginPromise = h.controller.begin(h.record, ['bash'])
  await h.record.startGate.promise
  h.record.served = true

  h.spawn.lastPty.exit(null, 'SIGTERM')
  const outcome = await h.record.outcomeGate.promise

  assert.equal(outcome.status, 'killed')
  assert.equal(h.record.phase, 'killed')
  assert.equal(h.record.terminal.signal, 'SIGTERM')
  assert.equal(h.record.terminal.exitCode, null)
  await h.record.cleanupSettled.promise
  await beginPromise
})

test('C4d done 以 reject 落定 → 仍进 finish，Jobs status 合法', async () => {
  const h = harness()
  const beginPromise = h.controller.begin(h.record, ['bash'])
  await h.record.startGate.promise
  h.record.served = true

  h.spawn.lastPty.fail(new Error('pty transport failed'))
  const outcome = await h.record.outcomeGate.promise

  assert.ok(LEGAL_JOB_STATUS.includes(outcome.status), `status 必须合法，实际 ${outcome.status}`)
  assert.equal(h.record.phase, 'exited')
  assert.equal(h.record.terminal.exitCode, null)
  assert.match(h.record.terminal.detail, /exit code unknown/)
  assert.deepEqual(h.released, ['term-1'])
  await h.record.cleanupSettled.promise
  await beginPromise
})

test('C4e shell 启动期退出 → shell-exited（failed），不发布会话', async () => {
  const pty = makeFakePty({ pid: 555 })
  pty.exit(1)
  const h = harness({ spawnTerminal: async () => pty.handle })

  const beginPromise = h.controller.begin(h.record, ['bash'])
  const outcome = await h.record.outcomeGate.promise

  assert.equal(outcome.status, 'failed')
  assert.equal(h.record.phase, 'failed')
  assert.match(h.record.terminal.detail, /shell exited during startup/)
  assert.equal(h.published.length, 0, '启动期已退出不得发布会话')
  assert.equal(pty.state.terminated, 0)
  assert.deepEqual(h.released, ['term-1'])
  await h.record.cleanupSettled.promise
  await beginPromise
  await assert.rejects(() => h.record.startGate.promise)
})

test('C4f 已发布、未就绪即退出（served 未置）→ shell-exited，不得判 natural-exit', async () => {
  // C4a–C4d 全部显式置 served = true，只锁了"服役过"这一方向；C4e 是 publish
  // **之前**就退出（走 run() 里 facts.ptyExited 的显式分支，不经过 served）。
  // 缺的正是真机形态：会话已发布（phase = running）、就绪信标未到、shell 就崩。
  const h = harness()
  const beginPromise = h.controller.begin(h.record, ['bash'])
  await h.record.startGate.promise

  assert.equal(h.record.phase, 'running', '发布之后 phase 就是 running——分类不能依赖它')
  assert.notEqual(h.record.served, true, '集成层没观察到就绪信标')

  h.spawn.lastPty.exit(127)
  const outcome = await h.record.outcomeGate.promise

  assert.equal(outcome.status, 'failed', '起来就挂必须报 failed')
  assert.equal(h.record.phase, 'failed', '不得走 exited（"跑完了"）')
  assert.match(h.record.terminal.detail, /shell exited during startup/)
  assert.match(h.record.terminal.detail, /exit code 127/)
  assert.deepEqual(h.released, ['term-1'])
  await h.record.cleanupSettled.promise
  await beginPromise
})

// ─────────────────────────────────────────────────────────────────────────────
// C6：cleanup-failed 与重试
// ─────────────────────────────────────────────────────────────────────────────

test('C6 terminate 失败 → cleanup-failed；重试成功才释放；Jobs 不二次结算', async () => {
  const h = harness()
  const beginPromise = h.controller.begin(h.record, ['bash'])
  await h.record.startGate.promise
  const pty = h.spawn.lastPty

  pty.failNextTerminate('terminal cleanup failed; surviving pid: 4242')

  await h.controller.cancel(h.record, 'close')
  const first = await h.record.outcomeGate.promise

  assert.equal(first.status, 'failed')
  assert.equal(h.record.phase, 'cleanup-failed')
  assert.match(h.record.terminal.detail, /surviving pid: 4242/, 'detail 必须带错误原文')
  assert.equal(h.controller.attempts(h.record), 1)
  assert.equal(pty.state.terminated, 0)
  assert.deepEqual(h.released, [], 'cleanup-failed 期间容量保留')
  assert.deepEqual(h.retained, [])

  let cleanupSettled = false
  h.record.cleanupSettled.promise.then(() => {
    cleanupSettled = true
  })
  await tick()
  assert.equal(cleanupSettled, false, 'cleanup-failed 时 cleanupSettled 不得提前落定')

  // 重试：必须新建 attempt promise，否则拿到的永远是第一次失败的旧 Promise
  await h.controller.cancel(h.record, 'retry')
  assert.equal(h.controller.attempts(h.record), 2)
  assert.equal(pty.state.terminated, 1)
  assert.equal(h.record.phase, 'killed')
  assert.deepEqual(h.released, ['term-1'])
  assert.deepEqual(h.retained, ['term-1'])
  assert.equal(h.counts.outcomeResolves, 1, 'Jobs 只结算一次，重试不得二次落定')

  await h.record.cleanupSettled.promise
  assert.equal(cleanupSettled, true)
  await beginPromise
})

test('C6b 重试仍失败：保持 cleanup-failed、容量继续保留、仍可再次重试', async () => {
  const h = harness()
  const beginPromise = h.controller.begin(h.record, ['bash'])
  await h.record.startGate.promise
  const pty = h.spawn.lastPty

  pty.failNextTerminate('first failure')
  pty.failNextTerminate('second failure')

  await h.controller.cancel(h.record, 'close')
  assert.equal(h.record.phase, 'cleanup-failed')
  assert.equal(h.controller.attempts(h.record), 1)

  await h.controller.cancel(h.record, 'close again')
  assert.equal(h.record.phase, 'cleanup-failed')
  assert.equal(h.controller.attempts(h.record), 2)
  assert.deepEqual(h.released, [])
  assert.match(h.record.terminal.detail, /second failure/)

  await h.controller.cancel(h.record, 'close third')
  assert.equal(h.controller.attempts(h.record), 3)
  assert.equal(h.record.phase, 'killed')
  assert.deepEqual(h.released, ['term-1'])
  assert.equal(h.counts.outcomeResolves, 1)
  await h.record.cleanupSettled.promise
  await beginPromise
})

test('C6c terminate 成功但 handle.done 不落定：仍按已确认清理收口，不挂死', async () => {
  const pty = makeFakePty({ pid: 909 })
  const handle = {
    ...pty.handle,
    done: new Promise(() => {}),
    terminate: async () => {
      pty.state.terminated += 1
    },
  }
  const h = harness({ spawnTerminal: async () => handle })

  const beginPromise = h.controller.begin(h.record, ['bash'])
  await h.record.startGate.promise
  await h.controller.cancel(h.record, 'close')

  assert.equal(pty.state.terminated, 1)
  assert.equal(h.controller.attempts(h.record), 1)
  assert.equal(h.record.phase, 'killed')
  assert.deepEqual(h.released, ['term-1'])
  await h.record.cleanupSettled.promise
  await beginPromise
})

test('C6d terminateRecord 不 reject 但留下 terminateError → 仍判 cleanup-failed，重试后才释放', async () => {
  let failing = true
  const h = harness({
    deps: {
      // 复现 index.js attemptTerminate 的风格：吞掉异常，只把错误写进 record.terminateError
      terminateRecord: async (record) => {
        if (failing) record.terminateError = 'terminal cleanup failed; surviving pid: 4242'
      },
    },
  })

  const beginPromise = h.controller.begin(h.record, ['bash'])
  await h.record.startGate.promise

  await h.controller.cancel(h.record, 'close')
  assert.equal(h.record.phase, 'cleanup-failed')
  assert.match(h.record.terminal.detail, /surviving pid: 4242/)
  assert.deepEqual(h.released, [], '进程可能仍在，容量不得释放')

  failing = false
  await h.controller.cancel(h.record, 'retry')
  assert.equal(h.controller.attempts(h.record), 2)
  assert.equal(h.record.phase, 'killed')
  assert.deepEqual(h.released, ['term-1'])
  await h.record.cleanupSettled.promise
  await beginPromise
})

// ─────────────────────────────────────────────────────────────────────────────
// R1–R3：settleCleanup 的 release 与 enterRetention 必须各自结算
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 假 admission 探针：可分别让 release / enterRetention 抛错，并记录调用序列。
 * 为什么不用 harness 自带的：这三条要区分"调用过"与"容量真的归还了"。
 */
function makeAdmissionProbe() {
  const calls = []
  const released = []
  const retained = []
  let releaseFails = false
  let retentionFails = false
  return {
    calls,
    released,
    retained,
    setFailRelease(value) {
      releaseFails = value
    },
    setFailRetention(value) {
      retentionFails = value
    },
    admission: {
      release(record) {
        calls.push('release')
        if (releaseFails) throw new Error('release registry locked')
        released.push(record.id)
      },
      enterRetention(record) {
        calls.push('enterRetention')
        if (retentionFails) throw new Error('retention registry locked')
        retained.push(record.id)
      },
    },
  }
}

test('R1 enterRetention 抛错：容量已释放就不得回滚成 cleanup-failed，也不得二次 release', async () => {
  const probe = makeAdmissionProbe()
  probe.setFailRetention(true)
  const h = harness({ recordOverrides: { served: true }, deps: { admission: probe.admission } })

  const beginPromise = h.controller.begin(h.record, ['bash'])
  await h.record.startGate.promise
  h.spawn.lastPty.exit(0)

  const outcome = await h.record.outcomeGate.promise
  assert.equal(outcome.status, 'completed')
  assert.equal(h.record.phase, 'exited', 'enterRetention 失败不得改写终态')
  assert.notEqual(h.record.phase, 'cleanup-failed')
  assert.deepEqual(probe.calls, ['release', 'enterRetention'], '两项都要尝试，且 release 在前')
  assert.deepEqual(probe.released, ['term-1'], '容量必须已归还')
  assert.deepEqual(probe.retained, [], '保留期写入失败')
  assert.ok(
    h.logs.some((line) => /enterRetention/.test(line)),
    '保留期失败必须留日志，不得静默',
  )

  // cleanupSettled 是否落定用 flag + tick 观察：实现坏掉时用例干净地失败，而不是挂死
  let settled = false
  h.record.cleanupSettled.promise.then(() => {
    settled = true
  })
  await tick()
  assert.equal(settled, true, 'enterRetention 失败不得阻止 cleanupSettled 落定')

  // 重试路径：phase 已是终态，后续 cancel 不得再 release 一次
  await h.controller.cancel(h.record, 'retry')
  assert.equal(probe.calls.filter((name) => name === 'release').length, 1, 'release 恰好一次')
  assert.equal(h.record.phase, 'exited')

  await beginPromise
})

test('R2 release 抛错：判 cleanup-failed、cleanupSettled 不落定、容量未归还，重试后才放行', async () => {
  const probe = makeAdmissionProbe()
  probe.setFailRelease(true)
  const h = harness({ recordOverrides: { served: true }, deps: { admission: probe.admission } })

  const beginPromise = h.controller.begin(h.record, ['bash'])
  await h.record.startGate.promise
  h.spawn.lastPty.exit(0)

  await h.record.outcomeGate.promise
  assert.equal(h.record.phase, 'cleanup-failed')
  assert.deepEqual(probe.released, [], '容量未归还')
  assert.deepEqual(probe.retained, [], 'release 失败时不得进入保留期')

  let settled = false
  h.record.cleanupSettled.promise.then(() => {
    settled = true
  })
  await tick()
  assert.equal(settled, false, 'cleanup-failed 时 cleanupSettled 不得落定')

  // 重试路径必须仍然有效：release 成功后容量归还、cleanupSettled 落定
  probe.setFailRelease(false)
  await h.controller.cancel(h.record, 'retry')
  assert.equal(h.controller.attempts(h.record), 1)
  assert.equal(h.record.phase, 'killed')
  assert.deepEqual(probe.released, ['term-1'])
  assert.deepEqual(probe.retained, ['term-1'])
  assert.equal(h.counts.outcomeResolves, 1, 'Jobs 只结算一次，重试不得二次落定')

  // 用 flag + tick 而不是直接 await：实现坏掉时用例干净地失败，不挂死（连带取消下游用例）
  await tick()
  assert.equal(settled, true, '重试成功后 cleanupSettled 必须落定')

  await beginPromise
})

test('R3 release 与 enterRetention 都成功：各一次、cleanupSettled 落定、phase 终态', async () => {
  const probe = makeAdmissionProbe()
  const h = harness({ recordOverrides: { served: true }, deps: { admission: probe.admission } })

  const beginPromise = h.controller.begin(h.record, ['bash'])
  await h.record.startGate.promise
  h.spawn.lastPty.exit(0)

  const outcome = await h.record.outcomeGate.promise
  assert.equal(outcome.status, 'completed')
  assert.equal(h.record.phase, 'exited')
  assert.deepEqual(probe.calls, ['release', 'enterRetention'], 'release 先于 enterRetention')
  assert.deepEqual(probe.released, ['term-1'])
  assert.deepEqual(probe.retained, ['term-1'])

  let settled = false
  h.record.cleanupSettled.promise.then(() => {
    settled = true
  })
  await tick()
  assert.equal(settled, true, '两项都成功时 cleanupSettled 必须落定')

  await beginPromise
})

// ─────────────────────────────────────────────────────────────────────────────
// C7：并发取消
// ─────────────────────────────────────────────────────────────────────────────

test('C7 job_kill + close + owner release 并发：terminate 至多一次、finish 至多一次', async () => {
  const h = harness()
  const beginPromise = h.controller.begin(h.record, ['bash'])
  await h.record.startGate.promise
  const pty = h.spawn.lastPty

  await Promise.all([
    h.controller.cancel(h.record, 'job_kill'),
    h.controller.cancel(h.record, 'close'),
    h.controller.cancel(h.record, 'owner release'),
  ])
  const outcome = await h.record.outcomeGate.promise

  assert.equal(outcome.status, 'killed')
  assert.equal(h.record.phase, 'killed')
  assert.equal(h.controller.attempts(h.record), 1, 'terminate 尝试至多一次')
  assert.equal(pty.state.terminated, 1)
  assert.equal(h.counts.outcomeResolves, 1, 'Jobs 只结算一次')
  assert.equal(h.flushCalls.length, 1, 'flush 只发生一次')
  assert.deepEqual(h.released, ['term-1'], 'release 只发生一次')

  const once = h.controller.finish(h.record, { origin: 'cancel' })
  assert.equal(once, h.controller.finish(h.record, { origin: 'cancel' }), 'finish 幂等')

  await h.record.cleanupSettled.promise
  await beginPromise
  assert.equal(h.flushCalls.length, 1)
})

// ─────────────────────────────────────────────────────────────────────────────
// C8：卸载时推迟 Jobs 结算（关 DSH 不该唤醒 agent）
//
// 宿主只在 `cause === 'teardown'` 时抑制 job 完成通知，而那个 cause 只有宿主自己的
// teardown 路径会打（dsh-jobs-local 的 cancelForTeardown）。插件若抢先以 producer 身份
// 结算，通知照发、agent 被 followup 唤醒一轮——所以卸载必须先挂起、由宿主接管放行。
// ─────────────────────────────────────────────────────────────────────────────

test('C8 卸载挂起结算：宿主来 cancel 之前不得以 producer 结算', async () => {
  const h = harness()
  const begun = h.controller.begin(h.record, ['bash', '-i'])
  await h.record.startGate.promise

  // index.js teardown 的形态：先挂起，再关会话
  h.record.deferSettlement = true
  await h.controller.cancel(h.record, 'plugin unloaded', { keepDeferred: true })
  await tick()

  assert.equal(h.counts.outcomeResolves, 0, '挂起期间不得 resolve outcomeGate（那是唤醒 agent 的那条路）')
  assert.ok(!h.record.jobDoneResolved, 'jobDoneResolved 仍未置位')

  // 宿主 teardown 抵达：它的 settleCause 已经写成 teardown，此刻才放行
  assert.equal(h.controller.flushDeferred(h.record), true, '有挂起结算时才真的放行')
  const outcome = await h.record.outcomeGate.promise
  assert.equal(outcome.status, 'killed')
  assert.equal(h.counts.outcomeResolves, 1, '结算恰好一次')
  await begun
})

test('C8b 宿主 cancel 自己会放行挂起结算（不必等兜底定时器）', async () => {
  const h = harness()
  const begun = h.controller.begin(h.record, ['bash', '-i'])
  await h.record.startGate.promise

  h.record.deferSettlement = true
  await h.controller.cancel(h.record, 'plugin unloaded', { keepDeferred: true })
  await tick()
  assert.equal(h.counts.outcomeResolves, 0)

  // 第二次 cancel 来自宿主（jobs service disposed / owner dispose），先 flush 再收口
  await h.controller.cancel(h.record, 'jobs service disposed')
  const outcome = await h.record.outcomeGate.promise
  assert.equal(outcome.status, 'killed')
  assert.equal(h.counts.outcomeResolves, 1)
  await begun
})

test('C8c flushDeferred 在无挂起时是空操作（不重复结算）', async () => {
  const h = harness()
  const begun = h.controller.begin(h.record, ['bash', '-i'])
  await h.record.startGate.promise

  await h.controller.cancel(h.record, 'test done')
  assert.equal(h.counts.outcomeResolves, 1)
  assert.equal(h.controller.flushDeferred(h.record), false, '已结算过就不再结算')
  assert.equal(h.counts.outcomeResolves, 1)
  await begun
})

test('C8d 宿主 cancel 先于 finish 到达：挂起必须被撤掉，结算不能永远拖住', async () => {
  // 关机时的真实顺序不保证：宿主的 cancelForTeardown 可能在插件 finish 走到 settleJobs
  // 之前就到。若只在「已有结果」时才撤挂起，finish 随后会再推迟一次，而宿主正卡在
  // `await job.settled` 上——那就是关机多等一个永远不来的结算。
  const h = harness()
  const begun = h.controller.begin(h.record, ['bash', '-i'])
  await h.record.startGate.promise

  h.record.deferSettlement = true
  assert.equal(h.controller.flushDeferred(h.record), false, '此刻还没有可结算的结果')
  assert.equal(h.record.deferSettlement, false, '但挂起必须已经被撤掉')

  await h.controller.cancel(h.record, 'jobs service disposed')
  assert.equal(h.counts.outcomeResolves, 1, '之后的结算必须立刻生效')
  await begun
})


