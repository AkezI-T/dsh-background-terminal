/**
 * 输出泵：PTY 原始字节 → 有状态 ANSI 剥离 → 有界 cleanBytes ring → sink / consume。
 * 顺序即契约（FINAL.md §9.1）：`raw → decode UTF-8 → ANSI strip → cleanBytes ring → sink`。
 *
 * 三条铁律：
 *  1. cleanBytes 只存 ANSI 剥离后的**原始字节**，包含未完整的 UTF-8 尾部。
 *     解码器产生的 U+FFFD 永不写回 ring：替换字符是**读取时**的产物，只在 final consume
 *     对残缺尾部产出恰好一次，由 finalEmitted 防重复（REVIEW4 第 7 条）。
 *  2. 未闭合的 ANSI 序列留在剥离器状态里：不写进 ring、不推进 total；flush 时丢弃。
 *  3. 消费按 **Unicode 字符边界**截断，被截掉的字节留在 ring，nextOffset 只推进到实际返回处。
 *
 * 只依赖 `node:*`；appendRaw 是同步函数。
 */

import { StringDecoder } from 'node:string_decoder'

/** cleanBytes ring 默认上限（FINAL.md §9.4：与 Jobs 文本环的 retainBytes 互相独立）。 */
export const DEFAULT_MAX_BUFFER_BYTES = 262_144

/**
 * lossy 读取时置于 text 首行的固定提示：只说明"更早的字节已被 ring 覆盖"。
 * 它是提示而非数据，不参与 budgetChars 计数。
 */
export const GAP_NOTICE = '[background-terminal] earlier output was dropped (buffer overflow)\n'

const REPLACEMENT = 0xFFFD

// ─────────────────────────────────────────────────────────────────────────────
// ANSI 剥离：字节级状态机（跨 chunk 保留状态，不按单 chunk 独立正则替换）
// ─────────────────────────────────────────────────────────────────────────────

const BYTE_ESC = 0x1B
const BYTE_BEL = 0x07

const TEXT = 0 // 普通数据
const SAW_ESC = 1 // 已见 ESC，等待序列种类
const SAW_ESC_INT = 2 // ESC + 中间字节（如 `(`），等待终止字节
const IN_CSI = 3 // ESC [ ... 终止字节 0x40-0x7E
const IN_OSC = 4 // ESC ] ... BEL 或 ST
const IN_OSC_ESC = 5 // OSC 内已见 ESC，等待 `\`
const IN_STR = 6 // ESC P / ^ / _ ... ST
const IN_STR_ESC = 7 // STR 内已见 ESC，等待 `\`

/**
 * 有状态 ANSI 剥离器。只把**完整序列之外**的字节交给调用方；
 * 未闭合序列的字节留在状态里，flush 时随状态一起丢弃。
 */
function createAnsiStripper() {
  let state = TEXT

  return {
    /**
     * 剥离一个 chunk。
     * @param {Buffer} chunk
     * @returns {Buffer} 保留下来的 clean 字节（可能是空 Buffer）
     */
    write(chunk) {
      const out = Buffer.allocUnsafe(chunk.length)
      let n = 0
      for (let i = 0; i < chunk.length; i += 1) {
        const b = chunk[i]
        if (state === TEXT) {
          if (b === BYTE_ESC) state = SAW_ESC
          else out[n++] = b
          continue
        }
        if (state === SAW_ESC) {
          if (b === 0x5B) state = IN_CSI // [
          else if (b === 0x5D) state = IN_OSC // ]
          else if (b === 0x50 || b === 0x5E || b === 0x5F) state = IN_STR // P ^ _
          else if (b >= 0x20 && b <= 0x2F) state = SAW_ESC_INT // 中间字节：再等一个终止字节
          else if (b >= 0x30 && b <= 0x7E) state = TEXT // 两字节转义：整条吞掉
          else if (b !== BYTE_ESC) {
            // 控制字节等非法续接：序列作废，该字节按普通数据重新处理
            state = TEXT
            out[n++] = b
          }
          continue
        }
        if (state === SAW_ESC_INT) {
          if (b >= 0x20 && b <= 0x2F) continue // 允许多个中间字节
          if (b >= 0x30 && b <= 0x7E) state = TEXT
          else if (b === BYTE_ESC) state = SAW_ESC
          else {
            state = TEXT
            out[n++] = b
          }
          continue
        }
        if (state === IN_CSI) {
          if (b >= 0x20 && b <= 0x3F) continue // 参数 / 中间字节
          if (b >= 0x40 && b <= 0x7E) state = TEXT // 终止字节
          else if (b === BYTE_ESC) state = SAW_ESC
          else {
            state = TEXT
            out[n++] = b
          }
          continue
        }
        if (state === IN_OSC) {
          if (b === BYTE_BEL) state = TEXT
          else if (b === BYTE_ESC) state = IN_OSC_ESC
          continue
        }
        if (state === IN_OSC_ESC) {
          if (b === 0x5C) state = TEXT // ST
          else if (b !== BYTE_ESC) state = IN_OSC
          continue
        }
        if (state === IN_STR) {
          if (b === BYTE_ESC) state = IN_STR_ESC
          continue
        }
        // IN_STR_ESC
        if (b === 0x5C) state = TEXT
        else if (b !== BYTE_ESC) state = IN_STR
      }
      return out.subarray(0, n)
    },

    /**
     * flush 收尾：丢弃未闭合控制序列。本实现从不缓存完整字节，
     * 完整字节在 write() 时已即时交出，因此这里没有需要补写的 clean 字节。
     */
    finish() {
      state = TEXT
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UTF-8：按 Unicode 字符边界解码（WHATWG 宽松语义，与 Buffer#toString 对齐）
// ─────────────────────────────────────────────────────────────────────────────

function isContinuation(b) {
  return b >= 0x80 && b <= 0xBF
}

/** 首字节 lead 允许的第二字节范围（过长编码 / 代理区 / 超出 U+10FFFF 判为非法）。 */
function isValidSecond(lead, b) {
  if (lead === 0xE0) return b >= 0xA0 && b <= 0xBF
  if (lead === 0xED) return b >= 0x80 && b <= 0x9F
  if (lead === 0xF0) return b >= 0x90 && b <= 0xBF
  if (lead === 0xF4) return b >= 0x80 && b <= 0x8F
  return b >= 0x80 && b <= 0xBF
}

/**
 * 解一个字符。
 * @param {Buffer} buf
 * @param {number} i
 * @returns {[number, number]} [码点, 消耗字节数]；非法字节产出 U+FFFD 且只消耗 1 字节
 */
function decodeOne(buf, i) {
  const b = buf[i]
  if (b < 0x80) return [b, 1]

  if (b >= 0xC2 && b <= 0xDF) {
    const b1 = buf[i + 1]
    if (b1 !== undefined && isValidSecond(b, b1)) return [((b & 0x1F) << 6) | (b1 & 0x3F), 2]
    return [REPLACEMENT, 1]
  }

  if (b >= 0xE0 && b <= 0xEF) {
    const b1 = buf[i + 1]
    if (b1 === undefined || !isValidSecond(b, b1)) return [REPLACEMENT, 1]
    const b2 = buf[i + 2]
    // 输入被截断或第三字节非法：整个合法前缀（最大子部分）作为一个替换字符
    if (b2 === undefined || !isContinuation(b2)) return [REPLACEMENT, 2]
    return [((b & 0x0F) << 12) | ((b1 & 0x3F) << 6) | (b2 & 0x3F), 3]
  }

  if (b >= 0xF0 && b <= 0xF4) {
    const b1 = buf[i + 1]
    if (b1 === undefined || !isValidSecond(b, b1)) return [REPLACEMENT, 1]
    const b2 = buf[i + 2]
    if (b2 === undefined || !isContinuation(b2)) return [REPLACEMENT, 2]
    const b3 = buf[i + 3]
    if (b3 === undefined || !isContinuation(b3)) return [REPLACEMENT, 3]
    return [((b & 0x07) << 18) | ((b1 & 0x3F) << 12) | ((b2 & 0x3F) << 6) | (b3 & 0x3F), 4]
  }

  return [REPLACEMENT, 1] // 0x80-0xC1、0xF5-0xFF
}

/**
 * 尾部"可被后续字节补全"的残缺序列长度：0 / 1 / 2 / 3。
 * 只有真正可能补全的前缀才算残缺；非法字节（如 0xE0 0x80）不算，
 * 它们立即按替换字符解码，不能无限期留待 final。
 * @param {Buffer} buf
 * @returns {number}
 */
function incompleteTailLength(buf) {
  const n = buf.length
  if (n === 0) return 0

  const last = buf[n - 1]
  // 尾部只有首字节（0xC2-0xF4 都是合法首字节）：缺少全部续字节
  if (last >= 0xC2 && last <= 0xF4) return 1
  if (!isContinuation(last)) return 0

  if (n >= 2) {
    const lead = buf[n - 2]
    // [三/四字节首字节][合法第二字节]：缺最后 1-2 个续字节
    if (lead >= 0xE0 && lead <= 0xF4) return isValidSecond(lead, last) ? 2 : 0
    // [四字节首字节][合法第二字节][续字节]：缺最后一个续字节
    if (n >= 3 && isContinuation(lead)) {
      const lead2 = buf[n - 3]
      if (lead2 >= 0xF0 && lead2 <= 0xF4 && isValidSecond(lead2, lead)) return 3
    }
  }
  return 0
}

/**
 * 从 buf 头部按字符边界解码，最多 budget 个码点。
 * @param {Buffer} buf
 * @param {number} budget 最多返回的 Unicode 字符数
 * @returns {{text:string, bytesUsed:number, truncated:boolean}}
 */
function decodeChars(buf, budget) {
  let text = ''
  let i = 0
  let chars = 0
  while (i < buf.length) {
    if (chars === budget) return { text, bytesUsed: i, truncated: true }
    const [codePoint, size] = decodeOne(buf, i)
    text += String.fromCodePoint(codePoint)
    i += size
    chars += 1
  }
  return { text, bytesUsed: i, truncated: false }
}

// ─────────────────────────────────────────────────────────────────────────────
// 有界字节环：绝对偏移、覆盖式淘汰
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 固定容量的字节环。偏移是绝对字节位置，淘汰只让 earliest 前进，绝不移动已分配的偏移。
 * @param {number} cap 保留字节上限
 */
function createByteRing(cap) {
  const buf = Buffer.allocUnsafe(cap)
  let start = 0 // buf 中最早保留字节的下标
  let retained = 0 // 保留字节数
  let total = 0 // 下一个追加字节的绝对偏移（= 曾经写入的全部 clean 字节数）

  return {
    get total() {
      return total
    },
    /** 最早保留字节的绝对偏移；无保留数据时等于 total。 */
    get earliest() {
      return total - retained
    },
    /** 保留区间 [from, to) 的字节副本，自动夹到 ring 覆盖范围。 */
    read(from, to) {
      const lo = Math.max(from, total - retained)
      const hi = Math.min(to, total)
      if (hi <= lo) return Buffer.alloc(0)
      const out = Buffer.allocUnsafe(hi - lo)
      let idx = (start + (lo - (total - retained))) % cap
      const head = Math.min(cap - idx, hi - lo)
      buf.copy(out, 0, idx, idx + head)
      if (head < hi - lo) buf.copy(out, head, 0, hi - lo - head)
      return out
    },
    /**
     * 追加 clean 字节并淘汰到 cap。
     * @param {Buffer} chunk
     * @returns {number} 本次被覆盖掉的字节数（含超出 cap 的新到字节）
     */
    append(chunk) {
      const width = chunk.length
      if (width === 0) return 0
      let lost = 0
      let src = chunk
      if (width > cap) {
        src = chunk.subarray(width - cap)
        lost += width - cap
      }
      const n = src.length
      const overflow = retained + n - cap
      if (overflow > 0) {
        start = (start + overflow) % cap
        retained -= overflow
        lost += overflow
      }
      const at = (start + retained) % cap
      if (at + n <= cap) {
        src.copy(buf, at)
      } else {
        const head = cap - at
        src.copy(buf, at, 0, head)
        src.copy(buf, 0, head)
      }
      retained += n
      total += width
      return lost
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 泵
// ─────────────────────────────────────────────────────────────────────────────

function toBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8')
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  throw new TypeError(`background-terminal: appendRaw expects Buffer|string, got ${typeof chunk}`)
}

/**
 * 创建输出泵。
 * @param {{maxBufferBytes?:number}} [options]
 */
/**
 * 帧标记过滤器（**字节级**，跨 chunk 安全）。
 *
 * 命令级 framing 的标记不该出现在调用方读到的正文里，但标记可能**跨 chunk**到达，
 * 所以按行缓冲：确认「这一行怎么处理」之后才放行，未完结的最后一行留到下次。
 *
 * ## 为什么必须在**字节层**做
 *
 * `ring` 是 `terminal_read` / `terminal_exec.output` 的**唯一**内容来源，
 * 而 `consume` 的偏移（`nextOffset`）与 cursor 都按 ring 的字节算。
 * 曾经把过滤只做在文本路（sink）上，ring 里仍是原始字节——结果 sink 干净了，
 * **`terminal_read` 照样看到标记**（真机实测）。反过来把 ring 存成"过滤后的字符串编码"
 * 又会让偏移与字节数漂移。
 *
 * 所以：过滤在字节层完成，**ring 与 sink 都拿同一份过滤后的字节**。字节账目因此精确，
 * 偏移与内容也始终对齐。标记全是 ASCII，按 `\n` 切分不会切坏多字节字符。
 *
 * ## 行形态（真机实测得来）
 *
 *   · **回显行** `PS F:\…>> [Console]::WriteLine("__…_S__"); <原命令>; …`
 *   · **纯标记行** `__…_S__` / `__…_E__<退出码>`
 *
 * 处理规则统一为一条：去掉**标记本身」与紧随其后的退出码**，其余字节原样保留。
 * 这样两种形态（纯标记行 / 带提示符的行）走同一条路径，也不会把提示符切出半截正文。
 * 退出码本身已在 `terminal_state.lastCommandExitCode` 里如实上报，正文里不必再留。
 */
function createMarkerFilter() {
  const PREFIX = Buffer.from('__DSH_BGTERM_', 'ascii')
  const START = Buffer.from('_S__', 'ascii')
  const END = Buffer.from('_E__', 'ascii')
  const EXIT_CODE = /^(?:\d+|cmdlet:(?:ok|fail))\r?/i

  /** 缓冲未完结的一行；null 表示空。 */
  let pending = null

  /** 这一行里有没有**完整**的标记？不能要求行首——真机回显会带提示符。 */
  function completeMarkerAt(buf) {
    const at = buf.indexOf(PREFIX)
    if (at < 0) return -1
    // 前缀之后必须出现完整的 `_S__` 或 `_E__`（只出现 `_S_` 算未完结）
    return buf.indexOf(START, at) >= 0 || buf.indexOf(END, at) >= 0 ? at : -1
  }

  /**
   * 处理一行**正文**（不含换行）：返回 `{ keep, keepEol }`。
   *
   *   · `keep`    —— 该保留的字节
   *   · `keepEol` —— 是否保留这一行的换行符
   *
   * 规则只有一条：**含完整标记的整行丢弃**。
   *
   * 为什么整行丢而不是"只删标记"：
   *   · 真机回显行是 `PS F:\…>> [Console]::WriteLine("__…_S__"); <原命令>; …`
   *     —— 只删标记会留下 `PS F:\…>> [Console]::WriteLine(""); <原命令>; …` 这种
   *     既难看又半截的正文；整行丢最干净。
   *   · 结束标记行 `__…_E__0` 同理。
   *
   * 唯一的例外：标记**在行首且前面只有空白**、后面紧跟退出码时，保留退出码
   * （纯标记行，`_E__7` → `7`），便于肉眼核对；此时换行也要保留，
   * 否则会得到 `0\n` 这种丢了 `\r` 的输出。
   */
  function processBody(buf) {
    const at = completeMarkerAt(buf)
    if (at < 0) return { keep: buf, keepEol: true } // 没有完整标记 → 一字节不动
    const before = buf.subarray(0, at)
    if (before.toString('latin1').trim().length === 0) {
      const endAt = buf.indexOf(END, at)
      if (endAt >= 0) {
        const code = EXIT_CODE.exec(buf.subarray(endAt + END.length).toString('latin1'))
        // 匹配里带上了 `\r`：它属于**行正文**（`_E__0\r` 的 `\r`），而循环只在
        // keepEol 为真时补 `\n`。只保留 `"0"` 就会丢掉 `\r`，得到 `0\n`（实测踩过）。
        if (code !== null) return { keep: Buffer.from(code[0], 'ascii'), keepEol: true }
      }
    }
    return { keep: Buffer.alloc(0), keepEol: false } // 含标记的整行 → 连同换行一起丢弃
  }

  /**
   * 尾行是否"可能长成标记"，必须继续缓冲。
   *
   * 三种情形：
   *   1. 整个缓冲区是 PREFIX 的前缀（逐字符喂入时走到这里）；
   *   2. 缓冲区**末尾**是不完整的 PREFIX —— 这是最容易漏的一种：
   *      `PS F:\…>> [Console]::WriteLine("__` 的末尾是 `__`，前缀在行中且被切断。
   *      只看"整个缓冲区是不是前缀"会把它放行，于是标记照旧漏进正文（实测）。
   *   3. 已含完整 PREFIX，但 `_S__` / `_E__` 还没到齐。
   *
   * 其它情况一律立即放行——无条件缓冲会扣住"没有换行的输出"，
   * 改变 ring 的字节可见时序（实测红 14 条 pump 测试）。
   */
  function mayBecomeMarker(buf) {
    if (buf.length === 0) return false
    const n = Math.min(buf.length, PREFIX.length)
    // 情形 1
    if (buf.length <= PREFIX.length && PREFIX.subarray(0, n).equals(buf.subarray(0, n))) return true
    // 情形 2：末尾 k 字节是 PREFIX 的前 k 字节
    const maxTail = Math.min(PREFIX.length - 1, buf.length)
    for (let k = maxTail; k > 0; k -= 1) {
      if (PREFIX.subarray(0, k).equals(buf.subarray(buf.length - k))) return true
    }
    // 情形 3
    return buf.indexOf(PREFIX) >= 0 && completeMarkerAt(buf) < 0
  }

  return {
    /**
     * @param {Buffer} chunk 已剥 ANSI 的 clean 字节
     * @returns {Buffer} 可安全交给 ring **与** sink 的字节
     */
    write(chunk) {
      if (chunk.length === 0) return chunk
      const combined = pending === null ? chunk : Buffer.concat([pending, chunk])
      const out = []
      let from = 0
      for (;;) {
        const nl = combined.indexOf(0x0a, from)
        if (nl < 0) break
        const { keep, keepEol } = processBody(combined.subarray(from, nl))
        out.push(keep)
        if (keepEol) out.push(combined.subarray(nl, nl + 1)) // 换行原样保留
        from = nl + 1
      }
      const rest = combined.subarray(from)
      if (rest.length === 0) {
        pending = null
        return Buffer.concat(out)
      }
      // 尾行（还没换行）：能判就判（标记可能在换行前就到齐），判不出来才缓冲。
      if (completeMarkerAt(rest) >= 0) {
        pending = null
        out.push(processBody(rest).keep)
        return Buffer.concat(out)
      }
      if (mayBecomeMarker(rest)) {
        pending = Buffer.from(rest) // 复制：subarray 是视图，底层 buffer 会被复用
      } else {
        pending = null
        out.push(rest)
      }
      return Buffer.concat(out)
    },
    /** 收尾：把缓冲里未完结的一行交出去（EOF 时调用）。 */
    flush() {
      if (pending === null) return Buffer.alloc(0)
      const rest = pending
      pending = null
      return rest
    },
  }
}
export function createPump(options = {}) {
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES
  if (!Number.isSafeInteger(maxBufferBytes) || maxBufferBytes <= 0) {
    throw new Error(
      `background-terminal: maxBufferBytes must be a positive safe integer, got ${JSON.stringify(maxBufferBytes)}`,
    )
  }

  const ring = createByteRing(maxBufferBytes)
  const stripper = createAnsiStripper()
  // 帧标记过滤器（**字节级**）：把 `__DSH_BGTERM_…_S__/_E__<code>` 从正文里去掉。
  const framer = createMarkerFilter()
  // ring 与 sink **共用**同一份过滤后的字节；sink 需要文本，所以这里增量解码。
  // 必须用 `StringDecoder` 而不是 `buf.toString('utf8')`：过滤后的输出仍可能在末尾留下
  // 残缺的多字节序列，直接 toString 会立刻吐出 U+FFFD（应当等到补全或 EOF）。
  const sinkDecoder = new StringDecoder('utf8')
  const sinks = new Set()
  let flushed = false
  let finalEmitted = false

  function emitSink(text) {
    if (text.length === 0) return
    for (const sink of sinks) sink.write(text)
  }

  /**
   * 同步追加一段 PTY 原始输出。
   *
   * 这里同时负责**帧标记抑制**：`__DSH_BGTERM_<nonce>_S__` / `_E__<退出码>` 是
   * 命令级 framing 的内部标记，属于实现细节，不该出现在调用方读到的正文里。
   *
   * 抑制全部在**一条**数据流上完成（`framer.write` 的返回值），再同时喂给 ring 与 sink：
   * ring 的 `totalBytes` 是 UTF-8 字节计数、而 `consume`/cursor 都以它为偏移，
   * 只过滤 sink 不过滤 ring 会让两者永久错位（`terminal_state.outputBytes` 与
   * `terminal_read.nextCursor` 对不上）。
   *
   * 标记行可能**跨 chunk**，所以过滤器按行缓冲，未完结的最后一行留到下一次。
   *
   * @param {Buffer|string} chunk
   * @returns {{lostBytes:number}}
   */
  function appendRaw(chunk) {
    if (flushed) return { lostBytes: 0 } // flush 后不再写入 ring
    const raw = toBuffer(chunk)
    if (raw.length === 0) return { lostBytes: 0 }
    const clean = stripper.write(raw)
    if (clean.length === 0) return { lostBytes: 0 }
    // 过滤在**字节层**完成，ring 与 sink 共用这一份结果：
    // 只把 sink 过滤掉是不够的——`terminal_read` / `terminal_exec.output` 读的是 **ring**，
    // 那样它们照样会看到标记（真机实测踩过）。
    const visible = framer.write(clean)
    if (visible.length === 0) return { lostBytes: 0 }
    const lostBytes = ring.append(visible)
    emitSink(sinkDecoder.write(visible))
    return { lostBytes }
  }
  /**
   * 把新产出的 clean 文本按顺序喂给 sink；sink 自己负责自己的保留与解码。
   * @param {{write:(text:string)=>void, end:()=>void}} sink
   * @returns {{detach:()=>void}}
   */
  function attachSink(sink) {
    sinks.add(sink)
    let detached = false
    return {
      detach() {
        if (detached) return
        detached = true
        sinks.delete(sink)
      },
    }
  }

  /**
   * 从 fromOffset 起增量消费，最多 budgetChars 个 Unicode 字符。
   * @param {number} fromOffset
   * @param {number} budgetChars
   * @param {{final?:boolean}} [opts] final：唯一一次对残缺 UTF-8 尾部产出替换字符
   * @returns {import('./contract.mjs').ConsumeResult}
   */
  function consume(fromOffset, budgetChars, opts = {}) {
    if (!Number.isSafeInteger(fromOffset) || fromOffset < 0) {
      throw new TypeError(`background-terminal: fromOffset must be a non-negative safe integer, got ${JSON.stringify(fromOffset)}`)
    }
    if (!Number.isSafeInteger(budgetChars) || budgetChars <= 0) {
      throw new TypeError(`background-terminal: budgetChars must be a positive safe integer, got ${JSON.stringify(budgetChars)}`)
    }
    const final = opts.final === true

    const total = ring.total
    const earliest = ring.earliest
    const lossy = fromOffset < earliest
    // 被覆盖时从 earliest 起宽松解码：它可能落在多字节字符中间。
    const start = lossy ? earliest : Math.min(fromOffset, total)

    const bytes = ring.read(start, total)
    // 非 final 把可补全的残缺尾部留在 ring；final 只替换一次，之后重复消费不再产出替换字符。
    // 只有真正读到了（含尾部在内）整段保留字节才算"这次 final 已经替换过"，
    // 否则 budget 恰好把尾部截在外面时替换字符会被永久丢掉。
    const holdback = final && !finalEmitted ? 0 : incompleteTailLength(bytes)
    const decodable = holdback > 0 ? bytes.subarray(0, bytes.length - holdback) : bytes
    const decoded = decodeChars(decodable, budgetChars)
    if (final && decoded.bytesUsed === bytes.length) finalEmitted = true

    return {
      text: lossy ? GAP_NOTICE + decoded.text : decoded.text,
      nextOffset: start + decoded.bytesUsed,
      consumedBytes: decoded.bytesUsed,
      lossy,
      gapBefore: lossy ? earliest - fromOffset : undefined,
      truncated: decoded.truncated,
    }
  }

  /**
   * 输出流 end 之后由集成层调用（集成层负责先等到 end）：
   * 丢弃未闭合控制序列 → 通知 sink 收尾。此后不再写入 ring。
   * 幂等。
   */
  async function flush() {
    if (flushed) return
    flushed = true
    stripper.finish()
    // 过滤器缓冲里可能还有未完结的一行：交出去（EOF 时它不可能再补全），
    // 并且**同样要写进 ring**——否则那段字节会从可读内容里消失。
    const tail = framer.flush()
    if (tail.length > 0) {
      ring.append(tail)
      emitSink(sinkDecoder.write(tail))
    }
    if (sinks.size > 0) {
      emitSink(sinkDecoder.end()) // 未完整 UTF-8 头部 → 恰好一个 U+FFFD，只进 sink
      for (const sink of sinks) sink.end()
    }
  }

  /**
   * 只读窥视：返回缓冲区内容**但不推进任何游标**。
   *
   * 用途是"通知尾部摘要"这类需要看内容却**不得消费**的场景
   * （`docs/terminal-notifications/OUTPUT_EVENTS_AND_LLM_WAKEUP.md` §5：
   * "通知尾部使用只读快照；若需要新增 peek API，应在 pump 层实现，
   * 避免借用 reader 的消费函数"）。
   *
   * 与 `consume` 的区别：`consume` 的调用方会拿到 `nextOffset` 并推进自己的
   * 游标（真正消费）；`peek` 只回一个快照，模型侧的 `terminal_read` cursor
   * 丝毫不受影响。因此通知/UI 观察输出不会"偷走"模型该读到的内容。
   *
   * @param {number} [fromOffset] 起始字节偏移；省略表示从最早可用处起
   * @param {number} [budgetChars] 最多返回的字符数
   * @returns {{text:string, fromOffset:number, toOffset:number, lossy:boolean, truncated:boolean, totalBytes:number}}
   */
  function peek(fromOffset, budgetChars = 2048) {
    const total = ring.total
    const earliest = ring.earliest
    const requested = Number.isSafeInteger(fromOffset) && fromOffset >= 0 ? fromOffset : earliest
    // 请求位置早于最早可用处 = 那段已被覆盖，如实报告丢失
    const lossy = requested < earliest
    const start = lossy ? earliest : Math.min(requested, total)
    const budget = Number.isSafeInteger(budgetChars) && budgetChars > 0 ? budgetChars : 2048
    const bytes = ring.read(start, total)
    // 非 final：可补全的残缺尾部留着不动（与 consume 一致，避免产生替换字符）
    const holdback = incompleteTailLength(bytes)
    const decodable = holdback > 0 ? bytes.subarray(0, bytes.length - holdback) : bytes
    const decoded = decodeChars(decodable, budget)
    return {
      text: decoded.text,
      fromOffset: start,
      toOffset: start + decoded.bytesUsed,
      lossy,
      truncated: decoded.truncated,
      totalBytes: total,
    }
  }

  return {
    appendRaw,
    attachSink,
    consume,
    flush,
    peek,
    /** 已写入 ring 的 clean 字节总数（不含未闭合 ANSI 序列）。 */
    totalBytes: () => ring.total,
  }
}
