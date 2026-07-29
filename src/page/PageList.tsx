import { useEffect, useState, type FormEvent } from 'react'
import { describeApiFailure } from '../common/http/failure'
import type { WorkspaceResponse } from '../workspace/api'
import { MAX_PAGE_TITLE_LENGTH, createPage, listPages, type PageResponse } from './api'

/// 서버가 빈 title 을 허용하므로(Untitled 패턴) 목록에 **클릭할 글자가 없는 행**이 생길 수 있다.
const UNTITLED = '제목 없음'

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly message: string }
  | { readonly status: 'ready'; readonly pages: readonly PageResponse[] }

interface PageListProps {
  readonly workspace: WorkspaceResponse
  readonly onOpen: (pageId: string) => void
  readonly onBack: () => void
}

/// 평면 페이지 목록 + 생성. 선택한 페이지의 **UUID 가 곧 room** 이다 — 트리(계층) 렌더링은 M3.
export default function PageList({ workspace, onOpen, onBack }: PageListProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [title, setTitle] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    listPages(workspace.id)
      .then((pages) => {
        if (!cancelled) setState({ status: 'ready', pages })
      })
      .catch((cause) => {
        if (!cancelled) setState({ status: 'failed', message: describeApiFailure(cause) })
      })
    return () => {
      cancelled = true
    }
  }, [workspace.id])

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormError(null)
    // 제출 중 재클릭으로 페이지가 두 개 생기는 것을 막는다(POST 는 멱등이 아니다).
    setSubmitting(true)
    let created: PageResponse | null = null
    try {
      created = await createPage(workspace.id, title)
    } catch (cause) {
      setFormError(describeApiFailure(cause))
    } finally {
      setSubmitting(false)
    }
    // 화면 전환은 이 컴포넌트의 상태 정리가 끝난 뒤에 한다 — 전환이 먼저면 위 `finally` 가
    // 이미 언마운트된 컴포넌트를 갱신하게 된다. 만든 페이지는 바로 연다(목록에서 다시 찾게 하지 않는다).
    if (created !== null) {
      onOpen(created.id)
    }
  }

  return (
    <section className="picker">
      <h2>{workspace.name}</h2>
      <button type="button" className="picker-back" onClick={onBack}>
        ← 다른 워크스페이스
      </button>

      {state.status === 'loading' && <p className="picker-hint">불러오는 중…</p>}
      {state.status === 'failed' && (
        <p className="picker-error" role="alert">
          {state.message}
        </p>
      )}
      {state.status === 'ready' &&
        (state.pages.length === 0 ? (
          <p className="picker-hint">아직 페이지가 없습니다. 하나 만들어 보세요.</p>
        ) : (
          // 서버가 position·생성순으로 정렬해 준다 — 클라에서 재정렬하지 않는다.
          <ul className="picker-list">
            {state.pages.map((page) => (
              <li key={page.id}>
                <button type="button" onClick={() => onOpen(page.id)}>
                  {page.title.trim().length === 0 ? UNTITLED : page.title}
                </button>
              </li>
            ))}
          </ul>
        ))}

      <form onSubmit={handleCreate}>
        <label htmlFor="page-title">새 페이지</label>
        {/* 서버가 빈 title 을 허용하므로 required 를 걸지 않는다 — 클라가 서버보다 엄격해지지 않게. */}
        <input
          id="page-title"
          type="text"
          maxLength={MAX_PAGE_TITLE_LENGTH}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
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
