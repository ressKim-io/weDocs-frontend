// 인증 유스케이스 — REST 호출과 토큰 보관을 잇는 유일한 지점.

import { login, signup } from './api'
import { setToken } from './token'

/// 왜 이 파일이 따로 있나: "가입은 토큰을 주지 않으므로 login 을 이어 부른다"는 것은 서버 계약에서
/// 오는 절차이지 UI 의 관심사가 아니다. 컴포넌트에 두면 화면이 늘어날 때마다 같은 절차가 복제된다.
export async function signIn(email: string, password: string): Promise<void> {
  const token = await login(email, password)
  setToken(token.accessToken, token.expiresInSeconds)
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
