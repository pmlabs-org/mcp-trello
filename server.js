import express from 'express';
import { spawn } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '8080');
const AUTH_TOKEN = process.env.TRELLO_MCP_AUTH_TOKEN?.trim();
const OAUTH_CLIENT_ID = process.env.TRELLO_OAUTH_CLIENT_ID?.trim();
const OAUTH_CLIENT_SECRET = process.env.TRELLO_OAUTH_CLIENT_SECRET?.trim();

const authCodes = {};

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Sessions: sessionId -> { proc, pending: Map<id, resolver>, buffer, timer }
const sessions = new Map();
// Each session is a full `node build/index.js` child, so sessions are expensive.
// Without a cap, a client retry storm spawned one child per `initialize` and
// pinned a 2-core droplet (load avg 33, repeated OOM kills, 2026-11-23).
//   SESSION_TTL      idle time before an established session's child is killed
//   UNINIT_TTL       lifetime of a session that never sends a second request
//                    (a client that timed out right after `initialize`)
//   MAX_SESSIONS     hard cap on live children; extras get a fast 503
//   EVICT_MIN_IDLE   a session idle at least this long may be evicted for a new one
const SESSION_TTL = 10 * 60 * 1000;
const UNINIT_TTL = 60 * 1000;
const EVICT_MIN_IDLE = 30 * 1000;
const MAX_SESSIONS = Math.max(1, parseInt(process.env.TRELLO_MCP_MAX_SESSIONS || '12', 10) || 12);

// --- OAuth 2.0 PKCE routes ---
app.get('/.well-known/oauth-protected-resource', (req, res) => {
    const base = `https://${req.headers.host}`;
    res.json({ resource: `${base}/mcp`, authorization_servers: [base] });
});

app.get('/.well-known/oauth-authorization-server', (req, res) => {
    const base = `https://${req.headers.host}`;
    res.json({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/oauth/token`,
        grant_types_supported: ['authorization_code', 'client_credentials'],
        code_challenge_methods_supported: ['S256'],
        response_types_supported: ['code']
    });
});

app.get('/authorize', (req, res) => {
    const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state } = req.query;
    if (client_id !== OAUTH_CLIENT_ID) { res.status(401).json({ error: 'invalid_client' }); return; }
    if (response_type !== 'code') { res.status(400).json({ error: 'unsupported_response_type' }); return; }
    if (!code_challenge) { res.status(400).json({ error: 'code_challenge required' }); return; }
    const code = randomUUID();
    authCodes[code] = { codeChallenge: code_challenge, codeChallengeMethod: code_challenge_method || 'S256', redirectUri: redirect_uri, expiresAt: Date.now() + 5 * 60 * 1000 };
    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set('code', code);
    if (state) redirectUrl.searchParams.set('state', state);
    res.redirect(redirectUrl.toString());
});

app.post('/oauth/token', (req, res) => {
    if (!OAUTH_CLIENT_ID || !AUTH_TOKEN) { res.status(500).json({ error: 'server_misconfigured' }); return; }
    const grant_type = req.body.grant_type;
    if (grant_type === 'authorization_code') {
        if (req.body.client_id !== OAUTH_CLIENT_ID || req.body.client_secret !== OAUTH_CLIENT_SECRET) {
            res.status(401).json({ error: 'invalid_client' }); return;
        }
        const { code, code_verifier, redirect_uri } = req.body;
        const stored = authCodes[code];
        if (!stored || stored.expiresAt < Date.now()) { res.status(400).json({ error: 'invalid_grant' }); return; }
        const expected = createHash('sha256').update(code_verifier).digest('base64url');
        if (expected !== stored.codeChallenge) { res.status(400).json({ error: 'invalid_grant' }); return; }
        if (redirect_uri && redirect_uri !== stored.redirectUri) { res.status(400).json({ error: 'invalid_grant' }); return; }
        delete authCodes[code];
        res.json({ access_token: AUTH_TOKEN, token_type: 'Bearer', expires_in: 2592000 });
        return;
    }
    if (!OAUTH_CLIENT_SECRET) { res.status(500).json({ error: 'server_misconfigured' }); return; }
    let client_id, client_secret;
    const basicAuth = req.headers['authorization'];
    if (basicAuth?.startsWith('Basic ')) {
        const decoded = Buffer.from(basicAuth.slice(6), 'base64').toString();
        const colon = decoded.indexOf(':');
        client_id = decoded.slice(0, colon); client_secret = decoded.slice(colon + 1);
    } else { client_id = req.body.client_id; client_secret = req.body.client_secret; }
    if (client_id !== OAUTH_CLIENT_ID || client_secret !== OAUTH_CLIENT_SECRET) { res.status(401).json({ error: 'invalid_client' }); return; }
    res.json({ access_token: AUTH_TOKEN, token_type: 'Bearer', expires_in: 2592000 });
});

// --- Bearer token middleware ---
app.use((req, res, next) => {
    if (['/health', '/authorize', '/oauth/token'].includes(req.path) || req.path.startsWith('/.well-known/')) return next();
    if (!AUTH_TOKEN) return next();
    const authHeader = req.headers['authorization'];
    if (!authHeader?.startsWith('Bearer ')) {
        res.status(401).set('WWW-Authenticate', `Bearer resource_metadata="https://${req.headers.host}/.well-known/oauth-protected-resource"`).json({ error: 'Unauthorized' });
        return;
    }
    if (authHeader.slice(7) !== AUTH_TOKEN) {
        res.status(401).set('WWW-Authenticate', 'Bearer error="invalid_token"').json({ error: 'Unauthorized' });
        return;
    }
    next();
});

function createSession(sessionId) {
  const bin = join(__dirname, 'build', 'index.js');
  const proc = spawn('node', [bin], {
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  const session = { proc, pending: new Map(), buffer: '', timer: null, lastUsed: Date.now() };

  // A failed spawn or a write to an already-dead child emits 'error' / EPIPE.
  // Unhandled, either one takes down the whole proxy and every live session.
  proc.on('error', () => endSession(sessionId, session, 'Process error'));
  proc.stdin.on('error', () => {});

  proc.stdout.on('data', (chunk) => {
    session.buffer += chunk.toString();
    const lines = session.buffer.split('\n');
    session.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null) {
          const resolver = session.pending.get(String(msg.id));
          if (resolver) {
            session.pending.delete(String(msg.id));
            resolver(msg);
          }
        }
      } catch { /* skip non-JSON stdout */ }
    }
  });

  proc.on('exit', () => endSession(sessionId, session, 'Process exited'));

  // Short lifetime until the client proves it is real by sending a second request.
  resetTTL(sessionId, session, UNINIT_TTL);
  sessions.set(sessionId, session);
  return session;
}

// Single teardown path: stop the timer, drop the session, kill the child if it is
// still running, and fail any requests still waiting on it. Safe to call twice.
function endSession(sessionId, session, reason) {
  if (session.timer) clearTimeout(session.timer);
  session.timer = null;
  if (sessions.get(sessionId) === session) sessions.delete(sessionId);
  if (session.proc.exitCode === null && !session.proc.killed) {
    try { session.proc.kill(); } catch { /* already gone */ }
    // The cap counts table entries, so a child that ignores SIGTERM would keep its
    // memory while its slot is reused. Escalate if it has not exited shortly after.
    const proc = session.proc;
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }, 3000).unref();
  }
  session.pending.forEach(resolve =>
    resolve({ jsonrpc: '2.0', error: { code: -32603, message: reason }, id: null })
  );
  session.pending.clear();
}

function resetTTL(sessionId, session, ms = SESSION_TTL) {
  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(() => endSession(sessionId, session, 'Session expired'), ms);
}

// Make room for one new session. Returns true if a slot is available.
// Evicts the least-recently-used session, but only one that has been idle for at
// least EVICT_MIN_IDLE: never kill a session mid-conversation to admit a newcomer.
// A session with a request still in flight is never a candidate, however old its
// lastUsed stamp is (a slow request can outlast EVICT_MIN_IDLE).
function ensureCapacity() {
  if (sessions.size < MAX_SESSIONS) return true;
  let oldestId = null;
  let oldest = null;
  for (const [id, s] of sessions) {
    if (s.pending.size > 0) continue;
    if (!oldest || s.lastUsed < oldest.lastUsed) { oldestId = id; oldest = s; }
  }
  if (oldest && Date.now() - oldest.lastUsed >= EVICT_MIN_IDLE) {
    console.log(`[SESSION] Evicting idle session ${oldestId} to admit a new one`);
    endSession(oldestId, oldest, 'Session evicted');
    return true;
  }
  return false;
}

function sendRequest(session, message) {
  return new Promise((resolve, reject) => {
    if (session.proc.exitCode !== null || session.proc.killed) {
      reject(new Error('Session process is not running'));
      return;
    }
    const id = message.id ?? randomUUID();
    const msg = { ...message, id };
    const timeout = setTimeout(() => {
      session.pending.delete(String(id));
      reject(new Error('Request timed out'));
    }, 30_000);
    session.pending.set(String(id), (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
    session.proc.stdin.write(JSON.stringify(msg) + '\n');
  });
}

app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  const isInit = req.body?.method === 'initialize';
  let session;
  let activeId = sessionId;

  if (sessionId && sessions.has(sessionId)) {
    // Known active session — reuse.
    session = sessions.get(sessionId);
    session.lastUsed = Date.now();
    resetTTL(sessionId, session);
  } else if (!sessionId && isInit) {
    // Fresh initialize — spawn a new child, unless we are at capacity. Reject fast
    // with 503 + Retry-After so a retrying client backs off instead of piling on.
    if (!ensureCapacity()) {
      console.log(`[SESSION] At capacity (${sessions.size}/${MAX_SESSIONS}), rejecting initialize`);
      return res.status(503).set('Retry-After', '5').json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Server busy: too many active sessions, retry shortly' },
        id: req.body?.id ?? null
      });
    }
    activeId = randomUUID();
    session = createSession(activeId);
    console.log(`[SESSION] New session ${activeId}`);
  } else if (sessionId) {
    // Unknown session id — return 404 per MCP spec. A well-behaved client
    // will reinitialize. Do NOT silently spawn a replacement child — see
    // PM-Labs/mcp-playwright@1d75780 for root-cause analysis.
    return res.status(404).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Session not found' },
      id: req.body?.id ?? null
    });
  } else {
    // No session id and not initialize — malformed.
    return res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
      id: req.body?.id ?? null
    });
  }

  res.setHeader('mcp-session-id', activeId);

  const body = req.body;

  if (body.id == null) {
    session.proc.stdin.write(JSON.stringify(body) + '\n');
    return res.status(202).end();
  }

  try {
    const response = await sendRequest(session, body);
    res.json(response);
  } catch (err) {
    res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: err.message }, id: body.id ?? null });
  }
});

// Client-initiated session end (MCP streamable HTTP). Idempotent: 204 whether or
// not the session still exists, so a client cleaning up after an expiry is not
// shown an error. Behind the same bearer-auth middleware as POST /mcp.
app.delete('/mcp', (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (session) endSession(sessionId, session, 'Session closed by client');
  res.status(204).end();
});

app.get('/health', (_, res) => res.json({ status: 'ok', sessions: sessions.size, max_sessions: MAX_SESSIONS }));

app.listen(PORT, () => console.log(`Trello MCP proxy on :${PORT}`));
