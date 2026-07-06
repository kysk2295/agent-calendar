const { resolveOfficialProfileName } = require('./official-profiles');

function buildHermesChatVisualization({ message, command, run } = {}) {
  const agent = resolveOfficialProfileName(command && command.agent ? command.agent : run && run.agent);
  const model = command && command.model ? command.model : run && run.model ? run.model : 'Codex';
  const mode = command && command.templateId ? command.templateId : 'remote-ops';
  const wikiPath = run && run.file ? run.file : '5_conversation/agent-runs';
  const gatewayFallback = Boolean(run && run.gatewayFallback);
  const status = gatewayFallback ? 'gateway-fallback' : run && run.status ? run.status : 'running';

  return {
    agentState: {
      agent,
      model,
      mode,
      status,
      runId: run && run.id ? run.id : '',
      reason: gatewayFallback
        ? 'Railway recorded this command locally because the Mac mini runtime is unreachable.'
        : command && command.reason ? command.reason : 'Hermes routed this chat message into an agent run.',
    },
    timeline: [
      { label: 'Message received', detail: message || '' },
      { label: 'Agent selected', detail: `${agent} · ${model}` },
      {
        label: gatewayFallback ? 'Gateway fallback recorded' : 'Run created',
        detail: run && run.id ? run.id : 'pending',
      },
      { label: 'Wiki linked', detail: wikiPath },
    ],
    toolActivity: [
      { tool: 'Hermes Router', state: 'done', detail: mode },
      {
        tool: 'Mac mini Hermes',
        state: gatewayFallback ? 'down' : status,
        detail: gatewayFallback ? 'runtime unreachable; local gateway fallback only' : run && run.id ? run.id : 'run pending',
      },
      { tool: 'LLM-Wiki', state: 'linked', detail: wikiPath },
    ],
    memory: {
      wikiPath,
      savePolicy: 'chat transcript + run output are resumable from LLM-Wiki',
      next: gatewayFallback
        ? 'Recover the Mac mini runtime, then re-run this command from the same chat.'
        : 'Continue in the same chat or open Agent Runs for live logs.',
    },
  };
}

function buildHermesChatDeltas({ command, run } = {}) {
  const agent = resolveOfficialProfileName(command && command.agent);
  const model = command && command.model ? command.model : 'Codex';
  const mode = command && command.templateId ? command.templateId : 'remote-ops';
  const wikiPath = run && run.file ? run.file : '5_conversation/agent-runs';
  if (run && run.gatewayFallback) {
    return [
      `${agent}에게 연결했지만 Mac mini 런타임이 지금 닿지 않아. `,
      `모델은 ${model}, 모드는 ${mode}로 기록했고 `,
      `gateway fallback run으로 임시 기록했어. `,
      `복구 후 이어받기 맥락은 ${wikiPath}에서 확인하게 둘게.`,
    ];
  }
  return [
    `${agent}에게 연결했어. `,
    `모델은 ${model}, 모드는 ${mode}로 잡았고 `,
    `맥미니 Hermes run을 만들었어. `,
    `결과와 이어받기 맥락은 ${wikiPath}에 묶어둘게.`,
  ];
}

function compactStateSummary(state = {}) {
  return {
    runs: Array.isArray(state.runs) ? state.runs.length : 0,
    tasks: Array.isArray(state.tasks) ? state.tasks.length : 0,
  };
}

function buildHermesChatStreamEvents({ message, command, run, state } = {}) {
  const visual = buildHermesChatVisualization({ message, command, run });
  const deltas = buildHermesChatDeltas({ command, run });
  const stateSummary = compactStateSummary(state);
  return [
    { event: 'agent-state', data: visual.agentState },
    { event: 'timeline', data: visual.timeline },
    { event: 'tool-activity', data: visual.toolActivity },
    { event: 'memory', data: visual.memory },
    ...deltas.map((delta) => ({ event: 'delta', data: { text: delta } })),
    { event: 'run', data: { run, stateSummary } },
    {
      event: 'done',
      data: {
        text: deltas.join(''),
        visualization: visual,
        run,
        stateSummary,
      },
    },
  ];
}

module.exports = {
  buildHermesChatDeltas,
  buildHermesChatStreamEvents,
  buildHermesChatVisualization,
  compactStateSummary,
};
