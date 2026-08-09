// auth feature 의 doc-service 호출. 타입은 서버 record 와 1:1 로 맞춘다(계약이 갈라지지 않도록).

import { ApiError, MALFORMED_RESPONSE_CODE, apiRequest } from '../common/http/client'

/// doc-service `UserResponse` — 서버가 엔티티를 노출하지 않으므로 passwordHash·systemRole 은 없다.
export interface UserResponse {
  readonly id: string
  readonly email: string
  readonly displayName: string
}

/// doc-service `TokenResponse`.
export interface TokenResponse {
  readonly accessToken: string
  readonly tokenType: string
  readonly expiresInSeconds: number
}

/// ⚠️ 가입은 **토큰을 주지 않는다** — 201 + `UserResponse` 뿐이다(`AuthController.signup`).
/// 가입 직후 세션이 필요하면 `login` 을 이어서 불러야 한다(→ `session.ts`).
/// 반환값의 필드를 소비하지 않으므로(계정 생성 자체가 목적) 별도 형태 검증은 두지 않는다.
export function signup(email: string, password: string, displayName: string): Promise<UserResponse> {
  return apiRequest<UserResponse>('/api/auth/signup', {
    method: 'POST',
    body: { email, password, displayName },
  })
}

export async function login(email: string, password: string): Promise<TokenResponse> {
  const body = await apiRequest<unknown>('/api/auth/login', {
    method: 'POST',
    body: { email, password },
  })
  return requireUsableToken(body)
}

/// awareness에 싣는 이름·색상 기준을 인증 주체에서 얻는다. 공개 `/api/auth/**`와 달리
/// 이 경로는 Bearer 인증이 필수이며, 이메일은 응답 계약 검증에만 쓰고 presence에는 노출하지 않는다.
export async function fetchCurrentUser(): Promise<UserResponse> {
  const body = await apiRequest<unknown>('/api/users/me', { method: 'GET' })
  return requireUser(body)
}

function requireUser(body: unknown): UserResponse {
  const candidate = body as Partial<UserResponse> | null | undefined
  const valid =
    typeof candidate?.id === 'string' &&
    candidate.id.length > 0 &&
    typeof candidate.email === 'string' &&
    candidate.email.length > 0 &&
    typeof candidate.displayName === 'string' &&
    candidate.displayName.length > 0
  if (!valid) {
    throw new ApiError(200, MALFORMED_RESPONSE_CODE, 'current user response was malformed')
  }
  return candidate as UserResponse
}

/// 응답도 외부 입력이다(secure-coding P1). 타입 단언만 믿고 저장하면 계약이 바뀐 순간
/// `setToken(undefined, NaN)` 이 조용히 성립하고, 증상은 한참 뒤 "로그인은 됐는데 매 요청이 401"
/// 로 나타나 원인 추적이 로그인에서 멀어진다. 경계에서 끊는다.
function requireUsableToken(body: unknown): TokenResponse {
  const candidate = body as Partial<TokenResponse> | null | undefined
  const usable =
    typeof candidate?.accessToken === 'string' &&
    candidate.accessToken.length > 0 &&
    Number.isFinite(candidate.expiresInSeconds)
  if (!usable) {
    // HTTP 는 성공했다 — 실패의 성격이 "전송"이 아니라 "계약"임을 코드로 남긴다.
    throw new ApiError(200, MALFORMED_RESPONSE_CODE, 'login response did not carry a usable token')
  }
  return candidate as TokenResponse
}
