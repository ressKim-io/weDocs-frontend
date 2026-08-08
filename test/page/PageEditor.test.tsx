// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { Doc } from 'yjs'
import PageEditor from '../../src/page/PageEditor'
import { clearToken, setAuthenticatedUser, setToken } from '../../src/auth/token'

/// 실제 WS 는 열지 않는다 — 이 파일이 검증하는 것은 "연결 전에 권한을 먼저 확인하는가"다.
vi.mock('y-websocket', async () => {
  const { Awareness } = await import('y-protocols/awareness')
  return {
    WebsocketProvider: class {
      readonly awareness: InstanceType<typeof Awareness>

      constructor(_url: string, _room: string, doc: Doc) {
        this.awareness = new Awareness(doc)
      }

      destroy() {
        this.awareness.destroy()
      }
    },
  }
})

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  fetchMock.mockReset()
  clearToken()
})

const PAGE_ID = '33333333-3333-4333-8333-333333333333'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const PAGE_DETAIL = {
  id: PAGE_ID,
  workspaceId: '11111111-1111-4111-8111-111111111111',
  parentId: null,
  title: '설계 노트',
  position: 0,
  archived: false,
  myRole: 'VIEWER',
  canEdit: false,
}

describe('PageEditor', () => {
  it('단건 조회 결과의 권한으로 에디터를 연다', async () => {
    // Given: viewer 로 공유받은 페이지
    setToken('jwt-abc', 3600)
    setAuthenticatedUser({
      id: '22222222-2222-4222-8222-222222222222',
      displayName: '읽는 사용자',
    })
    fetchMock.mockResolvedValue(jsonResponse(200, PAGE_DETAIL))

    // When
    render(<PageEditor pageId={PAGE_ID} onClose={vi.fn()} />)

    // Then: 역할을 모른 채 붙으면 viewer 의 입력이 게이트웨이에서 조용히 버려져 로컬만 divergent 해진다
    expect(await screen.findByRole('heading', { name: '설계 노트' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('읽기 전용')
    expect(fetchMock.mock.calls[0][0]).toBe(`http://localhost:8081/api/pages/${PAGE_ID}`)
  })

  it('읽을 수 없는 페이지는 에디터를 열지 않는다', async () => {
    // Given: 서버는 권한 없는 리소스를 404 로 숨긴다(존재 비노출)
    setToken('jwt-abc', 3600)
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: 'page-not-found', detail: 'page not found' }), {
        status: 404,
        headers: { 'content-type': 'application/problem+json' },
      }),
    )

    // When
    render(<PageEditor pageId={PAGE_ID} onClose={vi.fn()} />)

    // Then: "없음"과 "권한 없음"을 구분해 말하지 않는다 — 구분하면 서버가 감춘 존재 여부가 되살아난다
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '페이지를 찾을 수 없거나 접근 권한이 없습니다',
    )
    expect(screen.queryByRole('heading', { name: '설계 노트' })).toBeNull()
  })
})
