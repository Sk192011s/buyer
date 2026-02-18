import { exists } from "https://deno.land/std@0.224.0/fs/exists.ts";  

// ─── Environment Variables ───────────────────────────────────────────
const envUUID = Deno.env.get('UUID') || '';
const proxyIPs = (Deno.env.get('PROXYIP') || '').split(',').map(ip => ip.trim()).filter(Boolean);
const credit = Deno.env.get('CREDIT') || '';
const webPassword = Deno.env.get('WEB_PASSWORD') || '';
const wsPath = Deno.env.get('WS_PATH') || '/ws';
const webUsername = Deno.env.get('WEB_USERNAME') || '';
const stickyProxyIPEnv = Deno.env.get('STICKY_PROXYIP') || '';
const CONFIG_FILE = 'config.json';

// ─── Trojan Environment Variables ────────────────────────────────────
const TROJAN_PASSWORD = Deno.env.get('TROJAN_PASSWORD') || '';
const TROJAN_WS_PATH = Deno.env.get('TROJAN_WS_PATH') || '/trojan-ws';

interface Config {
  uuid?: string;
  trojanPassword?: string;
}

// ─── HTML Escape (XSS Prevention) ───────────────────────────────────
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ─── Constant-Time Comparison ────────────────────────────────────────
function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.length !== bufB.length) {
    let dummy = 0;
    for (let i = 0; i < bufA.length; i++) {
      dummy |= bufA[i] ^ (bufB[i % bufB.length] || 0);
    }
    return false;
  }
  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}

// ─── Rate Limiter ────────────────────────────────────────────────────
const MAX_TRACKED_IPS = 10000;
const RATE_LIMIT_WINDOW = 15 * 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const loginAttempts = new Map<string, { count: number; lastAttempt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of loginAttempts) {
    if (now - record.lastAttempt > RATE_LIMIT_WINDOW) {
      loginAttempts.delete(ip);
    }
  }
}, 30 * 60 * 1000);

function pruneRateLimitMap(): void {
  if (loginAttempts.size > MAX_TRACKED_IPS) {
    const entries = Array.from(loginAttempts.entries());
    entries.sort((a, b) => a[1].lastAttempt - b[1].lastAttempt);
    const toRemove = Math.floor(entries.length / 2);
    for (let i = 0; i < toRemove; i++) {
      loginAttempts.delete(entries[i][0]);
    }
  }
}

function isRateLimited(ip: string): boolean {
  pruneRateLimitMap();
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record) {
    loginAttempts.set(ip, { count: 1, lastAttempt: now });
    return false;
  }
  if (now - record.lastAttempt > RATE_LIMIT_WINDOW) {
    loginAttempts.set(ip, { count: 1, lastAttempt: now });
    return false;
  }
  record.count++;
  record.lastAttempt = now;
  return record.count > RATE_LIMIT_MAX_ATTEMPTS;
}

function clearRateLimit(ip: string): void {
  loginAttempts.delete(ip);
}

// ─── Auth Middleware ─────────────────────────────────────────────────
function requireAuth(request: Request): Response | null {
  if (!webPassword) return null;

  const clientIP = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('cf-connecting-ip') || 'unknown';

  if (isRateLimited(clientIP)) {
    return new Response("Too Many Requests. Try again later.", {
      status: 429,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const authHeader = request.headers.get("Authorization") || '';
  const expectedAuth = `Basic ${btoa(`${webUsername}:${webPassword}`)}`;

  if (!constantTimeEqual(authHeader, expectedAuth)) {
    return new Response("Unauthorized", {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Basic realm="Proxy Admin"',
        "Content-Type": "text/plain",
      },
    });
  }

  clearRateLimit(clientIP);
  return null;
}

// ─── UUID Helpers ────────────────────────────────────────────────────
function maskUUID(uuid: string): string {
  if (uuid.length < 8) return '****';
  return uuid.slice(0, 4) + '****-****-****-****-********' + uuid.slice(-4);
}

function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// ─── Trojan Password Helpers ─────────────────────────────────────────
function maskPassword(pw: string): string {
  if (pw.length < 4) return '****';
  return pw.slice(0, 2) + '****' + pw.slice(-2);
}

async function hashTrojanPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-224', data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateTrojanPassword(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const array = new Uint8Array(24);
  crypto.getRandomValues(array);
  return Array.from(array).map(b => chars[b % chars.length]).join('');
}

// ─── Proxy IP Selection ──────────────────────────────────────────────
let fixedProxyIP = '';
if (stickyProxyIPEnv) {
  fixedProxyIP = stickyProxyIPEnv.trim();
  console.log(`Using STICKY_PROXYIP (forced): ${fixedProxyIP}`);
} else if (proxyIPs.length > 0) {
  fixedProxyIP = proxyIPs[Math.floor(Math.random() * proxyIPs.length)];
  console.log(`Selected fixed Proxy IP from list: ${fixedProxyIP}`);
}

function getFixedProxyIP(): string {
  return fixedProxyIP;
}

// ─── Config File ─────────────────────────────────────────────────────
async function getConfigFromFile(): Promise<Config> {
  if (await exists(CONFIG_FILE)) {
    try {
      const configText = await Deno.readTextFile(CONFIG_FILE);
      return JSON.parse(configText) as Config;
    } catch (e) {
      console.warn(`Error reading ${CONFIG_FILE}:`, (e as Error).message);
    }
  }
  return {};
}

async function saveConfig(config: Config): Promise<void> {
  try {
    await Deno.writeTextFile(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log(`Config saved to ${CONFIG_FILE}`);
  } catch (e) {
    console.error(`Failed to save config:`, (e as Error).message);
  }
}

// ─── UUID Initialization ─────────────────────────────────────────────
let userIDs: string[] = [];
if (envUUID) {
  userIDs = envUUID.split(',').map(u => u.trim().toLowerCase()).filter(isValidUUID);
  if (userIDs.length > 0) {
    console.log(`Using UUIDs from environment: ${userIDs.map(maskUUID).join(', ')}`);
  }
}

const savedConfig = await getConfigFromFile();

if (userIDs.length === 0) {
  if (savedConfig.uuid && isValidUUID(savedConfig.uuid)) {
    userIDs.push(savedConfig.uuid.toLowerCase());
    console.log(`Loaded UUID from config: ${maskUUID(savedConfig.uuid)}`);
  } else {
    const newUUID = crypto.randomUUID();
    console.log(`Generated new UUID: ${maskUUID(newUUID)}`);
    savedConfig.uuid = newUUID;
    userIDs.push(newUUID);
  }
}

// ─── Trojan Password Initialization ──────────────────────────────────
let trojanPassword = TROJAN_PASSWORD;
if (!trojanPassword) {
  if (savedConfig.trojanPassword) {
    trojanPassword = savedConfig.trojanPassword;
    console.log(`Loaded Trojan password from config: ${maskPassword(trojanPassword)}`);
  } else {
    trojanPassword = generateTrojanPassword();
    console.log(`Generated new Trojan password: ${maskPassword(trojanPassword)}`);
    savedConfig.trojanPassword = trojanPassword;
  }
}

// Save config with both UUID and Trojan password
await saveConfig(savedConfig);

// Pre-compute Trojan password hash
let trojanPasswordHash = '';
(async () => {
  trojanPasswordHash = await hashTrojanPassword(trojanPassword);
  console.log(`Trojan password hash computed`);
})();

if (userIDs.length === 0) {
  throw new Error('No valid UUID available');
}

const primaryUserID = userIDs[0];
console.log(Deno.version);
console.log(`UUIDs in use: ${userIDs.map(maskUUID).join(', ')}`);
console.log(`Trojan password: ${maskPassword(trojanPassword)}`);
console.log(`VLESS WebSocket path: ${wsPath}`);
console.log(`Trojan WebSocket path: ${TROJAN_WS_PATH}`);
console.log(`Fixed Proxy IP: ${fixedProxyIP || '(none — direct connection)'}`);

// ─── Connection Tracking & Graceful Shutdown ─────────────────────────
const activeConnections = new Set<Deno.TcpConn>();
const CONNECTION_TIMEOUT = 10000;

function trackConnection(conn: Deno.TcpConn): void {
  activeConnections.add(conn);
}

function untrackConnection(conn: Deno.TcpConn): void {
  activeConnections.delete(conn);
}

try {
  Deno.addSignalListener("SIGINT", () => {
    console.log("SIGINT received, shutting down...");
    for (const conn of activeConnections) {
      try { conn.close(); } catch (_) { /* ignore */ }
    }
    Deno.exit(0);
  });
} catch (_) {
  // Signal listeners may not be available on all platforms
}

// ─── Trojan Link Generator ──────────────────────────────────────────
function generateTrojanLink(hostname: string, port: string | number, tag: string): string {
  return `trojan://${trojanPassword}@${hostname}:${port}?security=tls&sni=${hostname}&type=ws&host=${hostname}&path=${encodeURIComponent(TROJAN_WS_PATH + '?ed=2048')}#${tag}`;
}

// ─── HTML Template ───────────────────────────────────────────────────
const getHtml = (title: string, bodyContent: string) => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
    <style>
        :root {
            --bg-color: #0f172a;
            --card-bg: rgba(30, 41, 59, 0.7);
            --primary: #3b82f6;
            --primary-hover: #2563eb;
            --text-main: #f8fafc;
            --text-sub: #94a3b8;
            --border: rgba(148, 163, 184, 0.1);
            --trojan-color: #f59e0b;
            --vless-color: #3b82f6;
        }
        body {
            font-family: 'Inter', system-ui, -apple-system, sans-serif;
            background-color: var(--bg-color);
            background-image: 
                radial-gradient(at 0% 0%, rgba(59, 130, 246, 0.15) 0px, transparent 50%),
                radial-gradient(at 100% 100%, rgba(139, 92, 246, 0.15) 0px, transparent 50%);
            color: var(--text-main);
            min-height: 100vh;
            margin: 0;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 20px;
        }
        .container {
            background: var(--card-bg);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            border: 1px solid var(--border);
            padding: 40px;
            border-radius: 24px;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
            max-width: 750px;
            width: 100%;
            text-align: center;
            animation: fadeIn 0.6s ease-out;
        }
        h1 {
            font-size: 2.5rem;
            font-weight: 800;
            background: linear-gradient(to right, #60a5fa, #a78bfa);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 1rem;
            margin-top: 0;
        }
        p {
            color: var(--text-sub);
            font-size: 1.1rem;
            line-height: 1.6;
            margin-bottom: 2rem;
        }
        .btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            background: var(--primary);
            color: white;
            padding: 12px 30px;
            border-radius: 12px;
            text-decoration: none;
            font-weight: 600;
            transition: all 0.2s;
            box-shadow: 0 4px 6px -1px rgba(59, 130, 246, 0.5);
            border: none;
            cursor: pointer;
            font-size: 1rem;
            margin: 5px;
        }
        .btn:hover {
            background: var(--primary-hover);
            transform: translateY(-2px);
            box-shadow: 0 10px 15px -3px rgba(59, 130, 246, 0.5);
        }
        .config-box {
            background: rgba(15, 23, 42, 0.6);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 20px;
            margin-top: 20px;
            text-align: left;
            position: relative;
        }
        .config-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }
        .config-title {
            font-weight: 700;
            color: #e2e8f0;
            font-size: 0.9rem;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }
        .config-title.vless { color: var(--vless-color); }
        .config-title.trojan { color: var(--trojan-color); }
        pre {
            margin: 0;
            white-space: pre-wrap;
            word-break: break-all;
            font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
            font-size: 0.85rem;
            color: #94a3b8;
            max-height: 150px;
            overflow-y: auto;
            padding-right: 10px;
        }
        pre::-webkit-scrollbar { width: 6px; }
        pre::-webkit-scrollbar-track { background: transparent; }
        pre::-webkit-scrollbar-thumb { background: #334155; border-radius: 3px; }
        .copy-btn {
            background: rgba(59, 130, 246, 0.1);
            color: #60a5fa;
            border: 1px solid rgba(59, 130, 246, 0.2);
            padding: 6px 12px;
            border-radius: 6px;
            font-size: 0.8rem;
            cursor: pointer;
            transition: all 0.2s;
        }
        .copy-btn:hover { background: rgba(59, 130, 246, 0.2); }
        .user-section {
            border-top: 1px solid var(--border);
            margin-top: 30px;
            padding-top: 20px;
        }
        .user-label {
            display: inline-block;
            background: rgba(59, 130, 246, 0.1);
            color: #60a5fa;
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 0.8rem;
            font-weight: 600;
            margin-bottom: 10px;
        }
        .protocol-badge {
            display: inline-block;
            padding: 3px 10px;
            border-radius: 12px;
            font-size: 0.7rem;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }
        .protocol-badge.vless {
            background: rgba(59, 130, 246, 0.15);
            color: #60a5fa;
            border: 1px solid rgba(59, 130, 246, 0.3);
        }
        .protocol-badge.trojan {
            background: rgba(245, 158, 11, 0.15);
            color: #f59e0b;
            border: 1px solid rgba(245, 158, 11, 0.3);
        }
        .section-divider {
            border: none;
            border-top: 1px dashed rgba(148, 163, 184, 0.2);
            margin: 30px 0;
        }
        .footer {
            margin-top: 40px;
            font-size: 0.85rem;
            color: #475569;
        }
        .footer a {
            color: #64748b;
            text-decoration: none;
            transition: color 0.2s;
        }
        .footer a:hover { color: #94a3b8; }
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .countdown {
            display: flex;
            justify-content: center;
            gap: 20px;
            margin: 30px 0;
        }
        .countdown-item {
            background: rgba(15, 23, 42, 0.6);
            border: 1px solid var(--border);
            border-radius: 16px;
            padding: 20px 24px;
            min-width: 80px;
        }
        .countdown-number {
            font-size: 2.2rem;
            font-weight: 800;
            background: linear-gradient(to bottom, #60a5fa, #a78bfa);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            line-height: 1;
        }
        .countdown-label {
            font-size: 0.75rem;
            color: #64748b;
            text-transform: uppercase;
            letter-spacing: 0.1em;
            margin-top: 8px;
        }
        .progress-bar {
            background: rgba(15, 23, 42, 0.6);
            border-radius: 10px;
            height: 6px;
            margin: 30px 0;
            overflow: hidden;
        }
        .progress-fill {
            height: 100%;
            border-radius: 10px;
            background: linear-gradient(to right, #3b82f6, #a78bfa);
            animation: progressAnim 3s ease-in-out infinite;
            width: 65%;
        }
        @keyframes progressAnim {
            0% { width: 55%; }
            50% { width: 75%; }
            100% { width: 55%; }
        }
        .feature-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 16px;
            margin: 30px 0;
        }
        .feature-item {
            background: rgba(15, 23, 42, 0.4);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 20px 12px;
        }
        .feature-icon { font-size: 1.8rem; margin-bottom: 8px; }
        .feature-name { font-size: 0.85rem; color: #94a3b8; font-weight: 500; }
        @media (max-width: 600px) {
            .container { padding: 28px 20px; }
            h1 { font-size: 1.8rem; }
            .countdown { gap: 10px; }
            .countdown-item { padding: 14px 16px; min-width: 60px; }
            .countdown-number { font-size: 1.6rem; }
            .feature-grid { grid-template-columns: repeat(3, 1fr); gap: 10px; }
            .feature-item { padding: 14px 8px; }
        }
    </style>
</head>
<body>
    <div class="container">
        ${bodyContent}
    </div>
    <script>
        function copyToClipboard(elementId, btn) {
            const text = document.getElementById(elementId).innerText;
            navigator.clipboard.writeText(text).then(() => {
                const originalText = btn.innerText;
                btn.innerText = 'Copied!';
                btn.style.background = 'rgba(34, 197, 94, 0.1)';
                btn.style.color = '#4ade80';
                btn.style.borderColor = 'rgba(34, 197, 94, 0.2)';
                setTimeout(() => {
                    btn.innerText = originalText;
                    btn.style = '';
                }, 2000);
            }).catch(err => {
                console.error('Failed to copy', err);
            });
        }
    </script>
</body>
</html>
`;

// ─── Connection with Timeout ─────────────────────────────────────────
async function connectWithTimeout(hostname: string, port: number, timeout: number): Promise<Deno.TcpConn> {
  let timeoutId: number;
  const connPromise = Deno.connect({ hostname, port });
  const timer = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`Connection to ${hostname}:${port} timed out after ${timeout}ms`)),
      timeout
    );
  });
  try {
    const result = await Promise.race([connPromise, timer]);
    clearTimeout(timeoutId!);
    return result;
  } catch (e) {
    clearTimeout(timeoutId!);
    connPromise.then(c => { try { c.close(); } catch (_) { /* ignore */ } }).catch(() => {});
    throw e;
  }
}

// ─── Main Server ─────────────────────────────────────────────────────
Deno.serve(async (request: Request) => {
  const upgrade = request.headers.get('upgrade') || '';
  if (upgrade.toLowerCase() === 'websocket') {
    const url = new URL(request.url);
    
    // VLESS WebSocket
    if (url.pathname === wsPath) {
      return await vlessOverWSHandler(request);
    }
    // Trojan WebSocket
    if (url.pathname === TROJAN_WS_PATH) {
      return await trojanOverWSHandler(request);
    }
    
    return new Response('Not Found', { status: 404 });
  }

  const url = new URL(request.url);

  // ── Health ──
  if (url.pathname === '/health') {
    return new Response(JSON.stringify({
      status: 'ok',
      protocols: ['vless', 'trojan'],
      timestamp: new Date().toISOString(),
    }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── Protected routes ──
  if (url.pathname === '/sub' || url.pathname === '/config') {
    const authResponse = requireAuth(request);
    if (authResponse) return authResponse;
  }

  if (url.pathname === '/sub') {
    const hostName = url.hostname;
    const port = url.port || (url.protocol === 'https:' ? 443 : 80);
    
    // VLESS links
    const vlessLinks = userIDs.map((uid, index) => {
      const tag = credit ? `${credit}-VLESS-${index + 1}` : `${hostName}-VLESS-${index + 1}`;
      return `vless://${uid}@${hostName}:${port}?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=${encodeURIComponent(wsPath + '?ed=2048')}#${tag}`;
    });
    
    // Trojan link
    const trojanTag = credit ? `${credit}-Trojan` : `${hostName}-Trojan`;
    const trojanLink = generateTrojanLink(hostName, port, trojanTag);
    
    const allLinks = [...vlessLinks, trojanLink].join('\n');
    const base64Content = btoa(allLinks);
    
    return new Response(base64Content, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Profile-Update-Interval': '12',
        'Subscription-Userinfo': 'upload=0; download=0; total=10737418240; expire=0',
      },
    });
  }

  switch (url.pathname) {
    case '/': {
      const content = `
          <h1>NovaByte Cloud</h1>
          <p>We're crafting a next-generation cloud platform.<br>Something amazing is on the way.</p>
          
          <div class="countdown" id="countdown">
              <div class="countdown-item">
                  <div class="countdown-number" id="days">00</div>
                  <div class="countdown-label">Days</div>
              </div>
              <div class="countdown-item">
                  <div class="countdown-number" id="hours">00</div>
                  <div class="countdown-label">Hours</div>
              </div>
              <div class="countdown-item">
                  <div class="countdown-number" id="minutes">00</div>
                  <div class="countdown-label">Minutes</div>
              </div>
              <div class="countdown-item">
                  <div class="countdown-number" id="seconds">00</div>
                  <div class="countdown-label">Seconds</div>
              </div>
          </div>

          <div class="progress-bar">
              <div class="progress-fill"></div>
          </div>

          <div class="feature-grid">
              <div class="feature-item">
                  <div class="feature-icon">⚡</div>
                  <div class="feature-name">Lightning Fast</div>
              </div>
              <div class="feature-item">
                  <div class="feature-icon">🔒</div>
                  <div class="feature-name">Secure</div>
              </div>
              <div class="feature-item">
                  <div class="feature-icon">🌍</div>
                  <div class="feature-name">Global CDN</div>
              </div>
          </div>

          <div class="footer">
              <p>&copy; 2026 NovaByte Cloud Inc. All rights reserved.</p>
          </div>

          <script>
              const launchDate = new Date();
              launchDate.setDate(launchDate.getDate() + 90);
              
              function updateCountdown() {
                  const now = new Date();
                  const diff = launchDate - now;
                  const d = Math.floor(diff / (1000 * 60 * 60 * 24));
                  const h = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
                  const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
                  const s = Math.floor((diff % (1000 * 60)) / 1000);
                  document.getElementById('days').textContent = String(d).padStart(2, '0');
                  document.getElementById('hours').textContent = String(h).padStart(2, '0');
                  document.getElementById('minutes').textContent = String(m).padStart(2, '0');
                  document.getElementById('seconds').textContent = String(s).padStart(2, '0');
              }
              updateCountdown();
              setInterval(updateCountdown, 1000);
          </script>
      `;
      return new Response(getHtml('NovaByte Cloud - Coming Soon', content), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    case '/config': {
      const hostName = url.hostname;
      const port = url.port || (url.protocol === 'https:' ? 443 : 80);
      let userSections = '';

      // ── VLESS Configs ──
      userIDs.forEach((uid, index) => {
        const rawTag = credit ? `${credit}-VLESS-${index + 1}` : `${hostName}-VLESS-${index + 1}`;

        const vlessLink = `vless://${uid}@${hostName}:${port}?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=${encodeURIComponent(wsPath + '?ed=2048')}#${rawTag}`;

        const clashVless = `
- type: vless
  name: ${rawTag}
  server: ${hostName}
  port: ${port}
  uuid: ${uid}
  network: ws
  tls: true
  udp: false
  sni: ${hostName}
  client-fingerprint: chrome
  ws-opts:
    path: "${wsPath}?ed=2048"
    headers:
      host: ${hostName}`;

        userSections += `
          <div class="${index > 0 ? 'user-section' : ''}">
              <span class="user-label">VLESS User ${index + 1}</span>
              <span class="protocol-badge vless">VLESS</span>
              <div class="config-box">
                  <div class="config-header">
                      <span class="config-title vless">VLESS URI (V2RayNG / Hiddify)</span>
                      <button class="copy-btn" onclick="copyToClipboard('vless-uri-${index}', this)">Copy</button>
                  </div>
                  <pre id="vless-uri-${index}">${escapeHtml(vlessLink)}</pre>
              </div>
              <div class="config-box">
                  <div class="config-header">
                      <span class="config-title vless">Clash Meta YAML</span>
                      <button class="copy-btn" onclick="copyToClipboard('clash-vless-${index}', this)">Copy</button>
                  </div>
                  <pre id="clash-vless-${index}">${escapeHtml(clashVless.trim())}</pre>
              </div>
          </div>
        `;
      });

      // ── Trojan Config ──
      const trojanTag = credit ? `${credit}-Trojan` : `${hostName}-Trojan`;
      const trojanLink = generateTrojanLink(hostName, port, trojanTag);

      const clashTrojan = `
- type: trojan
  name: ${trojanTag}
  server: ${hostName}
  port: ${port}
  password: ${trojanPassword}
  network: ws
  tls: true
  udp: false
  sni: ${hostName}
  ws-opts:
    path: "${TROJAN_WS_PATH}?ed=2048"
    headers:
      host: ${hostName}`;

      userSections += `
        <hr class="section-divider">
        <div>
            <span class="user-label">Trojan</span>
            <span class="protocol-badge trojan">TROJAN</span>
            <div class="config-box">
                <div class="config-header">
                    <span class="config-title trojan">Trojan URI (V2RayNG / Hiddify / Shadowrocket)</span>
                    <button class="copy-btn" onclick="copyToClipboard('trojan-uri', this)">Copy</button>
                </div>
                <pre id="trojan-uri">${escapeHtml(trojanLink)}</pre>
            </div>
            <div class="config-box">
                <div class="config-header">
                    <span class="config-title trojan">Clash Meta YAML</span>
                    <button class="copy-btn" onclick="copyToClipboard('clash-trojan', this)">Copy</button>
                </div>
                <pre id="clash-trojan">${escapeHtml(clashTrojan.trim())}</pre>
            </div>
        </div>
      `;

      const safeHostForSub = escapeHtml(url.hostname);
      const content = `
          <h1>Server Configuration</h1>
          <p>Multi-protocol proxy — VLESS + Trojan over WebSocket</p>
          ${userSections}
          <div class="config-box" style="margin-top: 30px;">
              <div class="config-header">
                  <span class="config-title">Subscription URL (VLESS + Trojan)</span>
                  <button class="copy-btn" onclick="copyToClipboard('sub-url', this)">Copy</button>
              </div>
              <pre id="sub-url">https://${safeHostForSub}/sub</pre>
          </div>
          <div class="footer">
              <a href="/">Back to Home</a>
          </div>
      `;
      return new Response(getHtml('VLESS + Trojan Config', content), {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    default:
      return new Response(getHtml('404', '<h1>404 Not Found</h1><p>The path you requested does not exist.</p><a href="/" class="btn">Go Home</a>'), {
        status: 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
  }
});

// ─── VLESS over WebSocket Handler ────────────────────────────────────
async function vlessOverWSHandler(request: Request) {
  const { socket, response } = Deno.upgradeWebSocket(request);

  let address = '';
  let portWithRandomLog = '';
  const log = (info: string, event = '') => {
    console.log(`[VLESS][${address}:${portWithRandomLog}] ${info}`, event);
  };

  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableWebSocketStream = makeReadableWebSocketStream(socket, earlyDataHeader, log);

  const remoteSocketWrapper: { value: Deno.TcpConn | null } = { value: null };
  let udpStreamWrite: ((chunk: Uint8Array) => void) | null = null;
  let isDns = false;

  readableWebSocketStream
    .pipeTo(
      new WritableStream({
        async write(chunk, controller) {
          if (isDns && udpStreamWrite) {
            return udpStreamWrite(chunk);
          }
          if (remoteSocketWrapper.value) {
            const writer = remoteSocketWrapper.value.writable.getWriter();
            try {
              await writer.write(new Uint8Array(chunk));
            } finally {
              writer.releaseLock();
            }
            return;
          }

          const {
            hasError,
            message,
            portRemote = 443,
            addressRemote = '',
            rawDataIndex,
            vlessVersion = new Uint8Array([0, 0]),
            isUDP,
          } = processVlessHeader(chunk, userIDs);

          address = addressRemote;
          portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? 'udp ' : 'tcp '} `;

          if (hasError) {
            throw new Error(message);
          }

          if (isUDP) {
            if (portRemote === 53) {
              isDns = true;
            } else {
              throw new Error('UDP proxy only enabled for DNS which is port 53');
            }
          }

          const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
          const rawClientData = chunk.slice(rawDataIndex);

          if (isDns) {
            const { write } = await handleUDPOutBound(socket, vlessResponseHeader, log);
            udpStreamWrite = write;
            udpStreamWrite(rawClientData);
            return;
          }

          handleTCPOutBound(
            remoteSocketWrapper,
            addressRemote,
            portRemote,
            rawClientData,
            socket,
            vlessResponseHeader,
            log
          );
        },
        close() {
          log(`readableWebSocketStream is closed`);
          safeCloseRemote(remoteSocketWrapper.value);
        },
        abort(reason) {
          log(`readableWebSocketStream is aborted`, JSON.stringify(reason));
          safeCloseRemote(remoteSocketWrapper.value);
        },
      })
    )
    .catch((err) => {
      log('readableWebSocketStream pipeTo error', err);
      safeCloseRemote(remoteSocketWrapper.value);
      safeCloseWebSocket(socket);
    });

  return response;
}

// ─── Trojan over WebSocket Handler ───────────────────────────────────
async function trojanOverWSHandler(request: Request) {
  const { socket, response } = Deno.upgradeWebSocket(request);

  let address = '';
  let portLog = '';
  const log = (info: string, event = '') => {
    console.log(`[Trojan][${address}:${portLog}] ${info}`, event);
  };

  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableStream = makeReadableWebSocketStream(socket, earlyDataHeader, log);
  const remoteSocketWrapper: { value: Deno.TcpConn | null } = { value: null };
  let udpStreamWrite: ((chunk: Uint8Array) => void) | null = null;
  let isDns = false;
  let headerProcessed = false;

  readableStream
    .pipeTo(
      new WritableStream({
        async write(chunk, controller) {
          if (isDns && udpStreamWrite) {
            return udpStreamWrite(chunk);
          }
          if (remoteSocketWrapper.value && headerProcessed) {
            const writer = remoteSocketWrapper.value.writable.getWriter();
            try {
              await writer.write(new Uint8Array(chunk));
            } finally {
              writer.releaseLock();
            }
            return;
          }

          // Process Trojan header
          const result = await processTrojanHeader(chunk, trojanPasswordHash);
          if (result.hasError) {
            throw new Error(result.message);
          }

          headerProcessed = true;
          const { addressRemote, portRemote, rawDataIndex, isUDP } = result;
          address = addressRemote!;
          portLog = `${portRemote}--${Math.random()} ${isUDP ? 'udp' : 'tcp'}`;

          if (isUDP) {
            if (portRemote === 53) {
              isDns = true;
            } else {
              throw new Error('UDP proxy only enabled for DNS port 53');
            }
          }

          const rawClientData = new Uint8Array(chunk.slice(rawDataIndex!));

          // Trojan has no response header
          const emptyHeader = new Uint8Array(0);

          if (isDns) {
            const { write } = await handleUDPOutBound(socket, emptyHeader, log);
            udpStreamWrite = write;
            udpStreamWrite(rawClientData);
            return;
          }

          handleTCPOutBound(
            remoteSocketWrapper,
            addressRemote!,
            portRemote!,
            rawClientData,
            socket,
            emptyHeader,
            log
          );
        },
        close() {
          log(`readableWebSocketStream closed`);
          safeCloseRemote(remoteSocketWrapper.value);
        },
        abort(reason) {
          log(`readableWebSocketStream aborted`, JSON.stringify(reason));
          safeCloseRemote(remoteSocketWrapper.value);
        },
      })
    )
    .catch((err) => {
      log('pipeTo error', String(err));
      safeCloseRemote(remoteSocketWrapper.value);
      safeCloseWebSocket(socket);
    });

  return response;
}

// ─── Trojan Header Parser ────────────────────────────────────────────
async function processTrojanHeader(
  buffer: ArrayBuffer,
  expectedHash: string
): Promise<{
  hasError: boolean;
  message?: string;
  addressRemote?: string;
  portRemote?: number;
  rawDataIndex?: number;
  isUDP?: boolean;
}> {
  const data = new Uint8Array(buffer);

  // Trojan: 56 bytes hex hash + \r\n (2) + command (1) + address type (1) + ...
  if (data.byteLength < 56 + 2 + 1 + 1 + 2 + 2) {
    return { hasError: true, message: 'Trojan header too short' };
  }

  // Extract hex password hash (56 chars for SHA-224)
  const clientHashHex = new TextDecoder().decode(data.slice(0, 56));

  if (!constantTimeEqual(clientHashHex.toLowerCase(), expectedHash.toLowerCase())) {
    return { hasError: true, message: 'Invalid Trojan password' };
  }

  // Skip CRLF after hash
  let offset = 56 + 2; // 56 hash + \r\n

  // Command byte
  const command = data[offset];
  offset += 1;

  const isUDP = command === 0x03;
  if (command !== 0x01 && command !== 0x03) {
    return { hasError: true, message: `Unsupported command: ${command}` };
  }

  // Address type
  const addressType = data[offset];
  offset += 1;

  let addressRemote = '';

  switch (addressType) {
    case 0x01: { // IPv4
      if (offset + 4 > data.byteLength) {
        return { hasError: true, message: 'Buffer too short for IPv4' };
      }
      addressRemote = `${data[offset]}.${data[offset + 1]}.${data[offset + 2]}.${data[offset + 3]}`;
      offset += 4;
      break;
    }
    case 0x03: { // Domain
      const domainLen = data[offset];
      offset += 1;
      if (offset + domainLen > data.byteLength) {
        return { hasError: true, message: 'Buffer too short for domain' };
      }
      addressRemote = new TextDecoder().decode(data.slice(offset, offset + domainLen));
      offset += domainLen;
      break;
    }
    case 0x04: { // IPv6
      if (offset + 16 > data.byteLength) {
        return { hasError: true, message: 'Buffer too short for IPv6' };
      }
      const dv = new DataView(buffer, offset, 16);
      const parts: string[] = [];
      for (let i = 0; i < 8; i++) {
        parts.push(dv.getUint16(i * 2).toString(16));
      }
      addressRemote = parts.join(':');
      offset += 16;
      break;
    }
    default:
      return { hasError: true, message: `Invalid address type: ${addressType}` };
  }

  // Port (2 bytes big-endian)
  if (offset + 2 > data.byteLength) {
    return { hasError: true, message: 'Buffer too short for port' };
  }
  const portRemote = (data[offset] << 8) | data[offset + 1];
  offset += 2;

  // Skip trailing CRLF
  if (offset + 2 <= data.byteLength && data[offset] === 0x0D && data[offset + 1] === 0x0A) {
    offset += 2;
  }

  return {
    hasError: false,
    addressRemote,
    portRemote,
    rawDataIndex: offset,
    isUDP,
  };
}

// ─── Safe Close Remote TCP ───────────────────────────────────────────
function safeCloseRemote(conn: Deno.TcpConn | null): void {
  if (conn) {
    untrackConnection(conn);
    try { conn.close(); } catch (_) { /* ignore */ }
  }
}

// ─── TCP Outbound Handler ────────────────────────────────────────────
async function handleTCPOutBound(
  remoteSocket: { value: Deno.TcpConn | null },
  addressRemote: string,
  portRemote: number,
  rawClientData: Uint8Array,
  webSocket: WebSocket,
  responseHeader: Uint8Array,
  log: (info: string, event?: string) => void
) {
  async function connectAndWrite(address: string, port: number) {
    try {
      const tcpSocket = await connectWithTimeout(address, port, CONNECTION_TIMEOUT);
      remoteSocket.value = tcpSocket;
      trackConnection(tcpSocket);
      log(`connected to ${address}:${port}`);
      const writer = tcpSocket.writable.getWriter();
      try {
        await writer.write(new Uint8Array(rawClientData));
      } finally {
        writer.releaseLock();
      }
      return tcpSocket;
    } catch (e) {
      log(`Failed to connect to ${address}:${port}: ${(e as Error).message}`);
      throw e;
    }
  }

  async function retry() {
    try {
      const fallbackIP = getFixedProxyIP();
      if (!fallbackIP) {
        log('No proxy IP available for retry');
        safeCloseWebSocket(webSocket);
        return;
      }
      log(`Retrying with fixed proxy IP: ${fallbackIP}`);
      const tcpSocket = await connectAndWrite(fallbackIP, portRemote);
      remoteSocketToWS(tcpSocket, webSocket, responseHeader, null, log);
    } catch (e) {
      log(`Retry failed: ${(e as Error).message}`);
      safeCloseWebSocket(webSocket);
    }
  }

  try {
    const tcpSocket = await connectAndWrite(addressRemote, portRemote);
    remoteSocketToWS(tcpSocket, webSocket, responseHeader, retry, log);
  } catch (e) {
    log(`Initial connection failed: ${(e as Error).message}, attempting retry...`);
    await retry();
  }
}

// ─── Readable WebSocket Stream ───────────────────────────────────────
function makeReadableWebSocketStream(
  webSocketServer: WebSocket,
  earlyDataHeader: string,
  log: (info: string, event?: string) => void
) {
  let readableStreamCancel = false;
  const stream = new ReadableStream({
    start(controller) {
      webSocketServer.addEventListener('message', (event) => {
        if (readableStreamCancel) return;
        const data = event.data;
        if (data instanceof ArrayBuffer) {
          controller.enqueue(data);
        } else if (data instanceof Blob) {
          data.arrayBuffer().then(buf => {
            if (!readableStreamCancel) controller.enqueue(buf);
          }).catch(err => {
            log('Blob to ArrayBuffer error', String(err));
          });
        }
      });

      webSocketServer.addEventListener('close', () => {
        safeCloseWebSocket(webSocketServer);
        if (readableStreamCancel) return;
        controller.close();
      });

      webSocketServer.addEventListener('error', (err) => {
        log('webSocketServer has error');
        controller.error(err);
      });

      const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
      if (error) {
        controller.error(error);
      } else if (earlyData) {
        controller.enqueue(earlyData);
      }
    },
    pull(_controller) {},
    cancel(reason) {
      if (readableStreamCancel) return;
      log(`ReadableStream was canceled, due to ${reason}`);
      readableStreamCancel = true;
      safeCloseWebSocket(webSocketServer);
    },
  });
  return stream;
}

// ─── VLESS Header Parser ─────────────────────────────────────────────
function processVlessHeader(vlessBuffer: ArrayBuffer, validUserIDs: string[]) {
  if (vlessBuffer.byteLength < 24) {
    return { hasError: true, message: 'invalid data' };
  }

  const version = new Uint8Array(vlessBuffer.slice(0, 1));
  const incomingUUID = stringify(new Uint8Array(vlessBuffer.slice(1, 17))).toLowerCase();

  let isValidUser = false;
  for (const id of validUserIDs) {
    if (constantTimeEqual(id, incomingUUID)) {
      isValidUser = true;
    }
  }

  if (!isValidUser) {
    return { hasError: true, message: 'invalid user' };
  }

  const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];

  if (18 + optLength + 1 > vlessBuffer.byteLength) {
    return { hasError: true, message: 'invalid header: optLength exceeds buffer' };
  }

  const command = new Uint8Array(vlessBuffer.slice(18 + optLength, 18 + optLength + 1))[0];
  let isUDP = false;

  if (command === 1) {
    // TCP
  } else if (command === 2) {
    isUDP = true;
  } else {
    return {
      hasError: true,
      message: `command ${command} is not supported, command 01-tcp, 02-udp, 03-mux`,
    };
  }

  const portIndex = 18 + optLength + 1;

  if (portIndex + 2 > vlessBuffer.byteLength) {
    return { hasError: true, message: 'invalid header: buffer too short for port' };
  }

  const portBuffer = vlessBuffer.slice(portIndex, portIndex + 2);
  const portRemote = new DataView(portBuffer).getUint16(0);

  const addressIndex = portIndex + 2;

  if (addressIndex + 1 > vlessBuffer.byteLength) {
    return { hasError: true, message: 'invalid header: buffer too short for address type' };
  }

  const addressBuffer = new Uint8Array(vlessBuffer.slice(addressIndex, addressIndex + 1));
  const addressType = addressBuffer[0];
  let addressLength = 0;
  let addressValueIndex = addressIndex + 1;
  let addressValue = '';

  switch (addressType) {
    case 1: {
      addressLength = 4;
      if (addressValueIndex + addressLength > vlessBuffer.byteLength) {
        return { hasError: true, message: 'invalid header: buffer too short for IPv4 address' };
      }
      addressValue = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
      break;
    }
    case 2: {
      if (addressValueIndex + 1 > vlessBuffer.byteLength) {
        return { hasError: true, message: 'invalid header: buffer too short for domain length' };
      }
      addressLength = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
      addressValueIndex += 1;
      if (addressValueIndex + addressLength > vlessBuffer.byteLength) {
        return { hasError: true, message: 'invalid header: domain length exceeds buffer' };
      }
      addressValue = new TextDecoder().decode(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
      break;
    }
    case 3: {
      addressLength = 16;
      if (addressValueIndex + addressLength > vlessBuffer.byteLength) {
        return { hasError: true, message: 'invalid header: buffer too short for IPv6 address' };
      }
      const dataView = new DataView(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
      const ipv6: string[] = [];
      for (let i = 0; i < 8; i++) {
        ipv6.push(dataView.getUint16(i * 2).toString(16));
      }
      addressValue = ipv6.join(':');
      break;
    }
    default:
      return {
        hasError: true,
        message: `invalid addressType is ${addressType}`,
      };
  }

  if (!addressValue) {
    return {
      hasError: true,
      message: `addressValue is empty, addressType is ${addressType}`,
    };
  }

  return {
    hasError: false,
    addressRemote: addressValue,
    addressType,
    portRemote,
    rawDataIndex: addressValueIndex + addressLength,
    vlessVersion: version,
    isUDP,
  };
}

// ─── Remote Socket to WebSocket ──────────────────────────────────────
async function remoteSocketToWS(
  remoteSocket: Deno.TcpConn,
  webSocket: WebSocket,
  responseHeader: Uint8Array,
  retry: (() => Promise<void>) | null,
  log: (info: string, event?: string) => void
) {
  let hasIncomingData = false;
  let headerSent = false;

  await remoteSocket.readable
    .pipeTo(
      new WritableStream({
        start() {},
        async write(chunk, controller) {
          hasIncomingData = true;
          if (webSocket.readyState !== WS_READY_STATE_OPEN) {
            controller.error('webSocket.readyState is not open, maybe close');
          }
          if (!headerSent && responseHeader.byteLength > 0) {
            webSocket.send(new Uint8Array([...responseHeader, ...chunk]));
            headerSent = true;
          } else {
            webSocket.send(chunk);
          }
        },
        close() {
          log(`remoteConnection readable closed, hasIncomingData: ${hasIncomingData}`);
        },
        abort(reason) {
          console.error(`remoteConnection readable abort`, reason);
        },
      })
    )
    .catch((error) => {
      console.error(`remoteSocketToWS exception`, error.stack || error);
      safeCloseWebSocket(webSocket);
    });

  if (hasIncomingData === false && retry) {
    log(`retry`);
    await retry();
  }
}

// ─── Base64 Decoder ──────────────────────────────────────────────────
function base64ToArrayBuffer(base64Str: string) {
  if (!base64Str) {
    return { error: null };
  }
  try {
    base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    const decode = atob(base64Str);
    const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
    return { earlyData: arryBuffer.buffer, error: null };
  } catch (error) {
    return { error: error };
  }
}

// ─── WebSocket Helpers ───────────────────────────────────────────────
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

function safeCloseWebSocket(socket: WebSocket) {
  try {
    if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
      socket.close();
    }
  } catch (error) {
    console.error('safeCloseWebSocket error', error);
  }
}

// ─── UUID Byte-to-Hex ────────────────────────────────────────────────
const byteToHex: string[] = [];
for (let i = 0; i < 256; ++i) {
  byteToHex.push((i + 256).toString(16).slice(1));
}

function unsafeStringify(arr: Uint8Array, offset = 0) {
  return (
    byteToHex[arr[offset + 0]] +
    byteToHex[arr[offset + 1]] +
    byteToHex[arr[offset + 2]] +
    byteToHex[arr[offset + 3]] +
    '-' +
    byteToHex[arr[offset + 4]] +
    byteToHex[arr[offset + 5]] +
    '-' +
    byteToHex[arr[offset + 6]] +
    byteToHex[arr[offset + 7]] +
    '-' +
    byteToHex[arr[offset + 8]] +
    byteToHex[arr[offset + 9]] +
    '-' +
    byteToHex[arr[offset + 10]] +
    byteToHex[arr[offset + 11]] +
    byteToHex[arr[offset + 12]] +
    byteToHex[arr[offset + 13]] +
    byteToHex[arr[offset + 14]] +
    byteToHex[arr[offset + 15]]
  ).toLowerCase();
}

function stringify(arr: Uint8Array, offset = 0) {
  const uuid = unsafeStringify(arr, offset);
  if (!isValidUUID(uuid)) {
    throw TypeError('Stringified UUID is invalid');
  }
  return uuid;
}

// ─── UDP Outbound (DNS only) ─────────────────────────────────────────
async function handleUDPOutBound(
  webSocket: WebSocket,
  responseHeader: Uint8Array,
  log: (info: string) => void
) {
  let isHeaderSent = false;

  const transformStream = new TransformStream({
    start(_controller) {},
    transform(chunk, controller) {
      for (let index = 0; index < chunk.byteLength;) {
        if (index + 2 > chunk.byteLength) {
          console.error('UDP: not enough data for length header');
          break;
        }
        const lengthBuffer = chunk.slice(index, index + 2);
        const udpPacketLength = new DataView(lengthBuffer).getUint16(0);
        if (udpPacketLength === 0 || index + 2 + udpPacketLength > chunk.byteLength) {
          console.error('UDP: invalid packet length or exceeds buffer');
          break;
        }
        const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPacketLength));
        index = index + 2 + udpPacketLength;
        controller.enqueue(udpData);
      }
    },
    flush(_controller) {},
  });

  transformStream.readable
    .pipeTo(
      new WritableStream({
        async write(chunk) {
          const resp = await fetch('https://1.1.1.1/dns-query', {
            method: 'POST',
            headers: { 'content-type': 'application/dns-message' },
            body: chunk,
          });
          const dnsQueryResult = await resp.arrayBuffer();
          const udpSize = dnsQueryResult.byteLength;
          const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
          if (webSocket.readyState === WS_READY_STATE_OPEN) {
            log(`doh success, dns message length: ${udpSize}`);
            if (isHeaderSent || responseHeader.byteLength === 0) {
              webSocket.send(await new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer());
            } else {
              webSocket.send(await new Blob([responseHeader, udpSizeBuffer, dnsQueryResult]).arrayBuffer());
              isHeaderSent = true;
            }
          }
        },
      })
    )
    .catch((error) => {
      log('dns udp error: ' + error);
    });

  const writer = transformStream.writable.getWriter();
  return {
    write(chunk: Uint8Array) {
      writer.write(chunk);
    },
  };
}
