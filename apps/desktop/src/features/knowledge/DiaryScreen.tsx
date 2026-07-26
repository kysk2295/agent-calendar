import { useEffect, useMemo, useState } from 'react';
import {
  docIdentity,
  hasWikiFullBody,
  isJournalDoc,
  journalBody,
  journalDateKey,
  journalTime,
  wikiDetail,
} from '../../domains/knowledge/knowledge';
import {
  addDaysKey,
  dateLabel,
  formatDateChip,
  todayKey,
} from '../../domains/work-management/workManagement';
import { itemId, text } from './knowledgePresentation';

type Item = Record<string, unknown>;

type DiaryScreenProps = {
  docs: Item[];
  diaryText: string;
  setDiaryText: (value: string) => void;
  diaryMood: string;
  setDiaryMood: (value: string) => void;
  saveDiary: () => void;
  loadDocument: (path: string) => Promise<Item>;
};

export function DiaryScreen({ docs, diaryText, setDiaryText, diaryMood, setDiaryMood, saveDiary, loadDocument }: DiaryScreenProps) {
  const [wikiDetails, setWikiDetails] = useState<Record<string, Item>>({});
  const diarySummaries = useMemo(() => docs.filter(isJournalDoc), [docs]);
  useEffect(() => {
    let cancelled = false;
    const targets = diarySummaries
      .filter((entry, index) => {
        const path = text(entry.path || entry.wikiPath, '');
        const key = docIdentity(entry, `past-${index}`);
        return path && !hasWikiFullBody(entry) && !wikiDetails[key] && !wikiDetails[path];
      })
      .slice(0, 20);
    targets.forEach((entry, index) => {
      const path = text(entry.path || entry.wikiPath, '');
      const key = docIdentity(entry, path || `past-${index}`);
      loadDocument(path)
        .then((payload) => {
          if (cancelled) return;
          const detail = wikiDetail(payload);
          if (!Object.keys(detail).length) return;
          setWikiDetails((current) => current[key] || current[path] ? current : { ...current, [key]: detail, [path]: detail });
        })
        .catch(() => {});
    });
    return () => { cancelled = true; };
  }, [diarySummaries, loadDocument, wikiDetails]);
  const diaryDocs = diarySummaries
    .map((entry, index) => {
      const path = text(entry.path || entry.wikiPath, '');
      const key = docIdentity(entry, path || `past-${index}`);
      return wikiDetails[key] || wikiDetails[path] ? { ...entry, ...(wikiDetails[key] || wikiDetails[path]) } : entry;
    })
    .sort((a, b) => journalTime(b) - journalTime(a));
  const past = diaryDocs;
  const prompts = ['오늘 가장 기억에 남는 일은?', '무엇을 배웠나?', '내일은 무엇을 다르게?', '감사한 것 3가지'];
  const stats = [
    ['🔥', '연속 기록', `${Math.max(1, diaryDocs.length)}일`],
    ['📔', '일기', `${past.length}개`],
    ['🙂', '기분', diaryMood || '미선택'],
  ];
  return <div className="diary-screen screen-in">
    <main>
      <div className="diary-inner">
        <div className="diary-stats">{stats.map(([icon, label, value]) => <div key={String(label)}><span>{icon} {label}</span><strong>{value}</strong></div>)}</div>
        <section className="diary-card">
          <header><h2>오늘의 일기</h2><span>{dateLabel()}</span></header>
          <p>저장하면 위키에 일기로 쌓여 질문 검색에 활용됩니다.</p>
          <label>오늘의 기분</label>
          <div className="diary-moods">{['😊', '😌', '😐', '😔', '😤', '🤔'].map((mood) => <button data-active={diaryMood === mood} key={mood} onClick={() => setDiaryMood(diaryMood === mood ? '' : mood)}>{mood}</button>)}</div>
          <textarea value={diaryText} onChange={(event) => setDiaryText(event.target.value)} placeholder="오늘 하루는 어땠나요? 무엇을 배웠고, 내일은 무엇을 다르게 할까요?" />
          <div className="diary-prompts">{prompts.map((prompt) => <button key={prompt} onClick={() => setDiaryText(`${diaryText}${diaryText ? '\n\n' : ''}· ${prompt}\n`)}>+ {prompt}</button>)}</div>
          <footer><span>매일 기록이 위키의 컨텍스트가 됩니다</span><button className="primary" onClick={saveDiary}>위키에 저장</button></footer>
        </section>
      </div>
    </main>
    <aside>
      <header><strong>지난 일기</strong><span>타임라인</span></header>
      <div className="diary-timeline">
        {past.map((entry, index) => {
          const body = journalBody(entry) || '기록된 일기';
          const mood = body.match(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic})/u)?.[0] || '📔';
          const dateKey = journalDateKey(entry, addDaysKey(todayKey(), -index - 1));
          const day = dateKey.slice(-2);
          return <button key={itemId(entry, `past-${index}`)} onClick={() => setDiaryText(body.replace(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic})\s*/u, ''))}>
            <i>{mood}</i><span><b>{Number(day) || index + 1}</b><small>{formatDateChip(dateKey)}</small><em>{body.replace(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic})\s*/u, '').slice(0, 72)}</em></span>
          </button>;
        })}
      </div>
    </aside>
  </div>;
}
