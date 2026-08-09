import { afterEach, describe, expect, it } from 'vitest'
import {
  EXPIRY_SKEW_MS,
  beginAuthenticationAttempt,
  clearToken,
  getAuthenticatedUser,
  getToken,
  isExpired,
  setAuthenticatedUser,
  setToken,
  type AuthenticationAttempt,
} from '../../src/auth/token'

// 모듈 수준 상태라 테스트 간 누수를 막는다.
afterEach(() => {
  clearToken()
})

const NOW = 1_700_000_000_000
const USER = {
  id: '11111111-1111-4111-8111-111111111111',
  displayName: '테스터',
}

function storeToken(accessToken = 'jwt-abc', ttlSeconds = 3600): AuthenticationAttempt {
  const owner = beginAuthenticationAttempt()
  expect(setToken(owner, accessToken, ttlSeconds, NOW)).toBe(true)
  return owner
}

describe('토큰 스토어', () => {
  it('저장 직후에는 토큰을 그대로 돌려준다', () => {
    // Given/When: 1시간짜리 토큰 저장
    storeToken()

    // Then: 유효 + 그대로 반환
    expect(getToken(NOW)).toBe('jwt-abc')
    expect(isExpired(NOW)).toBe(false)
  })

  it('스큐 마진만큼 앞당겨 만료로 판정한다', () => {
    // Given: TTL 60초
    const ttlSeconds = 60
    storeToken('jwt-abc', ttlSeconds)
    const expiresAtMs = NOW + ttlSeconds * 1000

    // Then: 마진 경계 직전은 아직 유효, 경계부터는 만료 취급
    expect(isExpired(expiresAtMs - EXPIRY_SKEW_MS - 1)).toBe(false)
    expect(isExpired(expiresAtMs - EXPIRY_SKEW_MS)).toBe(true)
    expect(isExpired(expiresAtMs + 1)).toBe(true)
  })

  it('만료된 토큰은 없는 것과 같이 null 이다 — WS 무한 재접속을 애초에 막는 지점', () => {
    // Given: 60초 토큰
    storeToken('jwt-abc', 60)

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
    storeToken()

    // When: 로그아웃
    clearToken()

    // Then: 흔적 없음
    expect(getToken(NOW)).toBeNull()
  })

  it('stale 시도는 최신 세션을 commit하거나 rollback할 수 없다', () => {
    // Given: A 뒤에 시작한 B가 완전한 세션을 만들었다
    const ownerA = storeToken('jwt-a')
    const ownerB = storeToken('jwt-b')
    expect(setAuthenticatedUser(ownerB, USER, NOW)).toBe('committed')

    // When/Then
    expect(setAuthenticatedUser(ownerA, { ...USER, displayName: '사용자 A' }, NOW)).toBe('stale')
    expect(clearToken(ownerA)).toBe(false)
    expect(getToken(NOW)).toBe('jwt-b')
    expect(getAuthenticatedUser(NOW)).toEqual(USER)
  })

  it('로그아웃은 진행 중인 인증 시도도 무효화한다', () => {
    // Given
    const owner = beginAuthenticationAttempt()

    // When
    clearToken()

    // Then: 늦게 온 login 응답이 로그아웃 뒤 세션을 되살리지 못한다
    expect(setToken(owner, 'jwt-late', 3600, NOW)).toBe(false)
    expect(getToken(NOW)).toBeNull()
  })

  it('프로필 commit 시점에도 스큐 만료를 검사한다', () => {
    // Given: 60초 토큰의 스큐 경계
    const owner = storeToken('jwt-abc', 60)
    const commitAt = NOW + 60_000 - EXPIRY_SKEW_MS

    // When/Then
    expect(setAuthenticatedUser(owner, USER, commitAt)).toBe('expired')
    expect(getToken(commitAt)).toBeNull()
    expect(getAuthenticatedUser(commitAt)).toBeNull()
  })
})
