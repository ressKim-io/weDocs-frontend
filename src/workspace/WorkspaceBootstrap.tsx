import { useEffect, useState, type FormEvent } from 'react'
import { describeApiFailure } from '../common/http/failure'
import {
  MAX_WORKSPACE_NAME_LENGTH,
  createWorkspace,
  listWorkspaces,
  type WorkspaceResponse,
} from './api'

/// 셋 중 하나만 성립한다 — `loading && error && data` 조합이 표현조차 되지 않게 유니온으로 둔다
/// (design-patterns P4: 불법 상태는 표현 불가능하게).
type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly message: string }
  | { readonly status: 'ready'; readonly workspaces: readonly WorkspaceResponse[] }

interface WorkspaceBootstrapProps {
  readonly onSelect: (workspace: WorkspaceResponse) => void
}

/// 로그인 직후의 첫 화면 — 워크스페이스를 고르거나, 없으면 만든다.
/// **빈 목록은 오류가 아니다**(첫 로그인의 정상 상태) — 그래서 생성 폼은 항상 보인다.
export default function WorkspaceBootstrap({ onSelect }: WorkspaceBootstrapProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // 목록 로딩 실패와 생성 실패를 한 자리에 담지 않는다 — 생성 실패로 이미 받아둔 목록을 잃으면
  // 사용자는 멀쩡한 선택지를 못 보게 된다.
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    // 언마운트·재마운트(StrictMode) 후 늦게 온 응답이 새 상태를 덮어쓰는 것을 막는다.
    let cancelled = false
    listWorkspaces()
      .then((workspaces) => {
        if (!cancelled) setState({ status: 'ready', workspaces })
      })
      .catch((cause) => {
        if (!cancelled) setState({ status: 'failed', message: describeApiFailure(cause) })
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormError(null)
    // 제출 중 재클릭으로 워크스페이스가 두 개 생기는 것을 막는다(POST 는 멱등이 아니다).
    setSubmitting(true)
    let created: WorkspaceResponse | null = null
    try {
      created = await createWorkspace(name)
    } catch (cause) {
      setFormError(describeApiFailure(cause))
    } finally {
      setSubmitting(false)
    }
    // 화면 전환은 이 컴포넌트의 상태 정리가 끝난 뒤에 한다 — 전환이 먼저면 위 `finally` 가
    // 이미 언마운트된 컴포넌트를 갱신하게 된다. 만들자마자 그 안으로 들어간다.
    if (created !== null) {
      onSelect(created)
    }
  }

  return (
    <section className="picker">
      <h2>워크스페이스</h2>

      {state.status === 'loading' && <p className="picker-hint">불러오는 중…</p>}
      {state.status === 'failed' && (
        <p className="picker-error" role="alert">
          {state.message}
        </p>
      )}
      {state.status === 'ready' &&
        (state.workspaces.length === 0 ? (
          <p className="picker-hint">아직 워크스페이스가 없습니다. 하나 만들어 시작하세요.</p>
        ) : (
          <ul className="picker-list">
            {state.workspaces.map((workspace) => (
              <li key={workspace.id}>
                <button type="button" onClick={() => onSelect(workspace)}>
                  {workspace.name}
                </button>
              </li>
            ))}
          </ul>
        ))}

      <form onSubmit={handleCreate}>
        <label htmlFor="workspace-name">새 워크스페이스</label>
        <input
          id="workspace-name"
          type="text"
          required
          maxLength={MAX_WORKSPACE_NAME_LENGTH}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" disabled={submitting}>
          {submitting ? '만드는 중…' : '만들기'}
        </button>
      </form>

      {formError !== null && (
        <p className="picker-error" role="alert">
          {formError}
        </p>
      )}
    </section>
  )
}
