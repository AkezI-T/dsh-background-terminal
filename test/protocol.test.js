/**
 * 终端协议应答的冷测试（lib/protocol.mjs）。
 *
 * 这些查询的共同点：**程序会同步等回答**。没有应答时不报错、只卡到自己的超时——
 * 在持久终端里看起来与「进程卡死」完全一样，这正是这个模块存在的理由。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createProtocolResponder } from '../lib/protocol.mjs'

test('PR1 DA1：ESC[c 回 VT100+高级视频', () => {
  const r = createProtocolResponder()
  assert.deepEqual(r.feed('\x1b[c'), ['\x1b[?1;2c'])
})

test('PR2 DA2 优先于 DA1：ESC[>c 不能被当成 ESC[c', () => {
  const r = createProtocolResponder()
  assert.deepEqual(r.feed('\x1b[>c'), ['\x1b[>0;95;0c'])
})

test('PR3 设备状态报告：ESC[5n → ESC[0n', () => {
  const r = createProtocolResponder()
  assert.deepEqual(r.feed('\x1b[5n'), ['\x1b[0n'])
})

test('PR4 光标位置：按已输出的可打印列回 1-based 列号', () => {
  const r = createProtocolResponder({ cols: 80 })
  assert.deepEqual(r.feed('abc'), [], '普通文本不产生应答')
  assert.deepEqual(r.feed('\x1b[6n'), ['\x1b[1;4R'], 'abc 之后列号应为 4')
  r.feed('\r\n')
  assert.deepEqual(r.feed('\x1b[6n'), ['\x1b[1;1R'], '换行后回到第 1 列')
})

test('PR5 跨 chunk：半个查询要攒着，不能漏答也不能答两次', () => {
  const r = createProtocolResponder()
  assert.deepEqual(r.feed('\x1b[6'), [], '不完整时先不答')
  assert.deepEqual(r.feed('n'), ['\x1b[1;1R'], '补齐后恰好答一次')
  assert.deepEqual(r.feed('n'), [], '不会因为残留前缀再答一次')
})

test('PR6 非查询的转义序列被跳过：不产生应答，也不破坏后续列计数', () => {
  const r = createProtocolResponder()
  assert.deepEqual(r.feed('\x1b[31mred\x1b[0m'), [], '着色序列不是查询')
  assert.deepEqual(r.feed('\x1b[6n'), ['\x1b[1;4R'], 'red 三个字符之后列号是 4')
})

test('PR7 列号夹在 [1, cols]：不因超长行回一个越界值', () => {
  const r = createProtocolResponder({ cols: 10 })
  r.feed('x'.repeat(50))
  assert.deepEqual(r.feed('\x1b[6n'), ['\x1b[1;10R'])
})

test('PR8 空输入与非法输入不炸', () => {
  const r = createProtocolResponder()
  assert.deepEqual(r.feed(''), [])
  assert.deepEqual(r.feed(undefined), [])
})
