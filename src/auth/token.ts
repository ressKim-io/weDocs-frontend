// 액세스 토큰 보관소 — **메모리 전용**. 이 모듈은 의존성이 없는 leaf 다(순환 방지).

/// 왜 localStorage/sessionStorage 를 쓰지 않나: 저장소에 넣는 순간 XSS 한 번으로 토큰이 그대로
/// 유출된다(secure-coding P1/P5). 대가는 "새로고침하면 재로그인"인데, TTL 이 24h 이고 refresh
/// token 이 비범위인 현 단계에선 그 대가가 훨씬 싸다. 부수 효과로 탭마다 독립 세션이 되는데,
/// editor/viewer 를 두 탭에 나눠 여는 이 프로젝트의 데모 시나리오와 오히려 맞는다.
export interface AuthenticatedUser {
  readonly id: string
  readonly displayName: string
}

/// 비동기 인증 bootstrap의 소유권 핸들. 객체 identity로 비교하므로 이전 시도가 새 세션을
/// commit/rollback할 수 없다. generation은 디버깅용이며 권한 판단에는 쓰지 않는다.
export interface AuthenticationAttempt {
  readonly generation: number
}

export type AuthenticationCommit = 'committed' | 'stale' | 'expired'

interface Session {
  readonly owner: AuthenticationAttempt
  readonly accessToken: string
  readonly expiresAtMs: number
  readonly user: AuthenticatedUser | null
}

/// 만료 직전 토큰으로 연결을 시작하지 않기 위한 여유. 요청이 서버에 도달하기 전에 만료되는
/// 창(clock skew + 왕복 지연)을 없앤다.
export const EXPIRY_SKEW_MS = 30_000

let nextGeneration = 0
let activeAttempt: AuthenticationAttempt | null = null
let session: Session | null = null

/// 최신으로 **시작한** 인증 시도만 세션을 완성할 수 있다. 첫 네트워크 await 전에 호출해야 한다.
export function beginAuthenticationAttempt(): AuthenticationAttempt {
  const attempt = { generation: ++nextGeneration }
  activeAttempt = attempt
  session = null
  return attempt
}

export function isAuthenticationAttemptCurrent(attempt: AuthenticationAttempt): boolean {
  return activeAttempt === attempt
}

/// 로그인 응답도 시작 시점의 소유권이 남아 있을 때만 임시 저장한다.
export function setToken(
  owner: AuthenticationAttempt,
  accessToken: string,
  expiresInSeconds: number,
  nowMs = Date.now(),
): boolean {
  if (!isAuthenticationAttemptCurrent(owner)) {
    return false
  }
  session = {
    owner,
    accessToken,
    expiresAtMs: nowMs + expiresInSeconds * 1000,
    user: null,
  }
  return true
}

/// 프로필 응답은 같은 시도가 저장한 아직 유효한 토큰에만 원자적으로 붙인다.
export function setAuthenticatedUser(
  owner: AuthenticationAttempt,
  user: AuthenticatedUser,
  nowMs = Date.now(),
): AuthenticationCommit {
  if (!isAuthenticationAttemptCurrent(owner)) {
    return 'stale'
  }
  if (session === null || session.owner !== owner || isExpiredAt(session, nowMs)) {
    session = null
    return 'expired'
  }
  session = { ...session, user: { id: user.id, displayName: user.displayName } }
  return 'committed'
}

/// owner가 있으면 해당 시도가 여전히 최신일 때만 rollback한다. owner 없는 호출은 로그아웃/테스트
/// 정리이며 진행 중인 모든 시도를 무효화한다.
export function clearToken(owner?: AuthenticationAttempt): boolean {
  if (owner !== undefined && !isAuthenticationAttemptCurrent(owner)) {
    return false
  }
  activeAttempt = null
  session = null
  return true
}

/// **사용 가능한** 토큰만 반환한다 — 만료된 토큰은 없는 것과 같이 취급한다.
///
/// 왜 만료를 클라이언트가 판단하나: 만료 토큰으로 WS 에 재접속하면 게이트웨이는 401 로 거절하지만
/// **브라우저는 그 상태 코드를 볼 수 없다**(WS 실패는 code 1006 뿐이다). 그러면 y-websocket 이
/// 상한 2500ms backoff 로 무한 재접속하고, 사용자는 원인을 모른 채 "연결 중"만 보게 된다.
/// 만료를 미리 알면 재접속 대신 재로그인 화면으로 보낼 수 있다 — 유일한 근본 대책이다.
export function getToken(nowMs = Date.now()): string | null {
  const current = usableSession(nowMs)
  return current?.accessToken ?? null
}

/// 토큰과 서버 공개 프로필이 모두 준비된 경우만 인증 세션으로 인정한다.
export function getAuthenticatedUser(nowMs = Date.now()): AuthenticatedUser | null {
  const current = usableSession(nowMs)
  return current?.user ?? null
}

/// 토큰이 없는 경우도 `true` — 호출자 입장에서 "쓸 수 있는 토큰이 없다"는 결론이 동일하기 때문이다.
export function isExpired(nowMs = Date.now()): boolean {
  return session === null || isExpiredAt(session, nowMs)
}

function usableSession(nowMs: number): Session | null {
  if (session === null || isExpiredAt(session, nowMs)) {
    session = null
    return null
  }
  return session
}

function isExpiredAt(current: Session, nowMs: number): boolean {
  return current.expiresAtMs - EXPIRY_SKEW_MS <= nowMs
}
