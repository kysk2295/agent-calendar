import type { Metadata } from "next";
import { TrustPage, type TrustSection } from "../_components/trust-page";

export const metadata: Metadata = {
  title: "Private beta 이용정책",
  description: "Agent Calendar private beta 사용과 Runner 운영에 적용되는 제품 정책.",
};

const sections: TrustSection[] = [
  {
    title: "Private beta의 범위",
    paragraphs: [
      "현재 서비스는 초대받은 사용자가 기능과 운영 안전성을 검증하는 private beta입니다. 공개 판매, 공개 다운로드, 일반 사용자를 위한 확정 서비스 수준을 제공하는 단계가 아닙니다.",
      "beta 중 기능, 지원 실행 엔진, 보존 정책은 안전성과 제품 품질을 위해 변경될 수 있으며 중요한 변경은 적용 전에 알립니다.",
    ],
  },
  {
    title: "사용자 소유 Runner와 계정",
    paragraphs: [
      "사용자는 자신의 컴퓨터, 실행 엔진 계정, 구독, 네트워크와 사용자 소유 Runner 운영에 대한 권한을 보유해야 합니다. Runner는 승인된 한 Workspace의 작업만 받아야 합니다.",
      "provider 약관을 우회하는 인증 공유, 권한 상승 옵션, 다른 사람의 자격 증명 사용은 허용되지 않습니다.",
    ],
  },
  {
    title: "작업, 자동화, 승인 관문",
    paragraphs: [
      "사용자는 위임 작업과 Connected Automation의 목적, 입력, 결과 사용에 책임이 있습니다. 에이전트 결과는 중요한 결정을 내리기 전에 사용자가 검토해야 합니다.",
      "새 권한, 추가 비용, 외부 전달이 필요한 지원 작업은 승인 관문을 통과해야 합니다. 제품이 지원하지 않는 전송, 게시, 구매, 삭제 요청은 승인을 받았다는 이유만으로 실행되지 않습니다.",
    ],
  },
  {
    title: "허용되지 않는 사용",
    items: [
      "다른 Workspace, 사용자, Runner의 데이터나 작업에 접근하려는 시도",
      "보안 경계, 사용량 제한, 승인 관문을 우회하는 행위",
      "불법 콘텐츠, 악성 코드, 무단 감시 또는 타인의 권리를 침해하는 작업",
      "서비스·Runner·연결된 provider에 과도한 부하나 장애를 일으키는 자동화",
    ],
  },
  {
    title: "서비스 수준과 beta 한계",
    paragraphs: [
      "Private beta에는 확정된 가용성, 응답 시간, 데이터 복구 시간에 대한 공개 서비스 수준 약정이 없습니다. 계획된 점검이나 장애가 있을 수 있으며, 안전한 복구가 불가능하면 기능을 일시 중지할 수 있습니다.",
      "Agent Calendar는 연결된 provider, Google Calendar, 사용자 네트워크나 Runner 자체의 가용성을 통제하지 않습니다. 중대한 데이터는 사용자가 원본 서비스와 별도 백업에서도 확인해야 합니다.",
    ],
  },
  {
    title: "중지와 종료",
    paragraphs: [
      "보안 위험, 다른 사용자의 권리 침해, 정책 위반이 확인되면 Workspace나 Runner 연결을 중지할 수 있습니다. 사용자는 언제든 Runner를 폐기하고 beta 참여 종료를 요청할 수 있습니다.",
    ],
  },
];

export default function TermsPage() {
  return (
    <TrustPage
      eyebrow="Terms"
      title="Private beta 이용정책"
      summary="Agent Calendar와 사용자 소유 Runner를 안전하게 시험하기 위한 현재 이용 경계입니다."
      sections={sections}
    />
  );
}
