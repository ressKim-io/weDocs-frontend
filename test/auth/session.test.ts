import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TokenResponse, UserResponse } from '../../src/auth/api'
import { ApiError } from '../../src/common/http/client'
import { signIn, signUpAndSignIn } from '../../src/auth/session'
import {
  EXPIRY_SKEW_MS,
  clearToken,
  getAuthenticatedUser,
  getToken,
} from '../../src/auth/token'

const { fetchCurrentUserMock, loginMock, signupMock } = vi.hoisted(() => ({
  fetchCurrentUserMock: vi.fn(),
  loginMock: vi.fn(),
  signupMock: vi.fn(),
}))

vi.mock('../../src/auth/api', () => ({
  fetchCurrentUser: fetchCurrentUserMock,
  login: loginMock,
  signup: signupMock,
}))

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (cause: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

const TOKEN_A: TokenResponse = {
  accessToken: 'jwt-a',
  tokenType: 'Bearer',
  expiresInSeconds: 3600,
}
const TOKEN_B: TokenResponse = {
  accessToken: 'jwt-b',
  tokenType: 'Bearer',
  expiresInSeconds: 3600,
}
const USER_A: UserResponse = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'a@example.com',
  displayName: '사용자 A',
}
const USER_B: UserResponse = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'b@example.com',
  displayName: '사용자 B',
}

// 모듈 수준 세션과 mock 큐가 테스트 사이에 남지 않게 한다.
afterEach(() => {
  clearToken()
  fetchCurrentUserMock.mockReset()
  loginMock.mockReset()
  signupMock.mockReset()
  vi.useRealTimers()
})

describe('인증 bootstrap 소유권', () => {
  it('이전 프로필 성공이 최신 토큰에 이전 사용자를 붙이지 않는다', async () => {
    // Given: A 프로필만 지연되고 B는 완전히 성공한다
    const profileA = deferred<UserResponse>()
    loginMock.mockResolvedValueOnce(TOKEN_A).mockResolvedValueOnce(TOKEN_B)
    fetchCurrentUserMock.mockReturnValueOnce(profileA.promise).mockResolvedValueOnce(USER_B)

    const attemptA = signIn(USER_A.email, 'password-a')
    await vi.waitFor(() => expect(fetchCurrentUserMock).toHaveBeenCalledTimes(1))
    const attemptB = signIn(USER_B.email, 'password-b')

    // When: 최신 B를 commit한 뒤 A가 늦게 성공한다
    await expect(attemptB).resolves.toBe(true)
    profileA.resolve(USER_A)

    // Then: A는 stale로 폐기되고 token/user는 B 쌍을 유지한다
    await expect(attemptA).resolves.toBe(false)
    expect(getToken()).toBe(TOKEN_B.accessToken)
    expect(getAuthenticatedUser()).toEqual({ id: USER_B.id, displayName: USER_B.displayName })
  })

  it('이전 프로필 실패가 최신 성공 세션을 rollback하지 않는다', async () => {
    // Given
    const profileA = deferred<UserResponse>()
    loginMock.mockResolvedValueOnce(TOKEN_A).mockResolvedValueOnce(TOKEN_B)
    fetchCurrentUserMock.mockReturnValueOnce(profileA.promise).mockResolvedValueOnce(USER_B)

    const attemptA = signIn(USER_A.email, 'password-a')
    await vi.waitFor(() => expect(fetchCurrentUserMock).toHaveBeenCalledTimes(1))
    const attemptB = signIn(USER_B.email, 'password-b')
    await expect(attemptB).resolves.toBe(true)

    // When: stale A가 실패한다
    profileA.reject(new TypeError('profile A failed'))

    // Then: stale 오류는 UI로 전파되지 않고 B 세션을 지우지 않는다
    await expect(attemptA).resolves.toBe(false)
    expect(getToken()).toBe(TOKEN_B.accessToken)
    expect(getAuthenticatedUser()).toEqual({ id: USER_B.id, displayName: USER_B.displayName })
  })

  it('소유권은 로그인 응답이 아니라 인증 시도 시작 순서로 결정한다', async () => {
    // Given: 먼저 시작한 A의 login 응답만 늦는다
    const loginA = deferred<TokenResponse>()
    loginMock.mockReturnValueOnce(loginA.promise).mockResolvedValueOnce(TOKEN_B)
    fetchCurrentUserMock.mockResolvedValueOnce(USER_B)

    const attemptA = signIn(USER_A.email, 'password-a')
    const attemptB = signIn(USER_B.email, 'password-b')
    await expect(attemptB).resolves.toBe(true)

    // When
    loginA.resolve(TOKEN_A)

    // Then: A는 임시 토큰도 저장하지 않고 profile도 요청하지 않는다
    await expect(attemptA).resolves.toBe(false)
    expect(fetchCurrentUserMock).toHaveBeenCalledTimes(1)
    expect(getToken()).toBe(TOKEN_B.accessToken)
  })

  it('지연된 가입 응답도 더 최신 로그인 세션을 덮지 않는다', async () => {
    // Given
    const signupA = deferred<UserResponse>()
    signupMock.mockReturnValueOnce(signupA.promise)
    loginMock.mockResolvedValueOnce(TOKEN_B)
    fetchCurrentUserMock.mockResolvedValueOnce(USER_B)

    const attemptA = signUpAndSignIn(USER_A.email, 'password-a', USER_A.displayName)
    const attemptB = signIn(USER_B.email, 'password-b')
    await expect(attemptB).resolves.toBe(true)

    // When
    signupA.resolve(USER_A)

    // Then: stale 가입은 후속 login을 시작하지 않는다
    await expect(attemptA).resolves.toBe(false)
    expect(loginMock).toHaveBeenCalledTimes(1)
    expect(getToken()).toBe(TOKEN_B.accessToken)
  })

  it('회원가입 뒤 현재 시도의 login 실패는 UI로 전파한다', async () => {
    // Given: 계정 생성은 성공했지만 이어지는 login은 실패한다
    const loginFailure = new ApiError(401, 'invalid-credentials', 'invalid credentials')
    signupMock.mockResolvedValueOnce(USER_A)
    loginMock.mockRejectedValueOnce(loginFailure)

    // When/Then: current 실패를 stale 완료(false)로 삼키지 않는다
    await expect(
      signUpAndSignIn(USER_A.email, 'password-a', USER_A.displayName),
    ).rejects.toBe(loginFailure)
    expect(getToken()).toBeNull()
    expect(getAuthenticatedUser()).toBeNull()
  })

  it('프로필 도착 시 토큰이 스큐 만료 경계면 세션을 완성하지 않는다', async () => {
    // Given: 프로필 응답 직전에 토큰이 정확히 스큐 경계에 도달한다
    const now = 1_700_000_000_000
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const profile = deferred<UserResponse>()
    loginMock.mockResolvedValueOnce({
      ...TOKEN_A,
      expiresInSeconds: EXPIRY_SKEW_MS / 1000 + 1,
    })
    fetchCurrentUserMock.mockReturnValueOnce(profile.promise)

    const attempt = signIn(USER_A.email, 'password-a')
    await vi.waitFor(() => expect(fetchCurrentUserMock).toHaveBeenCalledTimes(1))

    // When
    vi.setSystemTime(Date.now() + 1000)
    profile.resolve(USER_A)

    // Then
    const error = await attempt.catch((cause) => cause)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(401)
    expect(getToken()).toBeNull()
    expect(getAuthenticatedUser()).toBeNull()
  })
})
