/**
 * 插件日志。
 *
 * 为什么需要它：真机调试时"shell 起来就 exit 127 且零输出"完全不可见——
 * spawn spec、就绪信标、退出码、清理结果全都没有痕迹，只能靠猜。
 * 现在这些点都有日志，而且**默认打开 `info`**：这类失败需要理由，不是噪音。
 *
 * 输出经 Cordis 的 `ctx.logger`（宿主会把它落到 stderr 日志文件），
 * 格式与宿主其它插件一致：`[background-terminal] [level] 消息 {结构}`。
 *
 * 硬约束：只用 `node:*` 与相对 import。
 */

/** 级别由低到高；选中某级即输出该级及以上。 */
export const LEVELS = Object.freeze(['silent', 'error', 'warn', 'info', 'debug'])

const RANK = Object.freeze({ silent: -1, error: 0, warn: 1, info: 2, debug: 3 })

const PREFIX = '[background-terminal]'

/** 对应 Cordis logger 的方法名；`silent` 不落任何方法。 */
const METHOD = Object.freeze({ error: 'error', warn: 'warn', info: 'info', debug: 'debug' })

function isLevel(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(RANK, value)
}

/** 递归深度上限：再深就截断，日志不该为了完整性把自己撑爆。 */
const MAX_DEPTH = 4

/**
 * 把一个值整棵渲染成字符串（顶层入口）。
 *
 * 刻意**不做** JSON.stringify：它会在循环引用上抛错、把 Error 序列化成 `{}`，
 * 而日志恰恰是在异常路径上最需要的东西。
 *
 * 循环判定只靠 `render` 内部的 `WeakSet`，**不往被渲染对象上写任何标记**：
 * 日志不得修改调用方的数据，而且标记一旦写在嵌套对象上，"返回前删掉"就只管得了
 * 顶层——被复用的对象会带着内部记账字段继续流传。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function describe(value) {
  return render(value, new WeakSet(), 0)
}

/**
 * 递归渲染。`seen` 只记录**当前路径上的祖先**（进入时加入、返回前移除），
 * 因此判定循环不会给入参留下持久状态，同一个对象出现在不同分支时也会各渲染一次。
 */
function render(value, seen, depth) {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (typeof value === 'string') return `"${value}"`
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`
  if (typeof value !== 'object') return String(value)

  if (seen.has(value)) return '[Circular]'
  if (depth >= MAX_DEPTH) return '[…]'
  seen.add(value)

  let text
  if (Array.isArray(value)) {
    const head = value.slice(0, 12).map((item) => render(item, seen, depth + 1))
    text = `[${head.join(', ')}${value.length > head.length ? `, …+${value.length - head.length}` : ''}]`
  } else {
    const keys = Object.keys(value)
    const head = keys.slice(0, 12).map((key) => {
      try {
        return `${key}: ${render(value[key], seen, depth + 1)}`
      } catch (error) {
        return `${key}: <读取失败 ${render(error, new WeakSet(), depth + 1)}>`
      }
    })
    text = `{${head.join(', ')}${keys.length > head.length ? `, …+${keys.length - head.length}` : ''}}`
  }

  seen.delete(value) // 允许同一对象在不同分支里各渲染一次（有向无环图）
  return text
}

/**
 * 建一个日志器。永远不抛：日志失败不得影响会话生命周期
 * （这点很重要——日志代码本身跑在失败路径上）。
 *
 * @param {object|undefined} logger Cordis 的 ctx.logger（可选）
 * @param {string} [level] silent|error|warn|info|debug
 */
export function createLog(logger, level = 'info') {
  const selected = isLevel(level) ? level : 'info'
  const threshold = RANK[selected]

  const emit = (name, args) => {
    if (RANK[name] > threshold) return
    // 第一个参数按惯例是**事件名**：裸文本，不加引号。
    // 其余参数是结构化上下文，用 describe 渲染成可读、可安全截断的形式。
    const [event, ...rest] = args
    const head = typeof event === 'string' ? event : describe(event)
    const tail = rest.map((arg) => describe(arg)).join(' ')
    const line = `${PREFIX} [${name}] ${head}${tail.length > 0 ? ` ${tail}` : ''}`
    try {
      // ctx.logger 的方法可能不存在（不同宿主实现不同），逐级回退到 console
      const method = logger?.[METHOD[name]]
      if (typeof method === 'function') {
        method.call(logger, line)
        return
      }
      if (typeof console?.[name] === 'function') console[name](line)
    } catch {
      // 日志失败不改变任何行为
    }
  }

  return {
    level: selected,
    error: (...args) => emit('error', args),
    warn: (...args) => emit('warn', args),
    info: (...args) => emit('info', args),
    debug: (...args) => emit('debug', args),
    /** 把一个值渲染成可读字符串（给 detail 复用同一套表示）。 */
    describe,
  }
}
