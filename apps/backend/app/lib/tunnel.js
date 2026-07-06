const { execFileSync: defaultExecFileSync, spawn: defaultSpawn } = require('node:child_process');

function parseCloudflaredUrl(line) {
  const match = String(line || '').match(/https:\/\/[A-Za-z0-9.-]+\.trycloudflare\.com(?:\/[^\s|]*)?/);
  return match ? match[0] : '';
}

function buildTunnelTargetUrl({ targetUrl = '', port = 64369 } = {}) {
  const explicit = String(targetUrl || '').trim();
  if (explicit) return explicit;
  return `http://127.0.0.1:${Number(port) || 64369}`;
}

function checkTunnelBinary({ command = 'cloudflared', execFileSync = defaultExecFileSync } = {}) {
  try {
    const output = execFileSync(command, ['--version'], { encoding: 'utf8' });
    return {
      installed: true,
      command,
      version: String(output || '').trim(),
      installHint: '',
      error: '',
    };
  } catch (error) {
    return {
      installed: false,
      command,
      version: '',
      installHint: 'brew install cloudflared',
      error: error.message || String(error),
    };
  }
}

class RemoteTunnelManager {
  constructor({ spawn = defaultSpawn, clock = () => new Date() } = {}) {
    this.spawn = spawn;
    this.clock = clock;
    this.child = null;
    this.current = {
      state: 'stopped',
      provider: '',
      targetUrl: '',
      publicUrl: '',
      pid: null,
      startedAt: '',
      stoppedAt: '',
      command: '',
      args: [],
      logs: [],
      error: '',
    };
  }

  async start({ provider = 'cloudflare', targetUrl = '', port = 64369, waitMs = 12000 } = {}) {
    if (this.child && ['starting', 'ready'].includes(this.current.state)) {
      return { ...this.status(), alreadyRunning: true };
    }
    if (provider !== 'cloudflare') {
      this.current = {
        ...this.current,
        state: 'error',
        provider,
        error: `Unsupported tunnel provider: ${provider}`,
      };
      return this.status();
    }

    const resolvedTargetUrl = buildTunnelTargetUrl({ targetUrl, port });
    const command = 'cloudflared';
    const args = ['tunnel', '--url', resolvedTargetUrl];
    this.current = {
      state: 'starting',
      provider,
      targetUrl: resolvedTargetUrl,
      publicUrl: '',
      pid: null,
      startedAt: this.clock().toISOString(),
      stoppedAt: '',
      command,
      args,
      logs: [],
      error: '',
    };

    let child;
    try {
      child = this.spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      this.current.state = 'error';
      this.current.error = error.message;
      return this.status();
    }

    this.child = child;
    this.current.pid = child.pid || null;

    return new Promise((resolve) => {
      let resolved = false;
      let timer = null;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolve(this.status());
      };
      const handleData = (chunk) => {
        const lines = String(chunk || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        for (const line of lines) {
          this.#pushLog(line);
          const publicUrl = parseCloudflaredUrl(line);
          if (publicUrl) {
            this.current.publicUrl = publicUrl;
            this.current.state = 'ready';
            finish();
          }
        }
      };
      const handleExit = (code, signal) => {
        if (!['stopped', 'error'].includes(this.current.state)) {
          this.current.state = 'stopped';
          this.current.stoppedAt = this.clock().toISOString();
          if (code !== 0 && code !== null) this.current.error = `Tunnel exited with code ${code}`;
          if (signal) this.current.error = this.current.error || `Tunnel stopped by ${signal}`;
        }
        this.child = null;
        finish();
      };
      const handleError = (error) => {
        this.current.state = 'error';
        this.current.error = error.message;
        this.child = null;
        finish();
      };

      if (child.stdout && child.stdout.on) child.stdout.on('data', handleData);
      if (child.stderr && child.stderr.on) child.stderr.on('data', handleData);
      if (child.on) {
        child.on('exit', handleExit);
        child.on('error', handleError);
      }

      timer = setTimeout(finish, waitMs);
    });
  }

  status() {
    return {
      ...this.current,
      args: [...(this.current.args || [])],
      logs: [...(this.current.logs || [])],
    };
  }

  stop() {
    if (this.child && this.child.kill) {
      this.child.kill('SIGTERM');
    }
    this.child = null;
    this.current.state = 'stopped';
    this.current.stoppedAt = this.clock().toISOString();
    return this.status();
  }

  #pushLog(line) {
    this.current.logs = [...(this.current.logs || []), line].slice(-50);
  }
}

module.exports = {
  RemoteTunnelManager,
  buildTunnelTargetUrl,
  checkTunnelBinary,
  parseCloudflaredUrl,
};
