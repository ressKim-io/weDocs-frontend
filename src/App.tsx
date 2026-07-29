import { useState } from 'react'
import LoginForm from './auth/LoginForm'
import { clearToken, getToken } from './auth/token'
import { parseRoom } from './common/ws/connection'
import PageEditor from './page/PageEditor'
import PageList from './page/PageList'
import WorkspaceBootstrap from './workspace/WorkspaceBootstrap'
import type { WorkspaceResponse } from './workspace/api'

/// `?room=<page uuid>` — 같은 페이지를 **다른 탭에서 바로 열기** 위한 딥링크(두 탭 수렴 데모의 경로).
/// 무효하거나 없으면 null 이고, 그때는 연결하지 않고 선택 화면을 보여준다.
function pageIdFromUrl(): string | null {
  return parseRoom(new URLSearchParams(window.location.search).get('room'))
}

export default function App() {
  // 토큰은 메모리 전용이라 초기값은 사실상 항상 null 이다(새로고침 = 재로그인, 의도된 동작).
  // 그럼에도 상수 false 대신 스토어를 읽는 이유: "토큰이 있는가"의 답을 두 곳에 두지 않기 위해서다.
  const [authenticated, setAuthenticated] = useState(() => getToken() !== null)
  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null)
  const [pageId, setPageId] = useState<string | null>(pageIdFromUrl)

  function openPage(id: string) {
    setPageId(id)
    // 주소를 갱신해 이 탭의 URL 하나로 같은 페이지를 다시 열 수 있게 한다(두 번째 탭 = 복사·붙여넣기).
    // pushState 가 아니라 replaceState 인 이유: 뒤로가기로 돌아갈 "이전 페이지"가 앱 안에 없다.
    window.history.replaceState(null, '', `?room=${encodeURIComponent(id)}`)
  }

  function closePage() {
    setPageId(null)
    window.history.replaceState(null, '', window.location.pathname)
  }

  function handleSignOut() {
    clearToken()
    // 선택 상태까지 지운다 — 다음 사용자가 이전 사용자의 워크스페이스 이름을 보지 않게.
    setWorkspace(null)
    closePage()
    setAuthenticated(false)
  }

  /// 로그인 이후의 화면 전환은 이 세 갈래가 전부다: 페이지를 열었나 → 워크스페이스를 골랐나 → 목록.
  function renderSignedIn() {
    if (pageId !== null) {
      // key 로 페이지가 바뀌면 통째로 다시 마운트한다 — Y.Doc·provider·권한이 한 인스턴스 안에서
      // 뒤섞이는 경우를 아예 만들지 않는다(이전 페이지의 canEdit 이 남는 사고 방지).
      return <PageEditor key={pageId} pageId={pageId} onClose={closePage} />
    }
    if (workspace === null) {
      return <WorkspaceBootstrap onSelect={setWorkspace} />
    }
    return <PageList workspace={workspace} onOpen={openPage} onBack={() => setWorkspace(null)} />
  }

  return (
    <main className="app">
      <h1>weDocs</h1>
      <p className="subtitle">협업 에디터 — M2 Phase 2c</p>
      {authenticated ? (
        <>
          <button type="button" className="sign-out" onClick={handleSignOut}>
            로그아웃
          </button>
          {renderSignedIn()}
        </>
      ) : (
        <LoginForm onAuthenticated={() => setAuthenticated(true)} />
      )}
    </main>
  )
}
