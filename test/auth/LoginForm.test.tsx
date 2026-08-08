// @vitest-environment jsdom
//
// 전역 환경은 node 다(E2E 가 의존) — 컴포넌트 테스트만 위 docblock 으로 뒤집는다.
// vitest 4 에서 environmentMatchGlobs 가 제거돼 glob 기반 분기는 쓸 수 없다.
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import LoginForm from '../../src/auth/LoginForm'
import { clearToken, getToken } from '../../src/auth/token'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  // RTL 자동 cleanup 은 globals:false 에선 등록되지 않는다(afterEach 가 전역이 아니므로) — 명시적으로 부른다.
  cleanup()
  vi.unstubAllGlobals()
  fetchMock.mockReset()
  clearToken()
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const TOKEN_BODY = { accessToken: 'jwt-new', tokenType: 'Bearer', expiresInSeconds: 3600 }
const USER_BODY = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'user@example.com',
  displayName: '테스터',
}

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

/// 폼에 직접 submit 을 던진다 — 버튼 클릭 경로는 jsdom 의 HTML5 검증 구현에 따라 갈리므로
/// 테스트가 브라우저 검증 동작에 의존하지 않게 한다(검증 자체는 서버가 판정한다).
function submitForm(container: HTMLElement) {
  fireEvent.submit(container.querySelector('form') as HTMLFormElement)
}

describe('LoginForm', () => {
  it('로그인 폼을 렌더한다', () => {
    // Given/When
    render(<LoginForm onAuthenticated={() => { }} />)

    // Then
    expect(screen.getByLabelText('이메일')).toBeInTheDocument()
    expect(screen.getByLabelText('비밀번호')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '로그인' })).toBeInTheDocument()
    // 회원가입 전용 필드는 기본 모드에서 보이지 않는다
    expect(screen.queryByLabelText('표시 이름')).not.toBeInTheDocument()
  })

  it('로그인 성공하면 토큰을 저장하고 onAuthenticated 를 부른다', async () => {
    // Given
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, TOKEN_BODY))
      .mockResolvedValueOnce(jsonResponse(200, USER_BODY))
    const onAuthenticated = vi.fn()
    const { container } = render(<LoginForm onAuthenticated={onAuthenticated} />)

    // When
    fill('이메일', 'user@example.com')
    fill('비밀번호', 'password123')
    submitForm(container)

    // Then
    await vi.waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1))
    expect(getToken()).toBe('jwt-new')
  })

  it('401 invalid-credentials 면 실패를 표시하고 토큰을 저장하지 않는다', async () => {
    // Given: 서버가 자격증명 실패를 돌려준다
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ status: 401, detail: 'invalid credentials', code: 'invalid-credentials' }),
        { status: 401, headers: { 'content-type': 'application/problem+json' } },
      ),
    )
    const onAuthenticated = vi.fn()
    const { container } = render(<LoginForm onAuthenticated={onAuthenticated} />)

    // When
    fill('이메일', 'user@example.com')
    fill('비밀번호', 'wrong-password')
    submitForm(container)

    // Then: 서버 원문이 아니라 코드로 분기한 우리 문구가 보인다
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '이메일 또는 비밀번호가 올바르지 않습니다.',
    )
    expect(onAuthenticated).not.toHaveBeenCalled()
    expect(getToken()).toBeNull()
  })

  it('서버 미기동(네트워크 실패)은 자격증명 실패와 다른 문구로 안내한다', async () => {
    // Given: fetch 자체가 실패
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    const { container } = render(<LoginForm onAuthenticated={() => { }} />)

    // When
    fill('이메일', 'user@example.com')
    fill('비밀번호', 'password123')
    submitForm(container)

    // Then
    expect(await screen.findByRole('alert')).toHaveTextContent('서버에 연결할 수 없습니다')
  })

  it('회원가입은 signup 후 login 을 이어 불러 토큰을 얻는다', async () => {
    // Given: 가입은 201 + UserResponse 만 준다(토큰 없음) — 이 계약이 깨지면 이 테스트가 먼저 깨진다
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(201, { id: 'u1', email: 'new@example.com', displayName: '테스터' }),
      )
      .mockResolvedValueOnce(jsonResponse(200, TOKEN_BODY))
      .mockResolvedValueOnce(
        jsonResponse(200, { ...USER_BODY, email: 'new@example.com' }),
      )
    const onAuthenticated = vi.fn()
    const { container } = render(<LoginForm onAuthenticated={onAuthenticated} />)

    // When: 회원가입 모드로 전환 후 제출
    fireEvent.click(screen.getByRole('button', { name: /회원가입/ }))
    fill('이메일', 'new@example.com')
    fill('비밀번호', 'password123')
    fill('표시 이름', '테스터')
    submitForm(container)

    // Then: 가입 → 토큰 발급 → 인증 사용자 조회 순서이며, 세 단계가 끝나야 세션이 완성된다
    await vi.waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1))
    const paths = fetchMock.mock.calls.map(([url]) => new URL(url as string).pathname)
    expect(paths).toEqual(['/api/auth/signup', '/api/auth/login', '/api/users/me'])
    expect(getToken()).toBe('jwt-new')
  })

  it('모드를 전환하면 이전 실패 문구를 지운다', async () => {
    // Given: 로그인 실패로 문구가 떠 있는 상태
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    const { container } = render(<LoginForm onAuthenticated={() => { }} />)
    fill('이메일', 'user@example.com')
    fill('비밀번호', 'password123')
    submitForm(container)
    expect(await screen.findByRole('alert')).toBeInTheDocument()

    // When: 회원가입으로 전환
    fireEvent.click(screen.getByRole('button', { name: /회원가입/ }))

    // Then: 새 모드에 남은 실패 문구가 원인을 오해하게 하지 않는다
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
