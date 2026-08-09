// 인증 유스케이스 — REST 호출과 인증 세션 보관을 잇는 유일한 지점.

import { fetchCurrentUser, login, signup } from './api'
import { ApiError } from '../common/http/client'
import {
  beginAuthenticationAttempt,
  clearToken,
  isAuthenticationAttemptCurrent,
  setAuthenticatedUser,
  setToken,
  type AuthenticationAttempt,
} from './token'

/// 왜 이 파일이 따로 있나: "가입은 토큰을 주지 않으므로 login 을 이어 부른다"는 것은 서버 계약에서
/// 오는 절차이지 UI 의 관심사가 아니다. 컴포넌트에 두면 화면이 늘어날 때마다 같은 절차가 복제된다.
/// 반환값은 이 시도가 최종 세션을 commit했는지다. 더 최신 시도에 밀린 응답은 실패 UI도 덮지 않는다.
export async function signIn(email: string, password: string): Promise<boolean> {
  const owner = beginAuthenticationAttempt()
  return completeSignIn(owner, email, password)
}

/// 가입도 첫 await 전에 소유권을 얻는다. 지연된 가입 응답이 더 최신 로그인을 덮지 못하게
/// exported signIn을 다시 호출하지 않고 같은 owner로 login/profile 단계를 이어 간다.
export async function signUpAndSignIn(
  email: string,
  password: string,
  displayName: string,
): Promise<boolean> {
  const owner = beginAuthenticationAttempt()
  try {
    await signup(email, password, displayName)
  } catch (cause) {
    if (!clearToken(owner)) {
      return false
    }
    throw cause
  }
  if (!isAuthenticationAttemptCurrent(owner)) {
    return false
  }
  // completeSignIn이 current login/profile 실패의 rollback과 예외 전파를 이미 소유한다.
  // 이 호출을 위 catch 안에 두면 두 번째 clear가 false가 되어 실제 실패를 stale로 오인한다.
  return completeSignIn(owner, email, password)
}

async function completeSignIn(
  owner: AuthenticationAttempt,
  email: string,
  password: string,
): Promise<boolean> {
  try {
    const token = await login(email, password)
    // `/api/users/me`도 Bearer 인증이 필요하므로 토큰을 먼저 임시 저장한다. 단, 이 시도보다
    // 나중에 시작한 로그인이 있으면 응답을 폐기하고 프로필 요청도 보내지 않는다.
    if (!setToken(owner, token.accessToken, token.expiresInSeconds)) {
      return false
    }

    const user = await fetchCurrentUser()
    const commit = setAuthenticatedUser(owner, user)
    if (commit === 'committed') {
      return true
    }
    if (commit === 'stale') {
      return false
    }
    throw new ApiError(401, null, 'authentication expired before profile was loaded')
  } catch (cause) {
    // 현재 시도의 실패만 현재 세션을 지운다. stale 실패는 최신 성공 세션과 UI를 건드리지 않는다.
    if (!clearToken(owner)) {
      return false
    }
    throw cause
  }
}
