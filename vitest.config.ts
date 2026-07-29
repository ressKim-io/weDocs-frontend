import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// 이 파일은 vite.config.ts 와 **별개**라 플러그인이 상속되지 않는다 — .tsx 테스트의 JSX 변환을
// esbuild 의 tsconfig 추론에 맡기지 않고 여기서 명시 배선한다.
export default defineConfig({
  plugins: [react()],
  test: {
    // E2E 는 Node 환경에서 ws 폴리필로 실제 게이트웨이에 접속한다(브라우저 DOM 불필요) → 전역 기본은 node.
    // 컴포넌트 테스트만 파일 상단 `// @vitest-environment jsdom` docblock 으로 뒤집는다.
    // (glob 기반 분기인 environmentMatchGlobs 는 vitest 4 에서 제거됐다.)
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
  },
})
