#!/usr/bin/env node
// 回归测试：node --test tests
// 需要本机能启动 Chrome / Chromium / Edge；找不到浏览器时整组跳过。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findBrowser } from "../scripts/lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.join(here, "..", "scripts");
const fixture = path.join(here, "fixture", "index.html");
const brokenFixture = path.join(here, "fixture", "broken.html");

let browserPath = null;
try {
  browserPath = findBrowser();
} catch { /* 没有浏览器 */ }

const skip = browserPath ? false : "本机没有可用的 Chrome / Chromium / Edge";

function run(script, args, timeout = 120000) {
  const result = spawnSync(process.execPath, [path.join(scripts, script), ...args], {
    encoding: "utf8",
    timeout,
  });
  return result;
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hb-test-"));
}

/** 读 PNG 头里的宽高，不依赖第三方库 */
function pngSize(file) {
  const buf = fs.readFileSync(file);
  assert.equal(buf.subarray(1, 4).toString("ascii"), "PNG", `${file} 不是 PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test("首屏截图尺寸等于请求的视口", { skip }, () => {
  const out = tempDir();
  const result = run("shot.mjs", [fixture, "--size", "390x844", "--viewport", "--out", out]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const { width, height } = pngSize(path.join(out, "390x844.png"));
  assert.deepEqual({ width, height }, { width: 390, height: 844 });
  fs.rmSync(out, { recursive: true, force: true });
});

test("整页截图高度等于文档真实高度，而不是猜出来的窗口高度", { skip }, () => {
  const out = tempDir();
  const result = run("shot.mjs", [fixture, "--size", "800x600", "--out", out]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const { width, height } = pngSize(path.join(out, "800x600.png"));
  assert.equal(width, 800);
  assert.equal(height, 2100, "整页高度应等于文档内容高度");
  fs.rmSync(out, { recursive: true, force: true });
});

test("横向溢出与页面问题会写进 report.json", { skip }, () => {
  const out = tempDir();
  const result = run("shot.mjs", [fixture, "--size", "800x600", "--out", out, "--steps", "click #toggle"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(fs.readFileSync(path.join(out, "report.json"), "utf8"));
  assert.equal(report.length, 1);
  assert.ok(
    report[0].issues.some((issue) => issue.includes("横向溢出")),
    `report 里应有横向溢出，实际：${JSON.stringify(report[0].issues)}`
  );
  fs.rmSync(out, { recursive: true, force: true });
});

test("图片加载失败与控制台错误会被报告", { skip }, () => {
  const out = tempDir();
  const result = run("shot.mjs", [brokenFixture, "--size", "600x400", "--out", out]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const issues = JSON.parse(fs.readFileSync(path.join(out, "report.json"), "utf8"))[0].issues.join("\n");
  assert.match(issues, /图片没加载出来/);
  assert.match(issues, /控制台错误/);
  fs.rmSync(out, { recursive: true, force: true });
});

test("本地文件可以带查询参数打开状态", { skip }, () => {
  const out = tempDir();
  const result = run("shot.mjs", [`${fixture}?tall=1`, "--size", "500x400", "--out", out]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const { height } = pngSize(path.join(out, "500x400.png"));
  assert.equal(height, 3300, "查询参数应把 .body 拉长到 3000px");
  fs.rmSync(out, { recursive: true, force: true });
});

test("没有 viewport meta 的页面也按请求宽度布局", { skip }, () => {
  const result = run("measure.mjs", [path.join(here, "fixture", "no-viewport.html"), "--w", "390"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /实测视口 390px\s+✅/);
});

test("measure 回报的实测视口等于请求宽度", { skip }, () => {
  const result = run("measure.mjs", [fixture, "--w", "390"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /实测视口 390px\s+✅/);
});

test("measure 在窄视口下能报出横向溢出", { skip }, () => {
  const result = run("measure.mjs", [fixture, "--w", "320"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /横向溢出: ✅ 无/);
});
