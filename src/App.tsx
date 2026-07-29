import { useState } from 'react'
import Editor from './Editor'
import LoginForm from './auth/LoginForm'
import { clearToken, getToken } from './auth/token'

export default function App() {
  // 토큰은 메모리 전용이라 초기값은 사실상 항상 null 이다(새로고침 = 재로그인, 의도된 동작).
  // 그럼에도 상수 false 대신 스토어를 읽는 이유: "토큰이 있는가"의 답을 두 곳에 두지 않기 위해서다.
  const [authenticated, setAuthenticated] = useState(() => getToken() !== null)

  function handleSignOut() {
    clearToken()
    setAuthenticated(false)
  }

  return (
    <main className="app">
      <h1>weDocs</h1>
      <p className="subtitle">협업 에디터 — M2 Phase 2c (인증 셸)</p>
      {authenticated ? (
        <>
          <button type="button" className="sign-out" onClick={handleSignOut}>
            로그아웃
          </button>
          <Editor />
        </>
      ) : (
        <LoginForm onAuthenticated={() => setAuthenticated(true)} />
      )}
    </main>
  )
}
