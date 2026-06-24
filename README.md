# weDocs-frontend

weDocs 협업 에디터 프론트엔드 — **React 19 + Tiptap 3 + Yjs**.
표준 `y-websocket` provider로 **ws-gateway**에 접속한다(gRPC 비소비자 — proto 의존 없음).

> 상태: **M1 골격**. Tiptap 에디터 + Yjs `Y.Doc` + `WebsocketProvider(→ ws-gateway)` 배선.
> "두 브라우저 탭 동시 편집 수렴"이 M1 목표 — gateway↔engine 브리지 완성 후 검증.

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

## M1 데모 (목표)
1. `crdt-engine` 실행(50051) → `ws-gateway` 실행(8080) → `npm run dev`
2. 두 브라우저 탭에서 같은 room 접속 → 한쪽 편집이 다른쪽에 수렴.

## 설계 메모
- **Hocuspocus/TiptapCloud 미사용** — 자체 `ws-gateway`가 y-protocols 서버를 구현, Rust 엔진이 yrs 머지.
- Collaboration 확장이 자체 히스토리 제공 → StarterKit `undoRedo` 비활성.
