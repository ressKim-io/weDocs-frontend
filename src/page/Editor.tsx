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
import { LocalCaret } from './localCaret'
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

    // 새로고침·탭 닫기 때 내 presence를 **직접** 회수한다.
    //
    // 왜 필요한가: y-websocket 3.0.0에는 페이지 이탈 핸들러가 없다(실측 2026-08-08: `unload`·`pagehide`
    // 참조 0건). 언마운트 경로는 아래 cleanup의 `provider.destroy()`가 제거 프레임을 보내지만,
    // 새로고침은 cleanup이 돌지 않아 **아무도 보내지 않는다.** 게이트웨이도 대신 못 한다 — awareness를
    // 해석하지 않는 불투명 릴레이라 떠난 clientID를 모른다. 그 결과 상대 화면에 내 유령 커서가 남고,
    // 그 창 안에 재접속하면 게이트웨이의 join 시 queryAwareness가 peer에게서 그 유령을 **되살려**
    // 내 화면에 내 과거 커서를 띄운다(실측 재현 2026-08-08). 즉 즉시성을 위한 기능이 유령을 증폭시킨다.
    //
    // `unload`가 아니라 `pagehide`인 이유: `unload`는 폐기 예정이고 back/forward cache 진입을 막으며
    // 모바일에서 발화하지 않는 경로가 있다. `pagehide`는 bfcache 진입까지 포함해 이탈 전에 발화한다.
    // ⚠️ 회수는 **보장이 아니라 최선노력**이다. 세 종류의 경로가 남는다:
    // ① 이벤트가 발화하지 않는 경로 — 탭이 hidden 이 된 뒤의 브라우저·OS discard, 앱 스위처 강제 종료,
    //    렌더러 크래시. Page Lifecycle 이 보장하는 마지막 지점은 `visibilitychange`(hidden)이고
    //    `pagehide`는 그보다 뒤다. 그런데 회수를 `visibilitychange`로 옮기면 **단순 탭 전환에서도**
    //    내 커서가 상대 화면에서 사라진다 — presence 의 의미가 "문서를 보고 있다"인데 탭을 옮길 때마다
    //    깜빡이면 신호가 망가진다. 그래서 teardown·bfcache 진입에만 발화하는 `pagehide`를 유지한다.
    // ② 발화했지만 소켓이 닫혀 프레임이 버려지는 경로 — y-websocket 의 `broadcastMessage`는
    //    `wsconnected && OPEN` 이 아니면 큐·재시도 없이 버린다(재접속 백오프 창·네트워크 단절).
    // ③ 남는 경로는 peer 의 `outdatedTimeout` 폴백이 청소한다. 그 폴백은 **세션당** 30초 + 체크 3초이고
    //    전역 상한이 아니다 — 유령을 쥔 peer 가 join 재질의에 응답하면 새 세션에서 `lastUpdated`가
    //    수신 시각으로 다시 찍혀 33초가 재시작된다(join 이 이어지는 동안 사슬이 연장된다).
    //    즉 회수 성공의 값은 "33초짜리 불편을 없앤다"가 아니라 **그 사슬의 시작점을 없앤다**는 것이다.
    const releasePresence = () => provider.awareness.setLocalState(null)

    // bfcache 복귀 시 presence 를 **다시 무장한다.**
    //
    // 왜 필요한가: `setLocalState(null)` 이후 `getLocalState()` 는 영구히 null 이고, presence 를 다시
    // 발행하는 모든 경로가 그 null 뒤에 잠긴다 — `setLocalStateField`·y-protocols 의 15초 자가 갱신·
    // y-websocket 의 `onopen` 재발행이 전부 `getLocalState() !== null` 가드를 통과하지 못한다.
    // 재무장이 없으면 bfcache 로 돌아온 탭은 **문서를 보고 있는데 아무에게도 보이지 않는다.**
    //
    // 그리고 그 15초 자가 갱신은 keep-alive 가 아니다 — y-websocket 의 `messageReconnectTimeout`(30초)
    // 무응답 감지를 면하게 해주는 유일한 자체 트래픽이라, 룸에 혼자 남으면 30초 주기로 스스로 끊고
    // 재접속하는 flap 이 된다. 재무장이 presence 소실과 그 flap 을 함께 닫는다.
    //
    // `setLocalStateField` 가 아니라 `setLocalState` 인 이유가 위 null 가드다. cursor 필드는 다음
    // selection 변경에서 y-tiptap 이 다시 싣는다 — 그때까지는 이름·색만 있는 부분 presence 다.
    const restorePresence = () => {
      if (provider.awareness.getLocalState() === null) {
        provider.awareness.setLocalState({ user: awarenessUser })
      }
    }

    window.addEventListener('pagehide', releasePresence)
    window.addEventListener('pageshow', restorePresence)

    return () => {
      window.removeEventListener('pagehide', releasePresence)
      window.removeEventListener('pageshow', restorePresence)
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
        // viewer 화면은 contenteditable=false라 브라우저가 caret을 그리지 않는다 — 자기 커서만 보충한다.
        // editable일 때 넣으면 네이티브 caret과 겹쳐 커서가 두 개로 보인다.
        ...(page.canEdit || awarenessUser === null
          ? []
          : [LocalCaret.configure({ color: awarenessUser.color })]),
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
