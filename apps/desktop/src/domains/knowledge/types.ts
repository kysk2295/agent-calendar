export type KnowledgeItem = Record<string, unknown>;
export type KnowledgeEnvelope = Record<string, unknown>;

export type WikiGraphLayoutOptions = {
  readonly centerForce?: number;
  readonly repelForce?: number;
  readonly linkDistance?: number;
};

export type WikiStreamState = {
  readonly answer: string;
  readonly sources: KnowledgeItem[];
  readonly meta: KnowledgeItem;
};
