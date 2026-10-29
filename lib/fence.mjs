/**
 * 沙箱模式变更围栏（FINAL.md §12.2 / PLAN.md §9.1）。
 *
 * 我们的 PTY 由 `ctx.subprocess.spawnTerminal` 直接创建，不计入 `ctx.terminals.hasOwnerActivity`，
 * 所以官方围栏对"仅我们有会话"不设防——这里自建一份：
 * 只要该 owner 还有活动记录（reserved/spawning/running/stopping/cleanup-failed），
 * 就拒绝切换到另一个 sandbox mode。
 *
 * 接线（index.js 拥有）：`const fence = createSandboxFence(ctx)`，随后 `admission.setFence(fence)`
 * 反向绑定活动判据；也可以直接 `createSandboxFence(ctx, admission)`。
 * handler 挂到 ownerCtx（`owner.ctx`，测试可用 init.ownerCtx 覆盖注入）；本模块不碰 owner.ctx.effect。
 *
 * 无依赖：只用语言内建。
 */

const DISPATCH_EVENT = 'internal/dispatch'
const SESSION_EVENT = 'session/event'
const MODE_EVENT = 'sandbox/mode'

function ownerKeyOf(owner) {
  if (typeof owner === 'string' && owner !== '') return owner
  if (owner !== null && typeof owner === 'object' && typeof owner.id === 'string' && owner.id !== '') {
    return owner.id
  }
  throw new TypeError('background-terminal: owner must be a non-empty string id or an object with a string "id"')
}

/**
 * @param {object} ctx 插件 ctx：需要 `sessionProjections`（缺了 ensure 抛错 = 挂载失败）与可选 `sandboxPolicy`
 * @param {object} [admission] 活动判据来源；常规用法是省略它，改由 `admission.setFence(fence)` 反向绑定。
 *   未绑定时 ensure/shouldBlock 抛错（不静默不设防）。
 *
 * 刻意**不**读 `ctx.admission`：Cordis 的 ctx 是代理，读取未出现在 `inject` 里的服务属性
 * 会直接抛 `cannot get property "…" without inject`，而围栏是在 `inject` 解析之前构造的。
 */
export function createSandboxFence(ctx, admission) {
  if (ctx === null || typeof ctx !== 'object') {
    throw new TypeError('background-terminal: createSandboxFence requires the plugin ctx')
  }
  let activity = admission
  if (activity !== undefined && activity !== null) assertAdmissionRegistry(activity)

  /** @type {Map<string, {owner:object, ownerCtx:object, listener:Function, off:unknown}>} */
  const installed = new Map()

  function assertAdmissionRegistry(candidate) {
    if (candidate === null || typeof candidate !== 'object' || typeof candidate.hasOwnerActivity !== 'function') {
      throw new TypeError(
        'background-terminal: the sandbox mode fence requires the admission registry '
        + '(pass createAdmission(...) to createSandboxFence, or let admission.setFence() attach it)',
      )
    }
  }

  function activityRegistry() {
    if (activity === undefined || activity === null) {
      throw new Error(
        'background-terminal: the sandbox mode fence has no admission registry attached; '
        + 'call admission.setFence(fence) while mounting the plugin',
      )
    }
    return activity
  }

  /**
   * 安全读取可选的 ctx 服务。
   *
   * Cordis 的 ctx 是代理：读取**未在 `inject` 里声明**的服务属性会抛
   * `cannot get property "…" without inject`，`?.` 挡不住。所以可选服务一律经这里读，
   * 读不到就返回 undefined。`logger` 就是这种"有更好、没有也能跑"的服务。
   */
  function optionalService(name) {
    try {
      const value = ctx[name]
      return value === null ? undefined : value
    } catch {
      return undefined
    }
  }

  /** `sessionProjections` 缺失即挂载失败（§6 服务依赖）。 */
  function requireSessionProjections() {
    const projections = ctx.sessionProjections
    if (projections === null || typeof projections !== 'object' || typeof projections.stateOf !== 'function') {
      throw new Error(
        'background-terminal: the sandbox mode fence requires the "sessionProjections" service '
        + '(stateOf(session, "sandboxMode") is unavailable)',
      )
    }
    return projections
  }

  /** 当前模式：投影状态优先，取不到回退 `sandboxPolicy.defaultMode`。 */
  function currentMode(owner) {
    const projected = requireSessionProjections().stateOf(owner?.session, 'sandboxMode')
    if (typeof projected === 'string' && projected !== '') return projected
    const fallback = optionalService('sandboxPolicy')?.defaultMode
    return typeof fallback === 'string' && fallback !== '' ? fallback : undefined
  }

  function rejectionText(current, next) {
    return `cannot change sandbox mode from "${current}" to "${next}" while background terminal sessions `
      + 'are open or being created; wait for creation to settle and close them first'
  }

  /**
   * 返回拒绝文案，或 undefined 表示放行。
   * 顺序：同一模式不误拒 → 无活动记录放行 → 否则拒绝。
   */
  function shouldBlock(owner, nextMode) {
    if (typeof nextMode !== 'string' || nextMode === '') return undefined
    const current = currentMode(owner)
    if (nextMode === current) return undefined
    if (activityRegistry().hasOwnerActivity(owner) !== true) return undefined
    return rejectionText(current, nextMode)
  }

  function onDispatch(owner, eventName, args) {
    if (eventName !== SESSION_EVENT) return
    const [session, event] = Array.isArray(args) ? args : []
    if (session !== owner.session) return
    if (event === null || typeof event !== 'object' || event.type !== MODE_EVENT) return
    const rejection = shouldBlock(owner, event.data?.mode)
    if (rejection !== undefined) throw new Error(rejection)
  }

  return {
    /** `admission.setFence(fence)` 的反向绑定：fence 由此拿到 hasOwnerActivity 判据。 */
    attach(registry) {
      assertAdmissionRegistry(registry)
      activity = registry
    },

    /** 每 owner 幂等安装一次；缺 sessionProjections / admission / ownerCtx 时抛错，且不记入已安装。 */
    ensure(owner, ownerCtx) {
      requireSessionProjections()
      activityRegistry()
      const key = ownerKeyOf(owner)
      if (installed.has(key)) return
      if (ownerCtx === null || typeof ownerCtx !== 'object' || typeof ownerCtx.on !== 'function') {
        throw new TypeError(
          `background-terminal: the sandbox mode fence needs an owner ctx with on() to guard owner "${key}"`,
        )
      }
      const listener = (_mode, eventName, args) => onDispatch(owner, eventName, args)
      const off = ownerCtx.on(DISPATCH_EVENT, listener)
      installed.set(key, { owner, ownerCtx, listener, off })
    },

    shouldBlock,

    /** 卸载全部 handler（插件 teardown）。off() 抛错也保证 installedCount() 归零。 */
    disposeAll() {
      try {
        for (const entry of installed.values()) {
          if (typeof entry.off === 'function') entry.off()
          else if (typeof entry.ownerCtx.off === 'function') entry.ownerCtx.off(DISPATCH_EVENT, entry.listener)
        }
      } finally {
        installed.clear()
      }
    },

    /** 测试用：已安装 handler 的 owner 数。 */
    installedCount() {
      return installed.size
    },
  }
}
