import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../src/common/http/client'
import { createPage, getPage, listPages } from '../../src/page/api'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockReset()
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'
const PAGE_ID = '33333333-3333-4333-8333-333333333333'

const PAGE = {
  id: PAGE_ID,
  workspaceId: WORKSPACE_ID,
  parentId: null,
  title: '설계 노트',
  position: 0,
  archived: false,
}

function lastRequest(): [string, RequestInit] {
  return fetchMock.mock.calls.at(-1) as [string, RequestInit]
}

describe('listPages', () => {
  it('워크스페이스의 평면 목록을 서버 순서 그대로 반환한다', async () => {
    // Given: 서버가 position·생성순으로 정렬해 준다 — 클라는 재정렬하지 않는다
    const second = { ...PAGE, id: '44444444-4444-4444-8444-444444444444', title: '회의록', position: 1 }
    fetchMock.mockResolvedValue(jsonResponse(200, [PAGE, second]))

    // When
    const pages = await listPages(WORKSPACE_ID)

    // Then
    expect(pages.map((p) => p.title)).toEqual(['설계 노트', '회의록'])
    expect(lastRequest()[0]).toBe(`http://localhost:8081/api/workspaces/${WORKSPACE_ID}/pages`)
  })

  it('빈 title 페이지도 그대로 통과시킨다 — 서버가 허용하는 정상값이다', async () => {
    // Given/When/Then: 여기서 막으면 만들 수 있는 페이지를 목록에서 열 수 없게 된다
    fetchMock.mockResolvedValue(jsonResponse(200, [{ ...PAGE, title: '' }]))
    await expect(listPages(WORKSPACE_ID)).resolves.toMatchObject([{ title: '' }])
  })
})

describe('createPage', () => {
  it('루트 페이지로 생성한다(parentId = null)', async () => {
    // Given
    fetchMock.mockResolvedValue(jsonResponse(201, PAGE))

    // When
    await createPage(WORKSPACE_ID, '설계 노트')

    // Then: 트리(자식 생성)는 M3 — 지금 경로는 항상 루트다
    const [, init] = lastRequest()
    expect(JSON.parse(init.body as string)).toEqual({
      workspaceId: WORKSPACE_ID,
      parentId: null,
      title: '설계 노트',
    })
  })
})

describe('getPage — 유효 권한', () => {
  it('myRole 과 canEdit 을 함께 반환한다', async () => {
    // Given: 단건 조회에만 권한이 실린다(목록은 N+1 회피로 구조 필드만)
    fetchMock.mockResolvedValue(jsonResponse(200, { ...PAGE, myRole: 'VIEWER', canEdit: false }))

    // When
    const detail = await getPage(PAGE_ID)

    // Then
    expect(detail.myRole).toBe('VIEWER')
    expect(detail.canEdit).toBe(false)
  })

  it('역할과 canEdit 이 어긋나도 서버 값을 그대로 전달한다 — 클라는 정책을 재계산하지 않는다', async () => {
    // Given: 역할만 보면 편집 가능해 보이지만 서버는 불가라고 답했다
    fetchMock.mockResolvedValue(jsonResponse(200, { ...PAGE, myRole: 'EDITOR', canEdit: false }))

    // When/Then: "editor 면 편집 가능"을 클라가 재구현하는 순간 두 곳이 갈라진다 — 판단은 canEdit 뿐
    await expect(getPage(PAGE_ID)).resolves.toMatchObject({ myRole: 'EDITOR', canEdit: false })
  })

  it.each([
    ['역할 누락', { ...PAGE, canEdit: true }],
    ['모르는 역할', { ...PAGE, myRole: 'ADMIN', canEdit: true }],
    ['계약에 없는 NONE', { ...PAGE, myRole: 'NONE', canEdit: false }],
    ['canEdit 이 문자열', { ...PAGE, myRole: 'OWNER', canEdit: 'true' }],
  ])('%s 응답은 즉시 실패시킨다', async (_label, body) => {
    // Given: HTTP 는 200 이지만 권한 계약이 깨졌다 — 낙관 해석은 조용한 권한 상승이다
    fetchMock.mockResolvedValue(jsonResponse(200, body))

    // When/Then
    const error = await getPage(PAGE_ID).catch((e) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.code).toBe('malformed-response')
  })

  it('경로 식별자를 인코딩한다 — room 은 사용자가 넣을 수 있는 값이다', async () => {
    // Given: `?room=` 으로 들어온 값이 그대로 이어지면 경로가 다른 엔드포인트로 바뀔 수 있다
    fetchMock.mockResolvedValue(jsonResponse(404, { code: 'page-not-found', detail: 'page not found' }))

    // When
    await getPage('../workspaces').catch(() => undefined)

    // Then
    expect(lastRequest()[0]).toBe('http://localhost:8081/api/pages/..%2Fworkspaces')
  })
})
