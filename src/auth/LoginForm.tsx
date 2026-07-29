import { useState, type FormEvent } from 'react'
import { ApiError, NETWORK_ERROR_STATUS } from '../common/http/client'
import { signIn, signUpAndSignIn } from './session'

/// 서버 `SignupRequest` 의 `@Size(min = 8)` 과 정합. 클라 검증은 왕복을 줄이기 위한 것이지
/// 신뢰 경계가 아니다 — 실제 판정은 언제나 서버가 한다.
const MIN_PASSWORD_LENGTH = 8

type Mode = 'login' | 'signup'

interface LoginFormProps {
  readonly onAuthenticated: () => void
}

/// 로그인/회원가입 화면. 성공하면 토큰이 메모리 스토어에 들어간 상태로 `onAuthenticated` 를 부른다.
export default function LoginForm({ onAuthenticated }: LoginFormProps) {
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  function switchMode(next: Mode) {
    setMode(next)
    // 이전 시도의 실패 문구가 새 모드에 남아 있으면 원인을 오해하게 된다.
    setError(null)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    // 제출 중 재클릭으로 같은 요청이 중복 발생하는 것을 막는다.
    setSubmitting(true)
    try {
      if (mode === 'login') {
        await signIn(email, password)
      } else {
        await signUpAndSignIn(email, password, displayName)
      }
      onAuthenticated()
    } catch (cause) {
      setError(describeFailure(cause))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="auth">
      <form onSubmit={handleSubmit}>
        <h2>{mode === 'login' ? '로그인' : '회원가입'}</h2>

        <label htmlFor="auth-email">이메일</label>
        <input
          id="auth-email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <label htmlFor="auth-password">비밀번호</label>
        <input
          id="auth-password"
          type="password"
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          required
          minLength={MIN_PASSWORD_LENGTH}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        {mode === 'signup' && (
          <>
            <label htmlFor="auth-display-name">표시 이름</label>
            <input
              id="auth-display-name"
              type="text"
              autoComplete="nickname"
              required
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </>
        )}

        {/* role="alert" — 실패는 스크린리더에도 즉시 전달돼야 한다. */}
        {error !== null && (
          <p className="auth-error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" disabled={submitting}>
          {submitting ? '처리 중…' : mode === 'login' ? '로그인' : '가입하고 시작하기'}
        </button>
      </form>

      <button
        type="button"
        className="auth-switch"
        onClick={() => switchMode(mode === 'login' ? 'signup' : 'login')}
      >
        {mode === 'login' ? '계정이 없으신가요? 회원가입' : '이미 계정이 있으신가요? 로그인'}
      </button>
    </section>
  )
}

/// 서버 문구를 그대로 노출하지 않고 `code`/`status` 로만 분기한다 — `detail` 파싱 금지 계약을
/// UI 에서도 지킨다(`api/client.ts` 참조). 분류되지 않은 실패는 뭉뚱그려 내부 상세를 흘리지 않는다.
function describeFailure(cause: unknown): string {
  if (!(cause instanceof ApiError)) {
    return '알 수 없는 오류가 발생했습니다.'
  }
  if (cause.status === NETWORK_ERROR_STATUS) {
    return '서버에 연결할 수 없습니다. doc-service(:8081)가 실행 중인지 확인하세요.'
  }
  switch (cause.code) {
    case 'invalid-credentials':
      return '이메일 또는 비밀번호가 올바르지 않습니다.'
    case 'email-already-used':
      return '이미 가입된 이메일입니다.'
    default:
      break
  }
  // Bean validation 400 에는 `code` 가 없다 — 상태 코드로 받는다.
  if (cause.status === 400) {
    return `입력값을 확인해 주세요. (비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상)`
  }
  return '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'
}
