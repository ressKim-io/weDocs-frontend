# weDocs-frontend

weDocs 협업 에디터 프론트엔드 — **React 19 + Tiptap 3 + Yjs**.
표준 `y-websocket` provider로 **ws-gateway**에 접속한다(gRPC 비소비자 — proto 의존 없음).

> 상태: **M2 Phase 2c 진행 중**. M1(수렴)에 더해 **인증 셸**(로그인 → 메모리 토큰 → 화면 게이팅)이 붙었다.
> ⚠️ **에디터 경로는 아직 복구 전이다** — 기본 room 이 비UUID `demo` 라 게이트웨이가 403 으로 거절한다.
> 페이지 선택(실제 UUID)과 토큰 전달은 **C3** 에서 붙는다. 로그인까지가 이번 단계의 완료 지점이다.

## 스택 (verified 2026-06-25 / 테스트 도구 2026-07-29)
- React 19.2 · Vite 8.1 · TypeScript 6.0
- Tiptap 3.27 (`@tiptap/react`,`starter-kit`,`extension-collaboration`,`y-tiptap`)
- yjs 13.6 · y-websocket 3.0 · y-protocols 1.0
- 테스트: vitest 4.1 · jsdom 30 · @testing-library/react 16.3

## 개발
```sh
npm install
cp .env.example .env      # VITE_WS_URL · VITE_API_URL 조정
npm run dev               # http://localhost:5173
npm run build             # tsc --noEmit + vite build
```

**로그인에는 doc-service(:8081)가 필요하다** — 미기동이면 폼이 "서버에 연결할 수 없습니다"로 실패한다.

```sh
# 사전 조건 2프로세스 (별도 레포)
docker run --rm -e POSTGRES_DB=wedocs -e POSTGRES_USER=wedocs -e POSTGRES_PASSWORD=wedocs \
  -p 5432:5432 postgres:16-alpine
cd ../weDocs-backend && make run-doc     # :8081 REST (+ :50052 gRPC)
```

room 은 `?room=<id>` 쿼리로 지정한다(미지정 시 `demo`) — 탭마다 다른 문서를 열 수 있다.

### 토큰을 저장하지 않는 이유
액세스 토큰은 **메모리에만** 둔다(`src/auth/token.ts`). localStorage/sessionStorage 에 넣으면
XSS 한 번으로 그대로 유출되기 때문이다. 대가는 "새로고침하면 재로그인"인데, TTL 이 24h 이고
refresh token 이 비범위인 현 단계에선 그 대가가 더 싸다. 부수 효과로 **탭마다 독립 세션**이 되는데,
editor/viewer 를 두 탭에 나눠 여는 데모 시나리오와 오히려 맞는다.

## M1 데모 (목표)
1. `crdt-engine` 실행(50051) → `ws-gateway` 실행(8080) → `npm run dev`
2. 두 브라우저 탭에서 같은 room 접속 → 한쪽 편집이 다른쪽에 수렴.

## 테스트 구분
| 명령 | 대상 | 사전 조건 |
|---|---|---|
| `npm run test:unit` | 단위·컴포넌트(`test/**`, e2e 제외) — room sanitize·WS URL 승격·토큰 만료·REST 에러 변환·로그인 폼 | 없음 (CI가 이걸 돌린다) |
| `npm run test:e2e` | 수렴 E2E(`test/e2e/`) | **engine + gateway 실기동** (아래) |

E2E는 다른 레포 서비스 2개를 띄워야 해서 CI에서 제외돼 있다(M5 배포 파이프라인과 함께 재판정).

**테스트 환경 분기** — 전역 기본은 `node`(E2E가 실제 WS 를 열어야 하므로). 컴포넌트 테스트만
파일 상단 `// @vitest-environment jsdom` docblock 으로 뒤집는다. vitest 4 에서 `environmentMatchGlobs`가
제거돼 glob 기반 분기는 쓸 수 없다. RTL 자동 cleanup 도 `globals:false` 에선 등록되지 않으므로
컴포넌트 테스트는 **명시적 `afterEach(cleanup)`** 을 둔다.

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
