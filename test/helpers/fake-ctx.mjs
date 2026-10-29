/**
 * 共享测试设施：假 PTY、假 spawn、假 ctx。
 * 四个模块的测试都从这里取，避免各写一份导致语义漂移。
 *
 * 严格冷测试：不创建真实进程、不碰文件系统、不联网。
 */

import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

/** 极简 deferred。 */
export function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  promise.catch(() => {}) // 防止未处理拒绝（调用方各自消费）
  return { promise, resolve, reject }
}

/**
 * 假 PTY handle。
 * @param {{pid?:number}} [opts]
 */
export function makeFakePty(opts = {}) {
  const output = new Readable({ read() {} })
  const done = deferred()

  const state = {
    pid: opts.pid ?? 4242,
    output,
    done: done.promise,
    exited: false,
    written: [],
    terminated: 0,
    terminateRejects: 0, // >0 时 terminate 抛错
    terminateError: undefined,
    terminateDelayMs: 0,
    signalCalls: [],
    activityState: 'idle',
    foreground: { processGroupId: 4242, inputWaiting: false },
    spawnCalls: 0,
    ignoreAbort: opts.ignoreAbort === true,
  }

  state.handle = {
    pid: state.pid,
    output,
    done: done.promise,
    async terminate() {
      if (state.terminateDelayMs > 0) await new Promise((r) => setTimeout(r, state.terminateDelayMs))
      if (state.terminateRejects > 0) {
        state.terminateRejects -= 1
        throw new Error(state.terminateError ?? `terminal cleanup failed; surviving pid: ${state.pid}`)
      }
      state.terminated += 1
      if (!state.exited) {
        state.exited = true
        output.push(null)
        done.resolve({ exitCode: null, signal: null })
      }
    },
    async write(data) {
      if (state.exited) throw new Error('terminal process has exited')
      state.written.push(data)
    },
    async inspectForeground() {
      return state.foreground
    },
    async inspectActivity() {
      return { state: state.activityState, revision: 1 }
    },
    async signalForeground(signal) {
      state.signalCalls.push(signal)
      return state.foreground.processGroupId
    },
  }

  return {
    handle: state.handle,
    state,
    /** 推送一段 PTY 输出。 */
    emit(text) {
      output.push(Buffer.from(text, 'utf8'))
    },
    /** 推送原始字节。 */
    emitBytes(buf) {
      output.push(Buffer.from(buf))
    },
    /** 结束输出流（不改变 exited——由 done 决定）。 */
    endOutput() {
      output.push(null)
    },
    /**
     * 自然退出（干净）。
     *
     * 顺序与真实 `LocalTerminalHandle` 一致：**先 end 输出流，再落定 done**
     * （真实实现同样先 `this.output.end()` 才 `outcome.resolve(...)`）。
     * 两者都在同一微任务里完成，与 node-pty 的同步退出路径相同。
     */
    exit(exitCode = 0, signal = null) {
      state.exited = true
      output.push(null)
      done.resolve({ exitCode, signal })
    },
    /** done 以失败落定（传输层错误）。同样先结束输出流。 */
    fail(error = new Error('pty transport failed')) {
      state.exited = true
      output.push(null)
      done.reject(error)
    },
    /** 让下一次 terminate 抛错。 */
    failNextTerminate(message) {
      state.terminateRejects += 1
      state.terminateError = message
    },
    writeCalls() {
      return state.written.slice()
    },
  }
}

/**
 * 假 spawnTerminal。默认立刻返回一个假 PTY。
 * `spawnCalls` 记录每次调用的 spec，供“spawn 次数 = 0/1”断言使用。
 *
 * @param {{delayMs?:number, rejectWith?:Error, ignoreAbort?:boolean, manual?:boolean}} [opts]
 */
export function makeFakeSpawn(opts = {}) {
  const calls = []
  const pending = []
  const fake = {
    spawnCalls: calls,
    /** 手动模式：返回一个由测试 resolve 的 spawn 控制柄。 */
    resolveNext(pty) {
      const entry = pending.shift()
      if (entry === undefined) throw new Error('makeFakeSpawn: no pending spawn to resolve')
      entry.resolve(pty.handle)
      return pty
    },
    rejectNext(error) {
      const entry = pending.shift()
      if (entry === undefined) throw new Error('makeFakeSpawn: no pending spawn to reject')
      entry.reject(error)
    },
    pendingCount() {
      return pending.length
    },
    async spawnTerminal(spec) {
      calls.push(spec)
      if (opts.manual === true) {
        const d = deferred()
        pending.push(d)
        return d.promise
      }
      if (opts.delayMs !== undefined && opts.delayMs > 0) {
        await new Promise((r) => setTimeout(r, opts.delayMs))
      }
      if (opts.rejectWith !== undefined) throw opts.rejectWith
      if (opts.ignoreAbort === true) {
        // 刻意忽略 abort：用于复现“取消先到、handle 后到”
      } else if (spec.signal?.aborted === true) {
        throw new Error('aborted before spawn')
      }
      const pty = makeFakePty({ ignoreAbort: opts.ignoreAbort })
      fake.lastPty = pty
      return pty.handle
    },
  }
  return fake
}

/** 假 ownerCtx：记录 internal/dispatch 监听器，可手动 emit。 */
export function makeOwnerCtx(owner) {
  const handlers = []
  return {
    owner,
    handlers,
    on(name, handler) {
      handlers.push({ name, handler })
      return () => {
        const i = handlers.findIndex((h) => h.handler === handler)
        if (i >= 0) handlers.splice(i, 1)
      }
    },
    off(_name, handler) {
      const i = handlers.findIndex((h) => h.handler === handler)
      if (i >= 0) handlers.splice(i, 1)
    },
    /** 触发一次 internal/dispatch（模拟 session/event）。 */
    dispatch(eventName, args) {
      for (const entry of [...handlers]) entry.handler('default', eventName, args)
    },
  }
}

/**
 * 假 Cordis ctx。默认提供：sandboxPolicy / sessionProjections / jobs / subprocess / logger。
 * 测试可覆盖任意字段。
 */
export function makeFakeCtx(overrides = {}) {
  const logs = []
  const base = {
    logs,
    sandboxPolicy: {
      defaultMode: 'workspace-write',
      resolve: () => ({ mode: 'workspace-write', workspaceRoot: 'F:/ws' }),
    },
    sessionProjections: {
      stateOf: () => 'workspace-write',
    },
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    },
  }
  return Object.assign(base, overrides)
}
