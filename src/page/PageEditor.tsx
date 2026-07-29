import { useEffect, useState } from 'react'
import { describeApiFailure } from '../common/http/failure'
import Editor from './Editor'
import { getPage, type PageDetailResponse } from './api'

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly message: string }
  | { readonly status: 'ready'; readonly page: PageDetailResponse }

interface PageEditorProps {
  readonly pageId: string
  readonly onClose: () => void
}

/// 페이지를 열기 위한 관문 — **연결 전에** 단건 조회로 권한(`canEdit`)을 받아온다.
///
/// 왜 조회가 먼저인가: 역할을 모른 채 붙으면 viewer 가 타이핑할 수 있게 되고, 그 입력은 게이트웨이에서
/// 조용히 버려져 로컬만 divergent 해진다. 조회는 접근 자체의 사전 검사이기도 하다 — 읽기 권한이 없으면
/// 서버가 404 로 끝내므로 WS 를 열어보기 전에 실패가 드러난다(WS 실패는 브라우저에서 원인이 안 보인다).
export default function PageEditor({ pageId, onClose }: PageEditorProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    getPage(pageId)
      .then((page) => {
        if (!cancelled) setState({ status: 'ready', page })
      })
      .catch((cause) => {
        if (!cancelled) setState({ status: 'failed', message: describeApiFailure(cause) })
      })
    return () => {
      cancelled = true
    }
  }, [pageId])

  return (
    <section className="page">
      <button type="button" className="picker-back" onClick={onClose}>
        ← 페이지 목록
      </button>

      {state.status === 'loading' && <p className="picker-hint">페이지를 여는 중…</p>}
      {state.status === 'failed' && (
        <p className="picker-error" role="alert">
          {state.message}
        </p>
      )}
      {state.status === 'ready' && (
        <>
          <h2>{state.page.title}</h2>
          <Editor page={state.page} />
        </>
      )}
    </section>
  )
}
