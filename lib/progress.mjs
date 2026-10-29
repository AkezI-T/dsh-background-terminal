/**
 * 长任务可观测性：把"这个会话还在干活"变成一行**只读观测**的进度。
 *
 * 语义纪律（本模块最重要的约束）：
 *   进度行**只汇报观测值**——过了多久、产出多少字节、距上次输出多久、进程是否已退出。
 *   它**绝不判断"是否卡死"**。`npm install` 能静默工作数分钟，"没有输出"不等于"卡死"；
 *   判定留给调用方（模型/用户），本模块只把事实摆出来，不替调用方下结论。
 *
 * 两个硬约束：
 *   1. `renderProgress()` 是纯函数且**永不抛**——它跑在活动会话的定时器与 jobs 回调里，
 *      自身崩掉会把一个健康的长任务变成故障；
 *   2. 输出行**必须有界且单行**（≤ PROGRESS_MAX_CHARS），它要进 `/jobs` 面板的一行。
 *
 * 硬约束：只用 `node:*` 与相对 import；不 import 任何 `@deepseek-ai/*`。
 */

/** 进度行长度上限（UTF-16 码元）。面板是单行显示，超长只会在渲染层被截掉。 */
export const PROGRESS_MAX_CHARS = 200

/** 默认推送间隔：1s——足够让"还在干活"可见，又不至于把面板刷爆。 */
export const DEFAULT_PROGRESS_INTERVAL_MS = 1000

/** 极端输入下的兜底行：同样是单行、有界、不含任何判断。 */
const FALLBACK_LINE = 'progress unavailable'

/** 渲染值的最后一道防线：任何取值/转换都可能抛（getter、代理、Symbol）。 */
function safeString(value) {
  try {
    if (typeof value === 'string') return value
    if (value === undefined || value === null) return ''
    if (typeof value === 'symbol' || typeof value === 'bigint') return String(value)
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`
    return '[object]'
  } catch {
    return ''
  }
}

/**
 * 非负有限数。观测值只接受这个范围：`NaN`/`Infinity`/负数/`undefined` 一律视为"没观测到"，
 * 而不是当成 0 混进展示（把"不知道"伪装成"是 0"正是进度行最容易骗人的地方）。
 */
function finiteNumber(value) {
  try {
    if (typeof value !== 'number') return undefined
    return Number.isFinite(value) && value >= 0 ? value : undefined
  } catch {
    return undefined
  }
}

/** 时长：`0.4s` / `12.3s` / `3m05s` / `1h02m`。 */
export function formatDuration(ms) {
  const value = finiteNumber(ms) ?? 0
  const totalSeconds = Math.floor(value / 1000)
  if (totalSeconds < 60) return `${(value / 1000).toFixed(1)}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

/** 体积：`512B` / `45.2KB` / `1.2MB`（1024 进位，与 ring/输出环的口径一致）。 */
export function formatBytes(bytes) {
  const value = finiteNumber(bytes)
  if (value === undefined) return 'unknown'
  if (value < 1024) return `${Math.round(value)}B`
  const kb = value / 1024
  if (kb < 1024) return `${kb.toFixed(1)}KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)}MB`
  return `${(mb / 1024).toFixed(1)}GB`
}

/** 单行且 ≤ PROGRESS_MAX_CHARS；截断标记也算在预算内。 */
function clampLine(line) {
  const single = line.replace(/[\r\n]+/g, ' ')
  if (single.length <= PROGRESS_MAX_CHARS) return single
  return `${single.slice(0, PROGRESS_MAX_CHARS - 3)}...`
}

/**
 * 渲染一行进度。**纯函数、永不抛、有界、单行。**
 *
 * @param {{phase?:string, elapsedMs?:number, outputBytes?:number,
 *          lastOutputAgoMs?:number, exited?:boolean}} [state] 全部字段都是"观测值"；
 *        缺失即视为未观测到，渲染成 `unknown` / `no output yet`，绝不补默认值假装知道
 * @returns {string} 形如 `phase running · elapsed 12.3s · out 45.2KB · last 0.4s ago · alive`
 */
export function renderProgress(state) {
  try {
    const source = state !== null && typeof state === 'object' ? state : {}
    const phase = safeString(source.phase).replace(/[\r\n\t]+/g, ' ').trim() || 'unknown'

    // "没观测到"就写 unknown：NaN / Infinity / 负数 / 非数值都不是有效观测，
    // 把它们混成 0 或 0.0s 会让进度行看起来"知道"其实不知道的事。
    const elapsed = finiteNumber(source.elapsedMs) === undefined ? 'unknown' : formatDuration(source.elapsedMs)
    const output = finiteNumber(source.outputBytes) === undefined ? 'unknown' : formatBytes(source.outputBytes)

    // "没有输出"是观测事实，不是异常：明说 no output yet，不写 0.0s
    // （0.0s 会被读成"刚刚才输出过"，正好把要观察的东西说反）。
    const last = finiteNumber(source.lastOutputAgoMs) === undefined
      ? 'no output yet'
      : `last ${formatDuration(source.lastOutputAgoMs)} ago`

    const lifecycle = source.exited === true ? 'exited' : 'alive'
    return clampLine(`phase ${phase} · elapsed ${elapsed} · out ${output} · ${last} · ${lifecycle}`)
  } catch {
    // 定时器上的渲染绝不允许把异常抛回会话生命周期
    return FALLBACK_LINE
  }
}

/**
 * 进度观察器：累积"上次输出时间/输出字节"，按固定间隔把快照交给 `onTick`。
 *
 * `describe()` 由调用方提供动态字段（`phase`/`exited`）；本模块不认识 record，
 * 只认识"观测值 + 一次推送"。定时器、时钟、清理函数全部可注入，便于冷测试。
 *
 * 不变量：
 *  - `start()` 幂等，`stop()` 幂等且必定清掉定时器；
 *  - 已进入终态（`describe().exited === true`）时**只停、不推**——"终态后不再更新"；
 *  - `onTick`/`describe` 抛错都不会传播（定时器回调里抛 = uncaughtException）。
 *
 * @param {{intervalMs?:number, now?:()=>number, onTick?:(state:object)=>void,
 *          describe?:()=>({phase?:string, exited?:boolean}),
 *          setTimer?:Function, clearTimer?:Function}} [options]
 */
export function createProgressTracker(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now
  const intervalMs = Number.isSafeInteger(options.intervalMs) && options.intervalMs > 0
    ? options.intervalMs
    : DEFAULT_PROGRESS_INTERVAL_MS
  const setTimer = typeof options.setTimer === 'function' ? options.setTimer : setInterval
  const clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : clearInterval
  const describe = typeof options.describe === 'function' ? options.describe : () => ({})
  const onTick = typeof options.onTick === 'function' ? options.onTick : () => {}

  let startedAt
  let lastOutputAt
  let outputBytes = 0
  let timer

  function dynamicFields() {
    try {
      const described = describe()
      return described !== null && typeof described === 'object' ? described : {}
    } catch {
      return {}
    }
  }

  function tick() {
    if (timer === undefined) return false
    const state = snapshot()
    if (state.exited === true) {
      stop()
      return false
    }
    try {
      onTick(state)
    } catch {
      // 推送失败不得影响会话（下一次 tick 继续）
    }
    return true
  }

  function stop() {
    if (timer === undefined) return false
    clearTimer(timer)
    timer = undefined
    return true
  }

  function snapshot() {
    const at = now()
    return {
      ...dynamicFields(),
      elapsedMs: startedAt === undefined ? 0 : Math.max(0, at - startedAt),
      // 由 `noteOutput` 喂入。**调用方必须真的喂**：不喂的话这里恒为 0，
      // 进度行会一直显示 `out 0B · no output yet` —— 那正是这个功能存在的理由，
      // 却看不出任何异常（实测踩过：221 条测试全绿、功能静默失效）。
      // 所以别在这里加"回退到 describe"的第二条路：两处互为兜底会让单点变异
      // 测不出任何一侧，反而掩盖真实覆盖情况。
      outputBytes,
      lastOutputAgoMs: lastOutputAt === undefined ? undefined : Math.max(0, at - lastOutputAt),
    }
  }

  return {
    intervalMs,
    /** 幂等启动：已在跑时返回 false，不会产生第二个定时器。 */
    start() {
      if (timer !== undefined) return false
      startedAt = now()
      timer = setTimer(tick, intervalMs)
      // 心跳不该把宿主进程钉住（与 readyTimer/sweepTimer 一致）
      timer?.unref?.()
      return true
    },
    stop,
    /** 在 `handle.output.on('data')` 里调用：记录"产出过"这件事与时刻。 */
    noteOutput(bytes) {
      const width = finiteNumber(bytes) ?? 0
      outputBytes += width
      lastOutputAt = now()
      return outputBytes
    },
    isRunning() {
      return timer !== undefined
    },
    snapshot,
    /** 测试用：直接走一次定时器的逻辑（不依赖真实等待）。 */
    tick,
  }
}
