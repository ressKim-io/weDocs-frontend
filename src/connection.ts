// 게이트웨이 연결 파라미터 sanity — 무검증 room이 그대로 연결에 쓰이는 것을 막고(엔진/게이트웨이 경계
// 검증과 규칙 일치, defense-in-depth), 보안 페이지에서 평문 WS를 막는다.

/// room(=docId) 규칙 — 엔진 DocId·게이트웨이 RoomId 와 **동일**(길이 1..=128 · [A-Za-z0-9_-]).
export const MAX_ROOM_LENGTH = 128
export const DEFAULT_ROOM = 'demo'
const ROOM_PATTERN = /^[A-Za-z0-9_-]+$/

export function isValidRoom(raw: string): boolean {
  return raw.length >= 1 && raw.length <= MAX_ROOM_LENGTH && ROOM_PATTERN.test(raw)
}

/// `?room=` 파라미터를 검증 — 위반/미지정이면 기본 room으로 폴백한다. 게이트웨이가 무효 room을
/// 핸드셰이크에서 거부하므로, 잘못된 room으로 연결을 시도해 실패하기 전에 클라에서 선방어한다.
export function sanitizeRoom(raw: string | null): string {
  return raw !== null && isValidRoom(raw) ? raw : DEFAULT_ROOM
}

/// 보안 페이지(https)에서 평문 ws:// 는 브라우저가 mixed-content로 차단한다 → wss:// 로 강제 승격.
/// dev(http)는 ws:// 유지. 스킴을 페이지 프로토콜에서 파생해 배포 misconfiguration(https인데 ws://)을 방어한다.
/// 스코프: `ws://` 리터럴 승격만 담당 — `http://` 등 스킴 자체 오설정은 대상 밖(브라우저가 즉시 SyntaxError로 실패).
export function resolveWsUrl(configured: string, pageProtocol: string): string {
  if (pageProtocol === 'https:' && configured.startsWith('ws://')) {
    return `wss://${configured.slice('ws://'.length)}`
  }
  return configured
}
