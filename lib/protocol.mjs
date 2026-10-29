/**
 * 极小的终端协议应答器：只回答「程序在等终端回话」的那几种查询。
 *
 * ## 为什么需要它
 *
 * 我们不是真终端：PTY 里的程序（readline、psql、部分安装器/REPL）会发 `ESC[6n`
 * （光标位置）、`ESC[c`（设备属性）这类**查询**，然后 synchronously 等回答。没有
 * 应答时它不会报错，只会等自己的超时——表现为「明明有输出，却像卡住了」。
 * 官方实现（dsh-terminal-bash）用 `@xterm/headless` 消费原始 PTY 并回写协议响应；
 * 这里不引依赖，只做等价的最小集。
 *
 * ## 已知近似（必须说清，不要当成完整终端）
 *
 * · 光标位置只跟踪**列**，行固定回 `1`：没有模拟器就没有屏幕模型，而行号在实践里
 *   几乎只被用来算列宽/换行；回一个假的列才会真的把程序算坏。
 * · 只处理 CSI 查询，不处理 DCS/OSC 查询（那些需要完整解释器）。
 * · 应答按控制序列原样写回 PTY 输入——与真终端一致；若 shell 恰好开着回显，
 *   这些字节可能出现在输出里。这是终端协议本身的代价，不是本模块的判断。
 */

/** 查询 → 应答。顺序有意义：`ESC[>c` 必须在 `ESC[c` 之前匹配。 */
const QUERIES = Object.freeze([
  { seq: '\x1b[>c', reply: () => '\x1b[>0;95;0c' }, // 次要设备属性（DA2）
  { seq: '\x1b[c', reply: () => '\x1b[?1;2c' }, // 主设备属性（DA1）：VT100 + 高级视频
  { seq: '\x1b[5n', reply: () => '\x1b[0n' }, // 设备状态报告：一切正常
  { seq: '\x1b[6n', reply: (state) => `\x1b[1;${state.col()}R` }, // 光标位置报告（行固定 1）
])

/**
 * 建一个应答器。
 *
 * @param {{cols?:number}} [options] PTY 列数（用于把列号夹在合法范围内）
 * @returns {{feed:(chunk:string)=>string[]}}
 */
export function createProtocolResponder(options = {}) {
  const cols = Number.isSafeInteger(options.cols) && options.cols > 0 ? options.cols : 120
  let column = 0 // 0-based 的可打印列位置
  let carry = '' // 跨 chunk 未决的转义前缀

  const clamp = () => Math.max(1, Math.min(cols, column + 1))

  function isQueryPrefix(rest) {
    return QUERIES.some((query) => rest.length < query.seq.length && query.seq.startsWith(rest))
  }

  /**
   * 跳过一个**非查询**转义序列，返回它占用的长度；不完整时返回 0（留给下一个 chunk）。
   */
  function skipEscape(rest) {
    if (rest.length < 2) return 0
    if (rest[1] === '[') {
      for (let i = 2; i < rest.length; i += 1) {
        const code = rest.charCodeAt(i)
        if (code >= 0x40 && code <= 0x7e) return i + 1
      }
      return 0
    }
    if (rest[1] === ']') {
      for (let i = 2; i < rest.length; i += 1) {
        if (rest[i] === '\x07') return i + 1
        if (rest[i] === '\x1b' && rest[i + 1] === '\\') return i + 2
      }
      return 0
    }
    return 2
  }

  return {
    /**
     * 喂一段原始 PTY 输出，返回**需要写回 PTY 的**应答（可能为空）。
     *
     * 只读输入、不改调用方的缓冲；跨 chunk 的半个转义序列由内部 carry 保存。
     *
     * @param {string} chunk
     * @returns {string[]}
     */
    feed(chunk) {
      if (typeof chunk !== 'string' || chunk.length === 0) return []
      const text = carry + chunk
      carry = ''
      const replies = []
      let i = 0
      while (i < text.length) {
        const ch = text[i]
        if (ch === '\x1b') {
          const rest = text.slice(i)
          const hit = QUERIES.find((query) => rest.startsWith(query.seq))
          if (hit !== undefined) {
            replies.push(hit.reply({ col: clamp }))
            i += hit.seq.length
            continue
          }
          if (isQueryPrefix(rest)) {
            carry = rest
            break
          }
          const skipped = skipEscape(rest)
          if (skipped === 0) {
            carry = rest
            break
          }
          i += skipped
          continue
        }
        if (ch === '\r' || ch === '\n') {
          column = 0
          i += 1
          continue
        }
        if (ch === '\b') {
          column = Math.max(0, column - 1)
          i += 1
          continue
        }
        const code = ch.charCodeAt(0)
        // 可打印字符才推进列；其余控制字符（BEL/TAB 等）不参与列计算
        if (code >= 0x20 && code !== 0x7f) {
          column += 1
          if (column > cols) column = cols // 不跟踪自动换行，够用即可
        }
        i += 1
      }
      return replies
    }
  }
}
