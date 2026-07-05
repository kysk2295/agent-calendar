import { app, shell } from 'electron';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';

export type AuthProvider = 'google' | 'password';

export type DesktopAuthProfile = {
  provider: AuthProvider;
  id: string;
  email: string;
  name: string;
  picture?: string;
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  code?: string;
  expiresAt?: string;
  updatedAt: string;
};

type CallbackPayload = Record<string, string>;
type TokenPayload = Record<string, unknown>;
type AuthUser = {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  passwordSalt: string;
  createdAt: string;
  updatedAt: string;
};
type AuthUsersStore = { users: AuthUser[] };

const AUTH_TIMEOUT_MS = 2 * 60 * 1000;
const GOOGLE_FETCH_TIMEOUT_MS = 15 * 1000;
const scryptAsync = promisify(scrypt);

function usersPath() {
  return path.join(app.getPath('userData'), 'auth-users.json');
}

function normalizeEmail(email: unknown) {
  return String(email || '').trim().toLowerCase();
}

function displayNameForEmail(email: string) {
  return email.split('@')[0] || 'Agent Calendar 사용자';
}

async function readUsersStore(): Promise<AuthUsersStore> {
  try {
    const parsed = JSON.parse(await readFile(usersPath(), 'utf8')) as Partial<AuthUsersStore>;
    return { users: Array.isArray(parsed.users) ? parsed.users.filter((user) => user && user.email && user.passwordHash && user.passwordSalt) as AuthUser[] : [] };
  } catch {
    return { users: [] };
  }
}

async function saveUsersStore(store: AuthUsersStore) {
  await mkdir(path.dirname(usersPath()), { recursive: true });
  await writeFile(usersPath(), `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

async function hashPassword(password: string, salt = randomToken(24)) {
  const hash = await scryptAsync(password, salt, 64) as Buffer;
  return { salt, hash: hash.toString('base64') };
}

async function verifyPassword(password: string, salt: string, expectedHash: string) {
  const { hash } = await hashPassword(password, salt);
  const expected = Buffer.from(expectedHash, 'base64');
  const actual = Buffer.from(hash, 'base64');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function validatePasswordAuth(email: string, password: string) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('올바른 이메일 주소를 입력하세요.');
  if (password.length < 8) throw new Error('비밀번호는 8자 이상이어야 합니다.');
}

function passwordProfile(user: AuthUser): DesktopAuthProfile {
  return {
    provider: 'password',
    id: user.id,
    email: user.email,
    name: user.name,
    updatedAt: new Date().toISOString(),
  };
}

function env(...keys: string[]) {
  const localEnv = readLocalEnv();
  for (const key of keys) {
    const value = process.env[key] || localEnv[key];
    if (value) return value;
  }
  return '';
}

function readLocalEnv() {
  const entries: Record<string, string> = {};
  for (const filename of ['.env.local', '.env']) {
    try {
      const raw = readFileSync(path.join(process.cwd(), filename), 'utf8');
      raw.split(/\r?\n/g).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const separator = trimmed.indexOf('=');
        if (separator < 1) return;
        const key = trimmed.slice(0, separator).trim();
        const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
        if (key && value && !entries[key]) entries[key] = value;
      });
    } catch {
      // Optional local env files are only for desktop OAuth client IDs.
    }
  }
  return entries;
}

function authClientId(_provider: AuthProvider) {
  return env('AGENT_CALENDAR_GOOGLE_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_CLIENT_ID', 'VITE_GOOGLE_CLIENT_ID');
}

function authClientSecret(_provider: AuthProvider) {
  return env('AGENT_CALENDAR_GOOGLE_CLIENT_SECRET', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_CLIENT_SECRET', 'VITE_GOOGLE_CLIENT_SECRET');
}

function base64Url(input: Buffer) {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomToken(bytes = 32) {
  return base64Url(randomBytes(bytes));
}

function pkceChallenge(verifier: string) {
  return base64Url(createHash('sha256').update(verifier).digest());
}

function decodeJwt(token: string): Record<string, unknown> {
  const [, payload] = token.split('.');
  if (!payload) return {};
  const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
  const padded = `${normalized}${'='.repeat((4 - normalized.length % 4) % 4)}`;
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>;
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : '';
}

async function readBody(request: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function callbackPage(message: string) {
  return `<!doctype html><meta charset="utf-8"><title>Agent Calendar</title><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f8f5ee;color:#25251f;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:420px;padding:32px;text-align:center}strong{display:block;font-size:20px;margin-bottom:8px}p{color:#746b5f;line-height:1.55}</style><main><strong>${message}</strong><p>Agent Calendar로 돌아가도 됩니다. 이 창은 닫아도 괜찮습니다.</p><script>setTimeout(() => window.close(), 800)</script></main>`;
}

async function createCallbackServer(expectedState: string): Promise<{ redirectUri: string; wait: Promise<CallbackPayload> }> {
  const server = http.createServer();
  const wait = new Promise<CallbackPayload>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error('OAuth 로그인이 시간 초과되었습니다.'));
    }, AUTH_TIMEOUT_MS);

    server.on('request', async (request, response) => {
      try {
        const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
        if (requestUrl.pathname !== '/oauth/callback') {
          response.writeHead(404).end('Not found');
          return;
        }
        let values = new URLSearchParams(requestUrl.search);
        if (request.method === 'POST') {
          values = new URLSearchParams(await readBody(request));
        }
        const result = Object.fromEntries(values.entries());
        if (result.state !== expectedState) throw new Error('OAuth state 검증에 실패했습니다.');
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(callbackPage('로그인이 완료되었습니다.'));
        clearTimeout(timeout);
        server.close();
        resolve(result);
      } catch (error) {
        response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(callbackPage('로그인을 완료하지 못했습니다.'));
        clearTimeout(timeout);
        server.close();
        reject(error);
      }
    });
  });

  const redirectUri = await new Promise<string>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('OAuth 콜백 서버를 시작하지 못했습니다.'));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}/oauth/callback`);
    });
  });
  return { redirectUri, wait };
}

async function openAndWait(authUrl: URL, state: string): Promise<CallbackPayload & { __redirectUri: string }> {
  const callback = await createCallbackServer(state);
  const redirectUri = callback.redirectUri;
  authUrl.searchParams.set('redirect_uri', redirectUri);
  await shell.openExternal(authUrl.toString());
  const payload = await callback.wait;
  return { ...payload, __redirectUri: redirectUri };
}

async function exchangeGoogleCode(clientId: string, code: string, redirectUri: string, verifier: string) {
  const clientSecret = authClientSecret('google');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GOOGLE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      signal: controller.signal,
      body: new URLSearchParams({
        client_id: clientId,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
        code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });
    const payload = await response.json() as TokenPayload;
    if (!response.ok) throw new Error(stringValue(payload.error_description) || 'Google 토큰 교환에 실패했습니다.');
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function loginWithGoogle(): Promise<DesktopAuthProfile> {
  const clientId = authClientId('google');
  if (!clientId) throw new Error('Google OAuth Client ID가 필요합니다. AGENT_CALENDAR_GOOGLE_CLIENT_ID 환경변수를 설정하세요.');
  const state = randomToken(24);
  const verifier = randomToken(48);
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid email profile');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('prompt', 'select_account');
  authUrl.searchParams.set('code_challenge', pkceChallenge(verifier));
  authUrl.searchParams.set('code_challenge_method', 'S256');

  const callback = await openAndWait(authUrl, state);
  if (callback.error) throw new Error(callback.error_description || callback.error);
  if (!callback.code) throw new Error('Google 인증 코드가 비어 있습니다.');
  if (!callback.__redirectUri) throw new Error('Google 리다이렉트 URI를 확인하지 못했습니다.');

  const token = await exchangeGoogleCode(clientId, callback.code, callback.__redirectUri, verifier);
  const accessToken = stringValue(token.access_token);
  const idToken = stringValue(token.id_token);
  const userInfo = decodeJwt(idToken);
  const expiresIn = typeof token.expires_in === 'number' ? token.expires_in : 3600;
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  return {
    provider: 'google',
    id: stringValue(userInfo.sub) || stringValue(decodeJwt(idToken).sub),
    email: stringValue(userInfo.email),
    name: stringValue(userInfo.name) || stringValue(userInfo.email) || 'Google 사용자',
    picture: stringValue(userInfo.picture),
    accessToken,
    refreshToken: stringValue(token.refresh_token),
    idToken,
    expiresAt,
    updatedAt: new Date().toISOString(),
  };
}

export async function startProviderLogin(provider: AuthProvider) {
  if (provider === 'google') return loginWithGoogle();
  throw new Error('지원하지 않는 로그인 제공자입니다.');
}

export async function signUpWithPassword(emailInput: unknown, passwordInput: unknown) {
  const email = normalizeEmail(emailInput);
  const password = String(passwordInput || '');
  validatePasswordAuth(email, password);
  const store = await readUsersStore();
  if (store.users.some((user) => user.email === email)) throw new Error('이미 가입된 이메일입니다. 로그인으로 계속하세요.');
  const now = new Date().toISOString();
  const { salt, hash } = await hashPassword(password);
  const user: AuthUser = {
    id: `password:${randomToken(18)}`,
    email,
    name: displayNameForEmail(email),
    passwordHash: hash,
    passwordSalt: salt,
    createdAt: now,
    updatedAt: now,
  };
  await saveUsersStore({ users: [...store.users, user] });
  return passwordProfile(user);
}

export async function loginWithPassword(emailInput: unknown, passwordInput: unknown) {
  const email = normalizeEmail(emailInput);
  const password = String(passwordInput || '');
  validatePasswordAuth(email, password);
  const store = await readUsersStore();
  const user = store.users.find((entry) => entry.email === email);
  if (!user) throw new Error('가입된 계정을 찾을 수 없습니다.');
  if (!await verifyPassword(password, user.passwordSalt, user.passwordHash)) throw new Error('이메일 또는 비밀번호가 올바르지 않습니다.');
  user.updatedAt = new Date().toISOString();
  await saveUsersStore(store);
  return passwordProfile(user);
}
