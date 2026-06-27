import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'

// M1 헤드라인 검증: 두 클라이언트가 같은 room 을 동시 편집하면 동일 텍스트로 수렴한다.
// 경로 = 브라우저 y-websocket → ws-gateway(8080) → crdt-engine(50051) → fan-out.
// 사전 조건: engine + gateway 로컬 기동 (README "E2E" 절). 미기동 시 연결 타임아웃으로 명확히 실패.
const WS_URL = process.env.E2E_WS_URL ?? 'ws://localhost:8080/ws/doc'
const CONNECT_TIMEOUT_MS = 10_000
const CONVERGE_TIMEOUT_MS = 15_000

interface Client {
  doc: Y.Doc
  provider: WebsocketProvider
}

function makeClient(room: string): Client {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(WS_URL, room, doc, {
    // Node 에는 전역 WebSocket 이 없으므로 ws 폴리필 주입.
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    // 같은 프로세스의 두 클라가 BroadcastChannel 로 직접 동기화하면 게이트웨이를 우회한다.
    // E2E 는 반드시 ws-gateway↔engine 경로만 검증해야 하므로 끈다.
    disableBc: true,
  })
  return { doc, provider }
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
          `WS 연결 타임아웃(${timeoutMs}ms) — engine(50051)+gateway(8080) 기동 확인 필요: ${WS_URL}`,
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

describe('M1 수렴 E2E — 두 클라이언트 동시 편집', () => {
  let clients: Client[] = []

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
      // Given: 같은 room 에 두 클라이언트 접속.
      // 엔진은 M1 에서 Doc 을 evict 하지 않으므로(plan §D-8) 실행마다 고유 room 으로 상태 오염 차단.
      const room = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const a = makeClient(room)
      const b = makeClient(room)
      clients = [a, b]

      await Promise.all([
        waitForConnected(a.provider, CONNECT_TIMEOUT_MS),
        waitForConnected(b.provider, CONNECT_TIMEOUT_MS),
      ])

      // When: 두 클라가 동시에 공유 Y.Text 에 삽입.
      const textA = a.doc.getText('content')
      const textB = b.doc.getText('content')
      textA.insert(0, 'Hello-from-A ')
      textB.insert(0, 'World-from-B ')

      // Then: 두 복제본이 동일 문자열로 수렴 + 양쪽 기여 모두 포함.
      // 게이트웨이가 모든 ServerFrame{update} 를 WS Update(2) 로 프레이밍하므로 provider.synced 는
      // set 되지 않는다(plan §D-4). 따라서 'synced' 이벤트가 아닌 텍스트 동등성 폴링으로 검증한다.
      const converged = await pollUntil(() => {
        const sa = textA.toString()
        const sb = textB.toString()
        return (
          sa.length > 0 &&
          sa === sb &&
          sa.includes('Hello-from-A') &&
          sa.includes('World-from-B')
        )
      }, CONVERGE_TIMEOUT_MS)

      const finalA = textA.toString()
      const finalB = textB.toString()
      expect(converged, `수렴 실패 — A="${finalA}" B="${finalB}"`).toBe(true)
      expect(finalA).toBe(finalB)
      expect(finalA).toContain('Hello-from-A')
      expect(finalA).toContain('World-from-B')
    },
    CONNECT_TIMEOUT_MS + CONVERGE_TIMEOUT_MS + 5_000,
  )
})
