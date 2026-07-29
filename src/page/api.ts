// page feature 의 doc-service 호출. 타입은 서버 record 와 1:1 로 맞춘다(계약이 갈라지지 않도록).

import { apiRequest } from '../common/http/client'
import {
  requireArrayOf,
  requireBoolean,
  requireEnum,
  requireInt,
  requireNonEmptyString,
  requireNullableString,
  requireRecord,
  requireString,
} from '../common/http/contract'

/// 서버 `PageCreateRequest.title` 의 `@Size(max = 512)` 와 정합. 서버는 **빈 title 도 허용**한다
/// (Untitled 패턴) — 클라도 막지 않는다.
export const MAX_PAGE_TITLE_LENGTH = 512

/// 노출 역할 = 서버 `PageDetailResponse.Role`. `NONE` 은 이 계약에 **나타날 수 없다**(읽기 권한이
/// 없으면 단건 조회가 404 로 끝난다) — 그래서 클라 타입에도 없다.
export const PAGE_ROLES = ['VIEWER', 'EDITOR', 'OWNER'] as const
export type PageRole = (typeof PAGE_ROLES)[number]

/// doc-service `PageResponse` — 트리 조립용 구조 필드까지만. 내용(CRDT)은 엔진 경로다.
export interface PageResponse {
  readonly id: string
  readonly workspaceId: string
  readonly parentId: string | null
  readonly title: string
  readonly position: number
  readonly archived: boolean
}

/// doc-service `PageDetailResponse` — **단건 조회에만** 호출자의 유효 권한이 실린다.
/// 목록에 역할이 없는 것은 누락이 아니라 계약이다(행마다 조상 walk = N+1).
export interface PageDetailResponse extends PageResponse {
  /// 표시용(예: 읽기 전용 배지). **편집 가능 여부를 여기서 유도하지 않는다** — 아래 참조.
  readonly myRole: PageRole
  /// 편집 가능 여부의 **단일 출처**. "editor 또는 owner 가 편집 가능"은 서버 정책이고, 클라가 그것을
  /// 다시 구현하는 순간 두 곳이 갈라진다(역할이 추가되면 즉시 오답). 분기는 항상 이 값으로 한다.
  readonly canEdit: boolean
}

/// 워크스페이스의 평면 페이지 목록. 서버가 아카이브·미도달 페이지를 걸러 최대 1,000행까지만 준다
/// (`PageTreeService.MAX_PAGE_LIST`) — 클라는 받은 순서를 그대로 쓴다(서버가 position·생성순 정렬).
export async function listPages(workspaceId: string): Promise<PageResponse[]> {
  const body = await apiRequest<unknown>(`/api/workspaces/${path(workspaceId)}/pages`, {
    method: 'GET',
  })
  return requireArrayOf(body, 'page list', toPage)
}

/// 루트 페이지 생성. 자식 페이지(parentId)는 트리 UI 와 함께 M3 — 지금 넘길 값이 항상 null 이라
/// 파라미터를 두지 않는다(쓰이지 않는 인자는 곧 검증되지 않는 경로가 된다).
export async function createPage(workspaceId: string, title: string): Promise<PageResponse> {
  const body = await apiRequest<unknown>('/api/pages', {
    method: 'POST',
    body: { workspaceId, parentId: null, title },
  })
  return toPage(body)
}

/// 단건 조회 = **에디터를 여는 그 순간**의 권한 확인 경로다. 읽기 권한이 없으면 서버가 404 로
/// 끝낸다(존재 비노출) — 403 을 기대하지 않는다.
export async function getPage(pageId: string): Promise<PageDetailResponse> {
  const body = await apiRequest<unknown>(`/api/pages/${path(pageId)}`, { method: 'GET' })
  const fields = requireRecord(body, 'page detail')
  return {
    ...toPage(body),
    myRole: requireEnum(fields, 'myRole', PAGE_ROLES, 'page detail'),
    canEdit: requireBoolean(fields, 'canEdit', 'page detail'),
  }
}

function toPage(raw: unknown): PageResponse {
  const fields = requireRecord(raw, 'page')
  return {
    id: requireNonEmptyString(fields, 'id', 'page'),
    workspaceId: requireNonEmptyString(fields, 'workspaceId', 'page'),
    parentId: requireNullableString(fields, 'parentId', 'page'),
    // 빈 title 은 서버가 허용하는 정상값이다 — 여기서 막으면 만들 수 있는 페이지를 열 수 없게 된다.
    title: requireString(fields, 'title', 'page'),
    position: requireInt(fields, 'position', 'page'),
    archived: requireBoolean(fields, 'archived', 'page'),
  }
}

/// 경로에 들어가는 식별자는 인코딩한다 — `pageId` 는 `?room=` 로 **사용자가 넣을 수 있는 값**이라
/// 그대로 이으면 경로가 다른 엔드포인트로 바뀔 수 있다(secure-coding P1).
function path(segment: string): string {
  return encodeURIComponent(segment)
}
