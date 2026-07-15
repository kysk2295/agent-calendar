export class AgentWorkParseError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`Invalid Agent Work payload: ${field}`);
    this.name = 'AgentWorkParseError';
    this.field = field;
  }
}
