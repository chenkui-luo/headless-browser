#!/usr/bin/env node
/**
 * 两个命令行脚本共用的引擎：找浏览器、启动、连 DevTools 协议、开页面、截图、做基础检查。
 * 只依赖 Node 22+（内置 WebSocket）和本机已安装的 Chrome / Chromium / Edge。
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 读 PNG 文件头里的真实像素尺寸，用于核对截图结果 */
export function pngSize(file) {
  const header = Buffer.alloc(24);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, header, 0, 24, 0);
  } finally {
    fs.closeSync(fd);
  }
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

/* ---------------- 找浏览器 ---------------- */

const CANDIDATES = {
  win32: [
    `${process.env.PROGRAMFILES || "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)"}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.PROGRAMFILES || "C:\\Program Files"}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)"}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
  ],
};

function onPath(name) {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        if (fs.statSync(file).isFile()) return file;
      } catch { /* 继续找 */ }
    }
  }
  return null;
}

export function findBrowser(explicit) {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`找不到浏览器：${explicit}`);
    return explicit;
  }
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  for (const file of CANDIDATES[process.platform] || []) {
    if (file && fs.existsSync(file)) return file;
  }
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "msedge"]) {
    const found = onPath(name);
    if (found) return found;
  }
  throw new Error("没找到 Chrome / Chromium / Edge。安装其一，或用 --browser <路径> 指定。");
}

/* ---------------- 启动浏览器 ---------------- */

/** 把浏览器自己的报错翻译成下一步动作，而不是把整段日志丢给使用者 */
function diagnose(stderr) {
  const text = stderr || "";
  const notable = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /FATAL|ERROR|拒绝|denied|0x5|failed/i.test(line))
    .slice(0, 4);

  let hint;
  if (/0x5|拒绝访问|Access is denied|denied|platform_channel|mojo|OpenProcess|EPERM/i.test(text)) {
    hint = "浏览器被系统或沙箱拒绝创建命名管道、打开进程句柄（Windows 上常见「拒绝访问 (0x5)」）。这不是脚本参数问题：需要让执行环境允许该进程启动，或换一个可用的浏览器。";
  } else if (!text.trim()) {
    hint = "浏览器没有输出任何信息就退出了。先确认这个可执行文件能手工启动，再检查执行环境的进程限制。";
  } else {
    hint = "浏览器启动失败，下面它自己的报错说明了原因。";
  }
  return { notable, hint };
}

export async function launchBrowser({ exe, timeoutMs = 20000 } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "hb-"));
  const proc = spawn(
    exe,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-breakpad",
      "--disable-crash-reporter",
      "--hide-scrollbars",
      "--mute-audio",
      "--force-device-scale-factor=1",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"], windowsHide: true }
  );

  let stderr = "";
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-20000);
  });

  const closed = new Promise((resolve) => {
    proc.once("error", (error) => resolve({ error }));
    proc.once("exit", (code) => resolve({ code }));
  });

  const wsUrl = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      const { notable, hint } = diagnose(stderr);
      finish(reject, new Error(`浏览器 ${timeoutMs / 1000} 秒内没有就绪。${hint}${notable.length ? "\n" + notable.join("\n") : ""}`));
    }, timeoutMs);

    const scan = () => {
      const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) finish(resolve, match[1]);
    };
    proc.stderr.on("data", scan);
    void closed.then((result) => {
      if (result.error) return finish(reject, new Error(`浏览器启动失败：${result.error.message}`));
      const { notable, hint } = diagnose(stderr);
      finish(reject, new Error(`浏览器启动后退出了（退出码 ${result.code}）。${hint}${notable.length ? "\n" + notable.join("\n") : ""}`));
    });
  });

  let closedFlag = false;
  async function close() {
    if (closedFlag) return;
    closedFlag = true;
    try { proc.kill(); } catch { /* 已退出 */ }
    await Promise.race([closed, sleep(3000)]);
    try { proc.kill("SIGKILL"); } catch { /* 已退出 */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 占用中 */ }
  }

  return { proc, wsUrl, close, stderr: () => stderr };
}

/* ---------------- DevTools 协议客户端 ---------------- */

export async function connect(wsUrl, { timeoutMs = 10000 } = {}) {
  if (typeof WebSocket !== "function") throw new Error("需要 Node 22 或更新版本（内置 WebSocket）。");
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("连接浏览器调试端口超时。")), timeoutMs);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("连接浏览器调试端口失败。")); };
  });

  const client = new Client(ws);
  client.onclose = () => client.failAll(new Error("浏览器连接已断开。"));
  return client;
}

class Client {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.onclose = null;
    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const listener of this.listeners) {
          try { listener(msg); } catch { /* 监听器出错不影响协议 */ }
        }
      }
    };
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(listener) { this.listeners.add(listener); }
  off(listener) { this.listeners.delete(listener); }

  failAll(error) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  close() {
    try { this.ws.close(); } catch { /* 已关闭 */ }
    this.failAll(new Error("浏览器已关闭。"));
  }
}

/* ---------------- 页面 ---------------- */

export class Page {
  constructor(client, sessionId) {
    this.client = client;
    this.sessionId = sessionId;
    this.problems = [];
    this.consoleLines = [];
    this._onEvent = (msg) => this._handle(msg);
  }

  cdp(method, params = {}) {
    return this.client.send(method, params, this.sessionId);
  }

  async init() {
    await this.cdp("Page.enable");
    await this.cdp("Runtime.enable");
    await this.cdp("Log.enable");
    this.client.on(this._onEvent);
  }

  _handle(msg) {
    if (msg.sessionId !== this.sessionId) return;
    const p = msg.params || {};
    if (msg.method === "Runtime.exceptionThrown") {
      const text = p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || "未知脚本错误";
      this.problems.push(`脚本错误：${String(text).split("\n")[0].slice(0, 200)}`);
    } else if (msg.method === "Runtime.consoleAPICalled") {
      const text = (p.args || []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200);
      this.consoleLines.push(`${p.type}: ${text}`);
      if (p.type === "error") this.problems.push(`控制台错误：${text}`);
    } else if (msg.method === "Log.entryAdded" && p.entry?.level === "error") {
      this.problems.push(`加载错误：${(p.entry.text || "").slice(0, 200)} ${p.entry.url || ""}`.trim());
    }
  }

  async evaluate(expression) {
    const result = await this.cdp("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "页面脚本出错");
    }
    return result.result?.value;
  }

  /**
   * 按 CSS 像素设置视口宽度。
   * 不使用移动端模拟：移动端模拟会让缺少 <meta name="viewport"> 的页面按 980px 布局，
   * 于是请求 390 却量到 980，看起来像工具算错了。这里保证请求宽度就是布局宽度。
   */
  async setViewport(width, height, dpr = 1) {
    await this.cdp("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: dpr,
      mobile: false,
    });
    await this.cdp("Emulation.setTouchEmulationEnabled", { enabled: false });
  }

  /** 打开页面并等它稳定：加载完成、字体就绪、再等 waitMs 给懒加载留时间 */
  async open(url, waitMs = 400) {
    this.problems = [];
    this.consoleLines = [];

    const navigation = await this.cdp("Page.navigate", { url });
    if (navigation.errorText) throw new Error(`打不开 ${url}：${navigation.errorText}`);

    const deadline = Date.now() + 15000;
    for (;;) {
      let state = "";
      try { state = await this.evaluate("document.readyState"); } catch { /* 文档切换中 */ }
      if (state === "complete") break;
      if (Date.now() > deadline) break;
      await sleep(100);
    }

    try {
      await this.evaluate("document.fonts ? document.fonts.ready.then(() => true) : true");
    } catch { /* 字体 API 不可用 */ }
    await sleep(waitMs);
  }

  async layoutMetrics() {
    return this.cdp("Page.getLayoutMetrics");
  }

  /** 截图：full=true 时按文档真实尺寸截整页，不依赖视口高度 */
  async screenshot(file, { full = false } = {}) {
    let clip;
    if (full) {
      const { contentSize } = await this.layoutMetrics();
      clip = {
        x: 0,
        y: 0,
        width: Math.ceil(contentSize.width),
        height: Math.ceil(contentSize.height),
        scale: 1,
      };
    }
    const { data } = await this.cdp("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: full,
      ...(clip ? { clip } : {}),
    });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    return file;
  }

  /** 截图之外的基础检查：横向溢出、图片加载失败，以及记录的脚本/控制台错误 */
  async inspect() {
    const found = await this.evaluate(`(() => {
      const issues = [];
      const doc = document.documentElement;
      if (doc.scrollWidth > innerWidth + 1) {
        issues.push("横向溢出：页面宽 " + doc.scrollWidth + "px，视口 " + innerWidth + "px");
      }
      for (const img of document.images) {
        if (img.complete && img.naturalWidth === 0) {
          issues.push("图片没加载出来：" + (img.getAttribute("src") || "").slice(0, 120));
        }
      }
      return issues;
    })()`);
    return [...this.problems, ...(found || [])];
  }

  dispose() {
    this.client.off(this._onEvent);
  }
}

/* ---------------- 一次性启动（两个命令共用） ---------------- */

export async function startBrowser({ exe } = {}) {
  const browserPath = findBrowser(exe);
  const browser = await launchBrowser({ exe: browserPath });
  let client;
  try {
    client = await connect(browser.wsUrl);
  } catch (error) {
    await browser.close();
    throw error;
  }

  try {
    const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(client, sessionId);
    await page.init();

    let version = null;
    try {
      version = (await client.send("Browser.getVersion")).product;
    } catch { /* 拿不到版本不影响使用 */ }

    let closed = false;
    return {
      page,
      version,
      browserPath,
      async close() {
        if (closed) return;
        closed = true;
        page.dispose();
        client.close();
        await browser.close();
      },
    };
  } catch (error) {
    client.close();
    await browser.close();
    throw error;
  }
}

/* ---------------- 本地文件：起一个只监听本机的静态服务器 ---------------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/**
 * 把「网址 / 本地文件 / file:// 地址」统一成一个可打开的 http 地址。
 * 本地文件走临时静态服务器，ES module、fetch 和相对路径都按真实站点的方式工作。
 */
export async function resolveTarget(input) {
  if (/^https?:\/\//i.test(input)) return { url: input, close: async () => {} };

  // 本地文件可以带查询参数，例如 index.html?state=done，用来打开某个已实现的状态
  const [address, query] = input.split(/\?(.*)/s);
  const file = /^file:\/\//i.test(address) ? fileURLToPath(address) : path.resolve(address);
  if (!fs.existsSync(file)) throw new Error(`找不到页面：${address}`);

  const stat = fs.statSync(file);
  const root = fs.realpathSync(stat.isDirectory() ? file : path.dirname(file));
  const page = stat.isDirectory() ? "index.html" : path.basename(file);

  const server = createServer((req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      if (pathname === "/favicon.ico" && !fs.existsSync(path.join(root, "favicon.ico"))) {
        // 没有 favicon 时回 204，避免每张截图都多一条无关的 404 记录
        res.writeHead(204).end();
        return;
      }
      const local = fs.realpathSync(path.join(root, pathname));
      const relative = path.relative(root, local);
      if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.statSync(local).isFile()) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(local).toLowerCase()] || "application/octet-stream" });
      res.end(fs.readFileSync(local));
    } catch {
      res.writeHead(404).end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const url = `http://127.0.0.1:${server.address().port}/${encodeURI(page)}${query ? `?${query}` : ""}`;
  return {
    url,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/* ---------------- 截图前的简单操作 ---------------- */

const KEY_CODES = {
  Enter: 13,
  Escape: 27,
  Tab: 9,
  Space: 32,
  " ": 32,
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
};

function tokenize(text) {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

async function center(page, selector) {
  const box = await page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center" });
    const rect = el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!box) throw new Error(`找不到元素：${selector}`);
  return box;
}

const mouse = (page, type, x, y, extra = {}) =>
  page.cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", pointerType: "mouse", ...extra });

/** 支持 click / hover / type / key / scroll / wait，用分号分隔 */
export async function runSteps(page, text) {
  for (const raw of (text || "").split(";").map((s) => s.trim()).filter(Boolean)) {
    const [verb, ...rest] = tokenize(raw);
    if (verb === "wait") {
      await sleep(Number(rest[0]) || 0);
    } else if (verb === "click") {
      const p = await center(page, rest[0]);
      await mouse(page, "mouseMoved", p.x, p.y);
      await mouse(page, "mousePressed", p.x, p.y, { clickCount: 1 });
      await mouse(page, "mouseReleased", p.x, p.y, { clickCount: 1 });
      await sleep(120);
    } else if (verb === "hover") {
      const p = await center(page, rest[0]);
      await mouse(page, "mouseMoved", p.x, p.y);
      await sleep(200);
    } else if (verb === "type") {
      await page.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(rest[0])});
        if (!el) throw new Error(${JSON.stringify("找不到元素：" + rest[0])});
        el.focus();
        return true;
      })()`);
      await page.cdp("Input.insertText", { text: rest.slice(1).join(" ") });
      await sleep(120);
    } else if (verb === "key") {
      const name = rest[0];
      const code = KEY_CODES[name] ?? name.toUpperCase().charCodeAt(0);
      await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: name, code: name, windowsVirtualKeyCode: code });
      await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: name, windowsVirtualKeyCode: code });
      await sleep(80);
    } else if (verb === "scroll") {
      await page.evaluate(`window.scrollBy(0, ${Number(rest[0]) || 0})`);
      await sleep(200);
    } else {
      throw new Error(`不认识的动作：${raw}（可用：click / hover / type / key / scroll / wait）`);
    }
  }
}
