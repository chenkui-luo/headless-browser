#!/usr/bin/env node
/**
 * 把网页截成 PNG：整页长图或指定视口，可一次跑多个尺寸。
 *
 *   node shot.mjs <页面地址或本地文件> [选项]
 *   node shot.mjs --help
 *
 * 结果写进 --out 目录（默认 ./shots），每张图配一条 report.json 记录：
 * 横向溢出、图片加载失败、脚本与控制台错误都会列出来。
 */
import fs from "node:fs";
import path from "node:path";
import { startBrowser, resolveTarget, runSteps, pngSize } from "./lib.mjs";

const HELP = `用法：node shot.mjs <页面地址或本地文件> [选项]

  --out <目录>        输出目录，默认 ./shots
  --size <宽x高,...>  视口尺寸，默认 1440x900,390x844；可写多个
  --viewport          只截首屏（默认截整页）
  --zoom <倍数>       设备像素比，默认 1；2 即 200% 截图
  --wait <毫秒>       页面加载完成后再等多久，默认 400
  --steps "<动作>"    截图前的操作，用分号分隔：
                      click <选择器> | hover <选择器> | type <选择器> <文字>
                      key <按键> | scroll <纵向位移> | wait <毫秒>
  --browser <路径>    指定浏览器，默认自动查找 Chrome / Chromium / Edge
  --fail-on-issues    发现页面问题时以退出码 1 结束（默认只报告）
  --url / --w / --h   旧写法别名：--url 等同于直接写页面，--w 与 --h 合起来等同于一个 --size

本地文件与 file:// 地址会自动用一个只监听本机的静态服务器打开，
这样 ES module、fetch 和相对路径都能正常工作。`;

function fail(message) {
  console.error(`shot：${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    process.exit(argv.length ? 0 : 1);
  }

  const knownFlags = new Set(["--viewport", "--fail-on-issues"]);
  const seenFlags = new Set();
  const takesValue = new Set(["--out", "--size", "--zoom", "--wait", "--steps", "--browser", "--url", "--w", "--h"]);
  const options = {};
  let target = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (knownFlags.has(arg)) {
      seenFlags.add(arg);
      continue;
    }
    if (arg.startsWith("--")) {
      if (!takesValue.has(arg)) fail(`不认识的选项 ${arg}，用 --help 看可用选项。`);
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) fail(`${arg} 需要一个值。`);
      options[arg] = argv[++i];
    } else if (!target) {
      target = arg;
    } else {
      fail(`只能指定一个页面，多出来的参数：${arg}`);
    }
  }

  target = options["--url"] || target;
  if (!target) fail("缺少页面地址或本地文件。");

  const sizes = [];
  if (options["--size"]) {
    for (const part of options["--size"].split(",")) {
      const match = part.trim().match(/^(\d+)x(\d+)$/);
      if (!match) fail(`尺寸写成 宽x高，例如 390x844：${part}`);
      sizes.push({ width: +match[1], height: +match[2] });
    }
  }
  if (options["--w"] || options["--h"]) {
    sizes.push({ width: Number(options["--w"]) || 1440, height: Number(options["--h"]) || 900 });
  }

  return {
    target,
    sizes: sizes.length ? sizes : [{ width: 1440, height: 900 }, { width: 390, height: 844 }],
    full: !seenFlags.has("--viewport"),
    zoom: Number(options["--zoom"]) || 1,
    out: path.resolve(options["--out"] || "shots"),
    wait: options["--wait"] === undefined ? 400 : Number(options["--wait"]),
    steps: options["--steps"] || "",
    browser: options["--browser"] || null,
    failOnIssues: seenFlags.has("--fail-on-issues"),
  };
}

function sizeName(size, options) {
  const zoom = options.zoom !== 1 ? `@${options.zoom}x` : "";
  return `${size.width}x${size.height}${zoom}`;
}

const options = parseArgs(process.argv.slice(2));
fs.mkdirSync(options.out, { recursive: true });

let target = null;
let browser = null;
const report = [];

try {
  target = await resolveTarget(options.target);
  browser = await startBrowser({ exe: options.browser });
  console.log(`浏览器：${browser.browserPath}${browser.version ? `  (${browser.version})` : ""}`);
  console.log(`页面：${target.url}`);
  console.log(`输出目录：${options.out}`);

  for (const size of options.sizes) {
    await browser.page.setViewport(size.width, size.height, options.zoom);
    await browser.page.open(target.url, options.wait);
    if (options.steps) await runSteps(browser.page, options.steps);

    const file = path.join(options.out, `${sizeName(size, options)}.png`);

    if (options.full) {
      const metrics = await browser.page.layoutMetrics();
      const contentHeight = Math.ceil(metrics.contentSize.height);
      if (contentHeight > 16000) {
        console.log(`⚠ 页面高 ${contentHeight}px，超过浏览器单张截图的上限，可能截不全；必要时分段截图。`);
      }
    }

    await browser.page.screenshot(file, { full: options.full });
    const issues = await browser.page.inspect();
    const pixels = pngSize(file);
    report.push({
      file: path.basename(file),
      size: `${size.width}x${size.height}`,
      pixels: `${pixels.width}x${pixels.height}`,
      full: options.full,
      zoom: options.zoom,
      steps: options.steps || null,
      issues,
    });

    const kb = Math.round(fs.statSync(file).size / 1024);
    console.log(`\n${path.basename(file)}  ${kb} KB  ${pixels.width}x${pixels.height} 像素  ${options.full ? "整页" : "首屏"}`);
    if (issues.length) issues.forEach((issue) => console.log(`  ⚠ ${issue}`));
    else console.log("  ✓ 没有发现问题");
  }

  fs.writeFileSync(path.join(options.out, "report.json"), JSON.stringify(report, null, 2));
  const total = report.reduce((sum, item) => sum + item.issues.length, 0);
  console.log(`\n${report.length} 张截图完成；${total ? `发现 ${total} 个页面问题，详见 report.json` : "没有发现页面问题"}`);
} catch (error) {
  console.error(`shot：${error.message}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await target?.close();
}

if (options.failOnIssues && report.some((item) => item.issues.length)) process.exitCode = 1;
process.exit(process.exitCode || 0);
