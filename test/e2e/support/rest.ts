// E2E 부트스트랩 — doc-service REST 로 **테스트가 스스로 자기 사전조건을 만든다.**
//
// 왜 토큰을 환경변수로 주입받지 않나: 주입 방식은 (a) 매번 사람이 토큰을 발급해 넣어야 하고
// (b) 그 계정의 권한에 따라 결과가 달라져 **viewer 케이스를 검증할 수 없다.** 부트스트랩이
// 계정 두 개와 페이지를 직접 만들면 editor/viewer/무토큰 세 경로를 한 번에 재현할 수 있다.

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:8081'

/// 서버 `SignupRequest` 의 `@Size(min = 8)` 을 만족하는 값. E2E 전용 계정이라 고정이어도 된다.
const PASSWORD = 'e2e-password-1'

export interface Account {
  readonly userId: string
  readonly token: string
}

async function call<T>(path: string, method: string, body?: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token !== undefined) {
    headers.Authorization = `Bearer ${token}`
  }
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) {
    // 부트스트랩 실패는 테스트 실패와 원인이 다르다(사전조건 미기동 vs 동작 결함) — 즉시 크게 실패시킨다.
    throw new Error(
      `E2E 부트스트랩 실패: ${method} ${path} → HTTP ${response.status}. ` +
        `doc-service(${API_URL}) 기동을 확인하세요.`,
    )
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T)
}

/// 실행마다 **고유 계정**을 만든다 — 계정·워크스페이스는 postgres 에 남으므로 재실행이 중복 이메일
/// 409 로 깨지지 않게 한다.
export async function provisionAccount(label: string): Promise<Account> {
  const email = `e2e-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`
  // 가입은 토큰을 주지 않는다(201 + UserResponse) → login 을 이어 부른다. userId 는 이 응답에서 얻는다
  // (JWT 를 디코드하지 않는다 — 테스트가 토큰 내부 구조에 의존하지 않게).
  const user = await call<{ id: string }>('/api/auth/signup', 'POST', {
    email,
    password: PASSWORD,
    displayName: `e2e-${label}`,
  })
  const session = await call<{ accessToken: string }>('/api/auth/login', 'POST', {
    email,
    password: PASSWORD,
  })
  return { userId: user.id, token: session.accessToken }
}

export async function createWorkspace(account: Account, name: string): Promise<string> {
  const workspace = await call<{ id: string }>('/api/workspaces', 'POST', { name }, account.token)
  return workspace.id
}

/// 반환값이 곧 **room** 이다 — 게이트웨이는 UUID 가 아닌 doc_id 를 403 으로 끊는다.
export async function createPage(account: Account, workspaceId: string, title: string): Promise<string> {
  const page = await call<{ id: string }>(
    '/api/pages',
    'POST',
    { workspaceId, parentId: null, title },
    account.token,
  )
  return page.id
}

/// 명시 공유는 해석 1순위라 워크스페이스 멤버가 아니어도 그 페이지만 볼 수 있다.
export async function shareAsViewer(owner: Account, pageId: string, target: Account): Promise<void> {
  await call<void>(
    `/api/pages/${pageId}/permissions/${target.userId}`,
    'PUT',
    { level: 'VIEWER' },
    owner.token,
  )
}
