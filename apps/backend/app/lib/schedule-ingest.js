const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

function text(value, fallback = '') {
  return String(value || fallback);
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function weekdayKo(dateKey) {
  const names = ['일', '월', '화', '수', '목', '금', '토'];
  const day = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
  return names[day] || '';
}

function localLlmModel(env = process.env) {
  return text(
    env.AGENT_CALENDAR_LOCAL_LLM_MODEL
    || env.HERMES_LOCAL_LLM_MODEL
    || env.LOCAL_LLM_MODEL
    || env.OLLAMA_MODEL
    || 'qwen2.5:7b',
  ).trim() || 'qwen2.5:7b';
}

function visionLlmModel(env = process.env) {
  return text(
    env.AGENT_CALENDAR_VISION_LLM_MODEL
    || env.HERMES_VISION_LLM_MODEL
    || env.LOCAL_VISION_LLM_MODEL
    || 'qwen2.5vl:7b',
  ).trim() || 'qwen2.5vl:7b';
}

function localLlmUrl(env = process.env) {
  return text(
    env.AGENT_CALENDAR_LOCAL_LLM_URL
    || env.HERMES_LOCAL_LLM_URL
    || env.LOCAL_LLM_URL
    || env.OLLAMA_BASE_URL,
  ).trim().replace(/\/+$/g, '');
}

function localLlmKey(env = process.env) {
  return text(
    env.AGENT_CALENDAR_LOCAL_LLM_API_KEY
    || env.HERMES_LOCAL_LLM_API_KEY
    || env.LOCAL_LLM_API_KEY,
  ).trim();
}

function ocrCliPath(env = process.env) {
  const configured = text(env.AGENT_CALENDAR_OCR_CLI_PATH || env.HERMES_OCR_CLI_PATH).trim();
  if (configured) return configured;
  const root = path.resolve(__dirname, '..', '..');
  const candidates = [
    path.join(root, 'tools/ocr-cli/.build/release/ocr-cli'),
    path.join(root, 'tools/ocr-cli/.build/debug/ocr-cli'),
    path.join(root, 'tools/ocr-cli/.build/arm64-apple-macosx/release/ocr-cli'),
    path.join(root, 'tools/ocr-cli/.build/arm64-apple-macosx/debug/ocr-cli'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function openAiCompatibleBaseUrl(value) {
  const base = text(value).trim().replace(/\/+$/g, '');
  if (!base) return '';
  return /\/v1$/i.test(base) ? base : `${base}/v1`;
}

function isValidIsoDate(value) {
  const raw = text(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const date = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === raw;
}

function normalizeTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const match = text(value).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function extractJsonObject(value) {
  const raw = text(value).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) throw new Error('invalid_json');
    return JSON.parse(raw.slice(start, end + 1));
  }
}

function normalizeOcrResult(payload = {}) {
  const blocks = array(payload.blocks).map((block) => ({
    text: text(block.text).trim(),
    confidence: Number(block.confidence || 0),
    boundingBox: block.boundingBox || null,
  })).filter((block) => block.text);
  return {
    engine: text(payload.engine, 'apple-vision'),
    text: text(payload.text || blocks.map((block) => block.text).join('\n')).trim(),
    blocks,
  };
}

async function runAppleVisionOcr({
  file,
  env = process.env,
  execFileImpl = execFileAsync,
} = {}) {
  if (!file?.buffer?.length) {
    return { engine: 'none', text: '', blocks: [] };
  }
  const ext = path.extname(text(file.filename)).toLowerCase() || '.png';
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-calendar-ocr-'));
  const imagePath = path.join(dir, `image${ext}`);
  try {
    await fsp.writeFile(imagePath, file.buffer);
    const { stdout } = await execFileImpl(ocrCliPath(env), [imagePath], {
      timeout: Number(env.AGENT_CALENDAR_OCR_TIMEOUT_MS || 15_000),
      maxBuffer: 2 * 1024 * 1024,
    });
    return normalizeOcrResult(JSON.parse(text(stdout)));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function buildVisionMessages(file) {
  const imageUrl = `data:${file.contentType || 'image/png'};base64,${file.buffer.toString('base64')}`;
  return [
    {
      role: 'system',
      content: '이미지에 보이는 일정 관련 텍스트만 한국어로 그대로 추출하라. 추측하지 말고 없는 정보는 쓰지 마라.',
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: '일정 등록 후보를 만들기 위한 OCR 텍스트를 추출해줘.' },
        { type: 'image_url', image_url: { url: imageUrl } },
      ],
    },
  ];
}

async function callVisionImageText({ file, env = process.env, fetchImpl = fetch, completionImpl = null }) {
  if (!file?.buffer?.length) return '';
  const baseUrl = openAiCompatibleBaseUrl(localLlmUrl(env));
  if (!baseUrl) {
    if (!completionImpl) return '';
    const content = await completionImpl({
      model: visionLlmModel(env),
      temperature: 0.1,
      messages: buildVisionMessages(file),
    });
    return text(content).trim();
  }
  const headers = { 'content-type': 'application/json' };
  const apiKey = localLlmKey(env);
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const response = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: visionLlmModel(env),
      temperature: 0.1,
      messages: buildVisionMessages(file),
    }),
  });
  if (!response.ok) return '';
  const payload = await response.json();
  return text(payload?.choices?.[0]?.message?.content).trim();
}

function validateDrafts(payload = {}) {
  const warnings = [...array(payload.warnings).map(String)];
  const drafts = [];
  array(payload.drafts).forEach((draft, index) => {
    const title = text(draft.title).trim();
    const date = text(draft.date).trim();
    if (!title || !isValidIsoDate(date)) {
      warnings.push(`${title || `draft ${index + 1}`} 항목은 유효한 ISO 날짜가 없어 제외했습니다.`);
      return;
    }
    drafts.push({
      kind: draft.kind === 'task' ? 'task' : 'event',
      title,
      date,
      start: normalizeTime(draft.start),
      end: normalizeTime(draft.end),
      location: draft.location === undefined ? null : draft.location,
      notes: text(draft.notes).trim(),
      confidence: draft.confidence === 'low' ? 'low' : 'high',
    });
  });
  return { drafts, warnings };
}

function minutes(value) {
  const normalized = normalizeTime(value);
  if (!normalized) return null;
  const [hour, minute] = normalized.split(':').map(Number);
  return hour * 60 + minute;
}

function existingDate(item) {
  const match = text(item.date || item.startDate || item.start || item.day || item.due).match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : '';
}

function existingTime(item) {
  return normalizeTime(item.time || item.t || item.startTime || item.start_time || text(item.start).match(/T(\d{2}:\d{2})/)?.[1]);
}

function existingEndTime(item) {
  return normalizeTime(item.endTime || item.tEnd || item.end_time || text(item.end).match(/T(\d{2}:\d{2})/)?.[1]);
}

function itemId(item, fallback) {
  return text(item.id || item._id || item.key || item.uid || item.sourceId, fallback);
}

function itemTitle(item) {
  return text(item.title || item.name || item.summary || item.subject || item.label, '기록');
}

function detectConflicts(drafts = [], state = {}) {
  const existing = [
    ...array(state.events),
    ...array(state.calendarEvents),
    ...array(state.externalCalendarEvents),
  ];
  const conflicts = [];
  drafts.forEach((draft, draftIndex) => {
    if (draft.kind !== 'event' || !draft.start || !draft.end) return;
    const start = minutes(draft.start);
    const end = minutes(draft.end);
    if (start === null || end === null || end <= start) return;
    existing.forEach((item, index) => {
      if (existingDate(item) !== draft.date) return;
      const existingStart = minutes(existingTime(item));
      const existingEnd = minutes(existingEndTime(item));
      if (existingStart === null || existingEnd === null || existingEnd <= existingStart) return;
      if (start < existingEnd && existingStart < end) {
        conflicts.push({
          draftIndex,
          existing: {
            id: itemId(item, `existing-${index}`),
            title: itemTitle(item),
            date: existingDate(item),
            time: existingTime(item),
            endTime: existingEndTime(item),
          },
        });
      }
    });
  });
  return conflicts;
}

function buildIngestLlmMessages({ textInput, today = todayKey() } = {}) {
  return [
    {
      role: 'system',
      content: [
        '너는 개인 캘린더 입력 추출기다.',
        '반드시 JSON 객체만 출력하라.',
        '이미지/텍스트에 없는 일정을 만들어내지 마라.',
        '불확실한 필드는 null로 두라.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `오늘 날짜: ${today} (${weekdayKo(today)})`,
        '상대 날짜는 오늘 날짜를 기준으로 ISO 날짜로 해석하라.',
        '이미지/텍스트에 없는 일정을 만들어내지 마라.',
        '출력 스키마: {"drafts":[{"kind":"event|task","title":"string","date":"YYYY-MM-DD","start":"HH:MM|null","end":"HH:MM|null","location":null,"notes":"원문: ...","confidence":"high|low"}],"warnings":["string"]}',
        '',
        `입력 텍스트:\n${textInput}`,
      ].join('\n'),
    },
  ];
}

async function callIngestLlm({ textInput, env = process.env, fetchImpl = fetch, completionImpl = null }) {
  const baseUrl = openAiCompatibleBaseUrl(localLlmUrl(env));
  const model = localLlmModel(env);
  const messages = buildIngestLlmMessages({ textInput });
  if (!baseUrl) {
    if (!completionImpl) {
      return {
        drafts: [],
        warnings: ['local LLM URL이 없어 일정 초안을 만들 수 없습니다.'],
        llm: { provider: 'none', used: false },
      };
    }
    const content = text(await completionImpl({
      model,
      temperature: 0.1,
      maxTokens: Number(env.AGENT_CALENDAR_INGEST_LLM_MAX_TOKENS || env.LOCAL_LLM_MAX_TOKENS || 700) || 700,
      messages,
    }));
    if (!content.trim()) {
      return {
        drafts: [],
        warnings: ['relay LLM이 빈 응답을 반환해 일정 초안을 만들 수 없습니다.'],
        llm: { provider: 'local-llm', model, used: false, transport: 'railway-relay' },
      };
    }
    const parsed = extractJsonObject(content);
    return {
      ...parsed,
      llm: { provider: 'local-llm', model, used: true, transport: 'railway-relay' },
    };
  }
  const headers = { 'content-type': 'application/json' };
  const apiKey = localLlmKey(env);
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const response = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      temperature: 0.1,
      messages,
    }),
  });
  if (!response.ok) {
    const body = typeof response.text === 'function' ? await response.text() : '';
    return {
      drafts: [],
      warnings: [`LLM 추출 실패: ${response.status} ${body.slice(0, 120)}`],
      llm: { provider: 'local-llm', model, used: false },
    };
  }
  const payload = await response.json();
  const content = text(payload?.choices?.[0]?.message?.content);
  const parsed = extractJsonObject(content);
  return {
    ...parsed,
    llm: { provider: 'local-llm', model, used: true },
  };
}

async function buildScheduleIngestDrafts({ textInput = '', imageFile = null, state = {}, env = process.env, fetchImpl = fetch, ocrRunner = runAppleVisionOcr, completionImpl = null } = {}) {
  const rawInputText = text(textInput).trim();
  let rawText = rawInputText;
  let ocr = { engine: 'none', text: '', blocks: [] };
  const hasImage = Boolean(imageFile?.buffer?.length);
  if (hasImage) {
    try {
      ocr = normalizeOcrResult(await ocrRunner({ file: imageFile, env }));
    } catch (error) {
      // OCR CLI가 없는 호스트(Railway 등)에서는 비전 폴백이 유일한 경로다.
      ocr = { engine: 'none', text: '', blocks: [] };
    }
    if (ocr.text.replace(/\s+/g, '').length < 10) {
      try {
        const visionText = await callVisionImageText({ file: imageFile, env, fetchImpl, completionImpl });
        if (visionText) {
          ocr = { engine: 'qwen-vl', text: visionText, blocks: ocr.blocks || [] };
        }
      } catch (error) {
        // 비전 폴백 실패 시 OCR 결과(비어 있을 수 있음)로 계속 진행한다.
      }
    }
    rawText = [rawInputText, ocr.text].filter(Boolean).join('\n').trim();
  }
  if (!rawText) {
    return {
      ok: false,
      error: 'text is required',
      drafts: [],
      warnings: [hasImage ? '이미지에서 텍스트를 추출하지 못했습니다.' : '텍스트 입력이 필요합니다.'],
      conflicts: [],
      ingest: { ocrEngine: ocr.engine || 'none', ocrBlocks: ocr.blocks || [] },
      search: { strategy: 'backend-calendar-ai-rag', intent: 'ingest' },
      llm: { provider: 'none', used: false },
    };
  }
  let extraction;
  try {
    extraction = await callIngestLlm({ textInput: rawText, env, fetchImpl, completionImpl });
  } catch (error) {
    extraction = {
      drafts: [],
      warnings: [`LLM JSON 추출 실패: ${error.message || String(error)}`],
      llm: { provider: 'local-llm', model: localLlmModel(env), used: false },
    };
  }
  const validated = validateDrafts(extraction);
  const conflicts = detectConflicts(validated.drafts, state);
  return {
    ok: true,
    drafts: validated.drafts,
    warnings: validated.warnings,
    conflicts,
    ingest: { ocrEngine: hasImage ? (ocr.engine || 'none') : 'none', ocrBlocks: ocr.blocks || [] },
    search: { strategy: 'backend-calendar-ai-rag', intent: 'ingest' },
    llm: extraction.llm || { provider: 'none', used: false },
  };
}

const INGEST_QUESTION_SIGNAL = /(알려|말해|보여|추천|정리해|분석|요약|비교|평가|설명|뭐|무엇|무슨|언제|어디|얼마|몇|어때|어떻게|왜|있(어|나|니|을까|는지)|없(어|나|니|는지)|[?？])/;
const INGEST_COMMAND_VERB = /(잡아|등록|추가|만들어|넣어|생성)\s*(해)?\s*(줘|줘요|주세요|주라|해\s*줘|해줘요|해라|하기)?/;
// 관형형/피동형(이미 존재하는 일정을 가리키는 표현)은 명령이 아니다.
const INGEST_NON_COMMAND_FORM = /(잡아\s*(둔|놓|뒀)|잡혀|등록(된|돼|되어)|추가(된|돼|되어)|만들어\s*(진|둔|놓)|생성(된|돼|되어))/g;

function isScheduleIngestCommand(value = '') {
  const message = text(value).trim();
  if (!message) return false;
  const withoutNonCommandForms = message.replace(INGEST_NON_COMMAND_FORM, ' ');
  if (!INGEST_COMMAND_VERB.test(withoutNonCommandForms)) return false;
  return !INGEST_QUESTION_SIGNAL.test(withoutNonCommandForms);
}

module.exports = {
  buildIngestLlmMessages,
  buildScheduleIngestDrafts,
  detectConflicts,
  isScheduleIngestCommand,
  runAppleVisionOcr,
  validateDrafts,
};
