// 브라우저 검증 공용 헬퍼 — 실제 Chromium 두 컨텍스트로 editor/viewer 화면을 조작한다.
//
// 왜 별도 컨텍스트인가: 같은 컨텍스트의 두 탭은 `y-websocket`이 BroadcastChannel로 **직접** 동기화해
// 게이트웨이를 우회한다(`disableBc`는 우리 앱 코드에 없다). 그러면 presence가 보이는데도 서버 경로가
// 검증되지 않는 **거짓 통과**가 된다. 컨텍스트를 분리하면 BroadcastChannel 파티션도 분리되므로
// 반드시 ws-gateway를 통과한다. 이것이 계획서가 "두 탭"이 아니라 "두 브라우저"를 요구하는 이유다.

import { chromium, type Browser, type Page } from 'playwright'

const APP_URL = process.env.E2E_APP_URL ?? 'http://localhost:5173'
const GATEWAY_METRICS_URL =
  process.env.E2E_GATEWAY_METRICS_URL ?? 'http://localhost:8080/actuator/prometheus'

export const VIEWPORT = { width: 1280, height: 900 } as const

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch()
}

/// 로그인부터 에디터 마운트까지. 토큰이 메모리 전용이라 컨텍스트마다 실제 로그인이 필요하다.
export async function signInAndOpen(
  browser: Browser,
  pageId: string,
  credentials: { readonly email: string; readonly password: string },
): Promise<Page> {
  const context = await browser.newContext({ viewport: VIEWPORT })
  const page = await context.newPage()
  await page.goto(`${APP_URL}/?room=${encodeURIComponent(pageId)}`)
  await page.waitForSelector('#auth-email')
  await page.fill('#auth-email', credentials.email)
  await page.fill('#auth-password', credentials.password)
  await page.click('button[type="submit"]')
  await page.waitForSelector('.editor .tiptap', { timeout: 20_000 })
  return page
}

/// 원격 caret 라벨 목록 — presence 가시성의 관측 지점.
export function remoteCaretLabels(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('.collaboration-carets__label')].map((node) => node.textContent ?? ''),
  )
}

export function remoteSelectionCount(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('.collaboration-carets__selection').length)
}

export function localCaretCount(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('.local-caret').length)
}

/// **위젯을 제외한** 문서 텍스트. 원격 caret 라벨 텍스트가 블록 `textContent`에 섞여 들어오므로
/// (실측: `"three" + "Diag Viewer"`) 그대로 읽으면 문서 내용 assertion이 오염된다.
export function documentText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const editor = document.querySelector('.editor .tiptap')
    if (editor === null) return ''
    const clone = editor.cloneNode(true) as HTMLElement
    clone
      .querySelectorAll('.collaboration-carets__caret, .collaboration-carets__selection, .local-caret')
      .forEach((node) => node.remove())
    return (clone.textContent ?? '').trim()
  })
}

export function isEditable(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.querySelector('.editor .tiptap')?.getAttribute('contenteditable') === 'true',
  )
}

/// 로컬 selection 이 **범위**인지(collapsed 아님) 확인한다. 원격 표시가 안 보일 때
/// "선택 자체가 안 만들어졌다"와 "만들어졌는데 릴레이가 안 됐다"를 가르는 지점이다.
function localSelectionIsRange(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const selection = document.getSelection()
    return selection !== null && selection.rangeCount > 0 && !selection.isCollapsed
  })
}

/// 트리플클릭으로 문단 전체를 범위 선택한다 — **편집 가능한 화면에서만** 성립한다.
///
/// 왜 이 조작인가(실측 2026-08-08, macOS Chromium):
/// - `Home`/`Shift+End`·`Shift+ArrowRight`·드래그는 범위를 만들지 **못했다**(macOS 키 관례 차이 + PM 처리)
/// - `dblclick`(단어)·트리플클릭(문단)은 안정적으로 범위를 만든다
/// 조작이 실패한 것과 원격 표시가 실패한 것은 원인이 다르므로 로컬 범위 생성을 먼저 단정한다.
export async function selectParagraph(page: Page): Promise<void> {
  await page.click('.editor .tiptap', { clickCount: 3 })
  await page.waitForTimeout(150)
  if (!(await localSelectionIsRange(page))) {
    throw new Error('트리플클릭이 범위 선택을 만들지 못했다 — 원격 표시 문제와 구분되는 조작 실패다')
  }
}

/// 읽기 전용 화면에서 범위 선택을 **시도**하고 성공했는지 반환한다(단정하지 않는다).
///
/// 현재 `editable: false` 화면은 어떤 조작으로도 범위를 만들지 못한다 — dblclick·트리플클릭·드래그
/// 전부 실패한다(실측 2026-08-08, `LocalCaret` 비활성 상태에서도 동일하므로 우리 확장과 무관하다).
/// 이 헬퍼는 그 사실이 **바뀌면 알아차리기 위한** 관측 지점이다.
export async function tryRangeSelect(page: Page): Promise<boolean> {
  await page.click('.editor .tiptap', { clickCount: 3 })
  await page.waitForTimeout(200)
  return localSelectionIsRange(page)
}

export async function waitUntil(
  probe: () => Promise<boolean>,
  timeoutMs: number,
  description: string,
): Promise<number> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await probe()) return Date.now() - startedAt
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`${description}: ${timeoutMs}ms 안에 관측되지 않았다`)
}

/// gateway 카운터 — presence가 **서버를 통과했다**는 독립 증거. UI만 보면 우회 경로를 구분할 수 없다.
///
/// 파싱을 느슨하게 두지 않는 이유: 접두사 매칭은 같은 접두사를 가진 다른 메트릭까지 합산하고,
/// `Number()` 실패를 흘리면 합계가 `NaN` 이 되어 "릴레이가 없었다"처럼 보이는 실패를 낸다.
/// 그러면 원인이 파싱인지 서버인지 구분할 수 없다 — 부트스트랩 실패는 즉시 크게 실패시킨다.
export async function gatewayCounter(metric: string): Promise<number> {
  const response = await fetch(GATEWAY_METRICS_URL)
  if (!response.ok) throw new Error(`gateway metrics -> HTTP ${response.status}`)
  const body = await response.text()
  // 메트릭 이름 직후는 라벨(`{`) 또는 공백뿐이다 — 그 경계를 강제해 접두사 오합산을 막는다.
  const linePattern = new RegExp(`^${metric.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\{|\\s)`)
  return body
    .split('\n')
    .filter((line) => !line.startsWith('#') && linePattern.test(line))
    .reduce((sum, line) => {
      const value = Number(line.trim().split(/\s+/).at(-1))
      if (!Number.isFinite(value)) {
        throw new Error(`gateway metric '${metric}' 파싱 실패 — 원문: ${JSON.stringify(line)}`)
      }
      return sum + value
    }, 0)
}
