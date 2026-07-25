import type { Metadata } from "next";
import { TrustPage, type TrustSection } from "../_components/trust-page";

export const metadata: Metadata = {
  title: "지원과 운영 상태",
  description: "Agent Calendar private beta의 지원, 장애, 보안 문제 보고 안내.",
};

const sections: TrustSection[] = [
  {
    title: "현재 지원 경로",
    paragraphs: [
      "Private beta 참여자는 초대받은 연락 채널에서 문제를 남겨 주세요. 공개 지원 주소와 티켓 시스템은 아직 운영하지 않으며, 존재하지 않는 연락처를 이 페이지에 표시하지 않습니다.",
      "문의에는 문제가 발생한 화면, 시간대, 기대한 결과, 재현 순서를 포함하되 토큰, 비밀번호, 실행 엔진 세션, 개인 문서 원문은 보내지 마세요.",
    ],
  },
  {
    title: "먼저 확인할 것",
    items: [
      "Desktop에서 로그인한 Workspace가 맞는지 확인합니다.",
      "Runner 설정에서 연결 상태와 필요한 실행 엔진의 최근 테스트 결과를 확인합니다.",
      "Google Calendar·Wiki·자동화 연결이 해지 또는 만료 상태인지 확인합니다.",
      "작업 대화에 blocker나 승인 요청이 남아 있는지 확인합니다.",
    ],
  },
  {
    title: "장애와 데이터 문제",
    paragraphs: [
      "일정 누락, 다른 Workspace 데이터 노출 의심, 반복 실행, 작업 결과 유실은 높은 우선순위로 보고합니다. 문제가 해결될 때까지 해당 Runner나 자동화를 폐기 또는 일시 중지하고 원본 캘린더·provider 상태를 함께 보존하세요.",
      "현재 공개 상태 페이지와 공개 서비스 수준은 없습니다. 운영 안정성 검증이 끝나기 전에는 beta 연락 채널의 안내가 현재 상태의 기준입니다.",
    ],
  },
  {
    title: "긴급 보안 문제",
    paragraphs: [
      "다른 사용자의 데이터가 보이거나 토큰·자격 증명이 노출된 것으로 의심되면 값을 복사해 보내지 말고 즉시 Runner 연결을 해지한 뒤 초대 채널에서 보안 문제라고 알려 주세요.",
      "공개 보안 신고 주소는 운영 주체와 대응 책임자가 확정된 뒤 공개합니다. 그 전에는 public signup을 열지 않습니다.",
    ],
  },
  {
    title: "공개 출시 전 남은 것",
    items: [
      "검증된 공개 지원 주소와 담당 운영자",
      "공개 상태 페이지와 incident communication 절차",
      "확정 서비스 수준, 보존 기간, 복구 목표",
      "법률 검토를 거친 개인정보·이용정책",
    ],
  },
];

export default function SupportPage() {
  return (
    <TrustPage
      eyebrow="Support"
      title="지원과 운영 상태"
      summary="문제를 안전하게 보고하고, 아직 준비되지 않은 공개 지원 경로를 구분하는 안내입니다."
      sections={sections}
    />
  );
}
