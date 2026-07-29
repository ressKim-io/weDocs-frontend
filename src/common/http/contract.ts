// 서버 응답의 경계 검증 유틸 — 응답도 외부 입력이다(secure-coding P1).
//
// 왜 feature 밖에 있나: "무엇이 유효한 문자열·열거값인가"는 feature 와 무관한 규칙이고, feature 마다
// 다시 쓰면 판단이 조금씩 갈라진다. **규칙**은 여기가, **계약**(어떤 필드가 있어야 하는가)은 각
// feature 가 소유한다 — `client.ts` 가 전송을 소유하는 것과 같은 분리다(layering-readability P7).
//
// 왜 스키마 라이브러리(zod 등)를 들이지 않았나: 검증 대상이 응답 3종이고 규칙이 원시 타입뿐이라
// 의존성 하나를 늘릴 만큼의 이득이 없다. 중첩 구조나 변환이 필요해지면 그때 재판정한다.

import { ApiError, MALFORMED_RESPONSE_CODE } from './client'

/// 계약 위반 시점의 HTTP 는 이미 성공(2xx)이다. 실패의 성격이 "전송"이 아니라 "계약"임은 `code` 가
/// 나르므로 상태 자리는 성공을 뜻하는 200 으로 고정한다 — 2xx 중 어느 값이었는지는 호출자의 어떤
/// 분기도 바꾸지 않는다(`auth/api.ts` 의 토큰 검증과 같은 표현).
const CONTRACT_VIOLATION_STATUS = 200

/// 검증 대상 레코드. 값은 전부 `unknown` 에서 시작한다 — 타입 단언으로 건너뛰지 않기 위해서다.
export type Fields = Readonly<Record<string, unknown>>

/// 위반은 전부 여기서 만든다(문구 형식이 갈라지지 않게). feature 가 직접 부를 일이 생기기 전까지는
/// 모듈 안에 둔다 — 쓰이지 않는 공개 표면을 미리 열지 않는다.
/// ⚠️ `what` 에는 **위치만** 넣는다 — 서버가 보낸 값을 문구에 실으면 응답 내용이 UI·로그로 새어
/// 나간다(secure-coding P4).
function contractViolation(what: string): ApiError {
  return new ApiError(CONTRACT_VIOLATION_STATUS, MALFORMED_RESPONSE_CODE, `malformed response: ${what}`)
}

/// 배열·null 을 레코드에서 제외하는 이유: 둘 다 `typeof === 'object'` 라 그대로 통과시키면 이후
/// 필드 접근이 전부 undefined 가 되어, 원인이 "응답 모양이 다름"인데 "필드 누락"으로 보고된다.
export function requireRecord(raw: unknown, what: string): Fields {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw contractViolation(what)
  }
  return raw as Fields
}

/// 목록 응답 — 원소 하나가 계약을 어기면 **목록 전체를 실패**시킨다. 깨진 원소만 조용히 건너뛰면
/// "왜 내 페이지가 목록에 없나"가 아무 신호 없는 버그로 남는다(fail-closed).
export function requireArrayOf<T>(raw: unknown, what: string, parseItem: (item: unknown) => T): T[] {
  if (!Array.isArray(raw)) {
    throw contractViolation(what)
  }
  return raw.map(parseItem)
}

/// 표시용 문자열 — **빈 문자열을 허용**한다. 서버가 빈 title 을 허용하기 때문이고(Untitled 패턴,
/// `PageCreateRequest`), 표시용 값의 공백 여부로 요청 전체를 실패시키면 서버가 계약을 완화한
/// 순간 화면이 통째로 죽는다. 엄격한 검사는 식별자에만 건다(`requireNonEmptyString`).
export function requireString(fields: Fields, key: string, what: string): string {
  const value = fields[key]
  if (typeof value !== 'string') {
    throw contractViolation(`${what}.${key}`)
  }
  return value
}

/// 식별자용 — 빈 문자열은 URL 경로에 실리면 **다른 엔드포인트를 호출**하게 되므로 거부한다
/// (`/api/pages/` ≠ `/api/pages/{id}`).
export function requireNonEmptyString(fields: Fields, key: string, what: string): string {
  const value = requireString(fields, key, what)
  if (value.length === 0) {
    throw contractViolation(`${what}.${key}`)
  }
  return value
}

/// nullable 식별자(예: `parentId` = 루트면 없음). 필드 **부재**도 null 로 받는다 — JSON 에서
/// "null" 과 "없음"은 같은 뜻이고, 서버의 직렬화 설정(Jackson inclusion) 변경만으로 클라가
/// 깨지지 않게 한다.
export function requireNullableString(fields: Fields, key: string, what: string): string | null {
  const value = fields[key]
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw contractViolation(`${what}.${key}`)
  }
  return value
}

export function requireBoolean(fields: Fields, key: string, what: string): boolean {
  const value = fields[key]
  if (typeof value !== 'boolean') {
    throw contractViolation(`${what}.${key}`)
  }
  return value
}

/// 정수만 — JSON number 는 실수·NaN·Infinity 를 전부 담을 수 있는데 서버 계약은 `int` 다.
export function requireInt(fields: Fields, key: string, what: string): number {
  const value = fields[key]
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw contractViolation(`${what}.${key}`)
  }
  return value
}

/// 열거값 — 모르는 값은 **거부**한다. 서버가 새 역할을 추가했을 때 클라가 그것을 임의로 해석하면
/// (예: 모르면 편집 가능) 조용한 권한 상승이 된다. 게이트웨이 `SessionRole.fromProto` 와 같은 원칙.
export function requireEnum<T extends string>(
  fields: Fields,
  key: string,
  allowed: readonly T[],
  what: string,
): T {
  const value = fields[key]
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw contractViolation(`${what}.${key}`)
  }
  return value as T
}
