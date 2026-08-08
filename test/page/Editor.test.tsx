// @vitest-environment jsdom
//
// 전역 환경은 node 다(E2E 가 의존) — 컴포넌트 테스트만 위 docblock 으로 뒤집는다.
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import type { Doc } from 'yjs'
import Editor from '../../src/page/Editor'
import type { PageDetailResponse } from '../../src/page/api'
import { clearToken, setAuthenticatedUser, setToken } from '../../src/auth/token'

/// provider 생성 인자를 기록만 하는 대역. 실제 WS 를 열지 않으므로 게이트웨이 없이도 **배선**을 검증한다.
/// `vi.hoisted` 인 이유: `vi.mock` 은 import 위로 끌어올려져 일반 const 를 참조하면 TDZ 로 죽는다.
const { providerCalls } = vi.hoisted(() => ({ providerCalls: [] as unknown[][] }))

vi.mock('y-websocket', async () => {
  const { Awareness } = await import('y-protocols/awareness')
  return {
    WebsocketProvider: class {
      readonly awareness: InstanceType<typeof Awareness>

      constructor(...args: unknown[]) {
        providerCalls.push(args)
        this.awareness = new Awareness(args[2] as Doc)
      }

      destroy() {
        this.awareness.destroy()
      }
    },
  }
})

const PAGE_ID = '33333333-3333-4333-8333-333333333333'

function authenticate(): void {
  setToken('jwt-abc', 3600)
  setAuthenticatedUser({
    id: '22222222-2222-4222-8222-222222222222',
    displayName: '협업 사용자',
  })
}

function pageWith(overrides: Partial<PageDetailResponse> = {}): PageDetailResponse {
  return {
    id: PAGE_ID,
    workspaceId: '11111111-1111-4111-8111-111111111111',
    parentId: null,
    title: '설계 노트',
    position: 0,
    archived: false,
    myRole: 'EDITOR',
    canEdit: true,
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
  clearToken()
  providerCalls.length = 0
})

describe('Editor — 토큰 전달', () => {
  it('게이트웨이 규약대로 [SENTINEL, jwt] 를 서브프로토콜로 싣는다', async () => {
    // Given: 유효 토큰
    authenticate()

    // When — provider 생성은 useEffect 안이라 act()로 flush 해야 한다
    await act(async () => {
      render(<Editor page={pageWith()} />)
    })

    // Then: 서버 AuthSubprotocol 은 토큰이 정확히 1개가 아니면 fail-closed 로 거절한다
    expect(providerCalls).toHaveLength(1)
    const [url, room, , options] = providerCalls[0]
    expect(url).toBe('ws://localhost:8080/ws/doc')
    expect(room).toBe(PAGE_ID)
    expect(options).toEqual({ protocols: ['wedocs.sync.v1', 'jwt-abc'] })
  })

  it('토큰이 없으면 provider 를 아예 만들지 않는다', () => {
    // Given: 로그아웃 상태

    // When
    render(<Editor page={pageWith()} />)

    // Then: 무토큰 연결은 게이트웨이가 401 로 거절하지만 브라우저는 그 상태를 볼 수 없어
    // (WS 실패는 code 1006 뿐) 무한 재접속에 빠진다 — 연결 전에 막는 것이 유일한 대책이다
    expect(providerCalls).toHaveLength(0)
    expect(screen.getByRole('alert')).toHaveTextContent('세션이 만료되었습니다')
  })

  it('만료된 토큰도 없는 것과 같이 취급한다', () => {
    // Given: 이미 만료된 토큰(스큐 마진 안쪽도 만료로 본다)
    setToken('jwt-old', 0)

    // When
    render(<Editor page={pageWith()} />)

    // Then
    expect(providerCalls).toHaveLength(0)
  })
})

describe('Editor — viewer 잠금', () => {
  it('canEdit=false 면 읽기 전용 배지를 보여준다', async () => {
    // Given: viewer 로 공유받은 페이지
    authenticate()

    // When
    await act(async () => {
      render(<Editor page={pageWith({ myRole: 'VIEWER', canEdit: false })} />)
    })

    // Then: 왜 타이핑이 안 되는지 모르는 상태를 만들지 않는다. 역할은 표시용으로만 쓴다
    const badge = screen.getByRole('status')
    expect(badge).toHaveTextContent('읽기 전용')
    expect(badge).toHaveTextContent('VIEWER')
  })

  it('canEdit=true 면 배지가 없다', async () => {
    // Given/When
    authenticate()
    await act(async () => {
      render(<Editor page={pageWith()} />)
    })

    // Then
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('역할이 EDITOR 라도 canEdit=false 면 잠근다 — 판단은 canEdit 단일 출처다', async () => {
    // Given: 역할만 보면 편집 가능해 보이는 응답
    authenticate()

    // When
    await act(async () => {
      render(<Editor page={pageWith({ myRole: 'EDITOR', canEdit: false })} />)
    })

    // Then: "editor 면 편집 가능"을 클라가 재구현하면 서버 정책과 갈라진다
    expect(screen.getByRole('status')).toHaveTextContent('읽기 전용')
  })
})
