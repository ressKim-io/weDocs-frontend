import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, NETWORK_ERROR_STATUS, apiRequest } from '../../../src/common/http/client'
import { beginAuthenticationAttempt, clearToken, setToken } from '../../../src/auth/token'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockReset()
  clearToken()
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/// doc-service 가 실제로 내보내는 모양 — 도메인 예외는 확장 멤버 `code` 를 갖는다.
function problemResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  })
}

function lastRequestHeaders(): Record<string, string> {
  const call = fetchMock.mock.calls.at(-1) as [string, RequestInit] | undefined
  return (call?.[1].headers ?? {}) as Record<string, string>
}

describe('apiRequest — 인증 헤더', () => {
  it('토큰이 있으면 Bearer 로 싣는다', async () => {
    // Given: 유효 토큰
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 'p1' }))
    setToken(beginAuthenticationAttempt(), 'jwt-abc', 3600)

    // When
    await apiRequest('/api/pages/p1', { method: 'GET' })

    // Then
    expect(lastRequestHeaders().Authorization).toBe('Bearer jwt-abc')
  })

  it('토큰이 없으면 Authorization 을 싣지 않는다 — 공개 경로에 불필요한 자격증명을 보내지 않는다', async () => {
    // Given: 토큰 없음(로그인 요청 상황)
    fetchMock.mockResolvedValue(jsonResponse(200, { accessToken: 'x' }))

    // When
    await apiRequest('/api/auth/login', { method: 'POST', body: { email: 'a@b.co' } })

    // Then
    expect(lastRequestHeaders().Authorization).toBeUndefined()
    expect(lastRequestHeaders()['Content-Type']).toBe('application/json')
  })

  it('만료된 토큰은 싣지 않는다', async () => {
    // Given: 이미 만료된 토큰 (스토어가 만료를 판정한다)
    fetchMock.mockResolvedValue(jsonResponse(200, {}))
    setToken(beginAuthenticationAttempt(), 'jwt-old', 60, Date.now() - 120_000)

    // When
    await apiRequest('/api/pages', { method: 'GET' })

    // Then
    expect(lastRequestHeaders().Authorization).toBeUndefined()
  })
})

describe('apiRequest — 에러 변환', () => {
  it('도메인 예외의 확장 멤버 code 를 그대로 노출한다', async () => {
    // Given: 401 invalid-credentials
    fetchMock.mockResolvedValue(
      problemResponse(401, {
        type: 'https://wedocs.io/errors/invalid-credentials',
        title: 'Unauthorized',
        status: 401,
        detail: 'invalid credentials',
        code: 'invalid-credentials',
      }),
    )

    // When/Then
    const error = await apiRequest('/api/auth/login', { method: 'POST', body: {} }).catch((e) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(401)
    expect(error.code).toBe('invalid-credentials')
    expect(error.message).toBe('invalid credentials')
  })

  it('code 가 없는 검증 400 은 code=null 로 두고 detail 을 문구로 쓴다', async () => {
    // Given: Bean validation 400 — 프레임워크 경로라 확장 멤버 code 가 없다
    fetchMock.mockResolvedValue(
      problemResponse(400, {
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: 'Invalid request content.',
      }),
    )

    // When/Then: code 를 지어내지 않는다 — 호출자는 status 로 분기해야 한다
    const error = await apiRequest('/api/auth/signup', { method: 'POST', body: {} }).catch((e) => e)
    expect(error.status).toBe(400)
    expect(error.code).toBeNull()
    expect(error.message).toBe('Invalid request content.')
  })

  it('JSON 이 아닌 오류 본문(프록시 HTML 등)도 ApiError 로 수렴한다', async () => {
    // Given: 인그레스가 돌려준 HTML 오류 페이지
    fetchMock.mockResolvedValue(
      new Response('<html>502</html>', {
        status: 502,
        statusText: 'Bad Gateway',
        headers: { 'content-type': 'text/html' },
      }),
    )

    // When/Then: SyntaxError 가 새어 나가지 않는다
    const error = await apiRequest('/api/pages', { method: 'GET' }).catch((e) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(502)
    expect(error.code).toBeNull()
    expect(error.message).toBe('Bad Gateway')
  })

  it('네트워크 도달 실패는 status 0 으로 구분 가능하게 만든다', async () => {
    // Given: 서버 미기동 — fetch 자체가 reject
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))

    // When/Then
    const error = await apiRequest('/api/auth/login', { method: 'POST', body: {} }).catch((e) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(NETWORK_ERROR_STATUS)
    expect(error.code).toBe('network-unreachable')
  })

  it('타임아웃은 network-unreachable 과 구분한다', async () => {
    // Given: AbortSignal.timeout 발화와 같은 형태의 거절
    const timeout = new Error('timed out')
    timeout.name = 'TimeoutError'
    fetchMock.mockRejectedValue(timeout)

    // When/Then
    const error = await apiRequest('/api/pages', { method: 'GET' }).catch((e) => e)
    expect(error.status).toBe(NETWORK_ERROR_STATUS)
    expect(error.code).toBe('request-timeout')
  })
})

describe('apiRequest — 본문 처리', () => {
  it('204 No Content 는 본문 없이 정상 종료한다', async () => {
    // Given: 공유 PUT 처럼 본문 없는 성공
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))

    // When/Then: 파싱을 시도하지 않는다
    await expect(
      apiRequest<void>('/api/pages/p1/permissions/u1', { method: 'PUT', body: { level: 'VIEWER' } }),
    ).resolves.toBeUndefined()
  })

  it('JSON 을 기대했는데 아니면 명시적으로 실패한다', async () => {
    // Given: 200 인데 본문이 JSON 이 아님
    fetchMock.mockResolvedValue(
      new Response('not json', { status: 200, headers: { 'content-type': 'text/plain' } }),
    )

    // When/Then: undefined 를 조용히 흘리지 않는다
    const error = await apiRequest('/api/pages', { method: 'GET' }).catch((e) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.code).toBe('malformed-response')
  })
})
