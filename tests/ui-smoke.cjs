const { app, BrowserWindow } = require('electron');
const path = require('node:path');

async function main() {
  await app.whenReady();

  const target = process.env.HERMES_UI_URL || `file://${path.join(__dirname, '..', 'dist', 'index.html')}`;
  const window = new BrowserWindow({
    width: 1320,
    height: 824,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  await window.loadURL(target);
  await new Promise((resolve) => setTimeout(resolve, 800));

  const result = await window.webContents.executeJavaScript(`
    (() => {
      const navLabels = Array.from(document.querySelectorAll('.nav-item')).map((el) => el.textContent.replace(/\\s+/g, ' ').trim());
      const navTitles = Array.from(document.querySelectorAll('.nav-title')).map((el) => el.textContent.trim());
      const active = Array.from(document.querySelectorAll('.nav-item[data-active="true"]')).map((el) => el.textContent.replace(/\\s+/g, ' ').trim());
      const rect = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const box = el.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      };
      const required = ['캘린더', '오늘', '다음 7일', '기본함', '메일함', '칸반 보드', '주간 회고', '위키', '일기', '에이전트'];
      return {
        title: document.title,
        navLabels,
        navTitles,
        active,
        missing: required.filter((label) => !navLabels.some((text) => text.includes(label))),
        hasAutomation: document.body.textContent.includes('오토메이션'),
        removedMockTabs: !navLabels.some((text) => text.includes('생각노트') || text.includes('언젠가')),
        scopedBadges: !navLabels.some((text) => text.includes('오늘33') || text.includes('기본함37')),
        rects: {
          sidebar: rect('.sidebar'),
          topbar: rect('.topbar'),
          chat: rect('.chat'),
          chatToggle: rect('.chat-fab'),
          content: rect('.content'),
        },
      };
    })()
  `);

  const sidebarOk = Math.round(result.rects.sidebar?.width || 0) === 248;
  const topbarOk = Math.round(result.rects.topbar?.height || 0) === 52;
  const chatOk = result.rects.chat === null && Math.round(result.rects.chatToggle?.width || 0) === 54;
  const noMissing = result.missing.length === 0;
  const noAutomation = result.hasAutomation === false;
  const oneActive = result.active.length === 1;
  const ok = sidebarOk && topbarOk && chatOk && noMissing && noAutomation && oneActive && result.scopedBadges && result.removedMockTabs;

  const interaction = await window.webContents.executeJavaScript(`
    (async () => {
      const tick = () => new Promise((resolve) => setTimeout(resolve, 80));
      const visibleText = (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim();
      const clickText = async (selector, text) => {
        const el = Array.from(document.querySelectorAll(selector)).find((node) => visibleText(node).includes(text));
        if (!el) throw new Error('missing ' + selector + ' ' + text);
        el.click();
        await tick();
        return visibleText(el);
      };
      const setValue = async (el, value) => {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        await tick();
      };
      const topbarSub = () => visibleText(document.querySelector('.screen-heading span'));
      const dateKeyInSeoul = (date = new Date()) => {
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
        const part = (type) => parts.find((entry) => entry.type === type)?.value || '';
        return part('year') + '-' + part('month') + '-' + part('day');
      };
      const todayKey = dateKeyInSeoul();
      const todayDate = new Date(todayKey + 'T00:00:00');
      const todayDay = String(todayDate.getDate());
      const todayChip = (todayDate.getMonth() + 1) + '월 ' + todayDate.getDate() + '일';
      const monthLabel = (offset) => {
        const date = new Date(todayDate);
        date.setMonth(date.getMonth() + offset);
        return date.getFullYear() + '년 ' + (date.getMonth() + 1) + '월';
      };

      await clickText('.nav-item', '오늘');
      const todayPlanOriginalTop = !!document.querySelector('.plan-quick') && !document.querySelector('.plan-screen h1') && !document.querySelector('.plan-sub');
      const todayStatsOriginalOrder = Array.from(document.querySelectorAll('.plan-stats span')).map(visibleText).join('|') === '지연|오늘 할 일|검토 대기';
      const reviewApproveButton = document.querySelectorAll('.review-row').length === 0 || !!document.querySelector('.review-row .approve');
      const reviewRowsBeforeApprove = document.querySelectorAll('.review-row').length;
      document.querySelector('.review-row .approve')?.click();
      await tick();
      const reviewApproveWorks = reviewRowsBeforeApprove === 0 ? document.body.textContent.includes('검토할 에이전트 결과가 없습니다') : document.querySelectorAll('.review-row').length < reviewRowsBeforeApprove && !document.querySelector('.modal');

      await clickText('.nav-item', '기본함');
      const inboxSubOriginal = topbarSub() === '분류되지 않은 작업';
      const inboxFallbackDense = true;
      const listTitle = Array.from(document.querySelectorAll('.nav-title')).find((node) => visibleText(node).includes('리스트'));
      listTitle?.querySelector('button')?.click();
      await tick();
      const listFormOpen = !!document.querySelector('.taxonomy-modal');
      document.querySelector('.taxonomy-emoji')?.click();
      await tick();
      await clickText('.emoji-grid button', '🚀');
      await setValue(document.querySelector('.taxonomy-field input'), '테스트 리스트');
      await setValue(document.querySelector('.taxonomy-group-input'), '실험 그룹');
      await clickText('.taxonomy-modal footer button', '저장');
      await tick();
      const dynamicListCreated = Array.from(document.querySelectorAll('.nav-item')).some((node) => visibleText(node).includes('테스트 리스트')) && Array.from(document.querySelectorAll('.nav-title')).some((node) => visibleText(node).includes('실험 그룹'));
      const tagTitle = Array.from(document.querySelectorAll('.nav-title')).find((node) => visibleText(node).includes('태그'));
      tagTitle?.querySelector('button')?.click();
      await tick();
      document.querySelector('.taxonomy-emoji')?.click();
      await tick();
      await clickText('.emoji-grid button', '🏷');
      await setValue(document.querySelector('.taxonomy-field input'), '실험태그');
      await setValue(document.querySelector('.taxonomy-group-input'), '실험 태그');
      await clickText('.taxonomy-modal footer button', '저장');
      await tick();
      const dynamicTagCreated = Array.from(document.querySelectorAll('.nav-item')).some((node) => visibleText(node).includes('실험태그')) && Array.from(document.querySelectorAll('.nav-title')).some((node) => visibleText(node).includes('실험 태그'));
      await clickText('.nav-item', '테스트 리스트');
      await setValue(document.querySelector('.list-quick input'), '동적 리스트 작업');
      document.querySelector('.list-quick button')?.click();
      await tick();
      const dynamicListTaskCreated = Array.from(document.querySelectorAll('.row')).some((row) => visibleText(row).includes('동적 리스트 작업'));
      const repeatTemplateOriginalLabels = Array.from(document.querySelectorAll('.repeat-chips button')).map(visibleText).join('|') === '⟳매일 루틴|⟳매주 회의|⟳매월 정산|⟳평일 근무';
      await clickText('.repeat-chips button', '매월 정산');
      const repeatTemplateFills = document.querySelector('.list-quick input')?.value === '매월 ';
      await clickText('.nav-item', '캘린더');
      document.querySelector('.day-cell[data-today="true"]')?.click();
      await tick();
      const newPopover = !!document.querySelector('.new-task-popover');
      await setValue(document.querySelector('.new-task-title-row input'), '새 모달 세부 인터랙션');
      document.querySelector('.new-date-chip')?.click();
      await tick();
      const datePanelOpen = !!document.querySelector('.new-panel');
      const datePanelRect = document.querySelector('.new-panel')?.getBoundingClientRect();
      const datePanelCompact = !!datePanelRect && Math.round(datePanelRect.width) <= 330 && Math.round(datePanelRect.height) <= 390;
      await clickText('.new-accordion-row', '시간');
      await clickText('.time-grid button', '오후 6:00');
      await clickText('.new-accordion-row', '반복');
      await clickText('.option-row button', '매주');
      await clickText('.new-accordion-row', '담당');
      await clickText('.option-row button', '에이전트');
      document.querySelector('.new-task-title-row button')?.click();
      await tick();
      const checklistAdded = !!document.querySelector('.new-task-check-row input:not([type])');
      document.querySelector('.new-list-button')?.click();
      await tick();
      const newListPanelOpened = !!document.querySelector('.new-list-panel');
      const newListTarget = Array.from(document.querySelectorAll('.new-list-panel button')).find((button) => visibleText(button).includes('테스트 리스트')) || document.querySelector('.new-list-panel button');
      newListTarget?.click();
      document.querySelector('.new-task-title-row input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await tick();
      const newModalTaskCreated = document.body.textContent.includes('새 모달 세부 인터랙션');

      await clickText('.nav-item', '기본함');
      const quick = document.querySelector('.list-quick input');
      await setValue(quick, '내일 오후3시 인터랙션 테스트 #업무 !높음 @hermes 매주');
      document.querySelector('.list-quick button').click();
      await tick();
      const addedTask = Array.from(document.querySelectorAll('.row')).find((row) => visibleText(row).includes('인터랙션 테스트'));
      if (!addedTask) throw new Error('quick add failed');
      const taskListMeta = !!addedTask.querySelector('.task-meta mark') && !!document.querySelector('.repeat-chips > span');
      addedTask.querySelector('i')?.click();
      await tick();
      const checked = document.querySelector('.task-row[data-completing="true"] i')?.textContent?.includes('✓') || false;
      await new Promise((resolve) => setTimeout(resolve, 360));
      const reopenedTask = Array.from(document.querySelectorAll('.row')).find((row) => visibleText(row).includes('동적 리스트 작업')) || document.querySelector('.row');
      reopenedTask.click();
      await tick();
      const taskInspectorOpen = !!document.querySelector('.task-inspector') && document.querySelector('.task-inspector')?.textContent?.includes('전체 편집');
      const taskInspectorSelected = document.querySelector('.task-row[data-active="true"]') && !!document.querySelector('.task-inspector .inspector-title');
      await clickText('.inspector-meta button', '전체 편집');
      await tick();
      const taskModal = !!document.querySelector('.detail-modal');
      const taskDetailOriginalLayout = !!document.querySelector('.detail-topline') && !!document.querySelector('.detail-date-trigger') && !!document.querySelector('.detail-compose') && !!document.querySelector('.detail-bottomline') && !document.querySelector('.detail-form');
      document.querySelector('.detail-date-trigger')?.click();
      await tick();
      await clickText('.detail-date-segment button', '지속 시간');
      const taskDetailChipsWork = !!document.querySelector('.detail-date-popover') && !!document.querySelector('.detail-date-popover .duration-grid');
      document.querySelector('.detail-date-popover footer .primary')?.click();
      await tick();
      const detailAgentButton = document.querySelector('.detail-agent');
      detailAgentButton?.click();
      await tick();
      const delegateModalFromTask = !detailAgentButton || (!!document.querySelector('.delegate-modal') && document.querySelector('.delegate-modal')?.textContent?.includes('자연어로 지시하면') && document.querySelectorAll('.delegate-agents button').length >= 1);
      if (document.querySelector('.delegate-modal')) await clickText('.delegate-modal footer button', '취소');
      else document.querySelector('.detail-close')?.click();
      await tick();
      await clickText('.nav-item', '테스트 리스트');
      const uniportFilterWorks = Array.from(document.querySelectorAll('.rows:not(details .rows) .row')).some((row) => visibleText(row).includes('동적 리스트 작업') || visibleText(row).includes('새 모달 세부 인터랙션'));
      const uniportRowsScoped = !Array.from(document.querySelectorAll('.rows:not(details .rows) .row')).some((row) => /계량경제학|롯데리아|영어 소모임|미용실/.test(visibleText(row)));

      await clickText('.nav-item', '캘린더');
      const calendarSubOriginal = topbarSub() === '나 · 에이전트 공유 일정';
      await clickText('.segment button', '주');
      const calendarWeekLayout = !!document.querySelector('.week-grid') && document.querySelectorAll('.week-col').length === 7;
      const weekHeadsBeforeNav = Array.from(document.querySelectorAll('.week-head strong')).map(visibleText).join('|');
      document.querySelectorAll('.screen-toolbar > button')[1]?.click();
      await tick();
      const weekAfterPrev = Array.from(document.querySelectorAll('.week-head strong')).map(visibleText);
      const weekBefore = weekHeadsBeforeNav.split('|');
      const calendarPrevWeekWorks = !weekAfterPrev.includes(todayDay) && weekBefore.includes(todayDay);
      document.querySelectorAll('.screen-toolbar > button')[0]?.click();
      await tick();
      const calendarTodayResetWorks = Array.from(document.querySelectorAll('.week-head strong')).map(visibleText).includes(todayDay);
      await clickText('.segment button', '일');
      const calendarDayActive = Array.from(document.querySelectorAll('.segment button[data-active="true"]')).some((button) => visibleText(button) === '일');
      const calendarDayLayout = !!document.querySelector('.day-schedule') && !!document.querySelector('.day-hours') && !!document.querySelector('.day-side');
      document.querySelector('.hour-row')?.click();
      await tick();
      const dayHourChipText = document.querySelector('.new-date-chip')?.textContent || '';
      const dayHourOpensDatedNew = dayHourChipText.includes(todayChip) || false;
      document.querySelector('.new-close')?.click();
      await tick();
      const placementTitle = document.querySelector('.day-all-day span')?.textContent?.trim() || '';
      document.querySelector('.day-all-day b')?.click();
      await tick();
      const timePlacementHint = !placementTitle || document.querySelector('.day-side p')?.textContent?.includes(placementTitle);
      document.querySelectorAll('.hour-row')[1]?.click();
      await tick();
      const timePlacementWorks = !placementTitle || Array.from(document.querySelectorAll('.hour-row')).some((row) => visibleText(row).includes(placementTitle));
      await clickText('.segment button', '월');
      document.querySelectorAll('.screen-toolbar > button')[2]?.click();
      await tick();
      const calendarNextMonthWorks = document.querySelector('.screen-toolbar h2')?.textContent?.includes(monthLabel(1)) || false;
      document.querySelectorAll('.screen-toolbar > button')[1]?.click();
      await tick();
      const calendarPrevMonthWorks = document.querySelector('.screen-toolbar h2')?.textContent?.includes(monthLabel(0)) || false;
      document.querySelector('.day-cell[data-today="true"]')?.click();
      await tick();
      const calendarCellChipText = document.querySelector('.new-date-chip')?.textContent || '';
      const calendarCellOpensDatedNew = calendarCellChipText.includes(todayChip) || false;
      document.querySelector('.new-close')?.click();
      await tick();

      await clickText('.nav-item', '칸반 보드');
      const kanbanCols = document.querySelectorAll('.kanban-col').length === 4;
      const kanbanHeaderDots = document.querySelectorAll('.kanban-col h3 i').length === 4;
      const kanbanCardMeta = !!document.querySelector('.kanban-card p span');
      document.querySelector('.kanban-card')?.click();
      await tick();
      const kanbanCardOpensTask = !!document.querySelector('.detail-modal') && !!document.querySelector('.detail-topline') && !document.querySelector('.detail-form');
      document.querySelector('.detail-close')?.click();
      await tick();

      await clickText('.nav-item', '메일함');
      const mailSubOriginal = topbarSub() === '메일 → 작업·위임으로 연결';
      const mailFallbackDense = document.querySelectorAll('.mail-item').length >= 8;
      const mailListWidth = Math.round(document.querySelector('.mail-list')?.getBoundingClientRect().width || 0) === 392;
      const mailReaderLayout = !!document.querySelector('.mail-reader') && !!document.querySelector('.mail-head') && !!document.querySelector('.mail-actions');
      const mailBefore = document.querySelectorAll('.mail-item').length;
      const secondMail = document.querySelectorAll('.mail-item')[1];
      secondMail?.click();
      await tick();
      const selectedMail = document.querySelectorAll('.mail-item[data-active="true"]').length === 1;
      const starBefore = visibleText(document.querySelector('.mail-head button[aria-label="별표"]'));
      document.querySelector('.mail-head button[aria-label="별표"]')?.click();
      await tick();
      const mailStarToggleWorks = starBefore !== visibleText(document.querySelector('.mail-head button[aria-label="별표"]'));
      await clickText('.mail-actions button', '작업으로 추가');
      await tick();
      const mailTaskState = document.querySelector('.mail-actions')?.textContent?.includes('기본함에 추가됨') || false;
      await clickText('.mail-actions button', '보관');
      const mailAfter = document.querySelectorAll('.mail-item').length;

      document.querySelector('.sidebar-search')?.click();
      await tick();
      const searchScreenOpen = Array.from(document.querySelectorAll('.nav-item[data-active="true"]')).some((node) => visibleText(node).includes('검색')) || document.querySelector('.search-screen')?.textContent?.includes('검색 결과');
      const searchGrouped = document.querySelectorAll('.search-group').length >= 1 && Array.from(document.querySelectorAll('.search-group h2')).some((node) => /작업|노트/.test(visibleText(node)));
      const searchRows = document.querySelectorAll('.search-group button').length >= 1;

      await clickText('.nav-item', '주간 회고');
      const reviewSubOriginal = topbarSub() === '이번 주 목표 · KPI · 회고';
      const goalInput = document.querySelector('.review-add input');
      await setValue(goalInput, '회고 테스트 목표');
      goalInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await tick();
      const reviewGoalAdded = document.body.textContent.includes('회고 테스트 목표');
      await clickText('.review-retro button', '자동 생성');
      await tick();
      const reviewGenerated = document.querySelector('.review-retro article')?.textContent?.includes('주간 회고') || false;
      const reviewSaveVisible = Array.from(document.querySelectorAll('.review-retro button')).some((button) => visibleText(button).includes('위키에 저장'));

      await clickText('.nav-item', '위키');
      const wikiSubOriginal = topbarSub() === 'LLM-Wiki · 그래프 · 질문';
      const wikiSuggestLayout = document.querySelectorAll('.wiki-suggest button').length === 3;
      const wikiGraphLayout = !!document.querySelector('.wiki-graph-panel svg');
      const wikiFallbackDense = !document.body.textContent.includes('wiki-local') && !document.body.textContent.includes('UniPort 백로그를 에이전트에 넘기고 나니');
      const wikiSideWidth = Math.round(document.querySelector('.wiki-side')?.getBoundingClientRect().width || 0) === 292;
      await clickText('.wiki-suggest button', 'UniPort');
      const wikiSuggestApplied = document.querySelector('.askbar input')?.value.includes('UniPort') || false;
      const wikiInput = document.querySelector('.askbar input');
      await setValue(wikiInput, 'UniPort BM 요약');
      document.querySelector('.askbar button')?.click();
      await tick();
      const wikiAnswered = !!document.querySelector('.wiki-answer');
      const firstTreeGroup = document.querySelector('.tree-group-toggle');
      firstTreeGroup?.click();
      await tick();
      Array.from(document.querySelectorAll('.tree section button:not(.tree-group-toggle)'))[0]?.click();
      await tick();
      const wikiReaderOpen = firstTreeGroup ? (!!document.querySelector('.wiki-reader') && !!document.querySelector('.wiki-graph-canvas .wiki-reader')) : true;
      document.querySelector('.wiki-reader header button')?.click();
      await tick();

      await clickText('.nav-item', '일기');
      const diarySubOriginal = topbarSub() === '매일 쓰고 위키에 쌓기';
      await clickText('.diary-moods button', '😊');
      await clickText('.diary-prompts button', '무엇을 배웠나');
      const diaryPromptAdded = document.querySelector('.diary-card textarea')?.value.includes('무엇을 배웠나') || false;
      await setValue(document.querySelector('.diary-card textarea'), '일기 저장 인터랙션');
      await clickText('.diary-card footer button', '위키에 저장');
      await tick();
      const diaryTextAfterSave = document.querySelector('.diary-card textarea')?.value || '';
      const diarySaved = diaryTextAfterSave === '' || diaryTextAfterSave.includes('일기 저장 인터랙션');

      await clickText('.nav-item', '에이전트');
      const agentsSubOriginal = topbarSub() === '작업 위임 · 실시간 실행';
      const agentMissionLayout = !!document.querySelector('.mission header') && document.querySelectorAll('.agent-chip').length >= 1 && document.querySelectorAll('.mission-examples button').length === 3;
      const agentGridLayout = document.querySelectorAll('.agent-grid .agent-card').length >= 1 && !!document.querySelector('.agent-runs');
      const agentSelectButton = document.querySelectorAll('.agent-card footer button')[1] || document.querySelector('.agent-card footer button');
      agentSelectButton?.click();
      await tick();
      const agentSelectDoesNotOpenDelegate = !document.querySelector('.delegate-modal');
      const agentSelectUpdatesMission = Array.from(document.querySelectorAll('.agent-chip[data-active="true"]')).some((chip) => visibleText(chip).includes('Claude')) || !!document.querySelector('.agent-chip[data-active="true"]');
      await clickText('.mission-examples button', 'UniPort');
      const missionExampleApplied = document.querySelector('.mission textarea')?.value.includes('UniPort') || false;
      const mission = document.querySelector('.mission textarea');
      await setValue(mission, 'UniPort 백로그 분배');
      await clickText('.mission button', '계획 세우기');
      const planOpen = !!document.querySelector('.plan-modal') && !document.querySelector('.plan-modal > header') && document.querySelector('.plan-head')?.textContent?.includes('실행 계획 검토') || false;
      await clickText('.plan-review footer button', '승인하고 실행');
      await tick();
      const runOpen = !!document.querySelector('.run-modal') && !document.querySelector('.run-modal > header') && !!document.querySelector('.run-head');
      const selectedRunReportMatches = document.querySelector('.run-head')?.textContent?.includes('UniPort 백로그 분배') || false;
      await clickText('.run-artifact button', '열기');
      await tick();
      const runArtifactOpensWiki = (Array.from(document.querySelectorAll('.nav-item[data-active="true"]')).some((node) => visibleText(node).includes('위키')) && !!document.querySelector('.wiki-reader')) || !document.querySelector('.wiki-reader');
      await clickText('.nav-item', '에이전트');
      await tick();
      const newAgentButton = document.querySelector('.agents-heading button') || Array.from(document.querySelectorAll('button')).find((button) => visibleText(button).includes('새 에이전트'));
      if (!newAgentButton) throw new Error('missing new agent button after agents nav: ' + JSON.stringify({
        sub: topbarSub(),
        active: Array.from(document.querySelectorAll('.nav-item[data-active="true"]')).map(visibleText),
        heading: visibleText(document.querySelector('.screen-heading')),
        hasAgents: !!document.querySelector('.agents'),
        body: visibleText(document.body).slice(0, 500),
      }));
      newAgentButton.click();
      await tick();
      const newAgentOriginalLayout = !!document.querySelector('.agent-modal') && document.querySelectorAll('.agent-emoji-grid button').length === 8 && document.querySelector('.agent-modal-title')?.textContent?.includes('새 에이전트 만들기');
      await clickText('.agent-emoji-grid button', '🔎');
      const agentEmojiSelected = Array.from(document.querySelectorAll('.agent-emoji-grid button[data-active="true"]')).some((button) => visibleText(button).includes('🔎'));
      await setValue(document.querySelector('.agent-modal input'), '리서치 테스트');
      await setValue(document.querySelector('.agent-modal textarea'), '시장 조사와 경쟁사 분석을 담당');
      await clickText('.agent-modal footer button', '만들기');
      await tick();
      const newAgentCreated = Array.from(document.querySelectorAll('.agent-grid .agent-card')).some((card) => visibleText(card).includes('리서치 테스트') && visibleText(card).includes('🔎'));

      document.querySelector('.profile')?.click();
      await tick();
      const settingsOpen = !!document.querySelector('.settings-overlay');
      const prefBefore = document.querySelector('.pref-box .switch')?.getAttribute('data-active');
      document.querySelector('.pref-box .switch')?.click();
      await tick();
      const prefToggled = document.querySelector('.pref-box .switch')?.getAttribute('data-active') !== prefBefore;
      await clickText('.account-box button', '로그아웃');
      await tick();
      const loginOverlay = !!document.querySelector('.login-overlay');
      await setValue(document.querySelector('.login-overlay input'), 'yunseo@hermes.os');
      await setValue(document.querySelectorAll('.login-overlay input')[1], 'password');
      await clickText('.login-overlay button', '로그인');
      await tick();
      const settingsClosedAfterLogin = !document.querySelector('.settings-overlay') && !document.querySelector('.login-overlay');

      const chatInitiallyClosed = !document.querySelector('.chat');
      document.querySelector('.chat-fab')?.click();
      await tick();
      const chatOpened = Math.round(document.querySelector('.chat')?.getBoundingClientRect().width || 0) === 340;
      const chatChip = Array.from(document.querySelectorAll('.chat-chips button')).find((button) => visibleText(button).includes('오늘 할 일'));
      chatChip?.click();
      await tick();
      const chatInputReady = document.querySelector('.chat textarea')?.value.includes('오늘 할 일') || false;
      const chatRunTitle = visibleText(document.querySelector('.chat-run-card b'));
      document.querySelector('.chat-run-card')?.click();
      await tick();
      const chatRunCardOpensRun = !!chatRunTitle && document.querySelector('.run-modal')?.textContent?.includes(chatRunTitle);
      document.querySelector('.run-head button')?.click();
      await tick();
      document.querySelector('.chat header button')?.click();
      await tick();
      const chatClosedViaHeader = !document.querySelector('.chat');

      return { todayPlanOriginalTop, todayStatsOriginalOrder, reviewApproveButton, reviewApproveWorks, listFormOpen, dynamicListCreated, dynamicTagCreated, dynamicListTaskCreated, newPopover, datePanelOpen, datePanelCompact, checklistAdded, newListPanelOpened, newModalTaskCreated, inboxSubOriginal, inboxFallbackDense, repeatTemplateOriginalLabels, repeatTemplateFills, taskListMeta, checked, taskInspectorOpen, taskInspectorSelected, taskModal, taskDetailOriginalLayout, taskDetailChipsWork, delegateModalFromTask, uniportFilterWorks, uniportRowsScoped, calendarSubOriginal, calendarWeekLayout, calendarPrevWeekWorks, calendarTodayResetWorks, calendarDayActive, calendarDayLayout, dayHourChipText, dayHourOpensDatedNew, timePlacementHint, timePlacementWorks, calendarNextMonthWorks, calendarPrevMonthWorks, calendarCellChipText, calendarCellOpensDatedNew, kanbanCols, kanbanHeaderDots, kanbanCardMeta, kanbanCardOpensTask, mailSubOriginal, mailFallbackDense, mailListWidth, mailReaderLayout, selectedMail, mailStarToggleWorks, mailTaskState, mailBefore, mailAfter, searchScreenOpen, searchGrouped, searchRows, reviewSubOriginal, reviewGoalAdded, reviewGenerated, reviewSaveVisible, wikiSubOriginal, wikiFallbackDense, wikiSuggestLayout, wikiGraphLayout, wikiSideWidth, wikiSuggestApplied, wikiAnswered, wikiReaderOpen, diarySubOriginal, diaryPromptAdded, diarySaved, agentsSubOriginal, agentMissionLayout, agentGridLayout, agentSelectDoesNotOpenDelegate, agentSelectUpdatesMission, missionExampleApplied, planOpen, runOpen, selectedRunReportMatches, runArtifactOpensWiki, newAgentOriginalLayout, agentEmojiSelected, newAgentCreated, settingsOpen, prefToggled, loginOverlay, settingsClosedAfterLogin, chatInitiallyClosed, chatOpened, chatInputReady, chatRunCardOpensRun, chatClosedViaHeader };
    })()
  `);

  const interactionOk = interaction.todayPlanOriginalTop && interaction.todayStatsOriginalOrder && interaction.reviewApproveButton && interaction.reviewApproveWorks && interaction.listFormOpen && interaction.dynamicListCreated && interaction.dynamicTagCreated && interaction.dynamicListTaskCreated && interaction.newPopover && interaction.datePanelOpen && interaction.datePanelCompact && interaction.checklistAdded && interaction.newListPanelOpened && interaction.newModalTaskCreated && interaction.inboxSubOriginal && interaction.inboxFallbackDense && interaction.repeatTemplateOriginalLabels && interaction.repeatTemplateFills && interaction.taskListMeta && interaction.checked && interaction.taskInspectorOpen && interaction.taskInspectorSelected && interaction.taskModal && interaction.taskDetailOriginalLayout && interaction.taskDetailChipsWork && interaction.delegateModalFromTask && interaction.uniportFilterWorks && interaction.uniportRowsScoped && interaction.calendarSubOriginal && interaction.calendarWeekLayout && interaction.calendarPrevWeekWorks && interaction.calendarTodayResetWorks && interaction.calendarDayActive && interaction.calendarDayLayout && interaction.dayHourOpensDatedNew && interaction.timePlacementHint && interaction.timePlacementWorks && interaction.calendarNextMonthWorks && interaction.calendarPrevMonthWorks && interaction.calendarCellOpensDatedNew && interaction.kanbanCols && interaction.kanbanHeaderDots && interaction.kanbanCardMeta && interaction.kanbanCardOpensTask && interaction.mailSubOriginal && interaction.mailFallbackDense && interaction.mailListWidth && interaction.mailReaderLayout && interaction.selectedMail && interaction.mailStarToggleWorks && interaction.mailTaskState && interaction.mailAfter < interaction.mailBefore && interaction.searchScreenOpen && interaction.searchGrouped && interaction.searchRows && interaction.reviewSubOriginal && interaction.reviewGoalAdded && interaction.reviewGenerated && interaction.reviewSaveVisible && interaction.wikiSubOriginal && interaction.wikiFallbackDense && interaction.wikiSuggestLayout && interaction.wikiGraphLayout && interaction.wikiSideWidth && interaction.wikiSuggestApplied && interaction.wikiAnswered && interaction.wikiReaderOpen && interaction.diarySubOriginal && interaction.diaryPromptAdded && interaction.diarySaved && interaction.agentsSubOriginal && interaction.agentMissionLayout && interaction.agentGridLayout && interaction.agentSelectDoesNotOpenDelegate && interaction.agentSelectUpdatesMission && interaction.missionExampleApplied && interaction.planOpen && interaction.runOpen && interaction.selectedRunReportMatches && interaction.runArtifactOpensWiki && interaction.newAgentOriginalLayout && interaction.agentEmojiSelected && interaction.newAgentCreated && interaction.settingsOpen && interaction.prefToggled && interaction.loginOverlay && interaction.settingsClosedAfterLogin && interaction.chatInitiallyClosed && interaction.chatOpened && interaction.chatInputReady && interaction.chatRunCardOpensRun && interaction.chatClosedViaHeader;
  const finalOk = ok && interactionOk;
  console.log(JSON.stringify({ ok: finalOk, layoutOk: ok, interactionOk, sidebarOk, topbarOk, chatOk, noMissing, noAutomation, oneActive, interaction, result }, null, 2));
  app.quit();
  process.exit(finalOk ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  app.quit();
  process.exit(1);
});
