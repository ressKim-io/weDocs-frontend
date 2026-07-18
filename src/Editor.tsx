import { useEffect, useMemo } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { resolveWsUrl, sanitizeRoom } from './connection'

const CONFIGURED_WS_URL = import.meta.env.VITE_WS_URL ?? 'ws://localhost:8080/ws/doc'

// room = 문서 ID. ?room=<id> 로 다중 문서를 열 수 있다(미지정/무효 시 demo로 폴백).
function roomFromUrl(): string {
  return sanitizeRoom(new URLSearchParams(window.location.search).get('room'))
}

/// Tiptap + Yjs 협업 에디터. 표준 y-websocket provider 로 ws-gateway 에 접속한다.
export default function Editor() {
  const room = useMemo(roomFromUrl, [])
  // 보안 페이지(https)에선 wss:// 강제 — 평문 WS의 mixed-content 차단 방어.
  const wsUrl = useMemo(() => resolveWsUrl(CONFIGURED_WS_URL, window.location.protocol), [])
  // Y.Doc 과 provider 는 컴포넌트 수명 동안 1회 생성.
  const ydoc = useMemo(() => new Y.Doc(), [])
  const provider = useMemo(() => new WebsocketProvider(wsUrl, room, ydoc), [wsUrl, room, ydoc])

  useEffect(() => {
    return () => {
      provider.destroy()
      ydoc.destroy()
    }
  }, [provider, ydoc])

  const editor = useEditor({
    extensions: [
      // Collaboration 이 자체 undo/redo 를 제공 → StarterKit 의 undoRedo 비활성(중복 방지).
      StarterKit.configure({ undoRedo: false }),
      Collaboration.configure({ document: ydoc }),
    ],
  })

  return (
    <section className="editor">
      <p className="hint">
        gateway: <code>{wsUrl}/{room}</code> — 두 탭에서 열어 동시 편집해 보세요.
      </p>
      <EditorContent editor={editor} />
    </section>
  )
}
