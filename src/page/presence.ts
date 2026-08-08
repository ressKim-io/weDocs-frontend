/// 같은 사용자는 탭·재접속이 달라도 같은 색을 쓴다. 팔레트는 흰 배경에서 커서·라벨로
/// 식별 가능한 중간 명도 색으로 제한하고, 임의 클라이언트 ID 대신 서버 사용자 UUID를 해시한다.
const PRESENCE_COLORS = [
  '#c2410c',
  '#b91c1c',
  '#a21caf',
  '#6d28d9',
  '#1d4ed8',
  '#047857',
  '#0f766e',
  '#a16207',
] as const

const PRESENCE_COLOR_PATTERN = /^#[0-9a-f]{6}$/i
const FALLBACK_PRESENCE_COLOR = '#475569'
const FALLBACK_PRESENCE_NAME = '협업 사용자'
const MAX_PRESENCE_NAME_LENGTH = 80

export interface PresenceIdentity {
  readonly id: string
  readonly displayName: string
}

export interface AwarenessUser {
  readonly name: string
  readonly color: string
}

export function awarenessUserFor(identity: PresenceIdentity): AwarenessUser {
  return {
    name: safePresenceName(identity.displayName),
    color: colorForUserId(identity.id),
  }
}

/// awareness는 인가된 멤버가 보내지만 페이로드 자체는 클라이언트 통제다. DOM style에 넣기 전에
/// 고정 hex 형식만 허용해 CSS 선언 삽입과 과도한 이름으로 인한 UI 훼손을 막는다.
export function safePresenceColor(value: unknown): string {
  return typeof value === 'string' && PRESENCE_COLOR_PATTERN.test(value)
    ? value
    : FALLBACK_PRESENCE_COLOR
}

export function safePresenceName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return FALLBACK_PRESENCE_NAME
  }
  return value.trim().slice(0, MAX_PRESENCE_NAME_LENGTH)
}

export function colorForUserId(userId: string): string {
  // FNV-1a 32-bit — 암호학적 용도가 아니라 UUID를 작은 고정 팔레트에 안정적으로 배정하는 용도다.
  let hash = 0x811c9dc5
  for (const character of userId) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193)
  }
  return PRESENCE_COLORS[(hash >>> 0) % PRESENCE_COLORS.length]
}
