import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../src/common/http/client'
import { createWorkspace, listWorkspaces } from '../../src/workspace/api'

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

const WORKSPACE = {
  id: '11111111-1111-4111-8111-111111111111',
  name: '내 워크스페이스',
  ownerId: '22222222-2222-4222-8222-222222222222',
}

function lastRequest(): [string, RequestInit] {
  return fetchMock.mock.calls.at(-1) as [string, RequestInit]
}

describe('listWorkspaces', () => {
  it('목록을 검증해 반환한다', async () => {
    // Given
    fetchMock.mockResolvedValue(jsonResponse(200, [WORKSPACE]))

    // When
    const workspaces = await listWorkspaces()

    // Then
    expect(workspaces).toEqual([WORKSPACE])
    expect(lastRequest()[0]).toBe('http://localhost:8081/api/workspaces')
  })

  it('빈 배열은 오류가 아니다 — 첫 로그인의 정상 상태다', async () => {
    // Given/When/Then: 여기서 실패시키면 "워크스페이스를 만들어야 하는 사용자"가 오류 화면을 본다
    fetchMock.mockResolvedValue(jsonResponse(200, []))
    await expect(listWorkspaces()).resolves.toEqual([])
  })

  it('원소가 계약을 어기면 실패시킨다', async () => {
    // Given: id 없는 행이 섞여 있다
    fetchMock.mockResolvedValue(jsonResponse(200, [WORKSPACE, { name: 'x' }]))

    // When/Then
    const error = await listWorkspaces().catch((e) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.code).toBe('malformed-response')
  })
})

describe('createWorkspace', () => {
  it('이름을 실어 POST 하고 생성 결과(201)를 검증해 반환한다', async () => {
    // Given
    fetchMock.mockResolvedValue(jsonResponse(201, WORKSPACE))

    // When
    const created = await createWorkspace('내 워크스페이스')

    // Then
    const [url, init] = lastRequest()
    expect(url).toBe('http://localhost:8081/api/workspaces')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ name: '내 워크스페이스' })
    expect(created).toEqual(WORKSPACE)
  })
})
