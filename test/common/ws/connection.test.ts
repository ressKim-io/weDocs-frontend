import { describe, expect, it } from 'vitest'
import { parseRoom, resolveWsUrl } from '../../../src/common/ws/connection'

const PAGE_UUID = '550e8400-e29b-41d4-a716-446655440000'

describe('parseRoom', () => {
  it('페이지 UUID 는 그대로 통과한다(대소문자 무관)', () => {
    // Given/When/Then: room = 페이지 UUID
    expect(parseRoom(PAGE_UUID)).toBe(PAGE_UUID)
    expect(parseRoom(PAGE_UUID.toUpperCase())).toBe(PAGE_UUID.toUpperCase())
  })

  it('UUID 가 아니면 null 이다 — 문자집합만 맞는 값도 거부한다', () => {
    // Given/When/Then: 게이트웨이 인가는 doc_id 가 UUID 가 아니면 CheckPermission 왕복 없이 403 이다.
    // 예전 기본값 `demo` 는 엔진 DocId 문자집합은 통과하지만 **무조건 403** 이었다 —
    // 그 값으로 연결을 시도하면 브라우저는 원인(401/403)을 보지 못한 채 1006 재접속만 반복한다.
    for (const raw of [
      null,
      '',
      'demo',
      'room-1',
      'page_42',
      '550e8400-e29b-41d4-a716',
      '550e8400e29b41d4a716446655440000',
      '550e8400-e29b-41d4-a716-44665544000g',
      ` ${PAGE_UUID}`,
      `${PAGE_UUID}/../etc`,
    ]) {
      expect(parseRoom(raw)).toBeNull()
    }
  })
})

describe('resolveWsUrl', () => {
  it('https 페이지에서 ws:// 를 wss:// 로 승격한다', () => {
    // Given/When/Then: 보안 페이지 + 평문 ws:// → wss:// 승격
    expect(resolveWsUrl('ws://gw.example/ws/doc', 'https:')).toBe('wss://gw.example/ws/doc')
  })

  it('http 페이지(dev)에서는 ws:// 를 유지한다', () => {
    // Given/When/Then: dev(http) → 무변경
    expect(resolveWsUrl('ws://localhost:8080/ws/doc', 'http:')).toBe('ws://localhost:8080/ws/doc')
  })

  it('이미 wss:// 면 프로토콜과 무관하게 그대로 둔다', () => {
    // Given/When/Then: 이미 wss:// → 무변경
    expect(resolveWsUrl('wss://gw.example/ws/doc', 'https:')).toBe('wss://gw.example/ws/doc')
  })
})
