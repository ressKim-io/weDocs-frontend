// 실패 → 사용자에게 보여줄 한 줄. 여러 화면이 같은 실패를 서로 다르게 설명하지 않게 한 곳에 둔다.
//
// 왜 `common/http/` 인가: 이 함수가 읽는 것은 `ApiError` 의 `code`/`status` 뿐이라 전송 계약에 붙어
// 있다. 화면별 특수 문구(예: 로그인의 자격증명 실패)는 각 feature 가 **먼저** 분기하고 남는 것을
// 여기로 넘긴다 — 공통 문구를 feature 가 다시 쓰지 않게.

import { ApiError, MALFORMED_RESPONSE_CODE, NETWORK_ERROR_STATUS } from './client'

/// ⚠️ 서버 `detail` 을 그대로 노출하지 않는다 — 분기는 `code`/`status` 로만 한다(서버가 명시한 계약).
export function describeApiFailure(cause: unknown): string {
  if (!(cause instanceof ApiError)) {
    return '알 수 없는 오류가 발생했습니다.'
  }
  if (cause.status === NETWORK_ERROR_STATUS) {
    return '서버에 연결할 수 없습니다. doc-service(:8081)가 실행 중인지 확인하세요.'
  }
  if (cause.code === MALFORMED_RESPONSE_CODE) {
    return '서버 응답을 이해할 수 없습니다. 서버 버전이 맞는지 확인하세요.'
  }
  // 인증 실패는 Spring Security 필터 경로라 **본문이 없다** → `code` 가 없고 상태로만 판정한다.
  // 토큰이 메모리 전용이라 만료의 정상 해소 경로는 재로그인이다(refresh token 은 비범위).
  if (cause.status === 401) {
    return '세션이 만료되었습니다. 로그아웃 후 다시 로그인해 주세요.'
  }
  // 서버는 권한 없는 리소스를 404로 숨긴다(존재 비노출, IDOR 방지) — 클라도 "없음"과 "권한 없음"을
  // 구분해 말하지 않는다. 구분해 주는 순간 서버가 감춘 존재 여부를 클라가 되살린다.
  if (cause.status === 404) {
    return '페이지를 찾을 수 없거나 접근 권한이 없습니다.'
  }
  return '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'
}
