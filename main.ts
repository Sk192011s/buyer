import { exists } from "https://deno.land/std/fs/exists.ts";
const envUUID = Deno.env.get('UUID') || '';
const proxyIPs = (Deno.env.get('PROXYIP') || '').split(',').map(ip => ip.trim()).filter(Boolean);
const credit = Deno.env.get('CREDIT') || '';
const webPassword = Deno.env.get('WEB_PASSWORD') || '';
const wsPath = Deno.env.get('WS_PATH') || '/ws';
const webUsername = Deno.env.get('WEB_USERNAME') || '';
const stickyProxyIPEnv = Deno.env.get('STICKY_PROXYIP') || '';
const CONFIG_FILE = 'config.json';
interface Config {
  uuid?: string;
}
const loginAttempts = new Map<string, { count: number; lastAttempt: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of loginAttempts) {
    if (now - record.lastAttempt > 15 * 60 * 1000) {
      loginAttempts.delete(ip);
    }
  }
}, 30 * 60 * 1000);
function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record) {
    loginAttempts.set(ip, { count: 1, lastAttempt: now });
    return false;
  }
  if (now - record.lastAttempt > 15 * 60 * 1000) {
    loginAttempts.set(ip, { count: 1, lastAttempt: now });
    return false;
  }
  record.count++;
  record.lastAttempt = now;
  return record.count > 5;
}
function maskUUID(uuid: string): string {
  if (uuid.length < 8) return '****';
  return uuid.slice(0, 4) + '****-****-****-****-********' + uuid.slice(-4);
}
let fixedProxyIP: string = '';
if (stickyProxyIPEnv) {
  fixedProxyIP = stickyProxyIPEnv.trim();
  console.log(`Using STICKY_PROXYIP (forced): ${fixedProxyIP}`);
} else if (proxyIPs.length > 0) {
  fixedProxyIP = proxyIPs[Math.floor(Math.random() * proxyIPs.length)];
  console.log(`Selected fixed Proxy IP from list: ${fixedProxyIP} (will not change until restart)`);
}
function getFixedProxyIP(): string {
  return fixedProxyIP;
}
async function getUUIDFromConfig(): Promise<string | undefined> {
  if (await exists(CONFIG_FILE)) {
    try {
      const configText = await Deno.readTextFile(CONFIG_FILE);
      const config: Config = JSON.parse(configText);
      if (config.uuid && isValidUUID(config.uuid)) {
        console.log(`Loaded UUID from ${CONFIG_FILE}: ${maskUUID(config.uuid)}`);
        return config.uuid;
      }
    } catch (e) {
      console.warn(`Error reading or parsing ${CONFIG_FILE}:`, (e as Error).message);
    }
  }
  return undefined;
}
async function saveUUIDToConfig(uuid: string): Promise<void> {
  try {
    const config: Config = { uuid: uuid };
    await Deno.writeTextFile(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log(`Saved new UUID to ${CONFIG_FILE}: ${maskUUID(uuid)}`);
  } catch (e) {
    console.error(`Failed to save UUID to ${CONFIG_FILE}:`, (e as Error).message);
  }
}
let userIDs: string[] = [];
if (envUUID) {
  userIDs = envUUID.split(',').map(u => u.trim()).filter(isValidUUID);
  if (userIDs.length > 0) {
    console.log(`Using UUIDs from environment: ${userIDs.map(maskUUID).join(', ')}`);
  }
}
if (userIDs.length === 0) {
  const configUUID = await getUUIDFromConfig();
  if (configUUID) {
    userIDs.push(configUUID);
  } else {
    const newUUID = crypto.randomUUID();
    console.log(`Generated new UUID: ${maskUUID(newUUID)}`);
    await saveUUIDToConfig(newUUID);
    userIDs.push(newUUID);
  }
}
if (userIDs.length === 0) {
  throw new Error('No valid UUID available');
}
const primaryUserID = userIDs[0];
console.log(Deno.version);
console.log(`UUIDs in use: ${userIDs.map(maskUUID).join(', ')}`);
console.log(`WebSocket path: ${wsPath}`);
console.log(`Fixed Proxy IP: ${fixedProxyIP || '(none — direct connection)'}`);
const CONNECTION_TIMEOUT = 10000;
const getHtml = (title: string, bodyContent: string) => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        :root {
            --bg-color: #0f172a;
            --card-bg: rgba(30, 41, 59, 0.7);
            --primary: #3b82f6;
            --primary-hover: #2563eb;
            --text-main: #f8fafc;
            --text-sub: #94a3b8;
            --border: rgba(148, 163, 184, 0.1);
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
            max-width: 700px;
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
        pre::-webkit-scrollbar {
            width: 6px;
        }
        pre::-webkit-scrollbar-track {
            background: transparent;
        }
        pre::-webkit-scrollbar-thumb {
            background: #334155;
            border-radius: 3px;
        }
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
        .copy-btn:hover {
            background: rgba(59, 130, 246, 0.2);
        }
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
        .footer a:hover {
            color: #94a3b8;
        }
        .health-ok {
            color: #4ade80;
            font-weight: 600;
        }
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
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
async function connectWithTimeout(hostname: string, port: number, timeout: number): Promise<Deno.TcpConn> {
  const conn = Deno.connect({ hostname, port });
  const timer = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Connection to ${hostname}:${port} timed out after ${timeout}ms`)), timeout);
  });
  return await Promise.race([conn, timer]);
}
Deno.serve(async (request: Request) => {
  const upgrade = request.headers.get('upgrade') || '';
  if (upgrade.toLowerCase() == 'websocket') {
    const url = new URL(request.url);
    if (url.pathname !== wsPath) {
      return new Response('Not Found', { status: 404 });
    }
    return await vlessOverWSHandler(request);
  }
  const url = new URL(request.url);
  if (url.pathname === '/health') {
    const healthInfo = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uuidCount: userIDs.length,
      proxyIPCount: proxyIPs.length,
      fixedProxyIP: fixedProxyIP || '(none)',
      wsPath: wsPath,
    };
    return new Response(JSON.stringify(healthInfo, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (url.pathname === '/sub') {
    if (webPassword) {
      const authHeader = request.headers.get("Authorization");
      const expectedAuth = `Basic ${btoa(`${webUsername}:${webPassword}`)}`;
      if (authHeader !== expectedAuth) {
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Basic realm="VLESS Proxy Admin"',
            "Content-Type": "text/plain"
          },
        });
      }
    }
    const hostName = url.hostname;
    const port = url.port || (url.protocol === 'https:' ? 443 : 80);
    const allLinks = userIDs.map((uid, index) => {
      const tag = credit ? `${credit}-${index + 1}` : `${hostName}-${index + 1}`;
      return `vless://${uid}@${hostName}:${port}?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=${encodeURIComponent(wsPath + '?ed=2048')}#${tag}`;
    }).join('\n');
    const base64Content = btoa(allLinks);
    return new Response(base64Content, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Profile-Update-Interval': '12',
        'Subscription-Userinfo': 'upload=0; download=0; total=10737418240; expire=0'
      },
    });
  }
  if (url.pathname === '/config' || url.pathname === '/sub') {
    if (webPassword) {
      const clientIP = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
                       request.headers.get('cf-connecting-ip') || 'unknown';
      if (isRateLimited(clientIP)) {
        return new Response("Too Many Requests. Try again later.", {
          status: 429,
          headers: { "Content-Type": "text/plain" },
        });
      }
      const authHeader = request.headers.get("Authorization");
      const expectedAuth = `Basic ${btoa(`${webUsername}:${webPassword}`)}`;
      if (authHeader !== expectedAuth) {
        return new Response("Unauthorized Access", {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Basic realm="VLESS Proxy Admin"',
            "Content-Type": "text/plain"
          },
        });
      }
    }
  }
  switch (url.pathname) {
    case '/': {
      const content = `
          <h1>Hello</h1>
      `;
      return new Response(getHtml('Hello', content), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
    case '/config': {
      const hostName = url.hostname;
      const port = url.port || (url.protocol === 'https:' ? 443 : 80);
      let userSections = '';
      userIDs.forEach((uid, index) => {
        const tag = credit ? `${credit}-${index + 1}` : `${hostName}-${index + 1}`;
        const vlessLink = `vless://${uid}@${hostName}:${port}?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=${encodeURIComponent(wsPath + '?ed=2048')}#${tag}`;
        const clashConfig = `
- type: vless
  name: ${tag}
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
              <span class="user-label">User ${index + 1}</span>
              <div class="config-box">
                  <div class="config-header">
                      <span class="config-title">VLESS URI (V2RayNG / v2rayN)</span>
                      <button class="copy-btn" onclick="copyToClipboard('vless-uri-${index}', this)">Copy</button>
                  </div>
                  <pre id="vless-uri-${index}">${vlessLink}</pre>
              </div>
              <div class="config-box">
                  <div class="config-header">
                      <span class="config-title">Clash Meta YAML</span>
                      <button class="copy-btn" onclick="copyToClipboard('clash-config-${index}', this)">Copy</button>
                  </div>
                  <pre id="clash-config-${index}">${clashConfig.trim()}</pre>
              </div>
          </div>
        `;
      });
      const content = `
          <h1>Server Configuration</h1>
          <p>Import these settings into your V2Ray or Clash client.</p>
          ${userSections}
          <div class="config-box" style="margin-top: 30px;">
              <div class="config-header">
                  <span class="config-title">Subscription URL</span>
                  <button class="copy-btn" onclick="copyToClipboard('sub-url', this)">Copy</button>
              </div>
              <pre id="sub-url">https://${hostName}/sub</pre>
          </div>
          <div class="footer">
              <a href="/">Back to Home</a>
          </div>
      `;
      return new Response(getHtml('VLESS Config', content), {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
    default:
      return new Response(getHtml('404', '<h1>404 Not Found</h1><p>The path you requested does not exist.</p><a href="/" class="btn">Go Home</a>'), {
        status: 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
  }
});
async function vlessOverWSHandler(request: Request) {
  const { socket, response } = Deno.upgradeWebSocket(request);
  let address = '';
  let portWithRandomLog = '';
  const log = (info: string, event = '') => {
    console.log(`[${address}:${portWithRandomLog}] ${info}`, event);
  };
  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableWebSocketStream = makeReadableWebSocketStream(socket, earlyDataHeader, log);
  const remoteSocketWapper: { value: Deno.TcpConn | null } = {
    value: null,
  };
  let udpStreamWrite: ((chunk: Uint8Array) => void) | null = null;
  let isDns = false;
  readableWebSocketStream
    .pipeTo(
      new WritableStream({
        async write(chunk, controller) {
          if (isDns && udpStreamWrite) {
            return udpStreamWrite(chunk);
          }
          if (remoteSocketWapper.value) {
            const writer = remoteSocketWapper.value.writable.getWriter();
            await writer.write(new Uint8Array(chunk));
            writer.releaseLock();
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
              throw new Error('UDP proxy only enable for DNS which is port 53');
            }
          }
          const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
          const rawClientData = chunk.slice(rawDataIndex);
          if (isDns) {
            console.log('isDns:', isDns);
            const { write } = await handleUDPOutBound(socket, vlessResponseHeader, log);
            udpStreamWrite = write;
            udpStreamWrite(rawClientData);
            return;
          }
          handleTCPOutBound(
            remoteSocketWapper,
            addressRemote,
            portRemote,
            rawClientData,
            socket,
            vlessResponseHeader,
            log
          );
        },
        close() {
          log(`readableWebSocketStream is close`);
          if (remoteSocketWapper.value) {
            try { remoteSocketWapper.value.close(); } catch (_) {  }
          }
        },
        abort(reason) {
          log(`readableWebSocketStream is abort`, JSON.stringify(reason));
          if (remoteSocketWapper.value) {
            try { remoteSocketWapper.value.close(); } catch (_) {  }
          }
        },
      })
    )
    .catch((err) => {
      log('readableWebSocketStream pipeTo error', err);
      if (remoteSocketWapper.value) {
        try { remoteSocketWapper.value.close(); } catch (_) {  }
      }
      safeCloseWebSocket(socket);
    });
  return response;
}
async function handleTCPOutBound(
  remoteSocket: { value: Deno.TcpConn | null },
  addressRemote: string,
  portRemote: number,
  rawClientData: Uint8Array,
  webSocket: WebSocket,
  vlessResponseHeader: Uint8Array,
  log: (info: string, event?: string) => void
) {
  async function connectAndWrite(address: string, port: number) {
    try {
      const tcpSocket = await connectWithTimeout(address, port, CONNECTION_TIMEOUT);
      remoteSocket.value = tcpSocket;
      log(`connected to ${address}:${port}`);
      const writer = tcpSocket.writable.getWriter();
      await writer.write(new Uint8Array(rawClientData));
      writer.releaseLock();
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
      remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null, log);
    } catch (e) {
      log(`Retry failed: ${(e as Error).message}`);
      safeCloseWebSocket(webSocket);
    }
  }
  try {
    const tcpSocket = await connectAndWrite(addressRemote, portRemote);
    remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry, log);
  } catch (e) {
    log(`Initial connection failed: ${(e as Error).message}, attempting retry...`);
    await retry();
  }
}
function makeReadableWebSocketStream(webSocketServer: WebSocket, earlyDataHeader: string, log: (info: string, event?: string) => void) {
  let readableStreamCancel = false;
  const stream = new ReadableStream({
    start(controller) {
      webSocketServer.addEventListener('message', (event) => {
        if (readableStreamCancel) {
          return;
        }
        const message = event.data;
        controller.enqueue(message);
      });
      webSocketServer.addEventListener('close', () => {
        safeCloseWebSocket(webSocketServer);
        if (readableStreamCancel) {
          return;
        }
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
      if (readableStreamCancel) {
        return;
      }
      log(`ReadableStream was canceled, due to ${reason}`);
      readableStreamCancel = true;
      safeCloseWebSocket(webSocketServer);
    },
  });
  return stream;
}
function processVlessHeader(vlessBuffer: ArrayBuffer, validUserIDs: string[]) {
  if (vlessBuffer.byteLength < 24) {
    return {
      hasError: true,
      message: 'invalid data',
    };
  }
  const version = new Uint8Array(vlessBuffer.slice(0, 1));
  let isValidUser = false;
  let isUDP = false;
  const incomingUUID = stringify(new Uint8Array(vlessBuffer.slice(1, 17)));
  if (validUserIDs.includes(incomingUUID)) {
    isValidUser = true;
  }
  if (!isValidUser) {
    return {
      hasError: true,
      message: 'invalid user',
    };
  }
  const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
  const command = new Uint8Array(vlessBuffer.slice(18 + optLength, 18 + optLength + 1))[0];
  if (command === 1) {
  } else if (command === 2) {
    isUDP = true;
  } else {
    return {
      hasError: true,
      message: `command ${command} is not support, command 01-tcp,02-udp,03-mux`,
    };
  }
  const portIndex = 18 + optLength + 1;
  const portBuffer = vlessBuffer.slice(portIndex, portIndex + 2);
  const portRemote = new DataView(portBuffer).getUint16(0);
  const addressIndex = portIndex + 2;
  const addressBuffer = new Uint8Array(vlessBuffer.slice(addressIndex, addressIndex + 1));
  const addressType = addressBuffer[0];
  let addressLength = 0;
  let addressValueIndex = addressIndex + 1;
  let addressValue = '';
  switch (addressType) {
    case 1:
      addressLength = 4;
      addressValue = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
      break;
    case 2:
      addressLength = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
      addressValueIndex += 1;
      addressValue = new TextDecoder().decode(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
      break;
    case 3:
      addressLength = 16;
      const dataView = new DataView(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
      const ipv6: string[] = [];
      for (let i = 0; i < 8; i++) {
        ipv6.push(dataView.getUint16(i * 2).toString(16));
      }
      addressValue = ipv6.join(':');
      break;
    default:
      return {
        hasError: true,
        message: `invild addressType is ${addressType}`,
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
async function remoteSocketToWS(remoteSocket: Deno.TcpConn, webSocket: WebSocket, vlessResponseHeader: Uint8Array, retry: (() => Promise<void>) | null, log: (info: string, event?: string) => void) {
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
          if (!headerSent) {
            webSocket.send(new Uint8Array([...vlessResponseHeader, ...chunk]));
            headerSent = true;
          } else {
            webSocket.send(chunk);
          }
        },
        close() {
          log(`remoteConnection!.readable is close with hasIncomingData is ${hasIncomingData}`);
        },
        abort(reason) {
          console.error(`remoteConnection!.readable abort`, reason);
        },
      })
    )
    .catch((error) => {
      console.error(`remoteSocketToWS has exception `, error.stack || error);
      safeCloseWebSocket(webSocket);
    });
  if (hasIncomingData === false && retry) {
    log(`retry`);
    retry();
  }
}
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
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}
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
async function handleUDPOutBound(webSocket: WebSocket, vlessResponseHeader: Uint8Array, log: (info: string) => void) {
  let isVlessHeaderSent = false;
  const transformStream = new TransformStream({
    start(_controller) {},
    transform(chunk, controller) {
      for (let index = 0; index < chunk.byteLength;) {
        const lengthBuffer = chunk.slice(index, index + 2);
        const udpPakcetLength = new DataView(lengthBuffer).getUint16(0);
        const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPakcetLength));
        index = index + 2 + udpPakcetLength;
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
            headers: {
              'content-type': 'application/dns-message',
            },
            body: chunk,
          });
          const dnsQueryResult = await resp.arrayBuffer();
          const udpSize = dnsQueryResult.byteLength;
          const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
          if (webSocket.readyState === WS_READY_STATE_OPEN) {
            log(`doh success and dns message length is ${udpSize}`);
            if (isVlessHeaderSent) {
              webSocket.send(await new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer());
            } else {
              webSocket.send(await new Blob([vlessResponseHeader, udpSizeBuffer, dnsQueryResult]).arrayBuffer());
              isVlessHeaderSent = true;
            }
          }
        },
      })
    )
    .catch((error) => {
      log('dns udp has error' + error);
    });
  const writer = transformStream.writable.getWriter();
  return {
    write(chunk: Uint8Array) {
      writer.write(chunk);
    },
  };
}
