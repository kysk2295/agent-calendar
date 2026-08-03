import assert from "node:assert/strict";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(new URL(pathname, "http://localhost"), {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the calendar-centered personal intelligence story", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html lang="ko">/i);
  assert.match(html, /<title>Agent Calendar/);
  assert.match(html, /나를 이해하고/);
  assert.match(html, /나를 다시 설명하지 않도록/);
  assert.match(html, /사용자가 허용한 일정, 메일, 파일과 기록/);
  assert.match(html, /결과를 다시 캘린더와 Wiki에 남깁니다/);
  assert.match(html, /통합 캘린더/);
  assert.match(html, /Calendar AI/);
  assert.match(html, /Runner/);
  assert.match(html, /Codex/);
  assert.match(html, /Claude/);
  assert.match(html, /Grok/);
  assert.match(html, /Hermes/);
  assert.match(html, /<main\b/i);
  assert.match(html, /<nav\b/i);
  assert.match(html, /<footer\b/i);
});

test("fails closed when public handoff configuration is absent", async () => {
  const response = await render();
  const html = await response.text();

  assert.match(html, /Private beta 준비 중/);
  assert.doesNotMatch(html, /href="http:/i);
  assert.doesNotMatch(html, /download=["']/i);
  assert.match(html, /공개 다운로드 전 서명과 체크섬을 검증합니다/);
});

test("landing exposes product trust routes without inventing an external support address", async () => {
  const response = await render();
  const html = await response.text();

  assert.match(html, /href="\/privacy"/);
  assert.match(html, /href="\/terms"/);
  assert.match(html, /href="\/support"/);
  assert.doesNotMatch(html, /mailto:/i);
});

test("server-renders product-accurate privacy, terms, and support routes", async () => {
  const cases = [
    {
      pathname: "/privacy",
      heading: "개인정보 처리 안내",
      evidence: ["Workspace", "Google Calendar", "WorkOS", "실행 엔진 자격 증명"],
    },
    {
      pathname: "/terms",
      heading: "Private beta 이용정책",
      evidence: ["사용자 소유 Runner", "승인 관문", "서비스 수준"],
    },
    {
      pathname: "/support",
      heading: "지원과 운영 상태",
      evidence: ["초대받은 연락 채널", "긴급 보안 문제", "공개 지원 주소"],
    },
  ];

  for (const entry of cases) {
    const response = await render(entry.pathname);
    assert.equal(response.status, 200, `${entry.pathname} should render`);
    const html = await response.text();
    assert.match(html, new RegExp(`<h1[^>]*>${entry.heading}</h1>`));
    assert.match(html, /<main\b/);
    assert.match(html, /href="\/"/);
    for (const phrase of entry.evidence) {
      assert.match(html, new RegExp(phrase));
    }
  }
});
