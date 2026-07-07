# 캘린더 AI · 위키 AI 명세서 (인덱스)

이 문서는 기능별 명세서로 분리되었다. 최신 내용은 아래 두 문서를 본다.

| 기능 | 문서 | 요약 |
|---|---|---|
| 캘린더 AI | [spec-calendar-ai.md](spec-calendar-ai.md) | 개인 비서. DB 근거 Q&A(읽기) + 사진/자연어 명령으로 일정 등록(쓰기, 확인 필수) |
| 위키 검색 AI | [spec-wiki-ai.md](spec-wiki-ai.md) | 지식 비서. iCloud LLM-Wiki 문서 RAG → 로컬 LLM 스트리밍 답변 (읽기 전용) |

## 공통 원칙 (두 문서에 동일 적용)

1. 계산은 코드, 서술은 LLM
2. 답변 후처리로 품질을 위장하지 않는다 (`answerMode`로 정직하게 표기)
3. 검색은 진짜 임베딩 (`embeddings.js` 공유 모듈, Ollama bge-m3)
4. 두 파이프라인은 절대 섞이지 않는다 (source 교차 오염 = 하드 실패)
5. 라우팅은 화면 기준 (채팅 FAB → 캘린더 AI, 위키 탭 → 위키 AI)

## 공유 인프라·평가

- 임베딩 모듈: `apps/backend/app/lib/embeddings.js` — 각 명세서의 임베딩 인프라 절 참조
- 골든셋: `apps/backend/tests/fixtures/golden-set.json` (calendar 15 + wiki 15)
- 테스트 피라미드: 유닛 → API 통합(`api-golden.test.cjs`) → UI 배선(`playwright-wiring.cjs`) → 야간 100회 리그레션
- 로드맵: M1 후처리 정리 → M2 임베딩 → M3 평가 체계 → M4 7b 전환·품질 → M5 일정 입력(캘린더 전용). 위키 몫은 M2~M4 안의 W2~W4 (각 명세서 로드맵 절 참조). 총 5~6 작업일
