import { describe, expect, it } from 'vitest'
import { DEFAULT_ROOM, MAX_ROOM_LENGTH, resolveWsUrl, sanitizeRoom } from '../src/connection'

describe('sanitizeRoom', () => {
  it('유효한 room(영숫자·하이픈·언더스코어·UUID·경계 길이)은 그대로 통과한다', () => {
    // Given/When/Then: 허용 문자·길이면 입력을 그대로 반환
    for (const raw of [
      'demo',
      'room-1',
      'page_42',
      '550e8400-e29b-41d4-a716-446655440000',
      'a'.repeat(MAX_ROOM_LENGTH),
    ]) {
      expect(sanitizeRoom(raw)).toBe(raw)
    }
  })

  it('null·빈 값·불허 문자·길이 초과는 기본 room으로 폴백한다', () => {
    // Given/When/Then: 위반/미지정이면 DEFAULT_ROOM
    for (const raw of [null, '', 'room/1', 'room 1', 'room.1', '../etc', '명', 'a'.repeat(MAX_ROOM_LENGTH + 1)]) {
      expect(sanitizeRoom(raw)).toBe(DEFAULT_ROOM)
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
