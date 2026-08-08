// 인증 유스케이스 — REST 호출과 인증 세션 보관을 잇는 유일한 지점.

import { fetchCurrentUser, login, signup } from './api'
import { clearToken, setAuthenticatedUser, setToken } from './token'

/// 왜 이 파일이 따로 있나: "가입은 토큰을 주지 않으므로 login 을 이어 부른다"는 것은 서버 계약에서
/// 오는 절차이지 UI 의 관심사가 아니다. 컴포넌트에 두면 화면이 늘어날 때마다 같은 절차가 복제된다.
export async function signIn(email: string, password: string): Promise<void> {
  const token = await login(email, password)
  // `/api/users/me`도 Bearer 인증이 필요하므로 토큰을 먼저 임시 저장한다. 프로필 조회까지 성공해야
  // 완전한 세션이며, 중간 실패 시 토큰을 지워 반쪽짜리 로그인 상태가 남지 않게 한다.
  setToken(token.accessToken, token.expiresInSeconds)
  try {
    const user = await fetchCurrentUser()
    setAuthenticatedUser(user)
  } catch (cause) {
    clearToken()
    throw cause
  }
}

/// 가입 실패(예: 이메일 중복)는 그대로 전파한다 — 여기서 삼키면 호출자가 실패를 표시할 수 없다.
export async function signUpAndSignIn(
  email: string,
  password: string,
  displayName: string,
): Promise<void> {
  await signup(email, password, displayName)
  await signIn(email, password)
}
