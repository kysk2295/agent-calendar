'use strict';

/**
 * EngineAdapter contract for production Runner execution.
 * All adapters: shell:false, fixed argv, no provider secrets in events.
 */

const BANNED_FLAGS = Object.freeze([
  '--yolo',
  '--full-auto',
  '--dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
  '--approval-mode=yolo',
  'bypassPermissions',
]);

function assertSafeArgv(args) {
  for (const arg of args || []) {
    const s = String(arg);
    for (const banned of BANNED_FLAGS) {
      if (s === banned || s.includes(banned)) {
        const error = new Error(`banned launch arg: ${banned}`);
        error.code = 'BANNED_LAUNCH_ARGS';
        throw error;
      }
    }
  }
}

function redactPrivatePaths(value) {
  return String(value || '')
    .replace(/\/(?:Users|home)\/[^/\s"'`]+(?:\/[^\s"'`]*)?/g, '[private-path]')
    .replace(/[A-Za-z]:\\Users\\[^\\\s"'`]+(?:\\[^\s"'`]*)?/g, '[private-path]')
    .replace(/\/(?:private\/)?var\/folders\/[^\s"'`]*/g, '[private-path]');
}

/**
 * @typedef {object} EngineRunInput
 * @property {string} goal
 * @property {string} [cwd]
 * @property {number} [timeoutMs]
 * @property {(event: object) => Promise<void>|void} [onCheckpoint]
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {object} EngineRunResult
 * @property {boolean} ok
 * @property {string} [summary]
 * @property {string} [errorCode]
 * @property {string} [errorMessage]
 * @property {Array<{name:string,content:string,contentType?:string}>} [artifacts]
 */

module.exports = {
  BANNED_FLAGS,
  assertSafeArgv,
  redactPrivatePaths,
};
