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
        ? 'The gateway recorded this command because the Workspace Runner is unreachable.'
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
        tool: 'Hermes Runner',
        state: gatewayFallback ? 'down' : status,
        detail: gatewayFallback ? 'runtime unreachable; local gateway fallback only' : run && run.id ? run.id : 'run pending',
      },
      { tool: 'LLM-Wiki', state: 'linked', detail: wikiPath },
    ],
    memory: {
      wikiPath,
      savePolicy: 'chat transcript + run output are resumable from LLM-Wiki',
      next: gatewayFallback
        ? 'Recover the Workspace Runner, then re-run this command from the same chat.'
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
      `${agent}에게 연결했지만 Workspace Runner가 지금 닿지 않아. `,
      `모델은 ${model}, 모드는 ${mode}로 기록했고 `,
      `gateway fallback run으로 임시 기록했어. `,
      `복구 후 이어받기 맥락은 ${wikiPath}에서 확인하게 둘게.`,
    ];
  }
  return [
    `${agent}에게 연결했어. `,
    `모델은 ${model}, 모드는 ${mode}로 잡았고 `,
    `Workspace Runner에 Hermes run을 만들었어. `,
    `결과와 이어받기 맥락은 ${wikiPath}에 묶어둘게.`,
  ];
}

function compactStateSummary(state = {}) {
  return {
    runs: Array.isArray(state.runs) ? state.runs.length : 0,
    tasks: Array.isArray(state.tasks) ? state.tasks.length : 0,
  };
}

function looksLikePrivateRuntimeTranscript(value) {
  return /INTERNAL_PROMPT_SENTINEL|reportSchema|priorMissionEvidence|commandTemplate|rawCommand|(?:^|\s)stdout\s*:|railway-relay job queued/i
    .test(String(value || ''));
}

function buildHermesChatStreamEvents({ command, run } = {}) {
  const deltas = buildHermesChatDeltas({ command, run });
  const agent = resolveOfficialProfileName(command && command.agent ? command.agent : run && run.agent);
  const model = command && command.model ? command.model : run && run.model ? run.model : 'Codex';
  return [
    ...deltas.map((delta) => ({ event: 'delta', data: { text: delta } })),
    {
      event: 'done',
      data: {
        text: deltas.join(''),
        source: run && run.source ? run.source : 'chat',
        gatewayFallback: Boolean(run && run.gatewayFallback),
        runtimeReachable: Boolean(run && run.runtimeReachable),
        agent,
        model,
        status: run && run.status ? run.status : 'completed',
      },
    },
  ];
}

module.exports = {
  buildHermesChatDeltas,
  buildHermesChatStreamEvents,
  buildHermesChatVisualization,
  compactStateSummary,
  looksLikePrivateRuntimeTranscript,
};
