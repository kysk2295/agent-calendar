import type { Metadata } from "next";
import { TrustPage, type TrustSection } from "../_components/trust-page";

export const metadata: Metadata = {
  title: "개인정보 처리 안내",
  description: "Agent Calendar private beta의 Workspace 데이터와 Runner 자격 증명 경계 안내.",
};

const sections: TrustSection[] = [
  {
    title: "어떤 정보를 다루나요",
    paragraphs: [
      "Agent Calendar는 가입 식별자와 하나의 Workspace에 속한 일정, 위임 작업, Work Conversation, Work Checkpoint, 결과, 개인 기억, Wiki 문서·검색 색인, Connected Automation 설정과 실행 증거를 다룹니다.",
      "Runner를 연결하면 기기 공개 식별자, 확인용 fingerprint, 연결 상태, 지원 실행 엔진과 작업 수행 증거가 해당 Workspace에 기록됩니다.",
    ],
  },
  {
    title: "외부 서비스는 언제 연결되나요",
    items: [
      "WorkOS는 로그인과 계정 세션을 처리합니다.",
      "Google Calendar는 사용자가 연결을 승인한 경우에만 일정 동기화에 사용됩니다.",
      "Railway와 PostgreSQL은 Workspace별 제품 데이터와 운영 상태를 처리합니다.",
      "Codex, Claude, Grok, Hermes 같은 실행 엔진은 사용자가 소유한 Runner에서 사용자가 직접 연결합니다.",
    ],
  },
  {
    title: "Runner와 자격 증명의 경계",
    paragraphs: [
      "실행 엔진 자격 증명과 provider 로그인은 사용자 Runner 환경에 남습니다. Agent Calendar control plane은 Runner가 보고한 지원 가능 상태와 실행 증거를 받지만 provider 비밀번호나 세션을 대신 보관하지 않습니다.",
      "Runner는 등록 시 하나의 Workspace에만 귀속되며, 해지되거나 다른 Workspace의 작업을 요청하면 연결과 작업 임대가 거절됩니다.",
    ],
  },
  {
    title: "Calendar AI와 Wiki AI",
    paragraphs: [
      "Calendar AI는 현재 Workspace에서 사용자가 허용한 일정, 지식, 개인 기억만 문맥으로 사용합니다. Wiki AI 검색과 답변 근거도 같은 Workspace 경계를 따릅니다.",
      "캘린더 항목은 일정의 원본이며 개인 기억으로 대체되지 않습니다. 기억에는 출처와 삭제 경로가 있고, 사용자가 명시적으로 남기기로 한 정보만 장기 문맥으로 사용합니다.",
    ],
  },
  {
    title: "보관, 삭제, 보안",
    paragraphs: [
      "Private beta 동안 제품 데이터는 Workspace가 유지되는 동안 보관됩니다. 사용자는 연결을 해제하고 Runner를 폐기하며 지원 채널을 통해 Workspace 삭제를 요청할 수 있습니다.",
      "세션과 로컬 Workspace snapshot은 지원되는 Desktop 보안 저장소를 사용하며, 로그·지표에는 토큰, 문서 본문, 대화 원문을 그대로 남기지 않는 경계를 적용합니다. 확정된 세부 보존 기간은 공개 가입 전에 고지합니다.",
    ],
  },
  {
    title: "이 랜딩 페이지",
    paragraphs: [
      "현재 소개 사이트는 광고·행동 분석 도구를 로드하지 않으며 인증된 Workspace 데이터에 접근하지 않습니다. 향후 분석 기능을 도입하면 수집 목적과 선택권을 먼저 고지합니다.",
    ],
  },
];

export default function PrivacyPage() {
  return (
    <TrustPage
      eyebrow="Privacy"
      title="개인정보 처리 안내"
      summary="Agent Calendar가 어떤 Workspace 데이터를 다루고, 사용자 소유 Runner와 실행 엔진 자격 증명을 어디에서 분리하는지 설명합니다."
      sections={sections}
    />
  );
}
