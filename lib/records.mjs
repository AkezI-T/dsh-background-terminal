/**
 * SessionRecord 注册表与预留（FINAL.md §6.1 / §6.3 / §6.11）。
 *
 * 职责边界：
 *  - `reserve()` 同步原子：参数校验 → 容量 → 围栏 → 建 record → 入注册表。
 *    任何拒绝都发生在返回之前，且不留副作用（§6.3）。
 *  - record 承载四个事实位与四个 Gate（§6.1）。本模块**不推断进程状态**：
 *    处置由 `dispositionOf(record)` 按事实位计算（事实位就在 record 顶层，
 *    所以 `dispositionOf(record)` 可直接调用）。
 *  - 容量按 phase 计算：`isActivePhase(phase)` 为真即计入，`cleanup-failed` 因此计入（§6.11）。
 *  - `release()` / `enterRetention()` 是仅有的两种终态处置，幂等，且顺序无关：
 *    终态记录只要还在保留期就仍可按 id 查到。
 *
 * 只依赖 `./contract.mjs`，不 import 任何其他模块实现。
 */

import { isActivePhase, isTerminalPhase } from './contract.mjs'

/** 兜底默认值，与 FINAL.md §14 配置表一致。 */
const DEFAULTS = Object.freeze({
  maxSessionsPerAgent: 4,
  maxSettledRetainedPerAgent: 4,
  settledRetainMs: 300000,
})

/** `createRecord()` 独立使用时的 id 序列；admission 自带序列（reserve 传显式 id）。 */
let standaloneSeq = 0

/**
 * 极简 deferred。挂一个 no-op catch：Gate 的 reject 由各自调用方消费，
 * 这里只保证未消费时不会变成 unhandledRejection。
 */
function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

/** owner 归一化：对象取 `.id`，也接受裸字符串 id。 */
function ownerKeyOf(owner) {
  if (typeof owner === 'string' && owner !== '') return owner
  if (owner !== null && typeof owner === 'object' && typeof owner.id === 'string' && owner.id !== '') {
    return owner.id
  }
  throw new TypeError('background-terminal: owner must be a non-empty string id or an object with a string "id"')
}

function requireInteger(value, name, fallback, { min }) {
  const resolved = value === undefined ? fallback : value
  if (typeof resolved !== 'number' || !Number.isInteger(resolved) || resolved < min) {
    throw new TypeError(`background-terminal: ${name} must be an integer >= ${min}, got ${String(value)}`)
  }
  return resolved
}

/**
 * 建一条 record。所有 Promise/AbortController 在任何 await 之前存在（§6.1）。
 *
 * @param {object|string} owner
 * @param {object} [init]    预留参数（index.js 的工具入参）
 * @param {object} [config]  预留配置：队列上限 + 可选 `id`
 */
export function createRecord(owner, init = {}, config = {}) {
  if (config === null || typeof config !== 'object') {
    throw new TypeError('background-terminal: createRecord config must be an object')
  }
  const ownerKey = ownerKeyOf(owner)
  const id = typeof config.id === 'string' && config.id !== '' ? config.id : `term-${++standaloneSeq}`

  return {
    id,
    owner,
    ownerKey,
    init: init ?? {},
    config: Object.freeze({ ...config }),
    jobId: undefined,
    session: undefined,
    handle: undefined,
    // spawn spec 取值（缺省由 controller 回落到 config.cols/rows 与 disposeGraceMs）
    cwd: init?.cwd,
    env: init?.env,
    cols: init?.cols,
    rows: init?.rows,
    // 本会话实际使用的 shell 与家族（由集成层在解析后写入；terminal_state 如实投影）。
    // 续签沿用同一条 record，所以这两个字段就是「这个会话用的哪个 shell」的唯一事实。
    shellPath: init?.shellPath,
    shellFlavor: init?.shellFlavor,
    reservation: { owner },
    abort: new AbortController(),
    // ── 四个 Gate（§6.1）────────────────────────────────────────────────
    startGate: createDeferred(),      // PTY 是否已发布：成功 resolve / 失败 reject
    outcomeGate: createDeferred(),    // Jobs 的可观察结果：恒 resolve，且始终带合法状态
    spawnSettled: createDeferred(),   // spawnTerminal 已落定（成功或失败）
    cleanupSettled: createDeferred(), // 最后一次清理尝试终态
    // ── 四个事实位（§6.1）──────────────────────────────────────────────
    spawnAttempted: false,
    spawnFinished: false,
    ptyCreated: false,
    ptyExited: false,
    // ── 生命周期 ───────────────────────────────────────────────────────
    phase: 'reserved',
    cancelRequested: null,
    terminateError: undefined,
    beginPromise: undefined,
    finishing: undefined,
    closeAttemptPromise: undefined,
    closeRetryCount: 0,
    jobDoneResolved: false,
    // ── 输入队列（§8.1：上限由 controller 在 enqueue 时执行）─────────────
    pendingWrites: [],
    pendingSignals: [],
    pendingWriteBytes: 0,
    limits: Object.freeze({
      maxPendingWriteBytes: config.maxPendingWriteBytes,
      maxPendingWriteCount: config.maxPendingWriteCount,
      maxPendingSignalCount: config.maxPendingSignalCount,
    }),
    // ── 唯一终态视图（terminal_read 的数据源，§9.3）────────────────────
    terminal: { exitCode: null, signal: null, detail: 'starting' },
    // ── 保留期记账 ─────────────────────────────────────────────────────
    retainedAt: undefined,
    releasedAt: undefined,
    evictedAt: undefined,
  }
}

/**
 * 注册表。返回 ADMISSION_SHAPE 描述的方法集合；reserve 是同步的。
 *
 * @param {object} [opts] AdmissionOptions + 可选 `settledRetainMs` / `now`（测试注入时钟）
 */
export function createAdmission(opts = {}) {
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) {
    throw new TypeError('background-terminal: createAdmission options must be an object')
  }
  const maxSessionsPerAgent = requireInteger(opts.maxSessionsPerAgent, 'maxSessionsPerAgent', DEFAULTS.maxSessionsPerAgent, { min: 1 })
  const maxSettledRetainedPerAgent = requireInteger(opts.maxSettledRetainedPerAgent, 'maxSettledRetainedPerAgent', DEFAULTS.maxSettledRetainedPerAgent, { min: 0 })
  const settledRetainMs = requireInteger(opts.settledRetainMs, 'settledRetainMs', DEFAULTS.settledRetainMs, { min: 0 })
  const now = typeof opts.now === 'function' ? opts.now : Date.now

  /** @type {Map<string, object>} 活动 + 保留期内的全部记录（id → record） */
  const records = new Map()
  /** @type {object[]} enterRetention 顺序 = LRU 顺序（最旧在前） */
  const retained = []
  let fence
  let seq = 0

  function lookup(id, owner) {
    const record = records.get(id)
    if (record === undefined) return undefined
    if (owner !== undefined && owner !== null && ownerKeyOf(owner) !== record.ownerKey) return undefined
    return record
  }

  function recordsOfOwner(ownerKey) {
    const found = []
    for (const record of records.values()) {
      if (record.ownerKey === ownerKey) found.push(record)
    }
    return found
  }

  /** 正在活动的记录（phase 非终态，cleanup-failed 计入）。 */
  function activeRecordsOfOwner(ownerKey) {
    return recordsOfOwner(ownerKey).filter((record) => isActivePhase(record.phase))
  }

  function sweepExpired() {
    const cut = now()
    for (let i = retained.length - 1; i >= 0; i -= 1) {
      const record = retained[i]
      if (cut - record.retainedAt >= settledRetainMs) {
        retained.splice(i, 1)
        records.delete(record.id)
        record.evictedAt = cut
      }
    }
  }

  function evictOverflow() {
    while (retained.length > maxSettledRetainedPerAgent) {
      const record = retained.shift()
      records.delete(record.id)
      record.evictedAt = now()
    }
  }

  const api = {
    /**
     * 同步预留。顺序即契约（§6.3）：① 参数 ② 容量 ③ 围栏 ④ record ⑤ 入注册表。
     * ② 之前的任何拒绝都不改动状态；③ 抛错时同样没有 record、没有容量占用。
     */    reserve(owner, init) {
      const ownerKey = ownerKeyOf(owner) // ① 参数校验
      if (init !== undefined && init !== null && (typeof init !== 'object' || Array.isArray(init))) {
        throw new TypeError('background-terminal: reserve init must be an object')
      }
      const active = activeRecordsOfOwner(ownerKey).length // ② 容量
      if (active >= maxSessionsPerAgent) {
        throw new Error(
          `background-terminal: owner "${ownerKey}" already has ${active} open terminal session(s) `
          + `(maxSessionsPerAgent=${maxSessionsPerAgent}); close one or wait for it to finish first`,
        )
      }
      if (fence !== undefined) {
        // ③ 围栏：同步安装，覆盖 confine 的 await 等待期（§12.2）。
        //    抛错即向上传播——此时既没有 record，也没有占用容量。
        const ownerCtx = init?.ownerCtx ?? owner.ctx
        fence.ensure(owner, ownerCtx)
      }
      const record = createRecord(owner, init ?? {}, {
        maxPendingWriteBytes: opts.maxPendingWriteBytes,
        maxPendingWriteCount: opts.maxPendingWriteCount,
        maxPendingSignalCount: opts.maxPendingSignalCount,
        id: `term-${++seq}`, // ④ record（四个 Gate + 四个事实位）
      })
      records.set(record.id, record) // ⑤ 入注册表 = 计入容量
      return record
    },

    /** 按 id 查（保留期内仍可查到）。给了 owner 就必须匹配。 */
    get(id, owner) {
      return lookup(id, owner)
    },

    /** `get(id, owner)` 的 owner-first 形式。 */
    find(owner, id) {
      return lookup(id, owner)
    },

    /** 该 owner 的全部记录（活动 + 保留期），按创建顺序。 */
    listForOwner(owner) {
      return recordsOfOwner(ownerKeyOf(owner))
    },

    /** 全部记录（活动 + 保留期），按创建顺序；index.js teardown 遍历用。 */
    allRecords() {
      return [...records.values()]
    },

    /** 该 owner 的活动会话数（phase 非终态，cleanup-failed 计入）。 */
    activeCount(owner) {
      return activeRecordsOfOwner(ownerKeyOf(owner)).length
    },

    /** 围栏判据（§6.11）：存在任意活动记录 → true。 */
    hasOwnerActivity(owner) {
      return activeRecordsOfOwner(ownerKeyOf(owner)).length > 0
    },

    /**
     * 终态处置之一：幂等。非保留期记录从注册表移除（= 容量 -1）；
     * 已在保留期的记录保留到 LRU/到期淘汰，不重复释放容量。
     */
    release(record) {
      if (record === null || typeof record !== 'object') return
      if (record.releasedAt === undefined) record.releasedAt = now()
      if (records.get(record.id) !== record) return // 已移除（或不属于本注册表）
      if (record.retainedAt === undefined) records.delete(record.id)
    },

    /**
     * 终态处置之二：进入保留期。要求终态 phase（否则会静默泄漏容量）。
     * 与 `release()` 顺序无关：后调用者不会让记录从注册表消失。
     */
    enterRetention(record) {
      if (record === null || typeof record !== 'object') return
      if (!isTerminalPhase(record.phase)) {
        throw new Error(
          `background-terminal: enterRetention requires a terminal phase (exited/killed/failed), `
          + `record ${record.id} is "${record.phase}"`,
        )
      }
      if (record.retainedAt !== undefined) return // 幂等：不改变 LRU 位置
      sweepExpired()
      record.retainedAt = now()
      records.set(record.id, record) // release() 先跑过时重新可查
      retained.push(record)
      evictOverflow()
    },

    /** 立即清扫：到期记录 + LRU 超额。 */
    sweepNow() {
      sweepExpired()
      evictOverflow()
    },

    /** 注册表大小：活动 + 保留期内（保留期内仍可按 id 查到）。 */
    size() {
      return records.size
    },

    /** index.js 注入围栏；reserve 时安装 handler。 */
    setFence(next) {
      if (next === undefined || next === null) {
        fence = undefined
        return
      }
      if (typeof next.ensure !== 'function') {
        throw new TypeError('background-terminal: setFence requires an object with ensure()')
      }
      fence = next
      // 反向绑定：fence 需要 hasOwnerActivity 作判据，而 createSandboxFence(ctx) 只拿到 ctx。
      // 这里把注册表自身交给 fence（FENCE_SHAPE 把 setFence 定为 index.js 的唯一注入点）。
      if (typeof next.attach === 'function') next.attach(api)
    },
  }

  return api
}
