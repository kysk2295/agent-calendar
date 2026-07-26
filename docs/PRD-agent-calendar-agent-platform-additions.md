# PRD: Agent Calendar 에이전트 플랫폼 보강

## 1. Summary

Agent Calendar의 중심은 일정 관리다. 에이전트는 별도 챗봇이 아니라 일정에 연결된 일을
맡고, 사용자와 같은 작업 대화를 이어가며, 진행과 결과를 통합 캘린더에 남기는 실행
주체다.

현재 기획에 Runner, provider 세션, Work Conversation, Workspace 격리는 포함되어 있다.
이 PRD는 화면에 저장된 에이전트 설정이 실제 행동에 적용되고, 세션·기억·외부 채널이
끊기지 않도록 추가로 필요한 제품 계약을 정의한다.

## 2. Contacts

| 역할 | 담당 | 책임 |
| --- | --- | --- |
| 제품 책임자 | 사용자 | 제품 방향, 출시 범위, 외부 서비스 연결 승인 |
| 구현·검증 | Codex | 설계, TDD 구현, 실제 표면 ETE, 운영 증거 |
| 실행 환경 책임자 | 각 Workspace 소유자 | 자기 Runner와 provider 계정 인증·운영 |

## 3. Background

현재 Agent Calendar에서는 에이전트 이름, 역할, 책임, 지침, 전문 분야, 기본 엔진,
기본 Runner를 저장할 수 있다. 그러나 책임·지침·전문 분야는 아직 실제 Runner 실행
문맥에 적용되지 않는다. 따라서 서로 다른 에이전트를 만들어도 실제 행동은 거의 같은
실행기가 될 수 있다.

Provider 세션 연속성은 더 앞서 있다. Codex의 기존 에이전트와 세션을 Runner에서
가져오고, 같은 provider 세션으로 후속 지시를 보내고, 앱과 Gateway 재시작 뒤 복구하는
흐름이 실제로 확인됐다. 이제 하나의 Work Conversation에 Codex, Claude, Telegram 같은
여러 provider/channel endpoint가 연결되고 어느 표면에서든 같은 canonical transcript를
읽고 쓰는 계약으로 확장한다.

Argo에서 참고할 점은 다음과 같다.

- 한 줄 역할 설명으로 에이전트 초안을 만든다.
- 이름, 팀, 엔진, 모델, 규칙, 답변 스타일, 외부 채널을 설정한다.
- 에이전트별 대화와 작업 기록을 계속 유지한다.
- PC와 외부 채널을 오가도 맥락이 끊기지 않는다.
- 기억, 도구, 자동화, 협업을 하나의 에이전트 설정에서 관리한다.

Agent Calendar는 이를 그대로 복제하지 않는다. 캘린더, 승인, 출처, Workspace 보안이
제품의 기준이며 에이전트 기능도 이 기준을 따라야 한다.

## 4. Objective

사용자가 에이전트를 만들거나 가져온 뒤 Agent Calendar 안에서 장기간 함께 일할 수
있게 한다. 사용자가 정한 역할과 규칙은 매 실행에 정확히 적용된다. 같은 작업 대화는
앱 종료와 네트워크 단절 뒤에도 유지되며 Codex, Claude, Telegram 등 연결된 endpoint가
같은 canonical transcript와 작업 상태를 공유해야 한다.

### Key Results

- 에이전트 작업의 100%가 실행 당시의 정확한 Runtime Profile 버전을 기록한다.
- 에이전트 규칙·도구·기억 범위를 무시한 실행을 0건으로 유지한다.
- 후속 메시지의 100%가 사용자가 선택한 exact provider endpoint를 사용하거나 명시적인
  새 세션 선택을 요구한다. 조용한 engine/session fallback은 0건이다.
- Desktop, Telegram, provider endpoint에서 수신한 메시지의 100%가 하나의 canonical
  sequence로 저장되며 replay로 중복되는 메시지는 0건이다.
- Workspace A/B hostile isolation 테스트에서 에이전트, 세션, 기억, 도구 결과,
  채널 상태의 교차 노출이 0건이다.
- 앱·Gateway·Runner 재시작 뒤 Work Conversation과 provider 세션 매핑 복구 성공률을
  100%로 유지한다.
- provider credential, cookie, token이 Gateway DB·로그·응답·증거에 나타나는 경우를
  0건으로 유지한다.
- 실제 WorkOS 두 계정과 서로 다른 Runner/provider identity를 사용한 ETE가 출시 전에
  통과한다.

## 5. Market Segments

### 첫 출시

한 사람이 자기 Workspace에서 일정, 지식, 자동화와 AI 작업을 함께 관리한다.

필요한 일:

- 여러 AI 앱을 번갈아 열지 않고 한 곳에서 일을 계속하고 싶다.
- 작업을 시키고 잊는 것이 아니라 언제 시작하고 끝났는지 일정에서 보고 싶다.
- Codex, Claude, Grok, Hermes 계정과 컴퓨터는 직접 소유하고 싶다.
- 에이전트가 어떤 규칙과 도구로 행동하는지 직접 통제하고 싶다.

### 후속 출시

- 여러 에이전트에게 역할을 나눠 맡기는 1인 사업자와 소규모 팀
- Desktop 밖에서 승인과 짧은 개입이 필요한 사용자
- 반복 업무를 자동화와 에이전트 작업으로 연결하려는 사용자

### 제약

- v1은 한 명의 소유자가 한 Workspace를 쓰는 단순한 UX를 유지한다.
- 내부 저장과 권한은 처음부터 다중 Workspace를 전제로 한다.
- Mobile은 Desktop/Web 프로덕션 게이트 이후 마지막에 개발한다.

## 6. Value Propositions

### 일정이 중심인 에이전트 운영

사용자는 별도 AI 채팅 목록이 아니라 통합 캘린더에서 예정, 진행, 완료, 재작업을
확인한다. 사람 일정과 에이전트 작업은 같은 시간축에 있지만 충돌로 취급하지 않는다.

### 원하는 방식으로 실제 행동하는 에이전트

이름만 다른 에이전트가 아니다. 역할, 규칙, 답변 스타일, 도구, 기억, 승인 정책이
실제 실행 입력과 권한에 적용된다.

### 끊기지 않는 작업 대화

Desktop에서 시작한 Work Conversation은 여러 provider/channel endpoint를 가질 수 있다.
Codex에서 시작해 Claude나 Telegram으로 이동해도 사용자가 맥락을 다시 설명하지 않는다.
대화 원본은 Agent Calendar가 소유하고 각 endpoint는 마지막으로 동기화한 위치를 가진다.

### 고객이 소유하는 AI 계정과 실행 환경

Provider 인증은 고객 Runner에 남는다. Agent Calendar는 credential을 가져오지 않고
Workspace가 허용한 작업과 공개 실행 증거만 관리한다.

### 보이는 기억과 권한

장기 기억은 숨은 프로필이 아니다. 사용자는 무엇이 기억됐는지, 어디서 왔는지,
어떤 에이전트가 쓰는지 확인하고 수정하거나 삭제할 수 있다.

## 7. Solution

### 7.1 UX and primary flow

#### 에이전트 만들기

1. 사용자가 “경쟁사와 고객 반응을 조사하고 매주 월요일 보고하는 리서처”처럼 한 줄로
   설명한다.
2. 시스템은 이름, 역할, 책임, 규칙, 답변 스타일, 추천 엔진, 필요한 도구와 기억 범위를
   초안으로 만든다.
3. 사용자는 초안을 검토하고 팀, Runner, provider, 모델, 도구, 승인 정책을 수정한다.
4. 테스트 대화에서 실제 적용될 설정과 예상 권한을 확인한다.
5. 사용자가 활성화하면 Runtime Profile 버전 1이 만들어진다.
6. 이후 수정은 기존 작업을 바꾸지 않고 새 버전으로 저장된다.

#### 기존 에이전트 가져오기

1. 사용자가 Workspace Runner와 provider를 선택하고 로컬 프로필 조회에 동의한다.
2. Runner가 공개 메타데이터만 읽어 목록과 capability를 보여준다.
3. 사용자가 하나를 연결하고 Agent Calendar 전용 규칙·도구·기억 범위를 덧붙인다.
4. Provider credential과 원본 설정 파일은 Runner 밖으로 나오지 않는다.

#### 대화와 세션

1. 에이전트를 선택하면 해당 에이전트의 Work Conversation 목록이 보인다.
2. 새 작업은 새 Work Conversation을 만들고 선택한 engine의 provider endpoint를 연결한다.
3. 같은 Work Conversation에 Codex, Claude 등 여러 provider endpoint를 연결할 수 있다.
4. 후속 메시지는 사용자가 선택한 active endpoint의 exact session으로 전송한다.
5. 다른 endpoint는 canonical transcript 또는 권한이 제한된 context snapshot으로
   같은 맥락을 이어간다.
6. 세션이 만료되거나 삭제되면 상태를 보여주고, 사용자가 선택하기 전에는 새 세션을
   만들지 않는다.
7. 작업 결과, artifact, 승인, 오류, 수정 차수는 통합 캘린더와 대화에 함께 남는다.

#### 외부 채널

1. 사용자는 Workspace 설정에서 Telegram 같은 채널을 연결한다.
2. 채널의 대화는 에이전트가 아니라 정확한 Work Conversation endpoint에 연결한다.
3. Desktop, Telegram, provider endpoint는 같은 canonical 메시지 순서와 작업 상태를
   공유한다.
4. 동시에 들어온 두 지시는 한 turn씩 직렬화하거나 명시적으로 fork한다.
5. 외부 채널에서 위험한 행동은 동일한 Approval Gate를 사용한다.

### 7.2 Key features

#### P0: 출시 전에 반드시 필요

1. **Versioned Agent Runtime Profile**
   - 이름, 역할, 책임, 시스템 규칙, 답변 스타일
   - 기본 provider, Execution Engine, 세부 모델, Runner
   - 허용 도구·스킬, 기억 범위, Approval 정책
   - profile version과 execution snapshot
   - 실제 Runner prompt와 tool policy에 강제 적용

2. **Session continuity contract**
   - Work Conversation 하나 ↔ 여러 provider/channel endpoint
   - turn별 active endpoint의 exact session reuse
   - Codex → Claude → Codex 전환 뒤에도 같은 canonical transcript 유지
   - concurrent turn lock, idempotency, restart recovery
   - missing, deleted, auth expired, quota exhausted의 정확한 상태
   - 새 세션, 기존 세션 재개, 명시적 fork

3. **Agent memory model**
   - 현재 세션 문맥
   - 에이전트별 작업 기억
   - Workspace 공유 Knowledge
   - Calendar AI Personal Memory
   - 네 종류를 섞지 않고 출처, 보존 기간, 수정, 삭제를 제공
   - 에이전트별 기억 범위와 검색 권한

4. **Real account and Workspace isolation**
   - 실제 WorkOS 두 계정
   - 각 계정 소유의 Runner와 서로 다른 provider identity
   - catalog, session, message, memory, artifact, Calendar, channel hostile isolation

5. **Effective configuration preview**
   - 사용자가 실행 전에 실제 적용될 엔진, 모델, Runner, 규칙, 도구, 기억 범위를 본다.
   - auto 선택 결과와 선택 이유를 보여준다.
   - 실행 이력에서 당시 profile version을 다시 볼 수 있다.

#### P1: 제품 완성도를 위해 필요

6. **One-line agent builder**
   - 한 줄 설명으로 초안을 만들되 자동 활성화하지 않는다.
   - 사용자가 반드시 검토하고 테스트한 뒤 활성화한다.

7. **Teams and handoff**
   - 에이전트에 팀 라벨을 지정한다.
   - 한 Delegated Work의 Responsible Agent는 한 명으로 유지한다.
   - 다른 에이전트에게 하위 작업을 맡길 때 관계와 결과를 원 작업에 남긴다.

8. **Tools and skills**
   - Runner에서 사용 가능한 도구와 스킬 조회
   - 에이전트별 허용·거부
   - 새 권한과 외부 전송은 승인 필요
   - 반복 업무는 자동 설치하지 않고 “스킬로 만들기” 제안으로 제공

9. **Cross-channel continuity**
   - Desktop과 Telegram 우선
   - 동일 Work Conversation 메시지와 checkpoint 동기화
   - channel account와 Workspace 연결, 해제, 감사 기록
   - Mobile은 같은 계약을 재사용하되 마지막 단계에서 구현

10. **Calendar-native agent lifecycle**
    - 에이전트 작업의 예정, 시작, 진행, 완료, 실패, 재작업
    - 반복 작업은 Connected Automation과 구분
    - 작업 대화, 결과, 다음 일정으로 바로 이동

#### P2: 후속 차별화

11. **Bounded agent meeting**
    - 최대 참여자와 turn 수를 제한한다.
    - 회의 목적, 각 에이전트의 의견, 최종 결정과 비용을 저장한다.
    - 결과는 Wiki와 Calendar 후속 작업으로 연결할 수 있다.

12. **Engine comparison**
    - 같은 입력을 여러 엔진에 보낸 뒤 결과, 시간, 비용, 근거를 비교한다.
    - 사용자가 채택한 결과만 현재 결과로 표시한다.

13. **Skill marketplace**
    - 서명, 권한 manifest, 출처, 버전, 제거와 rollback이 준비된 뒤 제공한다.
    - 검증되지 않은 스킬의 원클릭 자동 설치는 허용하지 않는다.

### 7.3 Technology contracts

- Gateway에는 Runtime Profile의 비밀 없는 정책과 버전만 저장한다.
- Provider credential과 provider 원본 설정은 Runner 로컬에만 남긴다.
- Runner는 profile version, tool grant, memory scope를 확인한 뒤 실행한다.
- 실제 provider session id는 Workspace + agent + Runner + Work Conversation에 묶는다.
- 모든 메시지와 checkpoint는 순서 번호와 idempotency key를 가진다.
- 외부 채널 ingress도 로그인 사용자와 같은 Workspace authorization을 통과한다.
- 기억 검색은 Workspace와 agent memory scope를 모두 만족해야 한다.
- 실행이 끝난 뒤 citation, artifact, Calendar projection 권한을 다시 확인한다.

### 7.4 Assumptions to validate

- Codex와 Claude는 안정적인 session resume identity를 제공한다.
- Hermes와 Grok은 provider 버전에 따라 session capability가 제한될 수 있다.
- 사용자는 완전 자동 생성보다 검토 가능한 agent profile 초안을 선호한다.
- 반복 업무의 자동 스킬화보다 명시적 제안과 승인이 안전하고 신뢰를 높인다.
- Telegram이 첫 외부 채널로 적합하지만 실제 사용자 수요는 검증이 필요하다.
- 에이전트별 장기 기억은 유용하지만 잘못된 기억 삭제 UX가 없으면 신뢰를 떨어뜨린다.

## 8. Release

### Release A: 행동하는 에이전트

- Runtime Profile과 version
- 역할·규칙·스타일·도구·기억 범위의 실제 실행 적용
- effective configuration preview
- Codex와 Claude 실제 ETE

완료 조건:

- 서로 다른 profile을 가진 두 에이전트가 같은 요청에 각자 규칙대로 답한다.
- 실행 이력에서 적용된 profile version과 권한을 확인할 수 있다.

### Release B: 끊기지 않는 세션과 기억

- provider session 연속성 완성
- agent memory model과 사용자 편집·삭제
- 실제 두 계정·두 Runner hostile ETE
- restart, disconnect, auth expiry, quota 상태

완료 조건:

- 사용자가 앱을 닫고 다시 열어도 설명 없이 같은 작업을 이어간다.
- 다른 Workspace는 세션과 기억의 존재 여부도 알 수 없다.

### Release C: 외부 채널과 협업

- Telegram 연결
- 동일 Work Conversation 동기화
- team label과 agent handoff
- bounded meeting과 engine comparison은 feature flag로 시작

완료 조건:

- Desktop과 Telegram에서 같은 대화 순서와 결과가 보인다.
- 동시 지시가 중복 실행되지 않는다.

### Release D: Mobile

Desktop/Web 프로덕션, 실제 계정 ETE, 운영·롤백 게이트가 모두 통과한 뒤 마지막으로
시작한다. Mobile은 통합 캘린더, Calendar AI, 승인, 에이전트 개입만 제공하며 별도의
세션·기억·권한 모델을 만들지 않는다.

### Explicitly deferred

- 무검증 스킬 마켓의 원클릭 설치
- 사용자가 확인하지 않은 자동 self-learning
- 무제한 에이전트 회의
- v1의 Workspace 공동 편집과 조직 관리
- Agent Calendar가 provider credential이나 AI 구독을 대신 보관하는 기능
