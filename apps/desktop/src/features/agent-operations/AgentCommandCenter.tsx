import { useState } from 'react';

import {
  hermesAutomationStatusLabel,
} from './hermesAutomation';
import { agentTaskAppearance } from './agentTaskAppearance';
import type {
  AgentOperationsState,
  AgentRosterEntry,
  HermesAutomationJob,
} from './types';

type AgentCommandCenterProps = {
  readonly state: AgentOperationsState;
  readonly agents: readonly AgentRosterEntry[];
  readonly automationJobs: readonly HermesAutomationJob[];
  readonly onOpenMission: (missionId: string) => void;
  readonly onOpenAutomation: (jobId: string) => void;
  readonly onStartRequest: (objective: string) => void;
};

function reviewPendingCount(state: AgentOperationsState): number {
  return state.reports.filter((report) => (
    report.useful === null || /waiting|pending|review|approval/i.test(report.deliveryStatus)
  )).length;
}

export function AgentCommandCenter(props: AgentCommandCenterProps) {
  const [request, setRequest] = useState('');
  const activeJobs = props.automationJobs.filter((job) => job.status === 'active').length;
  const runningTasks = props.state.tasks.filter((task) => task.status === 'running');
  const visibleTasks = [
    ...runningTasks,
    ...props.state.tasks.filter((task) => task.status !== 'running' && ['scheduled', 'blocked', 'proposed'].includes(task.status)),
  ].slice(0, 4);

  return (
    <div className="agent-command-center">
      <section className="agent-command-metrics" aria-label="Hermes 운영 현황">
        <div><span>Hermes 에이전트</span><strong>{props.agents.length}</strong><small>{props.agents.filter((agent) => /ready|online|준비|활성/i.test(agent.status)).length}개 준비됨</small></div>
        <div><span>활성 자동화</span><strong>{activeJobs}</strong><small>전체 {props.automationJobs.length}개</small></div>
        <div><span>실행 중</span><strong>{runningTasks.length}</strong><small>{props.state.daemon.running ? '스케줄러 온라인' : '스케줄러 일시정지'}</small></div>
        <div><span>검토 대기</span><strong>{reviewPendingCount(props.state)}</strong><small>완료 결과 확인</small></div>
      </section>

      <section className="agent-command-request">
        <header><div><strong>새 작업 지시</strong><span>목표를 설명하면 에이전트가 계획을 만들고 캘린더에 배치합니다.</span></div><b>Hermes · Local · Codex</b></header>
        <label>
          <span>에이전트 작업 요청</span>
          <textarea value={request} onChange={(event) => setRequest(event.target.value)} placeholder="예: 경쟁사 세 곳을 조사하고 금요일까지 Word 보고서로 정리해줘." />
        </label>
        <footer>
          <div><button type="button" onClick={() => setRequest('이번 주 사업 기회를 조사하고 근거와 추천 행동을 보고해줘.')}>리서치</button><button type="button" onClick={() => setRequest('내 위키의 새 문서를 정리하고 연결이 필요한 문서를 보고해줘.')}>위키 정리</button></div>
          <button className="primary" type="button" disabled={!request.trim()} onClick={() => props.onStartRequest(request.trim())}>상세 설정</button>
        </footer>
      </section>

      <div className="agent-command-grid">
        <section className="agent-command-automation-preview">
          <header><div><strong>Hermes 자동화</strong><span>연결된 실행 엔진에서 반복되는 작업</span></div><b>{props.automationJobs.length}개</b></header>
          <div>
            {props.automationJobs.slice(0, 4).map((job) => (
              <button type="button" key={job.id} onClick={() => props.onOpenAutomation(job.id)}>
                <i data-status={job.status} /><span><strong>{job.name}</strong><small>{job.agentId} · {job.schedule}</small></span><b>{hermesAutomationStatusLabel(job.status)}</b>
              </button>
            ))}
            {!props.automationJobs.length && <p>연결된 Hermes 자동화를 아직 확인하지 못했습니다.</p>}
          </div>
        </section>

        <section className="agent-command-live-work">
          <header><div><strong>실시간 작업</strong><span>미션에서 생성된 현재·다음 작업</span></div><b>{visibleTasks.length}개</b></header>
          <div>
            {visibleTasks.map((task) => {
              const appearance = agentTaskAppearance(task.status);
              return (
                <button type="button" key={task.id} onClick={() => props.onOpenMission(task.missionId)}>
                  <i data-tone={appearance.tone} /><span><strong>{task.title}</strong><small>{task.agent} · {task.expectedOutput}</small></span><b>{appearance.label}</b>
                </button>
              );
            })}
            {!visibleTasks.length && <p>실행 중이거나 예정된 미션 작업이 없습니다.</p>}
          </div>
        </section>
      </div>
    </div>
  );
}
