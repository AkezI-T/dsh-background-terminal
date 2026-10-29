/**
 * 增量读取：`terminal_read` / banner 共用的唯一消费例程（FINAL.md §10）。
 *
 * 薄封装：只调用 pump.consume 并推进 cursor.offset。
 * 等待新数据、lossy 提示、terminal 状态都由集成层负责；本模块不做等待、不复制输出。
 *
 * 只依赖相对导入，不 import 任何 `@deepseek-ai/*`。
 */

/**
 * 新游标。cursor 是普通对象 `{ offset }`（绝对 clean 字节偏移）。
 * @returns {{offset:number}}
 */
export function createCursor() {
  return { offset: 0 }
}

/**
 * 读一段增量并把游标推进到实际返回处；被 budgetChars 截掉的字节留在 ring。
 * @param {import('./contract.mjs').PUMP_SHAPE} pump 具备 consume 的泵
 * @param {{offset:number}} cursor
 * @param {{budgetChars:number, final?:boolean}} opts
 * @returns {import('./contract.mjs').ConsumeResult}
 */
export function read(pump, cursor, opts) {
  const result = pump.consume(cursor.offset, opts.budgetChars, { final: opts.final === true })
  cursor.offset = result.nextOffset
  return result
}
