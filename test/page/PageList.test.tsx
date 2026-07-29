// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import PageList from '../../src/page/PageList'
import type { WorkspaceResponse } from '../../src/workspace/api'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  // RTL 자동 cleanup 은 globals:false 에선 등록되지 않는다 — 명시적으로 부른다.
  cleanup()
  vi.unstubAllGlobals()
  fetchMock.mockReset()
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const WORKSPACE: WorkspaceResponse = {
  id: '11111111-1111-4111-8111-111111111111',
  name: '내 워크스페이스',
  ownerId: '22222222-2222-4222-8222-222222222222',
}

const PAGE = {
  id: '33333333-3333-4333-8333-333333333333',
  workspaceId: WORKSPACE.id,
  parentId: null,
  title: '설계 노트',
  position: 0,
  archived: false,
}

function renderList(onOpen = vi.fn()) {
  render(<PageList workspace={WORKSPACE} onOpen={onOpen} onBack={vi.fn()} />)
  return onOpen
}

describe('PageList — 목록', () => {
  it('페이지를 서버 순서대로 보여준다', async () => {
    // Given: 서버가 position·생성순으로 정렬해 준다
    const second = { ...PAGE, id: '44444444-4444-4444-8444-444444444444', title: '회의록' }
    fetchMock.mockResolvedValue(jsonResponse(200, [PAGE, second]))

    // When
    renderList()

    // Then
    expect(await screen.findByRole('button', { name: '설계 노트' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '회의록' })).toBeInTheDocument()
  })

  it('빈 title 도 클릭할 수 있게 대체 문구로 보여준다', async () => {
    // Given: 서버가 빈 title 을 허용한다(Untitled 패턴) → 글자 없는 버튼이 되면 열 수 없다
    fetchMock.mockResolvedValue(jsonResponse(200, [{ ...PAGE, title: '   ' }]))

    // When
    renderList()

    // Then
    expect(await screen.findByRole('button', { name: '제목 없음' })).toBeInTheDocument()
  })

  it('페이지가 없으면 안내를 보여준다 — 오류가 아니다', async () => {
    // Given/When
    fetchMock.mockResolvedValue(jsonResponse(200, []))
    renderList()

    // Then
    expect(await screen.findByText(/아직 페이지가 없습니다/)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('페이지를 고르면 그 UUID 를 넘긴다 — 이 값이 곧 room 이다', async () => {
    // Given
    fetchMock.mockResolvedValue(jsonResponse(200, [PAGE]))
    const onOpen = renderList()

    // When
    fireEvent.click(await screen.findByRole('button', { name: '설계 노트' }))

    // Then
    expect(onOpen).toHaveBeenCalledWith(PAGE.id)
  })

  it('목록 로딩 실패는 alert 로 알린다', async () => {
    // Given: 토큰 만료 — 인증 실패는 본문이 없어 status 로만 판정된다
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }))

    // When
    renderList()

    // Then
    expect(await screen.findByRole('alert')).toHaveTextContent('세션이 만료되었습니다')
  })
})

describe('PageList — 생성', () => {
  it('만든 페이지를 곧바로 연다', async () => {
    // Given: 목록은 비어 있고, 생성은 201 로 새 페이지를 준다
    const created = { ...PAGE, id: '55555555-5555-4555-8555-555555555555', title: '새 문서' }
    fetchMock.mockResolvedValueOnce(jsonResponse(200, []))
    fetchMock.mockResolvedValueOnce(jsonResponse(201, created))
    const onOpen = renderList()
    await screen.findByText(/아직 페이지가 없습니다/)

    // When
    fireEvent.change(screen.getByLabelText('새 페이지'), { target: { value: '새 문서' } })
    fireEvent.click(screen.getByRole('button', { name: '만들기' }))

    // Then: 목록으로 돌아가 다시 찾게 하지 않는다
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledWith(created.id))
  })

  it('생성 실패는 목록을 지우지 않는다', async () => {
    // Given: 목록은 정상, 생성만 실패
    fetchMock.mockResolvedValueOnce(jsonResponse(200, [PAGE]))
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }))
    renderList()
    await screen.findByRole('button', { name: '설계 노트' })

    // When
    fireEvent.click(screen.getByRole('button', { name: '만들기' }))

    // Then: 실패 문구가 떠도 이미 받아둔 선택지는 남아 있어야 한다
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '설계 노트' })).toBeInTheDocument()
  })
})
