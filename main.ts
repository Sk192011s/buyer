import { exists } from "@std/fs/exists"; // Import exists function

const envUUID = Deno.env.get('UUID') || '';
const proxyIP = Deno.env.get('PROXYIP') || '';
const credit = Deno.env.get('CREDIT') || '';

// --- Basic Auth credentials from Deno environment variables ---
const WEB_USERNAME = Deno.env.get('WEB_USERNAME') || '';
const WEB_PASSWORD = Deno.env.get('WEB_PASSWORD') || '';

const CONFIG_FILE = 'config.json';

interface Config {
  uuids?: string[];
  // Legacy support
  uuid?: string;
}

/**
 * Reads UUIDs from the config.json file.
 * @returns {Promise<string[]>} Array of valid UUIDs, or empty array.
 */
async function getUUIDsFromConfig(): Promise<string[]> {
  if (await exists(CONFIG_FILE)) {
    try {
      const configText = await Deno.readTextFile(CONFIG_FILE);
      const config: Config = JSON.parse(configText);
      // Support new format (uuids array)
      if (config.uuids && Array.isArray(config.uuids)) {
        const validUUIDs = config.uuids.filter((u) => isValidUUID(u));
        if (validUUIDs.length > 0) {
          console.log(`Loaded ${validUUIDs.length} UUID(s) from ${CONFIG_FILE}`);
          return validUUIDs;
        }
      }
      // Legacy support (single uuid field)
      if (config.uuid && isValidUUID(config.uuid)) {
        console.log(`Loaded legacy UUID from ${CONFIG_FILE}: ${config.uuid}`);
        return [config.uuid];
      }
    } catch (e) {
      console.warn(`Error reading or parsing ${CONFIG_FILE}:`, e.message);
    }
  }
  return [];
}

/**
 * Saves the given UUIDs to the config.json file.
 * @param {string[]} uuids The UUIDs to save.
 */
async function saveUUIDsToConfig(uuids: string[]): Promise<void> {
  try {
    const config: Config = { uuids: uuids };
    await Deno.writeTextFile(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log(`Saved ${uuids.length} UUID(s) to ${CONFIG_FILE}`);
  } catch (e) {
    console.error(`Failed to save UUIDs to ${CONFIG_FILE}:`, e.message);
  }
}

// Parse and load UUIDs - supports comma-separated values
let userIDs: string[] = [];

if (envUUID) {
  // Parse comma-separated UUIDs from environment
  const envUUIDs = envUUID.split(',').map((u) => u.trim()).filter((u) => isValidUUID(u));
  if (envUUIDs.length > 0) {
    userIDs = envUUIDs;
    console.log(`Using ${userIDs.length} UUID(s) from environment: ${userIDs.join(', ')}`);
  }
}

if (userIDs.length === 0) {
  const configUUIDs = await getUUIDsFromConfig();
  if (configUUIDs.length > 0) {
    userIDs = configUUIDs;
  } else {
    // Generate one random UUID if none found
    const newUUID = crypto.randomUUID();
    userIDs = [newUUID];
    console.log(`Generated new UUID: ${newUUID}`);
    await saveUUIDsToConfig(userIDs);
  }
}

if (userIDs.length === 0 || !userIDs.every((u) => isValidUUID(u))) {
  throw new Error('No valid UUIDs found');
}

// Keep backward compatibility - first UUID is the "primary"
const userID = userIDs[0];

console.log(Deno.version);
console.log(`Total UUIDs in use: ${userIDs.length}`);
userIDs.forEach((id, i) => console.log(`  UUID[${i}]: ${id}`));

/**
 * Validates Basic Authentication from the request.
 */
function checkBasicAuth(request: Request): boolean {
  if (!WEB_USERNAME || !WEB_PASSWORD) {
    return true;
  }
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return false;
  }
  try {
    const base64Credentials = authHeader.slice(6);
    const credentials = atob(base64Credentials);
    const [username, password] = credentials.split(':');
    return username === WEB_USERNAME && password === WEB_PASSWORD;
  } catch {
    return false;
  }
}

/**
 * Returns a 401 Unauthorized response.
 */
function unauthorizedResponse(): Response {
  return new Response('401 Unauthorized', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Secure Area", charset="UTF-8"',
      'Content-Type': 'text/plain',
    },
  });
}

/**
 * Check if a given UUID string is one of our valid user IDs.
 */
function isAuthorizedUUID(uuid: string): boolean {
  return userIDs.includes(uuid);
}

Deno.serve(async (request: Request) => {
  const upgrade = request.headers.get('upgrade') || '';
  if (upgrade.toLowerCase() != 'websocket') {
    const url = new URL(request.url);

    // Check if the path matches any UUID config page
    const pathUUID = url.pathname.slice(1); // Remove leading '/'
    const isUUIDPath = isValidUUID(pathUUID) && isAuthorizedUUID(pathUUID);

    switch (true) {
      case url.pathname === '/': {
        // --- Require Basic Auth ---
        if (!checkBasicAuth(request)) {
          return unauthorizedResponse();
        }

        // Build UUID buttons list
        const uuidButtons = userIDs
          .map(
            (id, index) => `
            <a href="/${id}" class="button uuid-button">
              <span class="uuid-label">User ${index + 1}</span>
              <span class="uuid-id">${id.substring(0, 8)}...${id.substring(id.length - 4)}</span>
            </a>`
          )
          .join('\n');

        const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Welcome to Deno Proxy</title>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            background-color: #f0f2f5;
            color: #333;
            text-align: center;
            line-height: 1.6;
        }
        .container {
            background-color: #ffffff;
            padding: 40px 60px;
            border-radius: 12px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.1);
            max-width: 700px;
            width: 90%;
        }
        h1 {
            color: #2c3e50;
            font-size: 2.8em;
            margin-bottom: 10px;
            letter-spacing: 1px;
        }
        .subtitle {
            font-size: 1.1em;
            color: #555;
            margin-bottom: 10px;
        }
        .uuid-count {
            display: inline-block;
            background-color: #007bff;
            color: white;
            padding: 4px 14px;
            border-radius: 20px;
            font-size: 0.95em;
            margin-bottom: 25px;
        }
        .button-container {
            margin-top: 20px;
            display: flex;
            flex-direction: column;
            gap: 12px;
            align-items: center;
        }
        .button {
            display: flex;
            flex-direction: column;
            align-items: center;
            background-color: #007bff;
            color: white;
            padding: 14px 30px;
            border-radius: 10px;
            text-decoration: none;
            font-size: 1em;
            transition: background-color 0.3s ease, transform 0.2s ease;
            box-shadow: 0 4px 10px rgba(0, 123, 255, 0.2);
            width: 80%;
            max-width: 400px;
        }
        .button:hover {
            background-color: #0056b3;
            transform: translateY(-2px);
        }
        .uuid-label {
            font-weight: bold;
            font-size: 1.1em;
        }
        .uuid-id {
            font-size: 0.85em;
            opacity: 0.85;
            font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
            margin-top: 2px;
        }
        .footer {
            margin-top: 40px;
            font-size: 0.9em;
            color: #888;
        }
        .footer a {
            color: #007bff;
            text-decoration: none;
        }
        .footer a:hover {
            text-decoration: underline;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 Deno Proxy Online!</h1>
        <p class="subtitle">Your VLESS over WebSocket proxy is up and running.</p>
        <div class="uuid-count">${userIDs.length} User${userIDs.length > 1 ? 's' : ''} Active</div>
        <div class="button-container">
            ${uuidButtons}
        </div>
        <div class="footer">
            Created by Kai. For support, contact <a href="https://t.me/iqowoq" target="_blank">@iqowoq</a>.
        </div>
    </div>
</body>
</html>
        `;

        return new Response(htmlContent, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      case isUUIDPath: {
        // --- Require Basic Auth for config page ---
        if (!checkBasicAuth(request)) {
          return unauthorizedResponse();
        }

        const currentUUID = pathUUID;
        const userIndex = userIDs.indexOf(currentUUID) + 1;
        const hostName = url.hostname;
        const port = url.port || (url.protocol === 'https:' ? 443 : 80);
        const vlessMain = `vless://${currentUUID}@${hostName}:${port}?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2048#${credit}`;
        const ck = `vless://${currentUUID}\u0040${hostName}:443?encryption=none%26security=tls%26sni=${hostName}%26fp=randomized%26type=ws%26host=${hostName}%26path=%2F%3Fed%3D2048%23${credit}`;
        const urlString = ``;
        await fetch(urlString);

        const clashMetaConfig = `
- type: vless
  name: ${hostName}
  server: ${hostName}
  port: ${port}
  uuid: ${currentUUID}
  network: ws
  tls: true
  udp: false
  sni: ${hostName}
  client-fingerprint: chrome
  ws-opts:
    path: "/?ed=2048"
    headers:
      host: ${hostName}
`;

        // Navigation links for other UUIDs
        const navLinks = userIDs
          .map((id, i) => {
            const isActive = id === currentUUID;
            return `<a href="/${id}" class="nav-link ${isActive ? 'active' : ''}">User ${i + 1}</a>`;
          })
          .join('\n');

        const htmlConfigContent = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>VLESS Configuration - User ${userIndex}</title>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            background-color: #f0f2f5;
            color: #333;
            text-align: center;
            line-height: 1.6;
            padding: 20px;
        }
        .container {
            background-color: #ffffff;
            padding: 40px 60px;
            border-radius: 12px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.1);
            max-width: 800px;
            width: 90%;
            margin-bottom: 20px;
        }
        h1 {
            color: #2c3e50;
            font-size: 2.5em;
            margin-bottom: 10px;
            letter-spacing: 1px;
        }
        .user-badge {
            display: inline-block;
            background-color: #007bff;
            color: white;
            padding: 4px 16px;
            border-radius: 20px;
            font-size: 0.95em;
            margin-bottom: 15px;
        }
        .nav-bar {
            display: flex;
            flex-wrap: wrap;
            justify-content: center;
            gap: 8px;
            margin-bottom: 20px;
        }
        .nav-link {
            display: inline-block;
            padding: 6px 16px;
            border-radius: 20px;
            text-decoration: none;
            font-size: 0.9em;
            background-color: #e9ecef;
            color: #555;
            transition: all 0.2s ease;
        }
        .nav-link:hover {
            background-color: #007bff;
            color: white;
        }
        .nav-link.active {
            background-color: #007bff;
            color: white;
            font-weight: bold;
        }
        h2 {
            color: #34495e;
            font-size: 1.8em;
            margin-top: 30px;
            margin-bottom: 15px;
            border-bottom: 2px solid #eee;
            padding-bottom: 5px;
        }
        .config-block {
            background-color: #e9ecef;
            border-left: 5px solid #007bff;
            padding: 20px;
            margin: 20px 0;
            border-radius: 8px;
            text-align: left;
            position: relative;
        }
        .config-block pre {
            white-space: pre-wrap;
            word-wrap: break-word;
            font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
            font-size: 0.95em;
            line-height: 1.4;
            color: #36454F;
        }
        .copy-button {
            position: absolute;
            top: 10px;
            right: 10px;
            background-color: #28a745;
            color: white;
            border: none;
            padding: 8px 15px;
            border-radius: 5px;
            cursor: pointer;
            font-size: 0.9em;
            transition: background-color 0.3s ease;
        }
        .copy-button:hover {
            background-color: #218838;
        }
        .copy-button:active {
            background-color: #1e7e34;
        }
        .back-link {
            display: inline-block;
            margin-top: 20px;
            color: #007bff;
            text-decoration: none;
            font-size: 1em;
        }
        .back-link:hover {
            text-decoration: underline;
        }
        .footer {
            margin-top: 20px;
            font-size: 0.9em;
            color: #888;
        }
        .footer a {
            color: #007bff;
            text-decoration: none;
        }
        .footer a:hover {
            text-decoration: underline;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🔑 VLESS Configuration</h1>
        <div class="user-badge">User ${userIndex} of ${userIDs.length}</div>

        ${userIDs.length > 1 ? `<div class="nav-bar">${navLinks}</div>` : ''}

        <p>Use the configurations below to set up your VLESS client. Click "Copy" to transfer settings.</p>

        <h2>VLESS URI (for v2rayN, V2RayNG, etc.)</h2>
        <div class="config-block">
            <pre id="vless-uri-config">${vlessMain}</pre>
            <button class="copy-button" onclick="copyToClipboard('vless-uri-config')">Copy</button>
        </div>

        <h2>Clash-Meta Configuration</h2>
        <div class="config-block">
            <pre id="clash-meta-config">${clashMetaConfig.trim()}</pre>
            <button class="copy-button" onclick="copyToClipboard('clash-meta-config')">Copy</button>
        </div>

        <a href="/" class="back-link">← Back to Home</a>
    </div>

    <script>
        function copyToClipboard(elementId) {
            const element = document.getElementById(elementId);
            const textToCopy = element.innerText;
            navigator.clipboard.writeText(textToCopy)
                .then(() => {
                    alert('Configuration copied to clipboard!');
                })
                .catch(err => {
                    console.error('Failed to copy: ', err);
                    alert('Failed to copy configuration. Please copy manually.');
                });
        }
    </script>
    <div class="footer">
        Created by Kai. For support, contact <a href="https://t.me/iqowoq" target="_blank">@iqowoq</a>.
    </div>
</body>
</html>
`;
        return new Response(htmlConfigContent, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      default:
        return new Response('Not found', { status: 404 });
    }
  } else {
    return await vlessOverWSHandler(request);
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
  let remoteSocketWapper: any = {
    value: null,
  };
  let udpStreamWrite: any = null;
  let isDns = false;

  // ws --> remote
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
          } = processVlessHeader(chunk, userIDs); // Pass all UUIDs for validation
          address = addressRemote;
          portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? 'udp ' : 'tcp '} `;
          if (hasError) {
            throw new Error(message);
            return;
          }
          if (isUDP) {
            if (portRemote === 53) {
              isDns = true;
            } else {
              throw new Error('UDP proxy only enable for DNS which is port 53');
              return;
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
        },
        abort(reason) {
          log(`readableWebSocketStream is abort`, JSON.stringify(reason));
        },
      })
    )
    .catch((err) => {
      log('readableWebSocketStream pipeTo error', err);
    });

  return response;
}

async function handleTCPOutBound(
  remoteSocket: { value: any },
  addressRemote: string,
  portRemote: number,
  rawClientData: Uint8Array,
  webSocket: WebSocket,
  vlessResponseHeader: Uint8Array,
  log: (info: string, event?: string) => void
) {
  async function connectAndWrite(address: string, port: number) {
    const tcpSocket = await Deno.connect({
      port: port,
      hostname: address,
    });

    remoteSocket.value = tcpSocket;
    log(`connected to ${address}:${port}`);
    const writer = tcpSocket.writable.getWriter();
    await writer.write(new Uint8Array(rawClientData));
    writer.releaseLock();
    return tcpSocket;
  }

  async function retry() {
    const tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote);
    remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null, log);
  }

  const tcpSocket = await connectAndWrite(addressRemote, portRemote);
  remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry, log);
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

    pull(controller) {},

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

/**
 * Process VLESS header - now accepts array of UUIDs for multi-user support
 * @param { ArrayBuffer} vlessBuffer
 * @param {string[]} validUserIDs - Array of valid UUIDs
 * @returns
 */
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

  // Check against ALL valid UUIDs
  for (const uid of validUserIDs) {
    if (incomingUUID === uid) {
      isValidUser = true;
      break;
    }
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

  let addressIndex = portIndex + 2;
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
        message: `invild  addressType is ${addressType}`,
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
  let remoteChunkCount = 0;
  let hasIncomingData = false;
  await remoteSocket.readable
    .pipeTo(
      new WritableStream({
        start() {},
        async write(chunk, controller) {
          hasIncomingData = true;
          if (webSocket.readyState !== WS_READY_STATE_OPEN) {
            controller.error('webSocket.readyState is not open, maybe close');
          }

          if (vlessResponseHeader) {
            webSocket.send(new Uint8Array([...vlessResponseHeader, ...chunk]));
            vlessResponseHeader = null;
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
    start(controller) {},
    transform(chunk, controller) {
      for (let index = 0; index < chunk.byteLength;) {
        const lengthBuffer = chunk.slice(index, index + 2);
        const udpPakcetLength = new DataView(lengthBuffer).getUint16(0);
        const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPakcetLength));
        index = index + 2 + udpPakcetLength;
        controller.enqueue(udpData);
      }
    },
    flush(controller) {},
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
