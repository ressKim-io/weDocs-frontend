// workspace feature 의 doc-service 호출. 타입은 서버 record 와 1:1 로 맞춘다(계약이 갈라지지 않도록).

import { apiRequest } from '../common/http/client'
import {
  requireArrayOf,
  requireNonEmptyString,
  requireRecord,
  requireString,
} from '../common/http/contract'

/// 서버 `WorkspaceCreateRequest` 의 `@Size(max = 255)` 와 정합. 클라 상한은 왕복을 줄이기 위한
/// 것이지 신뢰 경계가 아니다 — 판정은 언제나 서버가 한다.
export const MAX_WORKSPACE_NAME_LENGTH = 255

/// doc-service `WorkspaceResponse` — 엔티티 비노출이라 감사 타임스탬프는 없다.
export interface WorkspaceResponse {
  readonly id: string
  readonly name: string
  readonly ownerId: string
}

/// 내가 속한 워크스페이스. 빈 배열 = 아직 하나도 없음(오류가 아니다 — 첫 로그인의 정상 상태).
///
/// ⚠️ 서버 `WorkspaceService.listMine` 에는 **조회 상한이 없다** — 같은 서비스의 `PageTreeService.list`
/// 가 `MAX_PAGE_LIST` 로 자르는 것과 비대칭이다(secure-coding P2). 클라에서 잘라 감추지 않는다:
/// 자르면 "내 워크스페이스가 안 보인다"는 무증상 버그가 되고 서버의 무상한 조회는 그대로 남는다.
/// 상한은 조회가 있는 곳에 둬야 한다 → controller `docs/status/current.md` §이월된 findings 에 등록.
export async function listWorkspaces(): Promise<WorkspaceResponse[]> {
  const body = await apiRequest<unknown>('/api/workspaces', { method: 'GET' })
  return requireArrayOf(body, 'workspace list', toWorkspace)
}

/// 생성자는 그 워크스페이스의 owner 가 된다(서버 `WorkspaceService.create`).
export async function createWorkspace(name: string): Promise<WorkspaceResponse> {
  const body = await apiRequest<unknown>('/api/workspaces', { method: 'POST', body: { name } })
  return toWorkspace(body)
}

function toWorkspace(raw: unknown): WorkspaceResponse {
  const fields = requireRecord(raw, 'workspace')
  return {
    id: requireNonEmptyString(fields, 'id', 'workspace'),
    name: requireString(fields, 'name', 'workspace'),
    ownerId: requireNonEmptyString(fields, 'ownerId', 'workspace'),
  }
}
