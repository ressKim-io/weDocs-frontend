# weDocs-frontend

weDocs 협업 에디터 프론트엔드 — **React 19 + Tiptap 3 + Yjs**.
표준 `y-websocket` provider로 **ws-gateway**에 접속한다(gRPC 비소비자 — proto 의존 없음).

> 상태: **M1**. Tiptap 에디터 + Yjs `Y.Doc` + `WebsocketProvider(→ ws-gateway)` 배선.
> "두 브라우저 탭 동시 편집 수렴" = M1 목표 → E2E 자동 검증(아래 "E2E 수렴 테스트").

## 스택 (verified 2026-06-25)
- React 19.2 · Vite 8.1 · TypeScript 6.0
- Tiptap 3.27 (`@tiptap/react`,`starter-kit`,`extension-collaboration`,`y-tiptap`)
- yjs 13.6 · y-websocket 3.0 · y-protocols 1.0

## 개발
```sh
npm install
cp .env.example .env      # VITE_WS_URL 조정
npm run dev               # http://localhost:5173
npm run build             # tsc --noEmit + vite build
```

room 은 `?room=<id>` 쿼리로 지정한다(미지정 시 `demo`) — 탭마다 다른 문서를 열 수 있다.

## M1 데모 (목표)
1. `crdt-engine` 실행(50051) → `ws-gateway` 실행(8080) → `npm run dev`
2. 두 브라우저 탭에서 같은 room 접속 → 한쪽 편집이 다른쪽에 수렴.

## E2E 수렴 테스트
브라우저 없이 두 `y-websocket` 클라이언트(Node + `ws` 폴리필)로 "동시 편집 수렴"을 자동 검증한다.
경로 = `y-websocket → ws-gateway(8080) → crdt-engine(50051) → fan-out`. `disableBc: true` 로
BroadcastChannel 우회를 막아 **반드시 게이트웨이 경로만** 통과시킨다.

```sh
# 1. 사전 조건: engine + gateway 기동 (별도 레포)
#    crdt-engine:  cargo run                      # → 0.0.0.0:50051
#    ws-gateway :  make run  (또는 bootJar 실행)   # → :8080
# 2. E2E 실행
npm run test:e2e          # vitest run — 2클라 동시 편집 → 텍스트 동등성 폴링 수렴 assert
```

엔드포인트는 `E2E_WS_URL`(기본 `ws://localhost:8080/ws/doc`)로 덮어쓸 수 있다.
서비스 미기동 시 연결 타임아웃(10s)으로 명확히 실패한다. 'synced' 이벤트에 의존하지 않고
텍스트 동등성으로 검증한다(게이트웨이가 모든 update 를 WS `Update(2)` 로 프레이밍하기 때문).

## 설계 메모
- **Hocuspocus/TiptapCloud 미사용** — 자체 `ws-gateway`가 y-protocols 서버를 구현, Rust 엔진이 yrs 머지.
- Collaboration 확장이 자체 히스토리 제공 → StarterKit `undoRedo` 비활성.
