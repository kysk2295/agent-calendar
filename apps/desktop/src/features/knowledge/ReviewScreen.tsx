import { useState } from 'react';
import {
  isDone,
  taskOwner,
  todayKey,
  weekRangeLabel,
} from '../../domains/work-management/workManagement';
import { itemTitle, text } from './knowledgePresentation';

type Item = Record<string, unknown>;

export function ReviewScreen({ tasks, patchTask, generateRetroDraft, createReviewGoal, saveRetro }: { tasks: Item[]; patchTask: (task: Item, patch: Item) => void; generateRetroDraft: (summary: { range: string; done: number; total: number; overdue: number; delegated: number; goals: string[] }) => Promise<string>; createReviewGoal: (title: string) => Promise<boolean>; saveRetro: (body: string) => void }) {
  const done = tasks.filter(isDone).length;
  const [goalInput, setGoalInput] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [savingGoal, setSavingGoal] = useState(false);
  const [retro, setRetro] = useState('');
  const range = weekRangeLabel();
  const goals = tasks
    .filter((task) => /goal|objective|목표/i.test(text(task.kind || task.type || task.list || task.category || task.project || (Array.isArray(task.tags) ? task.tags.join(' ') : task.tags))))
    .map((task) => ({ task, text: itemTitle(task, '목표'), done: isDone(task) }));
  const overdue = tasks.filter((task) => text(task.date) && text(task.date) < todayKey() && !isDone(task)).length;
  const delegated = tasks.filter((task) => taskOwner(task) === 'Agent' || taskOwner(task) === 'Hybrid').length;
  const kpis = [
    ['완료율', `${Math.round((done / Math.max(tasks.length, 1)) * 100)}%`, `${done}/${tasks.length} 완료`, '#2B2620'],
    ['완료', done, '이번 주', '#3E9B72'],
    ['지연', overdue, '정리 필요', '#C0533B'],
    ['위임', delegated, '에이전트', '#3E7A52'],
  ];
  const addGoal = async () => {
    const value = goalInput.trim();
    if (!value || savingGoal) return;
    setSavingGoal(true);
    try {
      const created = await createReviewGoal(value);
      if (created) setGoalInput('');
    } finally {
      setSavingGoal(false);
    }
  };
  const generateRetro = async () => {
    if (drafting) return;
    setDrafting(true);
    try {
      const draft = await generateRetroDraft({
        range,
        done,
        total: tasks.length,
        overdue,
        delegated,
        goals: goals.map((goal) => `${goal.done ? '[완료]' : '[진행]'} ${goal.text}`),
      });
      setRetro(draft || '백엔드 회고 생성 결과가 비어 있습니다.');
    } catch (error) {
      setRetro((current) => current || (error instanceof Error ? `회고 생성 실패: ${error.message}` : '회고 생성 실패'));
    } finally {
      setDrafting(false);
    }
  };
  return <div className="review-screen screen-in">
    <p className="review-range">{range} · 이번 주 목표와 KPI를 점검하고 회고를 남기세요.</p>
    <div className="review-kpis">{kpis.map(([label, value, sub, color]) => <div key={String(label)}><span>{label}</span><strong style={{ color: String(color) }}>{value}</strong><small>{sub}</small></div>)}</div>
    <section className="review-goals">
      <h2>🎯 이번 주 목표</h2>
      <div>
        {goals.map((goal, index) => <button className="review-goal" data-done={goal.done} key={`${goal.text}-${index}`} onClick={() => patchTask(goal.task, { status: goal.done ? 'Planned' : 'Done', done: !goal.done })}>
          <i>{goal.done ? '✓' : ''}</i><span>{goal.text}</span>
        </button>)}
        <label className="review-add"><span>+</span><input value={goalInput} disabled={savingGoal} onChange={(event) => setGoalInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void addGoal(); }} placeholder={savingGoal ? '저장 중' : '목표 추가'} /></label>
      </div>
    </section>
    <section className="review-retro">
      <header><h2>📝 주간 회고</h2><span /><button className="primary" onClick={generateRetro} disabled={drafting}>{drafting ? '생성 중' : '자동 생성'}</button>{retro && <button onClick={() => saveRetro(retro)}>위키에 저장</button>}</header>
      {retro && <article>{retro}</article>}
    </section>
  </div>;
}
