import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Agent Calendar — 일정에서 시작하는 에이전트 작업",
    template: "%s · Agent Calendar",
  },
  description:
    "내 일정, 자동화, 위임한 에이전트 작업을 하나의 캘린더에서 계획하고 관찰하는 작업 관제 공간.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
  openGraph: {
    title: "Agent Calendar",
    description: "일정이 흐르는 곳에서, 에이전트 일도 끝나게.",
    type: "website",
    locale: "ko_KR",
    images: [
      {
        url: "/og.png",
        width: 1536,
        height: 1024,
        alt: "사람 일정과 에이전트 작업이 함께 놓인 Agent Calendar",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Agent Calendar",
    description: "일정이 흐르는 곳에서, 에이전트 일도 끝나게.",
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f4f1eb",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
