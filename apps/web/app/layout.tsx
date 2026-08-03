import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Agent Calendar | 나를 이해하고 일을 이어가는 캘린더",
    template: "%s · Agent Calendar",
  },
  description:
    "일정, 메일, 파일과 기록을 이해해 지금 중요한 일을 알려주고 필요한 작업을 같은 맥락으로 이어가는 macOS 캘린더.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
  openGraph: {
    title: "Agent Calendar",
    description: "나를 이해하고, 기억하며, 필요한 일을 실제로 수행하는 캘린더.",
    type: "website",
    locale: "ko_KR",
    images: [
      {
        url: "/og.png",
        width: 1536,
        height: 1024,
        alt: "일정과 작업 결과가 함께 놓인 Agent Calendar 통합 캘린더",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Agent Calendar",
    description: "나를 이해하고, 기억하며, 필요한 일을 실제로 수행하는 캘린더.",
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f7f6" },
    { media: "(prefers-color-scheme: dark)", color: "#101412" },
  ],
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
