import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { login } from '../../src/auth/api'
import { ApiError } from '../../src/common/http/client'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockReset()
})

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('login — 응답 경계 검증', () => {
  it('계약을 지킨 응답은 그대로 통과시킨다', async () => {
    // Given
    fetchMock.mockResolvedValue(
      jsonResponse({ accessToken: 'jwt-abc', tokenType: 'Bearer', expiresInSeconds: 86400 }),
    )

    // When/Then
    await expect(login('user@example.com', 'password123')).resolves.toMatchObject({
      accessToken: 'jwt-abc',
      expiresInSeconds: 86400,
    })
  })

  // 200 인데 토큰이 없는 응답을 통과시키면 setToken(undefined, NaN) 이 조용히 성립한다 —
  // 증상은 한참 뒤 "로그인은 됐는데 매 요청이 401" 로 나타나 원인 추적이 로그인에서 멀어진다.
  it.each([
    ['필드 누락', { tokenType: 'Bearer' }],
    ['빈 토큰', { accessToken: '', tokenType: 'Bearer', expiresInSeconds: 3600 }],
    ['만료가 숫자가 아님', { accessToken: 'jwt-abc', tokenType: 'Bearer', expiresInSeconds: 'soon' }],
    ['본문이 null', null],
  ])('%s 응답은 즉시 실패시킨다', async (_label, body) => {
    // Given: HTTP 는 200 이지만 계약이 깨진 본문
    fetchMock.mockResolvedValue(jsonResponse(body))

    // When/Then
    const error = await login('user@example.com', 'password123').catch((e) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.code).toBe('malformed-response')
  })
})
