import { afterEach, describe, expect, it } from 'vitest'
import { EXPIRY_SKEW_MS, clearToken, getToken, isExpired, setToken } from '../../src/auth/token'

// 모듈 수준 상태라 테스트 간 누수를 막는다.
afterEach(() => {
  clearToken()
})

const NOW = 1_700_000_000_000

describe('토큰 스토어', () => {
  it('저장 직후에는 토큰을 그대로 돌려준다', () => {
    // Given/When: 1시간짜리 토큰 저장
    setToken('jwt-abc', 3600, NOW)

    // Then: 유효 + 그대로 반환
    expect(getToken(NOW)).toBe('jwt-abc')
    expect(isExpired(NOW)).toBe(false)
  })

  it('스큐 마진만큼 앞당겨 만료로 판정한다', () => {
    // Given: TTL 60초
    const ttlSeconds = 60
    setToken('jwt-abc', ttlSeconds, NOW)
    const expiresAtMs = NOW + ttlSeconds * 1000

    // Then: 마진 경계 직전은 아직 유효, 경계부터는 만료 취급
    expect(isExpired(expiresAtMs - EXPIRY_SKEW_MS - 1)).toBe(false)
    expect(isExpired(expiresAtMs - EXPIRY_SKEW_MS)).toBe(true)
    expect(isExpired(expiresAtMs + 1)).toBe(true)
  })

  it('만료된 토큰은 없는 것과 같이 null 이다 — WS 무한 재접속을 애초에 막는 지점', () => {
    // Given: 60초 토큰
    setToken('jwt-abc', 60, NOW)

    // When/Then: 만료 후 조회는 null (호출자가 재접속 대신 재로그인으로 분기할 수 있다)
    expect(getToken(NOW + 60_000)).toBeNull()
  })

  it('토큰이 아예 없으면 만료로 판정한다', () => {
    // Given: 저장한 적 없음 / Then: "쓸 수 있는 토큰이 없다"는 결론이 같다
    expect(getToken(NOW)).toBeNull()
    expect(isExpired(NOW)).toBe(true)
  })

  it('clearToken 이후에는 남지 않는다', () => {
    // Given: 저장된 토큰
    setToken('jwt-abc', 3600, NOW)

    // When: 로그아웃
    clearToken()

    // Then: 흔적 없음
    expect(getToken(NOW)).toBeNull()
  })
})
