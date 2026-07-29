import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../src/common/http/client'
import {
  requireArrayOf,
  requireBoolean,
  requireEnum,
  requireInt,
  requireNonEmptyString,
  requireNullableString,
  requireRecord,
  requireString,
} from '../../../src/common/http/contract'

/// 계약 위반은 전송 실패와 구분돼야 한다 — 타입은 ApiError, 원인은 code 로 식별한다.
function expectViolation(run: () => unknown) {
  let caught: unknown
  try {
    run()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(ApiError)
  expect((caught as ApiError).code).toBe('malformed-response')
}

describe('requireRecord', () => {
  it('배열·null 은 레코드가 아니다 — typeof 만으로는 통과하므로 명시적으로 막는다', () => {
    // Given/When/Then: 통과시키면 이후 필드 접근이 전부 undefined 가 되어 원인이 "필드 누락"으로 왜곡된다
    for (const raw of [null, [], ['a'], 'text', 42, undefined]) {
      expectViolation(() => requireRecord(raw, 'thing'))
    }
  })

  it('평범한 객체는 그대로 통과한다', () => {
    expect(requireRecord({ id: 'x' }, 'thing')).toEqual({ id: 'x' })
  })
})

describe('문자열 필드', () => {
  it('표시용 문자열은 빈 값을 허용한다 — 서버가 빈 title 을 허용하기 때문', () => {
    // Given/When/Then: 여기서 막으면 서버가 만들 수 있는 페이지를 클라가 열지 못한다
    expect(requireString({ title: '' }, 'title', 'page')).toBe('')
  })

  it('식별자는 빈 값을 거부한다 — 빈 id 는 다른 엔드포인트를 호출하게 만든다', () => {
    expectViolation(() => requireNonEmptyString({ id: '' }, 'id', 'page'))
    expectViolation(() => requireNonEmptyString({ id: 42 }, 'id', 'page'))
  })

  it('nullable 식별자는 null 과 필드 부재를 같게 본다', () => {
    // Given/When/Then: JSON 에서 "null" 과 "없음"은 같은 뜻 — 서버 직렬화 설정 변경으로 깨지지 않게
    expect(requireNullableString({ parentId: null }, 'parentId', 'page')).toBeNull()
    expect(requireNullableString({}, 'parentId', 'page')).toBeNull()
    expect(requireNullableString({ parentId: 'p1' }, 'parentId', 'page')).toBe('p1')
    expectViolation(() => requireNullableString({ parentId: '' }, 'parentId', 'page'))
  })
})

describe('requireInt', () => {
  it('JSON number 중 정수만 통과시킨다', () => {
    // Given/When/Then: 서버 계약은 int 다 — 실수·NaN 은 계약 위반이다
    expect(requireInt({ position: 0 }, 'position', 'page')).toBe(0)
    for (const value of [1.5, Number.NaN, Number.POSITIVE_INFINITY, '3', null]) {
      expectViolation(() => requireInt({ position: value }, 'position', 'page'))
    }
  })
})

describe('requireBoolean', () => {
  it('truthy 문자열을 boolean 으로 받아들이지 않는다', () => {
    // Given/When/Then: "false" 를 통과시키면 편집 잠금이 조용히 풀린다
    expect(requireBoolean({ canEdit: false }, 'canEdit', 'page')).toBe(false)
    expectViolation(() => requireBoolean({ canEdit: 'false' }, 'canEdit', 'page'))
  })
})

describe('requireEnum', () => {
  const ROLES = ['VIEWER', 'EDITOR', 'OWNER'] as const

  it('모르는 값은 거부한다 — 임의 해석은 조용한 권한 상승이 된다', () => {
    // Given/When/Then: 서버가 새 역할을 추가해도 클라가 그것을 낙관 해석하지 않는다(fail-closed)
    expect(requireEnum({ myRole: 'VIEWER' }, 'myRole', ROLES, 'page')).toBe('VIEWER')
    for (const value of ['NONE', 'viewer', '', 1, null]) {
      expectViolation(() => requireEnum({ myRole: value }, 'myRole', ROLES, 'page'))
    }
  })
})

describe('requireArrayOf', () => {
  it('원소 하나가 깨지면 목록 전체를 실패시킨다', () => {
    // Given: 두 번째 원소에 id 가 없다
    const raw = [{ id: 'a' }, { name: 'b' }]

    // When/Then: 조용히 건너뛰면 "왜 내 페이지가 목록에 없나"가 무증상 버그로 남는다
    expectViolation(() =>
      requireArrayOf(raw, 'list', (item) => requireNonEmptyString(requireRecord(item, 'item'), 'id', 'item')),
    )
  })

  it('배열이 아니면 거부하고, 빈 배열은 정상으로 본다', () => {
    // Given/When/Then: 빈 목록은 오류가 아니라 "아직 없음"이다
    expectViolation(() => requireArrayOf({ items: [] }, 'list', (item) => item))
    expect(requireArrayOf([], 'list', (item) => item)).toEqual([])
  })
})
