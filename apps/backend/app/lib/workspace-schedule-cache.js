'use strict';

const { assertWorkspaceScope } = require('./workspace-scope');

/**
 * Workspace-keyed schedule embedding cache. Keys always include workspaceId first
 * so identical item ids/titles across workspaces cannot collide.
 */
function createWorkspaceScheduleCache({ limit = 500 } = {}) {
  const map = new Map();

  function buildKey(scope, itemId, source, model = '') {
    const valid = assertWorkspaceScope(scope);
    return [
      valid.workspaceId,
      valid.userId,
      String(model || ''),
      String(itemId || ''),
      String(source || ''),
    ].join('\u001f');
  }

  function get(scope, itemId, source, model) {
    return map.get(buildKey(scope, itemId, source, model));
  }

  function set(scope, itemId, source, model, value) {
    const key = buildKey(scope, itemId, source, model);
    map.set(key, value);
    if (map.size > limit) {
      const first = map.keys().next().value;
      if (first) map.delete(first);
    }
    return value;
  }

  function has(scope, itemId, source, model) {
    return map.has(buildKey(scope, itemId, source, model));
  }

  function clear() {
    map.clear();
  }

  return {
    buildKey,
    clear,
    get,
    has,
    set,
    get size() {
      return map.size;
    },
  };
}

module.exports = {
  createWorkspaceScheduleCache,
};
