import { useMemo, useState } from 'react';
import type { SecondBrainDecision, SecondBrainReviewDraft, SecondBrainRun } from './secondBrainModel';
import {
  secondBrainStageLabel,
  stageSecondBrainDecision,
  updateStagedCorrection,
} from './secondBrainModel';
import './second-brain.css';

type Props = Readonly<{
  run: SecondBrainRun | null;
  sourceAvailable: boolean;
  busy?: boolean;
  onStart: () => Promise<void>;
  onReview: (decisions: readonly SecondBrainDecision[], activate: boolean) => Promise<void>;
  onConnectCalendar: () => Promise<void>;
  onOpenWiki: () => void;
}>;

export function SecondBrainOnboarding({
  run, sourceAvailable, busy = false, onStart, onReview, onConnectCalendar, onOpenWiki,
}: Props) {
  const [draft, setDraft] = useState<SecondBrainReviewDraft>({});
  const [corrections, setCorrections] = useState<Readonly<Record<string, string>>>({});
  const snapshot = run?.snapshot || null;
  const decisions = useMemo(() => Object.values(draft), [draft]);

  if (!run || run.status === 'source_required') {
    return (
      <div className="second-brain-state" data-state="source-required">
        <strong>{sourceAvailable ? '개인 Second Brain을 만들 준비가 됐습니다' : '연결된 원본 자료가 없습니다'}</strong>
        <p>{sourceAvailable
          ? '연결된 Calendar, Google 메일 또는 파일의 근거만 사용합니다.'
          : 'Calendar, Google 메일 또는 파일을 연결한 뒤 만들기 할 수 있습니다.'}</p>
        {sourceAvailable ? (
          <button type="button" className="primary" disabled={busy} onClick={() => { void onStart(); }}>Second Brain 만들기</button>
        ) : (
          <div className="second-brain-source-actions">
            <button type="button" onClick={() => { void onConnectCalendar(); }}>Google Calendar 연결</button>
            <button type="button" onClick={onOpenWiki}>파일 연결</button>
            <span>자료를 연결한 뒤 만들기</span>
          </div>
        )}
      </div>
    );
  }

  if (run.status === 'running') {
    const percent = run.total > 0 ? Math.round((run.processed / run.total) * 100) : null;
    return (
      <div className="second-brain-state" data-state="running" role="status">
        <strong>{secondBrainStageLabel(run.stage)}</strong>
        <p>{run.processed} / {run.total} 자료 처리</p>
        {percent !== null ? <progress max="100" value={percent}>{percent}%</progress> : null}
      </div>
    );
  }

  if (!snapshot) return <div className="second-brain-state"><strong>검토 결과를 다시 불러와 주세요.</strong></div>;
  return (
    <div className="second-brain-review" data-state={snapshot.status}>
      <header><strong>{snapshot.status === 'active' ? '개인 Second Brain 활성화 완료' : '근거를 검토해 주세요'}</strong><span>v{snapshot.version}</span></header>
      {snapshot.claims.map((claim) => {
        const selected = draft[claim.id];
        return (
          <article key={claim.id} className="second-brain-claim">
            <div><strong>{claim.text}</strong><small>{claim.citation}</small></div>
            {snapshot.status !== 'active' ? (
              <div>
                {selected?.action === 'correct' ? (
                  <input
                    aria-label={`${claim.text} 수정 내용`}
                    value={corrections[claim.id] ?? claim.text}
                    onChange={(event) => {
                      const nextText = event.target.value;
                      setCorrections((current) => ({ ...current, [claim.id]: nextText }));
                      setDraft((current) => updateStagedCorrection(current, claim.id, nextText));
                    }}
                  />
                ) : null}
                <button type="button" data-selected={selected?.action === 'confirm'} onClick={() => setDraft((current) => stageSecondBrainDecision(current, claim.id, 'confirm'))}>확인</button>
                <button type="button" data-selected={selected?.action === 'correct'} onClick={() => setDraft((current) => stageSecondBrainDecision(current, claim.id, 'correct', corrections[claim.id] ?? claim.text))}>수정</button>
                <button type="button" data-selected={selected?.action === 'reject'} onClick={() => setDraft((current) => stageSecondBrainDecision(current, claim.id, 'reject'))}>제외</button>
              </div>
            ) : null}
          </article>
        );
      })}
      {snapshot.status !== 'active' ? (
        <button type="button" className="primary" disabled={busy || decisions.length !== snapshot.claims.length} onClick={() => { void onReview(decisions, true); }}>검토 완료 및 활성화</button>
      ) : null}
    </div>
  );
}
