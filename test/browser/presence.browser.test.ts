import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, Page } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createPage, createWorkspace, provisionAccount, shareAsViewer, type Account } from '../e2e/support/rest'
import {
  documentText,
  gatewayCounter,
  gatewayCounterOrZero,
  isEditable,
  launchBrowser,
  localCaretCount,
  remoteCaretLabels,
  remoteSelectionCount,
  selectParagraph,
  signInAgain,
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
      const querySentBefore = await gatewayCounterOrZero('ws_awareness_query_sent_total')

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
      const relayedBefore = await gatewayCounterOrZero('ws_awareness_relayed_total')
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
    'viewer의 커서와 선택 영역이 editor에게 보인다 — viewer도 presence는 발행한다',
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

      // And: viewer 도 **범위 선택**을 만들 수 있고 그것이 editor 에 보인다.
      //
      // ⚠️ 2026-08-08 에는 이 방향이 "달성 불가"라고 기록했었는데 **오측정이었다.** 당시 헬퍼가
      // `page.click(selector)` 로 요소 **박스 중심**을 찍었고, `.editor .tiptap` 은 `min-height: 240px`
      // 이라 한 줄 문서에서 중심은 텍스트가 없는 빈 공간이다. 즉 측정한 것은 제약이 아니라 클릭 좌표였다.
      // 첫 줄(`y + 28`)을 찍으면 읽기 전용 화면에서도 트리플클릭 범위 선택이 정상 동작한다.
      expect(await tryRangeSelect(viewer())).toBe(true)
      await waitUntil(
        async () => (await remoteSelectionCount(editorPage)) > 0,
        PRESENCE_TIMEOUT_MS,
        'viewer selection 이 editor 에 표시',
      )
      await screenshot(editorPage, '3b-editor-sees-viewer-selection')
    },
    PRESENCE_TIMEOUT_MS * 2,
  )

  it(
    'viewer는 자기 커서를 볼 수 있다 — contenteditable=false여도 남들만 내 커서를 보는 비대칭을 만들지 않는다',
    async () => {
      // Given: 읽기 전용 화면
      expect(await isEditable(viewer())).toBe(false)

      // When: 문서 안을 클릭해 커서를 collapsed 상태로 놓는다.
      // 직전 케이스가 범위 선택을 남겼으므로 **텍스트 끝 너머**를 찍어 확실히 collapse 시킨다 —
      // 선택 영역 안을 다시 클릭하면 범위가 유지될 수 있고, 그러면 collapsed caret 이 아니라
      // selection 상태라 보충 caret 이 렌더되지 않는다(플러그인이 `selection.empty` 만 그린다).
      const box = await viewer().locator('.editor .tiptap').boundingBox()
      if (box === null) throw new Error('에디터 영역을 찾지 못했다')
      await viewer().evaluate(() => document.getSelection()?.removeAllRanges())
      await viewer().mouse.click(box.x + 40, box.y + 28)
      await waitUntil(
        async () =>
          viewer().evaluate(() => {
            const selection = document.getSelection()
            return selection !== null && selection.rangeCount > 0 && selection.isCollapsed
          }),
        PRESENCE_TIMEOUT_MS,
        'viewer selection 이 collapsed 상태로 전환',
      )

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
      //
      // 시계를 **reload 직전에** 잡는다. `waitForSelector` 뒤에서 재면 그 사이에 회수가 이미 끝나 있어
      // 첫 프로브에서 즉시 참이 되고, 기록되는 숫자가 회수 지연이 아니라 **폴링 간격**이 된다.
      const releasedAt = Date.now()
      const relayedBeforeRelease = await gatewayCounter('ws_awareness_relayed_total')
      await viewer().reload()
      await viewer().waitForSelector('#auth-email', { timeout: CONNECT_TIMEOUT_MS })

      // Then: editor 화면에서 viewer 커서가 사라진다.
      // 회수하지 않으면 `outdatedTimeout` 30초 + 체크 주기 3초 = 약 33초 남고(실측 2026-08-08),
      // 그 창 안에 재접속하면 게이트웨이 queryAwareness가 peer에게서 유령을 되살려
      // **자기 과거 커서가 자기 화면에 뜬다.** 즉시성 기능이 유령을 증폭시키는 경로다.
      // 예산을 짧게 잡는 것이 곧 "폴백이 아니라 명시 회수"의 강제다 — 초과하면 여기서 실패한다.
      await waitUntil(
        async () => !(await remoteCaretLabels(editorPage)).includes(PASSWORD_DISPLAY_NAMES.viewer),
        GHOST_RELEASE_BUDGET_MS,
        '새로고침한 viewer의 유령 커서 회수(명시 회수 경로)',
      )
      // 이탈 시점 기준 경과. 이 값이 33초 폴백 근처면 명시 회수가 죽고 timeout 이 청소한 것이다.
      evidence.ghostClearedSinceReloadMs = Date.now() - releasedAt
      // 회수 프레임이 **서버를 통과했다**는 독립 증거 — UI 부재만으로는 릴레이 실패와 구분되지 않는다.
      evidence.releaseRelayedDelta =
        (await gatewayCounter('ws_awareness_relayed_total')) - relayedBeforeRelease
      expect(evidence.releaseRelayedDelta).toBeGreaterThan(0)
      await screenshot(editorPage, '6-editor-after-viewer-reload-no-ghost')

      // And: **이 수정의 동기였던 되살림 경로**를 곧바로 이어서 확인한다.
      // 유령이 남아 있으면 재접속 시 게이트웨이의 join queryAwareness 가 기존 peer 에게 되묻고, peer 는
      // 자기가 아는 **모든** 상태로 응답하므로 방금 떠난 내 유령이 되살아나 **자기 과거 커서가 자기
      // 화면에 뜬다.** 회수 확인만 하고 여기서 멈추면 그 현상은 어느 계층에도 고정되지 않는다.
      await signInAgain(viewer(), fixture.viewer)
      await viewer().waitForTimeout(1_500)
      const labelsAfterRejoin = await remoteCaretLabels(viewer())
      evidence.labelsAfterViewerRejoin = labelsAfterRejoin
      // 자기 이름이 **원격** caret 으로 보이면 과거 세션의 유령이다(원격 렌더러는 자기 clientID 를 뺀다).
      expect(labelsAfterRejoin).not.toContain(PASSWORD_DISPLAY_NAMES.viewer)
      await screenshot(viewer(), '7-viewer-rejoin-no-self-ghost')
    },
    CONNECT_TIMEOUT_MS * 2,
  )
})
