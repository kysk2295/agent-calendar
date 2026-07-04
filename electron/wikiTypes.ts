export type WikiChunk = {
  id: string;
  path: string;
  folder: string;
  title: string;
  heading: string;
  headingPath: string[];
  text: string;
  lineStart?: number;
  lineEnd?: number;
  tags?: string[];
  updatedAt?: string;
};

export type WikiSearchRequest = {
  query: string;
  limit?: number;
  includeJournal?: boolean;
  includeRaw?: boolean;
  folders?: string[];
};

export type WikiSearchResult = WikiChunk & {
  score: number;
  snippet: string;
};

export type WikiAskRequest = Partial<WikiSearchRequest> & {
  question?: string;
  mode?: 'smart' | 'search' | 'wiki_qa';
};

export type WikiAskResponse = {
  ok: boolean;
  answer: string;
  sources: Array<Pick<WikiSearchResult, 'id' | 'path' | 'title' | 'heading' | 'snippet' | 'score'>>;
  search: {
    query: string;
    results: WikiSearchResult[];
  };
  engine: {
    provider: 'hermes';
    baseUrl: string;
    model?: string;
    agent?: string;
  };
  gatewayFallback: boolean;
};
