import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'
import {
  createPage,
  createWorkspace,
  provisionAccount,
  shareAsViewer,
  type Account,
} from './support/rest'

// M2 Phase 2c 헤드라인 검증: **인증된** 클라이언트가 자기 권한대로 협업한다.
// 경로 = y-websocket → ws-gateway(8080) → crdt-engine(50051) → fan-out.
//
// 사전 조건 **4프로세스**: postgres · doc-service(8081) · ws-gateway(8080) · crdt-engine(50051).
// M1 시절의 2프로세스로는 부족하다 — 연결에 토큰과 실제 페이지 UUID 가 필요해졌기 때문이다(README §E2E).
const WS_URL = process.env.E2E_WS_URL ?? 'ws://localhost:8080/ws/doc'
const CONNECT_TIMEOUT_MS = 10_000
const CONVERGE_TIMEOUT_MS = 15_000

/// 게이트웨이 토큰 전달 규약(ADR-0014) — 프론트(`src/page/Editor.tsx`)와 **같은 값**이어야 한다.
const AUTH_SUBPROTOCOL = 'wedocs.sync.v1'

interface Client {
  doc: Y.Doc
  provider: WebsocketProvider
  text: Y.Text
}

function makeClient(room: string, token: string): Client {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(WS_URL, room, doc, {
    // 프론트와 동일한 인증 배선 — 토큰이 정확히 1개가 아니면 게이트웨이가 fail-closed 로 거절한다.
    protocols: [AUTH_SUBPROTOCOL, token],
    // Node 에는 전역 WebSocket 이 없으므로 ws 폴리필 주입.
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    // 같은 프로세스의 두 클라가 BroadcastChannel 로 직접 동기화하면 게이트웨이를 우회한다.
    // E2E 는 반드시 ws-gateway↔engine 경로만 검증해야 하므로 끈다.
    disableBc: true,
  })
  return { doc, provider, text: doc.getText('content') }
}

function waitForConnected(provider: WebsocketProvider, timeoutMs: number): Promise<void> {
  if (provider.wsconnected) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onStatus = (event: { status: string }) => {
      if (event.status !== 'connected') return
      cleanup()
      resolve()
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(
        new Error(
          `WS 연결 타임아웃(${timeoutMs}ms) — 4프로세스(postgres·doc-service·gateway·engine) 기동 확인 필요: ${WS_URL}`,
        ),
      )
    }, timeoutMs)
    function cleanup() {
      clearTimeout(timer)
      provider.off('status', onStatus)
    }
    provider.on('status', onStatus)
  })
}

async function pollUntil(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return predicate()
}

/// 핸드셰이크의 **결말만** 본다 — y-websocket 은 실패를 재접속으로 흡수해 거절을 관측할 수 없다.
/// (브라우저도 상태 코드를 볼 수 없다. Node `ws` 는 볼 수 있으므로 여기서 계약을 고정한다.)
function handshakeOutcome(room: string, protocols: string[]): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WS_URL}/${room}`, protocols)
    const settle = (outcome: string) => {
      try {
        ws.close()
      } catch {
        // 이미 닫힌 소켓 — 결과에 영향 없다.
      }
      resolve(outcome)
    }
    ws.on('open', () => settle('open'))
    ws.on('unexpected-response', (_request, response) => settle(`http-${response.statusCode}`))
    ws.on('error', (error: Error) => settle(`error-${error.message}`))
    setTimeout(() => settle('timeout'), CONNECT_TIMEOUT_MS)
  })
}

describe('M2 Phase 2c E2E — 인증된 협업', () => {
  let owner: Account
  let viewer: Account
  let pageId: string
  let clients: Client[] = []

  // 계정·워크스페이스·페이지를 테스트가 직접 만든다 — 실행마다 고유해 상태 오염이 없고,
  // viewer 케이스를 사람 손 없이 재현할 수 있다.
  beforeAll(async () => {
    owner = await provisionAccount('owner')
    viewer = await provisionAccount('viewer')
    const workspaceId = await createWorkspace(owner, 'e2e-workspace')
    pageId = await createPage(owner, workspaceId, 'e2e-page')
    await shareAsViewer(owner, pageId, viewer)
  }, CONNECT_TIMEOUT_MS * 2)

  afterEach(() => {
    for (const c of clients) {
      c.provider.destroy()
      c.doc.destroy()
    }
    clients = []
  })

  it(
    '동시 편집한 두 Y.Doc 이 게이트웨이를 통해 동일 텍스트로 수렴한다',
    async () => {
      // Given: 같은 페이지(room = 페이지 UUID)에 editor 권한 두 클라이언트가 접속
      const a = makeClient(pageId, owner.token)
      const b = makeClient(pageId, owner.token)
      clients = [a, b]
      await Promise.all([
        waitForConnected(a.provider, CONNECT_TIMEOUT_MS),
        waitForConnected(b.provider, CONNECT_TIMEOUT_MS),
      ])

      // When: 두 클라가 동시에 공유 Y.Text 에 삽입
      a.text.insert(0, 'Hello-from-A ')
      b.text.insert(0, 'World-from-B ')

      // Then: 두 복제본이 동일 문자열로 수렴 + 양쪽 기여 모두 포함.
      // 게이트웨이가 모든 ServerFrame{update} 를 WS Update(2) 로 프레이밍하므로 provider.synced 는
      // set 되지 않는다 — 'synced' 이벤트가 아닌 텍스트 동등성 폴링으로 검증한다.
      const converged = await pollUntil(() => {
        const sa = a.text.toString()
        return (
          sa.length > 0 &&
          sa === b.text.toString() &&
          sa.includes('Hello-from-A') &&
          sa.includes('World-from-B')
        )
      }, CONVERGE_TIMEOUT_MS)

      expect(converged, `수렴 실패 — A="${a.text.toString()}" B="${b.text.toString()}"`).toBe(true)
      expect(a.text.toString()).toBe(b.text.toString())
    },
    CONNECT_TIMEOUT_MS + CONVERGE_TIMEOUT_MS + 5_000,
  )

  it(
    'viewer 는 남의 편집을 받지만 자기 편집은 반영되지 않는다',
    async () => {
      // Given: editor 한 명과, 같은 페이지를 viewer 로 공유받은 한 명
      const editor = makeClient(pageId, owner.token)
      const readOnly = makeClient(pageId, viewer.token)
      clients = [editor, readOnly]
      await Promise.all([
        waitForConnected(editor.provider, CONNECT_TIMEOUT_MS),
        waitForConnected(readOnly.provider, CONNECT_TIMEOUT_MS),
      ])

      // When: editor 가 쓰고, viewer 도 쓴다
      editor.text.insert(0, 'EDITOR-WROTE ')
      const received = await pollUntil(
        () => readOnly.text.toString().includes('EDITOR-WROTE'),
        CONVERGE_TIMEOUT_MS,
      )
      readOnly.text.insert(0, 'VIEWER-WROTE ')

      // Then: 읽기는 정상, 쓰기는 게이트웨이가 버린다(`ws_write_dropped_total{reason=viewer}`).
      // 이것이 프론트가 viewer 에게 `editable: false` 를 거는 이유다 — 잠그지 않으면 이 입력이
      // 로컬 Y.Doc 에만 남아 새로고침 시 조용히 유실된다(정합성 문제).
      expect(received, 'viewer 가 editor 의 편집을 받지 못했다').toBe(true)
      const leaked = await pollUntil(() => editor.text.toString().includes('VIEWER-WROTE'), 3_000)
      expect(leaked, 'viewer 의 쓰기가 서버에 반영됐다 — 인가 방어 실패').toBe(false)
    },
    CONNECT_TIMEOUT_MS + CONVERGE_TIMEOUT_MS + 10_000,
  )

  it(
    '토큰 없이는 연결되지 않고, 비UUID room 은 인가에서 끊긴다',
    async () => {
      // Given/When/Then: 무토큰·규약 위반은 401, 형식 위반은 403.
      // 프론트가 토큰 없이 provider 를 만들지 않고 room 을 UUID 로 제한하는 이유가 이것이다 —
      // 브라우저는 이 상태 코드를 볼 수 없어(WS 실패는 code 1006 뿐) 원인 없는 무한 재접속으로만 보인다.
      expect(await handshakeOutcome(pageId, [AUTH_SUBPROTOCOL, owner.token])).toBe('open')
      expect(await handshakeOutcome(pageId, [])).toBe('http-401')
      expect(await handshakeOutcome(pageId, [owner.token])).toBe('http-401')
      expect(await handshakeOutcome('demo', [AUTH_SUBPROTOCOL, owner.token])).toBe('http-403')
    },
    CONNECT_TIMEOUT_MS * 4 + 5_000,
  )
})
