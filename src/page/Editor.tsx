import { useEffect, useMemo, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { getAuthenticatedUser, getToken } from '../auth/token'
import { resolveWsUrl } from '../common/ws/connection'
import type { PageDetailResponse } from './api'
import { awarenessUserFor, safePresenceColor, safePresenceName } from './presence'

const CONFIGURED_WS_URL = import.meta.env.VITE_WS_URL ?? 'ws://localhost:8080/ws/doc'

/// 게이트웨이 토큰 전달 규약(ADR-0014) — 클라가 `[SENTINEL, <jwt>]` 두 값을 제안하면 서버는 토큰을
/// 검증한 뒤 **SENTINEL 만** echo 한다(토큰은 응답에 반향하지 않는다). 서버 상수
/// (`AuthSubprotocol.SENTINEL`)와 문자열이 정확히 일치해야 하므로 리터럴은 이 한 곳에만 둔다 —
/// 토큰이 정확히 1개가 아니면 게이트웨이가 fail-closed 로 거절한다.
const AUTH_SUBPROTOCOL = 'wedocs.sync.v1'

interface EditorProps {
  readonly page: PageDetailResponse
}

interface CollaborationSession {
  readonly doc: Y.Doc
  readonly provider: WebsocketProvider
}

function renderRemoteCaret(remoteUser: Record<string, unknown>): HTMLElement {
  const color = safePresenceColor(remoteUser.color)
  const caret = document.createElement('span')
  caret.classList.add('collaboration-carets__caret')
  caret.style.borderColor = color

  const label = document.createElement('span')
  label.classList.add('collaboration-carets__label')
  label.style.backgroundColor = color
  label.textContent = safePresenceName(remoteUser.name)
  caret.append(label)
  return caret
}

/// Tiptap + Yjs 협업 에디터. room = **페이지 UUID**, 편집 가능 여부는 서버가 준 `canEdit` 이 정한다.
///
/// ## Provider lifecycle (StrictMode 안전)
///
/// React 18 StrictMode는 개발 모드에서 mount→unmount→remount를 수행한다. 이전 구현은
/// `useMemo` 안에서 `new WebsocketProvider(...)`를 생성했는데:
/// - 첫 mount: provider 생성 → WS 연결 시작
/// - StrictMode unmount: cleanup → `provider.destroy()` → WS가 수립 전 닫힘
/// - remount: **파괴된 provider의 memo 캐시**가 남아 있어 새 provider를 만들지 않음
/// → "closed before established" 반복 재연결
///
/// 해법: provider 생성을 `useEffect` 안에서 수행한다. cleanup이 호출되면 해당 인스턴스만
/// 파괴되고, remount 시 새 인스턴스가 생긴다. ydoc도 마찬가지로 effect에서 관리한다.
export default function Editor({ page }: EditorProps) {
  // 마운트 시점의 **사용 가능한** 토큰(만료면 null). 왜 만료를 미리 보는가: 만료 토큰으로 붙으면
  // 게이트웨이는 401 로 거절하지만 브라우저는 그 상태 코드를 볼 수 없어(WS 실패는 code 1006 뿐)
  // y-websocket 이 상한 2500ms backoff 로 무한 재접속한다. **연결 전에 막는 것이 유일한 대책이다.**
  const token = useMemo(() => getToken(), [])
  const authenticatedUser = useMemo(() => getAuthenticatedUser(), [])
  const awarenessUser = useMemo(
    () => (authenticatedUser === null ? null : awarenessUserFor(authenticatedUser)),
    [authenticatedUser],
  )
  // 보안 페이지(https)에선 wss:// 강제 — 평문 WS의 mixed-content 차단 방어.
  const wsUrl = useMemo(() => resolveWsUrl(CONFIGURED_WS_URL, window.location.protocol), [])

  // Y.Doc과 provider는 생명주기가 같고 caret 확장도 둘을 함께 요구하므로 원자적으로 공개한다.
  const [collaboration, setCollaboration] = useState<CollaborationSession | null>(null)

  useEffect(() => {
    if (token === null || awarenessUser === null) return

    const doc = new Y.Doc()
    const provider = new WebsocketProvider(wsUrl, page.id, doc, {
      protocols: [AUTH_SUBPROTOCOL, token],
    })

    // join 직후 queryAwareness 응답에도 사용자 정보가 실리도록 에디터 생성보다 먼저 설정한다.
    // CollaborationCaret도 같은 객체를 재설정하지만 계산 출처는 이 awarenessUser 하나뿐이다.
    provider.awareness.setLocalStateField('user', awarenessUser)
    setCollaboration({ doc, provider })

    return () => {
      provider.destroy()
      doc.destroy()
      setCollaboration(null)
    }
  }, [token, awarenessUser, wsUrl, page.id])

  const editor = useEditor(
    {
      // viewer 는 **타이핑 자체가 잠긴다.** 잠그지 않으면 입력이 로컬 Y.Doc 에만 반영되고 게이트웨이는
      // 조용히 drop 해(`ws_write_dropped_total{reason=viewer}`) 새로고침 시 유실된다 — UX 가 아니라
      // 정합성 문제다. 판단은 `myRole` 이 아니라 `canEdit`(서버 정책의 단일 출처)으로 한다.
      editable: page.canEdit,
      // viewer도 문서에 포커스해 selection awareness를 발행할 수 있어야 한다. 입력 가능 여부는
      // editable=false가 계속 막고, tabindex는 키보드 포커스와 원격 커서 표시만 연다.
      editorProps: { attributes: { tabindex: '0' } },
      extensions: [
        // Collaboration 이 자체 undo/redo 를 제공 → StarterKit 의 undoRedo 비활성(중복 방지).
        StarterKit.configure({ undoRedo: false }),
        ...(collaboration && awarenessUser
          ? [
            Collaboration.configure({ document: collaboration.doc }),
            CollaborationCaret.configure({
              provider: collaboration.provider,
              user: awarenessUser,
              render: renderRemoteCaret,
              selectionRender: (remoteUser) => ({
                nodeName: 'span',
                class: 'collaboration-carets__selection',
                style: `background-color: ${safePresenceColor(remoteUser.color)}33`,
              }),
            }),
          ]
          : []),
      ],
    },
    [collaboration, awarenessUser],
  )

  if (token === null || authenticatedUser === null) {
    return (
      <p className="picker-error" role="alert">
        세션이 만료되었습니다. 로그아웃 후 다시 로그인해 주세요.
      </p>
    )
  }

  if (!collaboration) {
    return <p className="picker-hint">연결 중…</p>
  }

  return (
    <section className="editor">
      {!page.canEdit && (
        <p className="read-only" role="status">
          읽기 전용 — 내 권한은 <strong>{page.myRole}</strong> 입니다. 편집이 잠겨 있습니다.
        </p>
      )}
      <p className="hint">
        gateway: <code>{wsUrl}/{page.id}</code> — 이 주소를 다른 탭에서도 열어 동시 편집해 보세요.
      </p>
      <EditorContent editor={editor} />
    </section>
  )
}
