import { Extension } from '@tiptap/react'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { safePresenceColor } from './presence'

export interface LocalCaretOptions {
  /// 자기 presence 색 — 원격 caret과 같은 팔레트를 써서 "이게 내 커서"임이 룸 안에서 일관되게 읽힌다.
  readonly color: string
}

const localCaretKey = new PluginKey<boolean>('wedocsLocalCaret')

/// widget decoration 의 **동일성 키**. 이 키가 없으면 `WidgetType.eq` 가 `toDOM` 참조 동일성으로
/// 떨어지는데, `decorations` 는 호출마다 새 클로저를 넘기므로 항상 불일치 → 데코레이션이 재계산되는
/// 모든 상태 갱신에서 caret `<span>` 이 파괴·재생성된다. 상대가 타이핑하는 동안에는 원격 update 가
/// 트랜잭션으로 계속 들어오므로, 그때마다 깜빡임 애니메이션이 0프레임부터 다시 시작해 **규칙적인
/// 깜빡임이 아니라 불규칙한 점멸**로 보인다. 키를 고정하면 같은 위치의 caret 은 동일 노드로 유지된다.
const LOCAL_CARET_DECORATION_KEY = 'wedocs-local-caret'

/// 포커스 상태를 갱신한다. 이미 같은 값이면 트랜잭션을 만들지 않는다.
/// 반환값 `false` = "이벤트를 소비하지 않았다"(ProseMirror 의 기본 처리를 계속 진행시킨다).
function setFocused(view: EditorView, focused: boolean): boolean {
  if (localCaretKey.getState(view.state) !== focused) {
    view.dispatch(view.state.tr.setMeta(localCaretKey, focused))
  }
  return false
}

/// 읽기 전용(viewer) 화면에서 **자기 커서**를 그린다.
///
/// 왜 필요한가: `editable: false`는 DOM `contenteditable="false"`로 내려가고, 브라우저는 편집 불가
/// 영역에 caret을 **그리지 않는다**(범위 선택 하이라이트는 그린다). 그래서 viewer가 클릭·방향키로
/// 커서를 옮기면 그 위치는 awareness로 상대에게 정상 전달되는데 **자기 화면에서는 아무것도 안 보인다**.
/// 남들은 내 커서를 보는데 나만 못 보는 비대칭이 되고, viewer는 자기가 어디를 짚었는지 알 수 없다.
/// (실측 2026-08-08: viewer의 DOM selection은 `collapsed:true`로 정상 존재하고 위치도 잡힌다 —
///  없는 것은 **그림**뿐이다.)
///
/// 왜 `editable: true` + 트랜잭션 필터로 풀지 않았나: `editable: false`는 viewer의 입력이 로컬 Y.Doc에만
/// 남아 divergent 해지는 것을 막는 **정합성 경계**이고, E2E가 그 불변식(게이트웨이 write drop)을 검증한다.
/// 표시 문제를 고치려고 그 경계를 열면 방어가 얇아지고 회귀 시 증상이 "조용한 유실"로 나타난다.
/// 그래서 쓰기 정책은 손대지 않고 **렌더링만** 추가한다.
export const LocalCaret = Extension.create<LocalCaretOptions>({
  name: 'wedocsLocalCaret',

  addOptions() {
    // 폴백 값을 여기서 재정의하지 않는다 — presence 색의 출처는 `presence.ts` 하나뿐이어야 한다.
    return { color: safePresenceColor(undefined) }
  },

  addProseMirrorPlugins() {
    const { editor, options } = this
    // 형제 경로(`renderRemoteCaret`)와 같은 경계를 통과시킨다. 지금 호출자는 자기 user id 해시의
    // 고정 팔레트 값을 넘기므로 외부 입력이 아니지만, 이 옵션은 나중에 peer 색을 받기 쉬운 자리다.
    const caretColor = safePresenceColor(options.color)
    return [
      new Plugin<boolean>({
        key: localCaretKey,
        /// 포커스가 없는데 caret을 그리면 "여기에 내 커서가 있다"는 거짓 신호가 된다. ProseMirror는
        /// 포커스 변화만으로 트랜잭션을 만들지 않으므로 포커스를 플러그인 상태로 들고 재계산을 유발한다.
        state: {
          // 초기값 `false`: 현재 배선에서는 연결이 끝난 뒤에 에디터가 마운트되므로 "포커스된 채 뷰가
          // 생성되는" 경로가 없다. 만약 그런 경로가 생기면 첫 클릭까지 caret 이 보이지 않는다 —
          // 그때는 `onCreate` 에서 `editor.view.hasFocus()` 로 seed 해야 한다.
          init: () => false,
          apply: (transaction, focused) => {
            const next = transaction.getMeta(localCaretKey)
            return typeof next === 'boolean' ? next : focused
          },
        },
        props: {
          handleDOMEvents: {
            // 값이 이미 같으면 dispatch 하지 않는다 — 창 재포커스 등으로 `focus` 가 반복 발화할 때
            // 상태 갱신과 데코레이션 재계산을 공짜로 반복하지 않기 위함이다.
            focus: (view) => setFocused(view, true),
            blur: (view) => setFocused(view, false),
          },
          decorations: (state) => {
            // 편집 가능하면 브라우저가 이미 caret을 그린다 — 중복 렌더는 커서가 두 개로 보이게 한다.
            if (editor.isEditable || localCaretKey.getState(state) !== true) {
              return null
            }
            const { selection } = state
            // 범위 선택은 네이티브 하이라이트가 편집 불가 영역에서도 보인다.
            // 안 보이는 것은 collapsed caret 하나뿐이므로 그것만 보충한다.
            if (!selection.empty) {
              return null
            }
            return DecorationSet.create(state.doc, [
              Decoration.widget(
                selection.head,
                () => {
                  const caret = document.createElement('span')
                  caret.classList.add('local-caret')
                  caret.style.borderColor = caretColor
                  // 내 커서는 스크린리더가 읽을 내용이 아니다(위치는 caret 자체로 전달된다).
                  caret.setAttribute('aria-hidden', 'true')
                  return caret
                },
                // side: 같은 위치의 원격 caret 뒤에 그려 라벨을 가리지 않는다.
                // key: 재계산마다 DOM 을 재생성하지 않기 위한 동일성 키(위 상수 주석 참조).
                { side: 1, key: LOCAL_CARET_DECORATION_KEY },
              ),
            ])
          },
        },
      }),
    ]
  },
})
