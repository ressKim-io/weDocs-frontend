// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import WorkspaceBootstrap from '../../src/workspace/WorkspaceBootstrap'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
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

const WORKSPACE = {
  id: '11111111-1111-4111-8111-111111111111',
  name: '내 워크스페이스',
  ownerId: '22222222-2222-4222-8222-222222222222',
}

describe('WorkspaceBootstrap', () => {
  it('워크스페이스가 없으면 생성을 유도한다 — 오류 화면이 아니다', async () => {
    // Given: 첫 로그인 = 빈 목록(정상 상태)
    fetchMock.mockResolvedValue(jsonResponse(200, []))

    // When
    render(<WorkspaceBootstrap onSelect={vi.fn()} />)

    // Then
    expect(await screen.findByText(/아직 워크스페이스가 없습니다/)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByLabelText('새 워크스페이스')).toBeInTheDocument()
  })

  it('목록에서 고르면 그대로 넘긴다', async () => {
    // Given
    fetchMock.mockResolvedValue(jsonResponse(200, [WORKSPACE]))
    const onSelect = vi.fn()
    render(<WorkspaceBootstrap onSelect={onSelect} />)

    // When
    fireEvent.click(await screen.findByRole('button', { name: '내 워크스페이스' }))

    // Then
    expect(onSelect).toHaveBeenCalledWith(WORKSPACE)
  })

  it('만들면 그 워크스페이스로 바로 들어간다', async () => {
    // Given: 빈 목록 → 생성 201
    fetchMock.mockResolvedValueOnce(jsonResponse(200, []))
    fetchMock.mockResolvedValueOnce(jsonResponse(201, WORKSPACE))
    const onSelect = vi.fn()
    render(<WorkspaceBootstrap onSelect={onSelect} />)
    await screen.findByText(/아직 워크스페이스가 없습니다/)

    // When
    fireEvent.change(screen.getByLabelText('새 워크스페이스'), { target: { value: '내 워크스페이스' } })
    fireEvent.click(screen.getByRole('button', { name: '만들기' }))

    // Then: 생성 다음의 유일한 행동은 "쓰기 시작"이다
    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith(WORKSPACE))
  })

  it('목록 로딩 실패는 alert 로 알린다', async () => {
    // Given: doc-service 미기동
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))

    // When
    render(<WorkspaceBootstrap onSelect={vi.fn()} />)

    // Then: 네트워크 미도달은 HTTP 실패와 다른 문구로 구분한다
    expect(await screen.findByRole('alert')).toHaveTextContent('서버에 연결할 수 없습니다')
  })
})
