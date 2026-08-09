# weDocs-frontend

weDocs 협업 에디터 프론트엔드 — **React 19 + Tiptap 3 + Yjs**.
표준 `y-websocket` provider로 **ws-gateway**에 접속한다(gRPC 비소비자 — proto 의존 없음).

> 상태: **M2 Phase 2c 진행 중**. 로그인 → 워크스페이스/페이지 선택 → 편집까지 이어진다.
> **room = 페이지 UUID** 이고, 토큰은 WS 서브프로토콜 `[wedocs.sync.v1, <jwt>]` 로 전달된다.
> viewer 로 공유받은 페이지는 **편집이 잠긴다**(서버가 준 `canEdit` 기준).
> 남은 것은 E2E 재작성(C3-5·6)뿐이다.

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

**로그인·페이지 목록에는 doc-service(:8081)가 필요하고, 편집에는 gateway(:8080) + engine(:50051)이 더 필요하다.**
미기동이면 화면이 "서버에 연결할 수 없습니다"로 실패한다.

```sh
# 사전 조건 (별도 레포)
docker run --rm -e POSTGRES_DB=wedocs -e POSTGRES_USER=wedocs -e POSTGRES_PASSWORD=wedocs \
  -p 5432:5432 postgres:16-alpine
cd ../weDocs-backend     && make run-doc   # :8081 REST (+ :50052 gRPC)
cd ../weDocs-backend     && make run       # :8080 gateway   — 편집에 필요
cd ../weDocs-crdt-engine && cargo run      # :50051 engine   — 편집에 필요
```

### room = 페이지 UUID
페이지를 열면 주소가 `?room=<page-uuid>` 로 갱신된다 — **그 URL을 다른 탭에 붙여 넣으면 같은 문서**다
(두 탭 동시 편집 데모의 경로). UUID가 아닌 room 은 연결을 시도조차 하지 않고 선택 화면으로 돌아간다:
게이트웨이 인가가 비UUID doc_id 를 무조건 403 으로 끊는데, **브라우저는 WS 실패에서 그 상태 코드를
볼 수 없어**(code 1006 뿐) 원인 없는 무한 재접속으로만 보이기 때문이다.

> 토큰은 메모리 전용이라 **탭마다 로그인이 필요하다**(아래 §토큰을 저장하지 않는 이유). 두 번째 탭은
> 로그인 후 같은 페이지를 목록에서 고르거나 `?room=` URL 로 바로 열면 된다.

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
| `npm run test:unit` | 단위·컴포넌트(`test/**`, e2e 제외) — room 파싱·WS URL 승격·토큰 만료·REST 계약 검증·화면 3종 | 없음 (CI가 이걸 돌린다) |
| `npm run test:e2e` | 인증된 협업 E2E(`test/e2e/`) | **4프로세스 실기동** (아래) |
| `npm run test:e2e:browser` | 실제 브라우저 2개로 presence 검증(`test/browser/`) — 커서·선택 영역이 **화면에 그려지는지** | **5프로세스**(위 4개 + `npm run dev`) **+ `npx playwright install chromium`** |

E2E는 다른 레포 서비스를 띄워야 해서 CI에서 제외돼 있다(M5 배포 파이프라인과 함께 재판정).

**브라우저 바이너리는 `npm ci` 가 받지 않는다** — `playwright` 패키지에 install 훅이 없다(1.62.1 확인).
덕분에 CI 가 쓰지 않는 100MB 다운로드를 짊어지지 않는 게 장점이지만, 새 클론에서 `test:e2e:browser` 를
그냥 돌리면 서비스 미기동이 아니라 "Executable doesn't exist" 로 실패해 **원인을 오인하게 된다.**
먼저 `npx playwright install chromium` 을 한 번 실행해야 한다.

**테스트 환경 분기** — 전역 기본은 `node`(E2E가 실제 WS 를 열어야 하므로). 컴포넌트 테스트만
파일 상단 `// @vitest-environment jsdom` docblock 으로 뒤집는다. vitest 4 에서 `environmentMatchGlobs`가
제거돼 glob 기반 분기는 쓸 수 없다. RTL 자동 cleanup 도 `globals:false` 에선 등록되지 않으므로
컴포넌트 테스트는 **명시적 `afterEach(cleanup)`** 을 둔다.

## E2E — 인증된 협업 테스트
브라우저 없이 `y-websocket` 클라이언트(Node + `ws` 폴리필)로 **권한별 협업 동작**을 자동 검증한다.
경로 = `y-websocket → ws-gateway(8080) → crdt-engine(50051) → fan-out`. `disableBc: true` 로
BroadcastChannel 우회를 막아 **반드시 게이트웨이 경로만** 통과시킨다.

| # | 케이스 | 확인하는 것 |
|---|---|---|
| ① | editor 2클라 동시 편집 | 텍스트 동등성 수렴 |
| ② | viewer 공유 | 읽기는 수신, **쓰기는 미반영**(게이트웨이 drop) |
| ③ | 무토큰 / SENTINEL 누락 / 비UUID room | 각각 401 · 401 · 403 |

**사전 조건이 M1의 2프로세스에서 4프로세스로 늘었다** — 연결에 토큰(→ doc-service)과 실제 페이지
UUID(→ postgres)가 필요해졌기 때문이다.

```sh
# 1. 사전 조건 4프로세스
docker run --rm -e POSTGRES_DB=wedocs -e POSTGRES_USER=wedocs -e POSTGRES_PASSWORD=wedocs \
  -p 5432:5432 postgres:16-alpine
cd ../weDocs-backend     && make run-doc   # :8081 REST (+ :50052 gRPC)
cd ../weDocs-backend     && make run       # :8080 gateway
cd ../weDocs-crdt-engine && cargo run      # :50051 engine

# 2. E2E 실행
npm run test:e2e
```

**테스트가 자기 사전조건을 스스로 만든다** — 실행마다 고유 이메일로 계정 2개(owner/viewer)를 가입시키고
워크스페이스·페이지를 생성한 뒤 그 UUID 로 접속한다(`test/e2e/support/rest.ts`). 토큰을 사람이 주입하는
방식을 쓰지 않은 이유는 그 방식으로는 **viewer 케이스를 재현할 수 없기** 때문이다.

엔드포인트는 `E2E_WS_URL`(기본 `ws://localhost:8080/ws/doc`) · `E2E_API_URL`(기본 `http://localhost:8081`)로
덮어쓸 수 있다(셸 환경변수 — `.env` 가 아니다). 서비스 미기동 시 부트스트랩이 즉시, 연결은 10s 타임아웃으로
명확히 실패한다. 'synced' 이벤트에 의존하지 않고 텍스트 동등성으로 검증한다(게이트웨이가 모든 update 를
WS `Update(2)` 로 프레이밍하기 때문).

## 설계 메모
- **Hocuspocus/TiptapCloud 미사용** — 자체 `ws-gateway`가 y-protocols 서버를 구현, Rust 엔진이 yrs 머지.
- Collaboration 확장이 자체 히스토리 제공 → StarterKit `undoRedo` 비활성.
