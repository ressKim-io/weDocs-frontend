// @vitest-environment jsdom
//
// 전역 환경은 node 다(E2E 가 의존) — 컴포넌트 테스트만 위 docblock 으로 뒤집는다.
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import type { Doc } from 'yjs'
import Editor from '../../src/page/Editor'
import type { PageDetailResponse } from '../../src/page/api'
import {
  beginAuthenticationAttempt,
  clearToken,
  setAuthenticatedUser,
  setToken,
} from '../../src/auth/token'

/// provider 생성 인자를 기록만 하는 대역. 실제 WS 를 열지 않으므로 게이트웨이 없이도 **배선**을 검증한다.
/// `vi.hoisted` 인 이유: `vi.mock` 은 import 위로 끌어올려져 일반 const 를 참조하면 TDZ 로 죽는다.
const { providerCalls, providerInstances } = vi.hoisted(() => ({
  providerCalls: [] as unknown[][],
  /// presence 회수 검증은 인자가 아니라 **awareness 상태**를 봐야 하므로 인스턴스도 붙잡는다.
  providerInstances: [] as { awareness: { getLocalState(): unknown } }[],
}))

vi.mock('y-websocket', async () => {
  const { Awareness } = await import('y-protocols/awareness')
  return {
    WebsocketProvider: class {
      readonly awareness: InstanceType<typeof Awareness>

      constructor(...args: unknown[]) {
        providerCalls.push(args)
        this.awareness = new Awareness(args[2] as Doc)
        providerInstances.push(this as unknown as { awareness: { getLocalState(): unknown } })
      }

      destroy() {
        this.awareness.destroy()
      }
    },
  }
})

const PAGE_ID = '33333333-3333-4333-8333-333333333333'

function authenticate(): void {
  const owner = beginAuthenticationAttempt()
  setToken(owner, 'jwt-abc', 3600)
  setAuthenticatedUser(owner, {
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
  providerInstances.length = 0
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
    setToken(beginAuthenticationAttempt(), 'jwt-old', 0)

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

describe('Editor — 이탈 시 presence 회수', () => {
  // 왜 단위 테스트가 필요한가: 이 동작의 실증은 브라우저 검증(`test/browser`)에 있지만 그건 5프로세스를
  // 요구해 **CI 에서 돌지 않는다.** 배선이 조용히 사라지는 회귀를 CI 가 잡을 수 있게 여기에 가드를 둔다.

  it('pagehide 가 오면 내 awareness 상태를 비운다', async () => {
    // Given: 연결된 세션 — awareness 에 내 사용자 정보가 실려 있다
    authenticate()
    await act(async () => {
      render(<Editor page={pageWith()} />)
    })
    const provider = providerInstances[0]
    expect(provider.awareness.getLocalState()).not.toBeNull()

    // When: 새로고침·탭 닫기 (언마운트 cleanup 은 돌지 않는 경로다)
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'))
    })

    // Then: 비우지 않으면 상대 화면에 내 유령 커서가 약 33초 남고(outdatedTimeout 30s + 체크 3s),
    // 그 창 안에 재접속하면 게이트웨이 queryAwareness 가 그 유령을 되살려 내 과거 커서를 내게 보여준다
    expect(provider.awareness.getLocalState()).toBeNull()
  })

  it('언마운트 시 리스너를 제거한다 — 등록과 해제를 짝지어 누수를 막는다', async () => {
    // Given
    authenticate()
    const addListener = vi.spyOn(window, 'addEventListener')
    const removeListener = vi.spyOn(window, 'removeEventListener')

    let unmount = (): void => { }
    await act(async () => {
      unmount = render(<Editor page={pageWith()} />).unmount
    })
    const registered = addListener.mock.calls.find(([type]) => type === 'pagehide')
    expect(registered).toBeDefined()

    // When
    await act(async () => {
      unmount()
    })

    // Then: 같은 핸들러 참조로 해제돼야 한다 — 익명 함수를 새로 만들어 넘기면 해제가 조용히 실패한다
    expect(removeListener).toHaveBeenCalledWith('pagehide', registered?.[1])

    addListener.mockRestore()
    removeListener.mockRestore()
  })
})

describe('Editor — 자기 caret 보충 배선', () => {
  // 렌더 품질의 증명은 브라우저 계층(`test/browser`)에 있지만 그건 CI 에서 돌지 않는다.
  // 여기서는 **배선의 존재/부재**만 단정한다 — 조건이 뒤집히거나 사라지는 회귀를 CI 가 잡는다.

  async function focusEditorSurface(): Promise<void> {
    const surface = document.querySelector('.editor .tiptap')
    expect(surface).not.toBeNull()
    await act(async () => {
      surface?.dispatchEvent(new FocusEvent('focus', { bubbles: false }))
    })
  }

  it('viewer 화면에는 자기 caret 을 보충한다', async () => {
    // Given: 읽기 전용 — contenteditable=false 라 브라우저가 caret 을 그리지 않는다
    authenticate()
    await act(async () => {
      render(<Editor page={pageWith({ myRole: 'VIEWER', canEdit: false })} />)
    })

    // When: 문서에 포커스가 오면
    await focusEditorSurface()

    // Then: 앱이 caret 을 직접 그린다. 없으면 남들만 내 커서를 보는 비대칭이 된다
    expect(document.querySelector('.local-caret')).not.toBeNull()
  })

  it('편집 가능한 화면에는 보충하지 않는다 — 네이티브 caret 과 겹쳐 커서가 두 개로 보인다', async () => {
    // Given: 편집 가능 — 브라우저가 이미 caret 을 그린다
    authenticate()
    await act(async () => {
      render(<Editor page={pageWith()} />)
    })

    // When
    await focusEditorSurface()

    // Then
    expect(document.querySelector('.local-caret')).toBeNull()
  })
})
