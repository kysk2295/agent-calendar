'use strict';

const { assertWorkspaceScope } = require('./workspace-scope');

/**
 * In-process SSE / event waiter hub keyed by workspaceId + channel.
 * Subscriptions cannot observe another workspace's channels.
 */
function createWorkspaceSseHub() {
  /** @type {Map<string, Set<{ resolve: Function, timer: any }>>} */
  const waiters = new Map();

  function channelKey(scope, channel) {
    const valid = assertWorkspaceScope(scope);
    return `${valid.workspaceId}\u001f${String(channel || '')}`;
  }

  function subscribe(scope, channel, { timeoutMs = 30_000 } = {}) {
    const key = channelKey(scope, channel);
    return new Promise((resolve) => {
      const entry = {
        resolve: (payload) => {
          clearTimeout(entry.timer);
          const set = waiters.get(key);
          if (set) {
            set.delete(entry);
            if (!set.size) waiters.delete(key);
          }
          resolve(payload);
        },
        timer: null,
      };
      entry.timer = setTimeout(() => {
        entry.resolve({ ok: true, events: [], timeout: true, workspaceId: assertWorkspaceScope(scope).workspaceId });
      }, timeoutMs);
      const set = waiters.get(key) || new Set();
      set.add(entry);
      waiters.set(key, set);
    });
  }

  function publish(scope, channel, event) {
    const key = channelKey(scope, channel);
    const set = waiters.get(key);
    if (!set || !set.size) return 0;
    const workspaceId = assertWorkspaceScope(scope).workspaceId;
    const payload = {
      ok: true,
      workspaceId,
      channel: String(channel || ''),
      events: [event],
    };
    let count = 0;
    for (const entry of [...set]) {
      entry.resolve(payload);
      count += 1;
    }
    return count;
  }

  /** Service path: publish by workspace id without a user session scope. */
  function publishWorkspace(workspaceId, channel, event) {
    const ws = String(workspaceId || '').trim();
    if (!ws) return 0;
    const key = `${ws}\u001f${String(channel || '')}`;
    const set = waiters.get(key);
    if (!set || !set.size) return 0;
    const payload = {
      ok: true,
      workspaceId: ws,
      channel: String(channel || ''),
      events: [event],
    };
    let count = 0;
    for (const entry of [...set]) {
      entry.resolve(payload);
      count += 1;
    }
    return count;
  }

  function activeChannels() {
    return [...waiters.keys()];
  }

  return {
    activeChannels,
    publish,
    publishWorkspace,
    subscribe,
  };
}

module.exports = {
  createWorkspaceSseHub,
};
