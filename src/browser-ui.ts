export function renderApp(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Worker SSH</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #111316;
      --panel: #181b20;
      --panel-2: #20242b;
      --line: #343a44;
      --text: #f2f4f8;
      --muted: #a7b0bf;
      --accent: #4fb477;
      --accent-2: #93d9ad;
      --danger: #ff6b6b;
      --focus: #8cc7ff;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
    }

    main {
      width: min(1120px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 28px 0;
    }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 20px;
    }

    h1 {
      margin: 0;
      font-size: 24px;
      font-weight: 700;
      letter-spacing: 0;
    }

    .status {
      display: inline-flex;
      align-items: center;
      min-height: 32px;
      padding: 0 10px;
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--muted);
      font-size: 13px;
      white-space: nowrap;
    }

    .layout {
      display: grid;
      grid-template-columns: 360px minmax(0, 1fr);
      gap: 16px;
      align-items: start;
    }

    form,
    .terminal {
      border: 1px solid var(--line);
      background: var(--panel);
    }

    form {
      display: grid;
      gap: 14px;
      padding: 16px;
    }

    .grid {
      display: grid;
      grid-template-columns: 1fr 96px;
      gap: 10px;
    }

    label {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
      text-transform: uppercase;
      letter-spacing: 0;
    }

    input,
    textarea {
      width: 100%;
      border: 1px solid var(--line);
      background: #0d0f12;
      color: var(--text);
      font: 14px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      outline: none;
    }

    input {
      height: 42px;
      padding: 0 10px;
    }

    textarea {
      min-height: 132px;
      resize: vertical;
      padding: 10px;
    }

    input:focus,
    textarea:focus {
      border-color: var(--focus);
      box-shadow: 0 0 0 2px rgba(140, 199, 255, 0.18);
    }

    .mode {
      display: grid;
      grid-template-columns: 1fr 1fr;
      border: 1px solid var(--line);
      background: #0d0f12;
    }

    .mode label {
      position: relative;
      min-width: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 38px;
      color: var(--muted);
      text-transform: none;
      cursor: pointer;
    }

    .mode input {
      position: absolute;
      opacity: 0;
      pointer-events: none;
    }

    .mode label:has(input:checked) {
      background: var(--panel-2);
      color: var(--accent-2);
    }

    button {
      height: 42px;
      border: 0;
      background: var(--accent);
      color: #07110b;
      font-size: 14px;
      font-weight: 750;
      cursor: pointer;
    }

    button:disabled {
      cursor: wait;
      opacity: 0.7;
    }

    .terminal {
      min-height: 620px;
      display: grid;
      grid-template-rows: auto 1fr;
      overflow: hidden;
    }

    .terminal-bar {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      background: var(--panel-2);
      color: var(--muted);
      font-size: 13px;
    }

    pre {
      margin: 0;
      min-height: 0;
      padding: 16px;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font: 14px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
    }

    .stderr {
      color: var(--danger);
    }

    @media (max-width: 820px) {
      main {
        width: min(100vw - 20px, 640px);
        padding: 18px 0;
      }

      header,
      .layout {
        grid-template-columns: 1fr;
      }

      header {
        align-items: stretch;
      }

      .layout {
        display: grid;
      }

      .terminal {
        min-height: 420px;
      }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Worker SSH</h1>
      <div class="status" id="status">Ready</div>
    </header>

    <div class="layout">
      <form id="ssh-form" autocomplete="off">
        <div class="grid">
          <label>
            Host
            <input name="host" placeholder="ssh.example.com" required>
          </label>
          <label>
            Port
            <input name="port" type="number" value="22" min="1" max="65535" required>
          </label>
        </div>
        <label>
          Username
          <input name="username" placeholder="root" required>
        </label>
        <label>
          Password
          <input name="password" type="password" required>
        </label>
        <label>
          Bearer Token
          <input name="token" type="password">
        </label>
        <label>
          Mode
          <div class="mode">
            <label><input name="mode" type="radio" value="buffered" checked>Buffered</label>
            <label><input name="mode" type="radio" value="stream">Streaming</label>
          </div>
        </label>
        <label>
          Command
          <textarea name="command" spellcheck="false" required>whoami && uname -srm && pwd</textarea>
        </label>
        <button id="run" type="submit">Run Command</button>
      </form>

      <section class="terminal" aria-live="polite">
        <div class="terminal-bar">
          <span id="target">not connected</span>
          <span id="exit-code">Exit -</span>
        </div>
        <pre id="output">$ ready</pre>
      </section>
    </div>
  </main>

  <script>
    const STORAGE_KEY = "worker-ssh.form.v1";
    const SAVED_FIELDS = ["host", "port", "username", "command", "mode"];
    const form = document.querySelector("#ssh-form");
    const statusEl = document.querySelector("#status");
    const outputEl = document.querySelector("#output");
    const targetEl = document.querySelector("#target");
    const exitCodeEl = document.querySelector("#exit-code");
    const runButton = document.querySelector("#run");

    loadSavedForm();
    updateTarget();

    form.addEventListener("input", () => {
      saveForm();
      updateTarget();
    });

    form.addEventListener("change", () => {
      saveForm();
      updateTarget();
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      saveForm();
      const data = new FormData(form);
      const token = String(data.get("token") || "");
      const mode = String(data.get("mode") || "buffered");
      const payload = {
        host: String(data.get("host") || ""),
        port: Number(data.get("port") || 22),
        username: String(data.get("username") || ""),
        password: String(data.get("password") || ""),
        command: String(data.get("command") || "")
      };

      runButton.disabled = true;
      statusEl.textContent = mode === "stream" ? "Streaming" : "Running";
      exitCodeEl.textContent = "Exit -";
      outputEl.className = "";
      outputEl.textContent = "$ " + payload.command + "\\n\\n";

      try {
        if (mode === "stream") {
          await runStreaming(payload, token);
        } else {
          await runBuffered(payload, token);
        }
        statusEl.textContent = "Ready";
      } catch (error) {
        outputEl.className = "stderr";
        outputEl.textContent += "\\n" + (error instanceof Error ? error.message : String(error));
        statusEl.textContent = "Failed";
      } finally {
        runButton.disabled = false;
      }
    });

    async function runBuffered(payload, token) {
      const response = await fetch("/", {
        method: "POST",
        headers: requestHeaders(token),
        body: JSON.stringify(payload)
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Request failed");

      const stdout = result.stdout || "";
      const stderr = result.stderr || "";
      outputEl.className = stderr ? "stderr" : "";
      outputEl.textContent =
        "$ " + payload.command + "\\n\\n" +
        (stdout ? stdout : "") +
        (stderr ? "\\n[stderr]\\n" + stderr : "");
      exitCodeEl.textContent = "Exit " + String(result.code ?? result.signal ?? "-");
    }

    async function runStreaming(payload, token) {
      const response = await fetch("/stream", {
        method: "POST",
        headers: requestHeaders(token),
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error || "Request failed");
      }
      if (!response.body) throw new Error("Streaming response body unavailable");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = consumeLines(buffer);
      }
      buffer += decoder.decode();
      consumeLines(buffer + "\\n");
    }

    function consumeLines(text) {
      const lines = text.split("\\n");
      const rest = lines.pop() || "";
      for (const line of lines) {
        if (!line) continue;
        handleStreamEvent(JSON.parse(line));
      }
      return rest;
    }

    function handleStreamEvent(event) {
      if (event.type === "stdout") {
        outputEl.textContent += event.data;
        return;
      }
      if (event.type === "stderr") {
        outputEl.textContent += event.data;
        return;
      }
      if (event.type === "exit") {
        exitCodeEl.textContent = "Exit " + String(event.code ?? event.signal ?? "-");
        return;
      }
      if (event.type === "error") {
        throw new Error(event.error || "Streaming command failed");
      }
    }

    function requestHeaders(token) {
      const headers = { "content-type": "application/json" };
      if (token) headers.authorization = "Bearer " + token;
      return headers;
    }

    function loadSavedForm() {
      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
        for (const field of SAVED_FIELDS) {
          if (typeof saved[field] !== "string") continue;
          const control = form.elements.namedItem(field);
          if (!control) continue;
          if (field === "mode") {
            const modeValue = saved[field] === "stream" ? "stream" : "buffered";
            const radio = form.querySelector('input[name="mode"][value="' + modeValue + '"]');
            if (radio) radio.checked = true;
          } else {
            control.value = saved[field];
          }
        }
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      }
    }

    function saveForm() {
      const data = new FormData(form);
      const saved = {};
      for (const field of SAVED_FIELDS) {
        saved[field] = String(data.get(field) || "");
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    }

    function updateTarget() {
      const data = new FormData(form);
      const host = String(data.get("host") || "");
      const port = String(data.get("port") || "22");
      const username = String(data.get("username") || "");
      targetEl.textContent = host ? (username || "?") + "@" + host + ":" + port : "not connected";
    }
  </script>
</body>
</html>`;
}
