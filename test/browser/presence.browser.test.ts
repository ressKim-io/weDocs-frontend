import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, Page } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createPage, createWorkspace, provisionAccount, shareAsViewer, type Account } from '../e2e/support/rest'
import {
  documentText,
  gatewayCounter,
  isEditable,
  launchBrowser,
  localCaretCount,
  remoteCaretLabels,
  remoteSelectionCount,
  selectParagraph,
  signInAndOpen,
  tryRangeSelect,
  waitUntil,
} from './support/browser'

// M3 Phase 2 헤드라인 검증: **실제 브라우저 두 개**에서 editor/viewer가 서로의 커서와 선택 영역을 본다.
//
// 사전 조건 **5프로세스**: postgres · doc-service(8081) · ws-gateway(8080) · crdt-engine(50051) ·
// vite dev(5173). **그리고 브라우저 바이너리**: `npx playwright install chromium` — `npm ci` 는 받지
// 않는다(`playwright` 에 install 훅이 없다). 없으면 서비스 미기동이 아니라 "Executable doesn't exist"
// 로 실패하므로 원인을 오인하게 된다.
//
// `test/e2e`(Node 클라이언트)는 문서 수렴과 인가 계약을 검증하지만 **UI 렌더링을 증명하지 못한다**
// — caret·selection이 화면에 그려지는지는 브라우저에서만 관측된다.
//
// 왜 확장 없는 Chromium인가: 브라우저 확장은 캡처 단계에서 키 이벤트를 삼킬 수 있어 검증 결과를
// 오염시킨다(실측 2026-08-08: 사용자 Chrome의 AI 코딩 확장이 위/아래 방향키를 삼켜 존재하지 않는
// 에디터 버그로 오인됐다). Playwright Chromium은 확장이 없으므로 이 오염원이 구조적으로 없다.

const PASSWORD_DISPLAY_NAMES = { editor: 'M3 Editor', viewer: 'M3 Viewer' } as const
const EVIDENCE_DIR = join(process.cwd(), 'test-results', 'm3-phase2-presence')
const CONNECT_TIMEOUT_MS = 20_000
const PRESENCE_TIMEOUT_MS = 10_000
/// 늦게 들어온 참가자가 **가만히 있는** peer의 커서를 보기까지 허용하는 상한.
/// 이 값을 넘으면 join 시 queryAwareness 배선이 죽어 15초 하트비트 폴백에 의존한다는 뜻이다(plan §1.3).
const LATE_JOIN_BUDGET_MS = 3_000
/// 이탈한 참가자의 presence 가 회수되기까지 허용하는 상한.
/// 명시 회수가 죽으면 `outdatedTimeout` 30초 + 체크 주기 3초 = 약 33초 폴백으로만 사라지므로,
/// 이 예산을 넘으면 폴백 경로로 떨어졌다는 뜻이다.
const GHOST_RELEASE_BUDGET_MS = 3_000

/// 예산은 `waitUntil` 의 타임아웃 **자체가 강제한다**(초과 시 throw). 같은 조건을 `expect` 로 다시
/// 단정하면 항상 참인 공허한 검증이 되므로 그렇게 쓰지 않는다 — 측정값은 증거로만 남긴다.

interface Fixture {
  readonly owner: Account
  readonly viewer: Account
  readonly pageId: string
}

async function screenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(EVIDENCE_DIR, `${name}.png`) })
}

describe('M3 Phase 2 — 두 브라우저 presence', () => {
  let browser: Browser
  let fixture: Fixture
  let editorPage: Page
  // viewer 화면은 **첫 케이스가 만든다** — "늦게 들어온다"가 그 케이스의 검증 대상이라 미리 열 수 없다.
  // 그래서 이 스위트는 시나리오형(순차 의존)이다. 첫 케이스가 깨지면 이후는 실행 의미가 없으므로,
  // `undefined` 접근으로 원인이 흐려지지 않게 아래 `viewer()` 가 사전조건 실패를 명시적으로 말한다.
  let viewerSession: Page | undefined
  const evidence: Record<string, unknown> = {}

  function viewer(): Page {
    if (viewerSession === undefined) {
      throw new Error('사전조건 미충족: 첫 케이스(늦은 join)가 viewer 화면을 열지 못했다')
    }
    return viewerSession
  }

  beforeAll(async () => {
    await mkdir(EVIDENCE_DIR, { recursive: true })
    const owner = await provisionAccount('m3-editor', PASSWORD_DISPLAY_NAMES.editor)
    const viewer = await provisionAccount('m3-viewer', PASSWORD_DISPLAY_NAMES.viewer)
    const workspaceId = await createWorkspace(owner, 'm3-phase2-browser')
    const pageId = await createPage(owner, workspaceId, 'presence evidence')
    await shareAsViewer(owner, pageId, viewer)
    fixture = { owner, viewer, pageId }

    browser = await launchBrowser()
    editorPage = await signInAndOpen(browser, pageId, owner)
  }, CONNECT_TIMEOUT_MS * 3)

  afterAll(async () => {
    await writeFile(join(EVIDENCE_DIR, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
    await browser?.close()
  })

  it(
    '늦게 들어온 viewer가 가만히 있는 editor의 커서를 즉시 본다',
    async () => {
      // Given: editor가 문서에 커서를 두고 **그 뒤로 아무 입력도 하지 않는다**
      await editorPage.click('.editor .tiptap')
      await editorPage.keyboard.type('M3 phase 2 presence evidence')
      await waitUntil(
        async () => (await documentText(editorPage)).includes('presence evidence'),
        PRESENCE_TIMEOUT_MS,
        'editor 입력 반영',
      )
      const querySentBefore = await gatewayCounter('ws_awareness_query_sent_total')

      // When: viewer가 새로 접속한다
      viewerSession = await signInAndOpen(browser, fixture.pageId, fixture.viewer)

      // Then: 기존 peer가 움직이지 않아도 그 커서가 즉시 보인다.
      // 이 지연이 예산을 넘으면 사용자에게는 "한참 뒤에야 커서가 생긴다"로 체감되고,
      // 에러가 아니라 지연이라 계측 없이는 발견되지 않는다.
      const latencyMs = await waitUntil(
        async () => (await remoteCaretLabels(viewer())).includes(PASSWORD_DISPLAY_NAMES.editor),
        LATE_JOIN_BUDGET_MS,
        'idle editor caret 즉시 발견',
      )
      evidence.lateJoinLatencyMs = latencyMs
      evidence.awarenessQuerySentDelta =
        (await gatewayCounter('ws_awareness_query_sent_total')) - querySentBefore

      // join 시 게이트웨이가 기존 peer에게 실제로 되물었다는 서버측 증거.
      // 이 값이 0이면 UI에 커서가 보였어도 그건 하트비트 폴백이거나 다른 경로였다는 뜻이다.
      expect(evidence.awarenessQuerySentDelta).toBeGreaterThan(0)
      await screenshot(viewer(), '1-viewer-late-join-sees-idle-editor-caret')
    },
    CONNECT_TIMEOUT_MS * 2,
  )

  it(
    'editor의 선택 영역이 viewer에게 보인다',
    async () => {
      // Given/When: editor가 문단 전체를 범위 선택
      const relayedBefore = await gatewayCounter('ws_awareness_relayed_total')
      await selectParagraph(editorPage)

      // Then: viewer에 원격 selection 하이라이트 + 이름 라벨
      await waitUntil(
        async () => (await remoteSelectionCount(viewer())) > 0,
        PRESENCE_TIMEOUT_MS,
        'editor selection이 viewer에 표시',
      )
      expect(await remoteCaretLabels(viewer())).toContain(PASSWORD_DISPLAY_NAMES.editor)
      evidence.awarenessRelayedDelta =
        (await gatewayCounter('ws_awareness_relayed_total')) - relayedBefore
      // UI만 보면 BroadcastChannel 우회와 구분할 수 없다 — 서버가 릴레이했다는 독립 증거를 함께 남긴다
      expect(evidence.awarenessRelayedDelta).toBeGreaterThan(0)
      await screenshot(viewer(), '2-viewer-sees-editor-selection')
    },
    PRESENCE_TIMEOUT_MS * 2,
  )

  it(
    'viewer의 커서가 editor에게 보인다 — viewer도 presence는 발행한다',
    async () => {
      // Given/When: viewer가 편집 영역 안을 클릭해 커서를 옮긴다(쓰기는 잠겨 있지만 포커스·presence는 허용)
      const box = await viewer().locator('.editor .tiptap').boundingBox()
      if (box === null) throw new Error('에디터 영역을 찾지 못했다')
      await viewer().mouse.click(box.x + 90, box.y + 28)

      // Then: editor 화면에 viewer 이름 라벨이 붙은 원격 caret이 보인다
      await waitUntil(
        async () => (await remoteCaretLabels(editorPage)).includes(PASSWORD_DISPLAY_NAMES.viewer),
        PRESENCE_TIMEOUT_MS,
        'viewer caret이 editor에 표시',
      )
      await screenshot(editorPage, '3-editor-sees-viewer-caret')

      // 읽기 전용 화면은 **범위 선택 자체가 불가능**하다 — 따라서 viewer→editor 방향의 "selection 표시"는
      // 현재 설계에서 달성 불가다. caret 전달과는 별개의 제약이다.
      //
      // 확인된 사실(2026-08-08): dblclick·트리플클릭·드래그 모두 범위를 만들지 못하고, `LocalCaret`을
      // 비활성화해도 동일하므로 우리 확장이 만든 회귀가 아니라 ProseMirror `editable: false`의 동작이다.
      // 부작용으로 **viewer는 문서 텍스트를 복사할 수 없다** — 읽기 전용 문서로서는 별도의 사용성 결함이라
      // 보류 항목으로 등록했다(controller `status/current.md` 이월 findings).
      //
      // 이 단정을 남기는 이유: 나중에 그 제약이 풀리면 이 테스트가 **실패해서** 알려준다.
      // 조용히 지나가면 "언젠가 되던데?" 상태로 방치된다.
      expect(await tryRangeSelect(viewer())).toBe(false)
      expect(await remoteSelectionCount(editorPage)).toBe(0)
    },
    PRESENCE_TIMEOUT_MS * 2,
  )

  it(
    'viewer는 자기 커서를 볼 수 있다 — contenteditable=false여도 남들만 내 커서를 보는 비대칭을 만들지 않는다',
    async () => {
      // Given: 읽기 전용 화면
      expect(await isEditable(viewer())).toBe(false)

      // When: 문서 안을 클릭해 커서를 collapsed 상태로 놓는다
      const box = await viewer().locator('.editor .tiptap').boundingBox()
      if (box === null) throw new Error('에디터 영역을 찾지 못했다')
      await viewer().mouse.click(box.x + 40, box.y + 28)

      // Then: 브라우저가 그려주지 않는 자기 caret을 앱이 보충한다
      await waitUntil(
        async () => (await localCaretCount(viewer())) > 0,
        PRESENCE_TIMEOUT_MS,
        'viewer 자기 caret 표시',
      )
      evidence.viewerLocalCaretCount = await localCaretCount(viewer())
      await screenshot(viewer(), '4-viewer-sees-own-caret')

      // 그리고 editable 화면에는 네이티브 caret이 있으므로 보충 caret을 넣지 않는다(커서 2개 방지)
      expect(await isEditable(editorPage)).toBe(true)
      expect(await localCaretCount(editorPage)).toBe(0)
    },
    PRESENCE_TIMEOUT_MS * 2,
  )

  it(
    'viewer는 편집이 잠기고 editor의 수정은 실시간으로 받는다',
    async () => {
      // Given: viewer가 문서에 포커스한 상태
      const before = await documentText(viewer())

      // When: viewer가 타이핑을 시도한다
      await viewer().keyboard.type('VIEWER_WRITE_MUST_BE_BLOCKED')
      await viewer().waitForTimeout(500)

      // Then: 로컬에도 반영되지 않는다. 잠그지 않으면 이 입력이 로컬 Y.Doc에만 남고 게이트웨이가
      // 조용히 버려(`ws_write_dropped_total{reason=viewer}`) 새로고침 시 유실된다 — 정합성 문제다
      expect(await documentText(viewer())).toBe(before)
      expect(await documentText(editorPage)).not.toContain('VIEWER_WRITE_MUST_BE_BLOCKED')

      // When: editor가 수정한다
      await editorPage.click('.editor .tiptap')
      await editorPage.keyboard.press('ControlOrMeta+End')
      await editorPage.keyboard.type(' :: editor-update')

      // Then: viewer가 실시간으로 받는다(읽기는 정상)
      await waitUntil(
        async () => (await documentText(viewer())).includes(':: editor-update'),
        PRESENCE_TIMEOUT_MS,
        'editor 수정이 viewer에 수신',
      )
      evidence.viewerFinalText = await documentText(viewer())
      await screenshot(viewer(), '5-viewer-read-only-receives-editor-update')
    },
    PRESENCE_TIMEOUT_MS * 3,
  )

  it(
    '새로고침한 참가자의 유령 커서가 남지 않는다',
    async () => {
      // Given: 두 화면이 서로의 presence를 보고 있다
      await waitUntil(
        async () => (await remoteCaretLabels(editorPage)).includes(PASSWORD_DISPLAY_NAMES.viewer),
        PRESENCE_TIMEOUT_MS,
        'viewer presence 선행 확인',
      )

      // When: viewer가 페이지를 새로고침한다(토큰은 메모리 전용이라 로그인 화면으로 돌아간다)
      await viewer().reload()
      await viewer().waitForSelector('#auth-email', { timeout: CONNECT_TIMEOUT_MS })

      // Then: editor 화면에서 viewer 커서가 사라진다.
      // 회수하지 않으면 `outdatedTimeout` 30초 + 체크 주기 3초 = 약 33초 남고(실측 2026-08-08),
      // 그 창 안에 재접속하면 게이트웨이 queryAwareness가 peer에게서 유령을 되살려
      // **자기 과거 커서가 자기 화면에 뜬다.** 즉시성 기능이 유령을 증폭시키는 경로다.
      // 예산을 짧게 잡는 것이 곧 "폴백이 아니라 명시 회수"의 강제다 — 초과하면 여기서 실패한다.
      evidence.ghostClearedInMs = await waitUntil(
        async () => !(await remoteCaretLabels(editorPage)).includes(PASSWORD_DISPLAY_NAMES.viewer),
        GHOST_RELEASE_BUDGET_MS,
        '새로고침한 viewer의 유령 커서 회수(명시 회수 경로)',
      )
      await screenshot(editorPage, '6-editor-after-viewer-reload-no-ghost')
    },
    CONNECT_TIMEOUT_MS * 2,
  )
})
