const fs = require('node:fs');
const path = require('node:path');

const MODEL_ORDER = ['Codex', 'Claude', 'Grok', 'Local', 'Other'];

function numberFrom(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function modelFamily(model = '') {
  const value = String(model || '').toLowerCase();
  if (value.includes('claude') || value.includes('anthropic')) return 'Claude';
  if (value.includes('grok') || value.includes('xai')) return 'Grok';
  if (value.includes('codex') || value.includes('openai') || value.includes('gpt')) return 'Codex';
  if (value.includes('local')) return 'Local';
  return 'Other';
}

function dayKeyFromDate(date = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return dayKeyFromDate(new Date());
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dayKeys({ now = new Date(), dayCount = 16 } = {}) {
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  return Array.from({ length: dayCount }, (_, index) => {
    const day = new Date(end);
    day.setDate(end.getDate() - (dayCount - 1 - index));
    return dayKeyFromDate(day);
  });
}

function emptyUsageSummary({ now = new Date(), dayCount = 16, sourceStatus = [] } = {}) {
  return {
    totalRuns: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    totalDurationMs: 0,
    averageContextTokens: 0,
    byModel: [],
    dailyTokenCounts: Array.from({ length: dayCount }, () => 0),
    dailyTokenBars: Array.from({ length: dayCount }, () => 0),
    sourceStatus,
    generatedAt: now instanceof Date && !Number.isNaN(now.getTime()) ? now.toISOString() : new Date().toISOString(),
  };
}

function normalizeSummary(summary, { now = new Date(), dayCount = 16 } = {}) {
  const dailyCounts = Array.isArray(summary.dailyTokenCounts)
    ? summary.dailyTokenCounts.slice(-dayCount).map(numberFrom)
    : Array.from({ length: dayCount }, () => 0);
  while (dailyCounts.length < dayCount) dailyCounts.unshift(0);
  const byModelMap = new Map(MODEL_ORDER.map((model) => [model, {
    model,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    runCount: 0,
  }]));
  for (const item of Array.isArray(summary.byModel) ? summary.byModel : []) {
    const family = MODEL_ORDER.includes(item.model) ? item.model : modelFamily(item.model);
    const target = byModelMap.get(family) || byModelMap.get('Other');
    target.inputTokens += numberFrom(item.inputTokens);
    target.outputTokens += numberFrom(item.outputTokens);
    target.totalTokens += numberFrom(item.totalTokens) || numberFrom(item.inputTokens) + numberFrom(item.outputTokens);
    target.runCount += numberFrom(item.runCount);
  }
  const inputTokens = numberFrom(summary.inputTokens) || [...byModelMap.values()].reduce((sum, item) => sum + item.inputTokens, 0);
  const outputTokens = numberFrom(summary.outputTokens) || [...byModelMap.values()].reduce((sum, item) => sum + item.outputTokens, 0);
  const totalTokens = numberFrom(summary.totalTokens) || inputTokens + outputTokens;
  if (totalTokens > 0 && dailyCounts.every((count) => count <= 0)) {
    dailyCounts[dailyCounts.length - 1] = totalTokens;
  }
  const maxDaily = Math.max(...dailyCounts, 1);
  return {
    totalRuns: numberFrom(summary.totalRuns),
    inputTokens,
    outputTokens,
    totalTokens,
    estimatedCostUsd: Math.round(numberFrom(summary.estimatedCostUsd) * 10000) / 10000,
    totalDurationMs: numberFrom(summary.totalDurationMs),
    averageContextTokens: numberFrom(summary.averageContextTokens),
    byModel: [...byModelMap.values()].filter((item) => item.totalTokens > 0 || item.runCount > 0),
    dailyTokenCounts: dailyCounts,
    dailyTokenBars: dailyCounts.map((count) => Math.round((count / maxDaily) * 100)),
    sourceStatus: Array.isArray(summary.sourceStatus) ? summary.sourceStatus : [],
    generatedAt: summary.generatedAt || (now instanceof Date ? now.toISOString() : new Date().toISOString()),
  };
}

function mergeUsageSummaries(summaries = [], options = {}) {
  const dayCount = options.dayCount || 16;
  const merged = emptyUsageSummary({ ...options, dayCount });
  const byModelMap = new Map(MODEL_ORDER.map((model) => [model, {
    model,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    runCount: 0,
  }]));
  for (const raw of summaries.filter(Boolean)) {
    const summary = normalizeSummary(raw, { ...options, dayCount });
    merged.totalRuns += summary.totalRuns;
    merged.inputTokens += summary.inputTokens;
    merged.outputTokens += summary.outputTokens;
    merged.totalTokens += summary.totalTokens;
    merged.estimatedCostUsd += summary.estimatedCostUsd;
    merged.totalDurationMs += summary.totalDurationMs;
    summary.dailyTokenCounts.forEach((count, index) => {
      merged.dailyTokenCounts[index] = numberFrom(merged.dailyTokenCounts[index]) + count;
    });
    merged.sourceStatus.push(...summary.sourceStatus);
    for (const item of summary.byModel) {
      const target = byModelMap.get(item.model) || byModelMap.get('Other');
      target.inputTokens += item.inputTokens;
      target.outputTokens += item.outputTokens;
      target.totalTokens += item.totalTokens;
      target.runCount += item.runCount;
    }
  }
  const contextDenominator = summaries.reduce((sum, summary) => sum + (summary?.averageContextTokens ? 1 : 0), 0);
  merged.averageContextTokens = contextDenominator
    ? Math.round(summaries.reduce((sum, summary) => sum + numberFrom(summary?.averageContextTokens), 0) / contextDenominator)
    : 0;
  merged.estimatedCostUsd = Math.round(merged.estimatedCostUsd * 10000) / 10000;
  merged.byModel = [...byModelMap.values()].filter((item) => item.totalTokens > 0 || item.runCount > 0);
  return normalizeSummary(merged, { ...options, dayCount });
}

function usageFromState(state, { now = new Date(), dayCount = 16 } = {}) {
  const runs = Array.isArray(state?.runs) ? state.runs : [];
  const usageNumber = (usage = {}, keys = []) => keys.reduce((value, key) => value || numberFrom(usage[key]), 0);
  const keys = dayKeys({ now, dayCount });
  const keyToIndex = new Map(keys.map((key, index) => [key, index]));
  const dailyTokenCounts = Array.from({ length: dayCount }, () => 0);
  const byModel = new Map(MODEL_ORDER.map((model) => [model, {
    model,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    runCount: 0,
  }]));
  const runMetrics = runs.map((run) => {
    const usage = run.usage && typeof run.usage === 'object' ? run.usage : {};
    const inputTokens = usageNumber(usage, ['inputTokens', 'promptTokens']);
    const outputTokens = usageNumber(usage, ['outputTokens', 'completionTokens']);
    const totalTokens = usageNumber(usage, ['totalTokens']) || inputTokens + outputTokens;
    return {
      createdAt: run.createdAt || '',
      estimatedCostUsd: numberFrom(usage.estimatedCostUsd),
      inputTokens,
      outputTokens,
      totalTokens,
      contextTokens: usageNumber(usage, ['contextTokens']) || totalTokens,
      durationMs: numberFrom(run.durationMs),
      model: modelFamily(run.model || run.executionBackend?.model || run.runtimeBinding?.model),
    };
  });
  for (const run of runMetrics) {
    const target = byModel.get(run.model) || byModel.get('Other');
    target.inputTokens += run.inputTokens;
    target.outputTokens += run.outputTokens;
    target.totalTokens += run.totalTokens;
    target.runCount += 1;
    const created = run.createdAt ? new Date(run.createdAt) : now;
    const index = keyToIndex.get(dayKeyFromDate(created));
    if (index !== undefined) dailyTokenCounts[index] += run.totalTokens;
  }
  const inputTokens = runMetrics.reduce((sum, run) => sum + run.inputTokens, 0);
  const outputTokens = runMetrics.reduce((sum, run) => sum + run.outputTokens, 0);
  return normalizeSummary({
    totalRuns: runs.length,
    inputTokens,
    outputTokens,
    totalTokens: runMetrics.reduce((sum, run) => sum + run.totalTokens, 0),
    estimatedCostUsd: runMetrics.reduce((sum, run) => sum + run.estimatedCostUsd, 0),
    totalDurationMs: runMetrics.reduce((sum, run) => sum + run.durationMs, 0),
    averageContextTokens: runMetrics.length
      ? Math.round(runMetrics.reduce((sum, run) => sum + run.contextTokens, 0) / runMetrics.length)
      : 0,
    byModel: [...byModel.values()],
    dailyTokenCounts,
    sourceStatus: [{ source: 'hermes-runs', ok: true, runCount: runs.length }],
  }, { now, dayCount });
}

function newestFile(files = []) {
  return files
    .filter((file) => {
      try {
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    })
    .map((file) => ({ file, mtimeMs: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.file || '';
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function addProviderMetric(summary, dayIndex, model, { inputTokens = 0, outputTokens = 0, costUsd = 0, runCount = 0 } = {}) {
  const family = modelFamily(model);
  let item = summary.byModel.find((entry) => entry.model === family);
  if (!item) {
    item = { model: family, inputTokens: 0, outputTokens: 0, totalTokens: 0, runCount: 0 };
    summary.byModel.push(item);
  }
  const input = numberFrom(inputTokens);
  const output = numberFrom(outputTokens);
  item.inputTokens += input;
  item.outputTokens += output;
  item.totalTokens += input + output;
  item.runCount += numberFrom(runCount);
  summary.inputTokens += input;
  summary.outputTokens += output;
  summary.totalTokens += input + output;
  summary.estimatedCostUsd += numberFrom(costUsd);
  summary.totalRuns += numberFrom(runCount);
  if (dayIndex !== undefined && summary.dailyTokenCounts[dayIndex] !== undefined) {
    summary.dailyTokenCounts[dayIndex] += input + output;
  }
}

function readCodexBarUsage({ env = process.env, homeDir = env.HOME || process.env.HOME, now = new Date(), dayCount = 16 } = {}) {
  const cacheDir = String(env.HERMES_USAGE_CACHE_DIR || path.join(homeDir || '', 'Library/Caches/CodexBar/cost-usage'));
  const summary = emptyUsageSummary({ now, dayCount, sourceStatus: [] });
  const keys = dayKeys({ now, dayCount });
  const keyToIndex = new Map(keys.map((key, index) => [key, index]));
  const status = { source: 'codexbar-cost-usage', ok: false, providers: [] };
  if (!cacheDir || !fs.existsSync(cacheDir)) {
    status.reason = 'cache-dir-missing';
    summary.sourceStatus.push(status);
    return normalizeSummary(summary, { now, dayCount });
  }
  const files = fs.readdirSync(cacheDir).map((name) => path.join(cacheDir, name));
  const codexFile = newestFile(files.filter((file) => /codex-v\d+\.json$/i.test(file)));
  const claudeFile = newestFile(files.filter((file) => /claude-v\d+\.json$/i.test(file)));

  if (codexFile) {
    try {
      const data = readJsonFile(codexFile);
      for (const [day, models] of Object.entries(data.days || {})) {
        const dayIndex = keyToIndex.get(day);
        for (const [model, values] of Object.entries(models || {})) {
          if (!Array.isArray(values)) continue;
          addProviderMetric(summary, dayIndex, model, {
            inputTokens: numberFrom(values[0]) + numberFrom(values[1]),
            outputTokens: numberFrom(values[2]),
          });
        }
      }
      const costByDayModel = {};
      for (const fileInfo of Object.values(data.files || {})) {
        for (const [day, models] of Object.entries(fileInfo.codexCostNanos || fileInfo.codexStandardCostNanos || {})) {
          for (const [model, costNanos] of Object.entries(models || {})) {
            const key = `${day}\u0000${modelFamily(model)}`;
            costByDayModel[key] = numberFrom(costByDayModel[key]) + numberFrom(costNanos);
          }
        }
      }
      summary.estimatedCostUsd += Object.values(costByDayModel).reduce((sum, nanos) => sum + nanos / 1_000_000_000, 0);
      status.providers.push('Codex');
    } catch (error) {
      status.codexError = error.message;
    }
  }

  if (claudeFile) {
    try {
      const data = readJsonFile(claudeFile);
      for (const [day, models] of Object.entries(data.days || {})) {
        const dayIndex = keyToIndex.get(day);
        for (const [model, values] of Object.entries(models || {})) {
          if (!Array.isArray(values)) continue;
          addProviderMetric(summary, dayIndex, model, {
            inputTokens: numberFrom(values[0]) + numberFrom(values[1]) + numberFrom(values[2]),
            outputTokens: numberFrom(values[3]),
            costUsd: numberFrom(values[4]) / 1_000_000_000,
            runCount: numberFrom(values[5]),
          });
        }
      }
      status.providers.push('Claude');
    } catch (error) {
      status.claudeError = error.message;
    }
  }

  status.ok = status.providers.length > 0;
  if (!status.ok) status.reason = 'provider-cache-missing';
  summary.sourceStatus.push(status);
  return normalizeSummary(summary, { now, dayCount });
}

function walkFiles(root, { names = new Set(), maxFiles = 5000 } = {}) {
  const results = [];
  const stack = [root];
  while (stack.length && results.length < maxFiles) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (!names.size || names.has(entry.name)) {
        results.push(fullPath);
        if (results.length >= maxFiles) break;
      }
    }
  }
  return results;
}

function readGrokUsage({ env = process.env, homeDir = env.HOME || process.env.HOME, now = new Date(), dayCount = 16 } = {}) {
  const root = String(env.HERMES_GROK_USAGE_ROOT || path.join(homeDir || '', '.grok/sessions'));
  const summary = emptyUsageSummary({ now, dayCount, sourceStatus: [] });
  const keys = dayKeys({ now, dayCount });
  const keyToIndex = new Map(keys.map((key, index) => [key, index]));
  const status = { source: 'grok-sessions', ok: false, providers: [] };
  if (!root || !fs.existsSync(root)) {
    status.reason = 'sessions-dir-missing';
    summary.sourceStatus.push(status);
    return normalizeSummary(summary, { now, dayCount });
  }
  const prompts = new Map();
  const files = walkFiles(root, { names: new Set(['updates.jsonl']), maxFiles: numberFrom(env.HERMES_GROK_USAGE_MAX_FILES) || 5000 });
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    let currentModel = 'grok';
    for (const line of lines) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const model = row.params?.update?._meta?.modelId || row.params?._meta?.modelId || row.params?.update?.modelId || currentModel;
      if (model) currentModel = String(model);
      const meta = row.params?._meta || row._meta || {};
      const totalTokens = numberFrom(meta.totalTokens);
      if (!totalTokens) continue;
      const timestampMs = numberFrom(meta.agentTimestampMs) || numberFrom(row.timestamp) * 1000 || Date.now();
      const day = dayKeyFromDate(new Date(timestampMs));
      if (!keyToIndex.has(day)) continue;
      const promptId = String(meta.promptId || row.params?.update?.prompt_id || `${file}:${day}`);
      const key = `${file}\u0000${promptId}`;
      const existing = prompts.get(key);
      if (!existing || existing.totalTokens < totalTokens) {
        prompts.set(key, { day, model: currentModel || 'grok', totalTokens });
      }
    }
  }
  for (const item of prompts.values()) {
    addProviderMetric(summary, keyToIndex.get(item.day), item.model || 'grok', {
      inputTokens: item.totalTokens,
      outputTokens: 0,
      runCount: 1,
    });
  }
  status.ok = prompts.size > 0;
  status.providers = status.ok ? ['Grok'] : [];
  status.fileCount = files.length;
  status.runCount = prompts.size;
  if (!status.ok) status.reason = 'usage-metadata-missing';
  summary.sourceStatus.push(status);
  return normalizeSummary(summary, { now, dayCount });
}

function readExternalUsageSources(options = {}) {
  return mergeUsageSummaries([
    readCodexBarUsage(options),
    readGrokUsage(options),
  ], options);
}

module.exports = {
  dayKeys,
  mergeUsageSummaries,
  modelFamily,
  readCodexBarUsage,
  readExternalUsageSources,
  readGrokUsage,
  usageFromState,
};
