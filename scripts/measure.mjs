#!/usr/bin/env node
/**
 * 量真实布局，不靠肉眼：视口宽、文档滚动宽、横向溢出、越界元素、文字对比度、关键字号。
 *
 *   node measure.mjs <页面地址或本地文件> [--w 1440] [--w 390] [--h 900] [--min-ratio 3]
 *
 * 视口宽度用 DevTools 的 Emulation.setDeviceMetricsOverride 强制设置，
 * 并回读实际视口宽，确认它与请求值一致。
 */
import { startBrowser, resolveTarget } from "./lib.mjs";

const HELP = `用法：node measure.mjs <页面地址或本地文件> [选项]

  --w <宽度>        视口宽度，可以给多次；默认 1440 / 768 / 390 / 320
  --h <高度>        视口高度，默认 900
  --min-ratio <数值> 判为对比度不足的阈值，默认 3（WCAG 大字标准）
  --browser <路径>  指定浏览器，默认自动查找 Chrome / Chromium / Edge

输出：实测视口宽、文档滚动宽、横向溢出、越界元素、对比度不足的文字、关键字号。
每一节都会核对「实测视口 = 请求宽度」。`;

const MEASURE = (minRatio) => `(() => {
  const width = document.documentElement.clientWidth;
  const out = {
    clientWidth: width,
    scrollWidth: document.documentElement.scrollWidth,
    docHeight: document.documentElement.scrollHeight,
    overflowX: document.documentElement.scrollWidth > width + 1,
    offenders: [],
    lowContrast: [],
    fontSizes: {},
  };
  const skip = (el) => el.classList && (el.classList.contains("skip") || el.classList.contains("sr-only"));
  for (const el of document.querySelectorAll("body *")) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") continue;
    if (skip(el)) continue;
    if (rect.right > width + 1) {
      out.offenders.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className || "").toString().slice(0, 44),
        right: Math.round(rect.right),
        w: Math.round(rect.width),
        text: (el.textContent || "").trim().slice(0, 20),
      });
    }
  }
  out.offenders = out.offenders.slice(0, 12);

  const parse = (color) => {
    const match = color.match(/rgba?\\(([^)]+)\\)/);
    if (!match) return null;
    const parts = match[1].split(",").map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const luminance = (color) => {
    const channel = (value) => {
      value /= 255;
      return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
  };
  const backgroundOf = (el) => {
    let node = el;
    while (node && node !== document.documentElement) {
      const color = parse(getComputedStyle(node).backgroundColor);
      if (color && color.a > 0.5) return color;
      node = node.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  for (const el of document.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6, span, a, td, th, button, label")) {
    if (!el.firstChild || el.children.length > 0) continue;
    const text = (el.textContent || "").trim();
    if (!text) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (skip(el)) continue;
    const style = getComputedStyle(el);
    const foreground = parse(style.color);
    if (!foreground) continue;
    const background = backgroundOf(el);
    const light = luminance(foreground);
    const dark = luminance(background);
    const ratio = (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
    if (ratio < ${minRatio}) {
      out.lowContrast.push({
        ratio: Math.round(ratio * 100) / 100,
        fg: style.color,
        bg: "rgb(" + background.r + "," + background.g + "," + background.b + ")",
        cls: (el.className || "").toString().slice(0, 34),
        text: text.slice(0, 18),
      });
    }
  }
  out.lowContrast = out.lowContrast.slice(0, 10);

  const fontTargets = [
    ["主标题", ".display-xl, h1"],
    ["区块标题", ".display-lg, .display-md"],
    ["次级标题", ".heading-xl, .heading-lg"],
    ["正文段落", ".body-md, .prose p, .hero__lede"],
    ["小正文", ".body-sm"],
    ["按钮", ".btn"],
  ];
  for (const [label, selector] of fontTargets) {
    const el = document.querySelector(selector);
    if (!el) continue;
    const style = getComputedStyle(el);
    const text = (el.textContent || "").trim().slice(0, 14);
    out.fontSizes[label] = style.fontSize + "/" + style.fontWeight + (text ? '  "' + text + '"' : "");
  }
  return JSON.stringify(out);
})()`;

function parseArgs(argv) {
  if (!argv.includes("--help") && !argv.includes("-h") && !argv.length) {
    console.log(HELP);
    process.exit(1);
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }

  const widths = [];
  const options = { heights: undefined, minRatio: 3, browser: null, target: null };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) throw new Error(`${arg} 需要一个值。`);
      return argv[++i];
    };
    try {
      if (arg === "--w") widths.push(Number(value()));
      else if (arg === "--h") options.height = Number(value());
      else if (arg === "--min-ratio") options.minRatio = Number(value());
      else if (arg === "--browser") options.browser = value();
      else if (arg === "--url") options.target = value();
      else if (arg.startsWith("--")) throw new Error(`不认识的选项 ${arg}，用 --help 看可用选项。`);
      else if (!options.target) options.target = arg;
      else throw new Error(`只能指定一个页面，多出来的参数：${arg}`);
    } catch (error) {
      console.error(`measure：${error.message}`);
      process.exit(1);
    }
  }

  if (!options.target) {
    console.error("measure：缺少页面地址或本地文件。");
    process.exit(1);
  }

  return {
    target: options.target,
    widths: widths.filter((n) => n > 0).length ? widths.filter((n) => n > 0) : [1440, 768, 390, 320],
    height: options.height || 900,
    minRatio: options.minRatio || 3,
    browser: options.browser || null,
  };
}

const options = parseArgs(process.argv.slice(2));

let target = null;
let browser = null;
let passed = 0;

try {
  target = await resolveTarget(options.target);
  browser = await startBrowser({ exe: options.browser });
  console.log(`浏览器：${browser.browserPath}${browser.version ? `  (${browser.version})` : ""}`);
  console.log(`页面：${target.url}`);
  console.log(`对比度阈值：${options.minRatio}:1`);

  for (const width of options.widths) {
    await browser.page.setViewport(width, options.height, 1);
    await browser.page.open(target.url, 300);

    const raw = await browser.page.evaluate(MEASURE(options.minRatio));
    const result = JSON.parse(raw);
    const exact = Math.abs(result.clientWidth - width) <= 2;

    console.log(`\n===== 视口 ${width}px =====`);
    console.log(`  实测视口 ${result.clientWidth}px  ${exact ? "✅ 等于请求值" : `❌ 不等于请求值（差 ${result.clientWidth - width}px）`}`);
    console.log(`  文档滚动宽 ${result.scrollWidth}   文档高 ${result.docHeight}   横向溢出: ${result.overflowX ? "❌ 有" : "✅ 无"}`);

    if (result.offenders.length) {
      console.log("  超出视口右边的元素:");
      result.offenders.forEach((item) =>
        console.log(`    · <${item.tag} class="${item.cls}"> right=${item.right} w=${item.w}  "${item.text}"`)
      );
    } else {
      console.log("  超出视口右边的元素: 无 ✅");
    }

    if (result.lowContrast.length) {
      console.log(`  对比度低于 ${options.minRatio}:1 的文字（可能看不清）:`);
      result.lowContrast.forEach((item) =>
        console.log(`    · ${item.ratio}:1  字 ${item.fg}  底 ${item.bg}  <${item.cls}>  "${item.text}"`)
      );
    } else {
      console.log(`  对比度低于 ${options.minRatio}:1 的文字: 无 ✅`);
    }

    if (Object.keys(result.fontSizes).length) {
      console.log("  字号（字号/字重）：");
      Object.entries(result.fontSizes).forEach(([label, value]) => console.log(`    · ${label}: ${value}`));
    }

    if (exact && !result.overflowX) passed++;
  }

  console.log(`\n${passed}/${options.widths.length} 个宽度检查通过`);
  process.exitCode = passed === options.widths.length ? 0 : 1;
} catch (error) {
  console.error(`measure：${error.message}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await target?.close();
}

process.exit(process.exitCode || 0);
