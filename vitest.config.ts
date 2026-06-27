import { defineConfig } from 'vitest/config'

// E2E 는 Node 환경에서 ws 폴리필로 실제 게이트웨이에 접속한다(브라우저 DOM 불필요).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
