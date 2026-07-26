import { isKnowledgeItem, knowledgeText } from './primitives';
import type { KnowledgeItem, WikiStreamState } from './types';

export class WikiStreamError extends Error {
  constructor(readonly streamMessage: string) {
    super(streamMessage);
    this.name = 'WikiStreamError';
  }
}

function knowledgeItems(value: unknown): KnowledgeItem[] | undefined {
  if (!Array.isArray(value) || !value.every(isKnowledgeItem)) return undefined;
  return value;
}

export function applyWikiStreamBlock(
  state: WikiStreamState,
  rawBlock: string,
): WikiStreamState {
  const block = rawBlock.replace(/\r\n/g, '\n');
  const lines = block.split('\n');
  const event = lines
    .find((line) => line.startsWith('event:'))
    ?.replace(/^event:\s*/, '')
    .trim() || '';
  const data = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.replace(/^data:\s?/, ''))
    .join('\n')
    .trim();
  if (!data) return state;

  const decoded: unknown = JSON.parse(data);
  if (!isKnowledgeItem(decoded)) return state;
  const sources = knowledgeItems(decoded.sources) || state.sources;
  const run = isKnowledgeItem(decoded.run) ? decoded.run : {};
  const llm = isKnowledgeItem(decoded.llm) ? decoded.llm : {};
  const retrieval = isKnowledgeItem(decoded.retrieval) ? decoded.retrieval : {};
  const hasMetadata = decoded.gatewayFallback !== undefined
    || Boolean(decoded.source)
    || Boolean(run.model)
    || Boolean(decoded.llm)
    || Boolean(decoded.retrieval);
  const meta = hasMetadata
    ? {
      ...state.meta,
      gatewayFallback: decoded.gatewayFallback ?? state.meta.gatewayFallback,
      source: decoded.source || knowledgeText(state.meta.source, 'stream'),
      model: run.model || knowledgeText(state.meta.model, 'wikicurator'),
      agent: knowledgeText(
        llm.agent || run.agent,
        knowledgeText(state.meta.agent, 'wikicurator'),
      ),
      provider: knowledgeText(llm.provider, knowledgeText(state.meta.provider, 'profile')),
      embeddingModel: knowledgeText(
        retrieval.embeddingModel,
        knowledgeText(state.meta.embeddingModel),
      ),
    }
    : state.meta;

  if (decoded.error) throw new WikiStreamError(knowledgeText(decoded.error));
  const streamText = knowledgeText(decoded.text);
  if (event === 'delta' && streamText) {
    return { answer: `${state.answer}${streamText}`, sources, meta };
  }
  if (event === 'done' && streamText) {
    return { answer: streamText, sources, meta };
  }
  return { answer: state.answer, sources, meta };
}
