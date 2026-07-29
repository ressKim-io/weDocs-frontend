// 게이트웨이 연결 파라미터 sanity — 무검증 room이 그대로 연결에 쓰이는 것을 막고(엔진/게이트웨이 경계
// 검증과 규칙 일치, defense-in-depth), 보안 페이지에서 평문 WS를 막는다.

/// room = **페이지 UUID**. 게이트웨이 인가(`AuthzHandshakeInterceptor`)는 doc_id가 UUID가 아니면
/// `CheckPermission` 왕복도 없이 403이므로, 클라도 같은 기준으로 선방어한다.
///
/// 왜 문자집합 규칙([A-Za-z0-9_-] 1..128, 엔진 `DocId`)만으로는 부족한가: 그 규칙만 통과시키면
/// **형식은 맞는데 무조건 403인 room**(예전 기본값 `demo`)이 그대로 연결을 시도한다. 브라우저는 WS
/// 실패에서 상태 코드를 볼 수 없어(code 1006뿐) 원인이 드러나지 않은 채 재접속만 반복된다.
/// 이 패턴은 엔진 규칙보다 **엄격**이라 여기를 통과한 값은 항상 저쪽도 통과한다(false-accept 없음).
const ROOM_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/// 유효하면 room, 아니면 **null**. 기본 room 폴백을 두지 않는 이유: 폴백은 "조용히 실패하는 경로"를
/// 유지하는 것과 같다 — 무효한 room으로 연결을 시도해 1006으로 끊기는 대신, 호출자가 페이지 선택
/// 화면을 보여줄 수 있게 실패를 값으로 돌려준다.
export function parseRoom(raw: string | null): string | null {
  return raw !== null && ROOM_PATTERN.test(raw) ? raw : null
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
