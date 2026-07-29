// doc-service REST 호출의 단일 출처 — 크로스-feature 전송 어댑터.
// 인증 헤더 주입 · 타임아웃 · RFC 9457 에러 변환을 여기서 끝낸다.
//
// 왜 `src/api/` 가 아니라 `common/http/` 인가: `api/`·`service/` 류의 전역 계층 통패키지는
// feature 가 늘수록 비대해지고 한 기능의 코드가 여러 층에 흩어진다(layering-readability P7).
// feature 별 호출은 각 feature 안에(`auth/api.ts`), 공용 전송만 여기에 둔다.

import { getToken } from '../../auth/token'

/// 기본값 = 로컬 dev(doc-service REST). 배포 값은 M5 에서 주입한다.
const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8081'

/// 응답 대기 상한(secure-coding P2: 상한 없는 수신 경로 금지). 서버가 응답하지 않을 때
/// 무한 스피너 대신 명시적 실패로 끝낸다.
const REQUEST_TIMEOUT_MS = 10_000

/// 네트워크에 도달조차 못 한 실패는 HTTP 상태가 없다. 자리를 0 으로 고정해 호출자가
/// "서버 미도달"을 상태 코드만으로 구분할 수 있게 한다.
export const NETWORK_ERROR_STATUS = 0

/// HTTP 는 성공했는데 본문이 계약을 어긴 경우. 전송 실패·서버 오류와 구분해야 원인 추적이 갈리지 않는다.
export const MALFORMED_RESPONSE_CODE = 'malformed-response'

/// REST 실패의 단일 표현(error-handling P1 — 경계에서 한 타입으로 수렴시킨다).
///
/// ⚠️ `message`(서버 detail)를 파싱해 분기하지 않는다. 서버가 명시적으로 금지한 계약이다
/// (doc-service `GlobalExceptionHandler`: "detail 파싱 금지 → 기계 정보는 확장 멤버").
/// 분기는 항상 `code` 또는 `status` 로 한다.
export class ApiError extends Error {
  readonly status: number
  /// RFC 9457 확장 멤버. **도메인 예외에만 존재한다** — Bean validation 400 같은 프레임워크
  /// 경로는 `problemdetails` 가 처리해서 `code` 가 없다. 그래서 nullable 이다.
  readonly code: string | null

  constructor(status: number, code: string | null, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export interface ApiRequestInit {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  readonly body?: unknown
}

/// 실패는 전부 `ApiError` 로 던진다 — 호출자는 성공 경로만 다루면 된다.
export async function apiRequest<T>(path: string, init: ApiRequestInit): Promise<T> {
  const response = await send(path, init)
  if (!response.ok) {
    throw await toApiError(response)
  }
  return readBody<T>(response)
}

async function send(path: string, init: ApiRequestInit): Promise<Response> {
  const headers: Record<string, string> = {}
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }
  const token = getToken()
  // 토큰이 있을 때만 — 공개 경로(/api/auth/*)에 불필요한 자격증명을 싣지 않는다.
  if (token !== null) {
    headers.Authorization = `Bearer ${token}`
  }

  try {
    return await fetch(`${BASE_URL}${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (cause) {
    // fetch 는 네트워크 실패·중단에서 reject 한다. 그대로 새어 나가면 호출자가 두 종류의 실패
    // (HTTP 오류 vs 도달 실패)를 서로 다른 타입으로 다뤄야 하므로 여기서 ApiError 로 수렴시킨다.
    const timedOut = (cause as { name?: unknown } | null)?.name === 'TimeoutError'
    throw new ApiError(
      NETWORK_ERROR_STATUS,
      timedOut ? 'request-timeout' : 'network-unreachable',
      timedOut ? `request timed out after ${REQUEST_TIMEOUT_MS}ms` : 'server unreachable',
      { cause },
    )
  }
}

async function readBody<T>(response: Response): Promise<T> {
  // 204 No Content = 본문 없음(공유 PUT/DELETE 등). 호출자가 `apiRequest<void>` 로 선언한다.
  if (response.status === 204) {
    return undefined as T
  }
  // JSON 이 아닐 수 있다 — 프록시/인그레스가 HTML 오류 페이지를 돌려주는 경우가 대표적이다.
  if (!isJson(response)) {
    throw new ApiError(response.status, MALFORMED_RESPONSE_CODE, 'expected a JSON body')
  }
  try {
    return (await response.json()) as T
  } catch (cause) {
    // 원인(SyntaxError)을 버리지 않는다 — 계약이 바뀐 건지 중간 장비가 본문을 건드린 건지는
    // cause 없이 구분할 수 없다(error-handling P4).
    throw new ApiError(
      response.status,
      MALFORMED_RESPONSE_CODE,
      'response body was not valid JSON',
      { cause },
    )
  }
}

function isJson(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').includes('json')
}

/// 오류 응답의 본문 파싱은 **실패해도 무시한다.** 삼키는 게 아니라 폴백이 설계다 — 이미 보고할
/// 실패(HTTP 오류)가 있고, 파싱 실패는 `toApiError` 의 statusText 폴백이 흡수한다. 여기서 던지면
/// 원래 오류가 파싱 오류에 가려진다.
async function parseProblemLeniently(response: Response): Promise<unknown> {
  if (!isJson(response)) {
    return null
  }
  try {
    return await response.json()
  } catch {
    return null
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  const problem = await parseProblemLeniently(response)
  // 표시용 문구 폴백 사슬: RFC 9457 detail → title → HTTP statusText. statusText 는 HTTP/2 에서
  // 빈 문자열이라 마지막에 상태 코드로 받친다.
  const message =
    readString(problem, 'detail') ??
    readString(problem, 'title') ??
    (response.statusText || `HTTP ${response.status}`)
  return new ApiError(response.status, readString(problem, 'code'), message)
}

function readString(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const raw = (value as Record<string, unknown>)[key]
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}
