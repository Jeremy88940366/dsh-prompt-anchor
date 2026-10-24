/**
 * 补丁漂移自检 / patch drift self-check
 *
 * 为什么需要它：
 *   prompt-anchor 的代码补丁靠 `applyReplacementsToText()`（lib/core.js:6864）
 *   对内核源码做**精确字符串 includes 匹配**。DSH 每次升级，只要上游改了
 *   一个空格、一个变量名、或者把某段代码挪了位置，对应 pattern 就永远
 *   匹配不上 —— 补丁静默失效，界面上只显示 "pattern_not_found"，不会
 *   告诉你「是因为 DSH 升级了」。
 *
 * 这个模块不改任何补丁逻辑，只做两件事：
 *   1. 取内核现在的补丁状态（**直接用 core.patchStatus()**，不自己再判一遍
 *      —— 早先版本自带一套 statusOf()，判的是「原文 pattern 还在不在」，
 *      和 core 判的「标记在不在」方向正好相反，把 62 条已打好的报成 71 条
 *      失配，也和面板上的数字永远对不上）；
 *   2. 把内核版本号和每条补丁的状态记进本地快照，下次启动时如果版本变了、
 *      而且有补丁从 applied 掉下去，就明确报「DSH 升级导致 N 条补丁失配」。
 *
 * 输出是给人看的：哪条补丁、哪个文件、pattern 开头 80 字符。
 */

import fs from "node:fs";
import path from "node:path";

const STAMP_FILE = "patch-drift.json";

/** 与 core.js 的 asLf 保持一致：CRLF 归一后再比对。 */
function asLf(text) {
  return String(text || "").replace(/\r\n/g, "\n");
}

function fileKeysOf(p) {
  return Array.isArray(p.file) ? p.file : [p.file];
}

/**
 * 这条补丁在给定文本上是不是已经打好了 —— 与 core.js 的 patchApplied() 同语义。
 *
 * 判据是「标记」而不是「原文」：marker 是 replace 里那句特征串（或显式的 marker
 * 字段），打上了它才在；原文 pattern 恰恰相反，打上了它就不在了。两者不能混用。
 */
function patchAppliedLike(hay, patch) {
  if (Array.isArray(patch.forbid) && patch.forbid.some((marker) => hay.includes(asLf(marker)))) return false;
  if (Array.isArray(patch.markers) && patch.markers.length > 0) {
    const match = patch.markersAny ? "some" : "every";
    return patch.markers[match]((marker) => hay.includes(asLf(marker)));
  }
  if (patch.marker) return hay.includes(asLf(patch.marker));
  if (typeof patch.replace === "string" && patch.replace.length > 0) {
    return hay.includes(asLf(patch.replace).split("\n")[0].slice(0, 60));
  }
  return false;
}

/** 原文 pattern 里还有几条没被替换掉 —— 也就是「还有活可干」。 */
function remainingWork(hay, patch) {
  const reps = Array.isArray(patch.replacements)
    ? patch.replacements
    : (patch.patterns ?? []).map((pattern) => ({ pattern, replace: patch.replace }));
  const missed = [];
  let total = 0;
  let hit = 0;
  for (const { pattern, replace } of reps) {
    if (!pattern || typeof replace !== "string") continue;
    total += 1;
    const found =
      pattern instanceof RegExp
        ? new RegExp(pattern.source, String(pattern.flags || "").replace("g", "")).test(hay)
        : hay.includes(asLf(pattern));
    if (found) hit += 1;
    else missed.push(pattern instanceof RegExp ? `/${pattern.source}/` : asLf(pattern));
  }
  return { total, hit, missed };
}

function stampPath(dshHome) {
  return path.join(dshHome, "prompt-anchor", STAMP_FILE);
}

function readStamp(dshHome) {
  try {
    return JSON.parse(fs.readFileSync(stampPath(dshHome), "utf8"));
  } catch {
    return null;
  }
}

function writeStamp(dshHome, data) {
  try {
    fs.mkdirSync(path.join(dshHome, "prompt-anchor"), { recursive: true });
    fs.writeFileSync(stampPath(dshHome), JSON.stringify(data, null, 2), "utf8");
  } catch {
    /* 写不进去就算了，自检本身不该让宿主启动失败 */
  }
}

/** 当前内核版本号（读解开的 app 目录里的 package.json）。 */
function kernelVersion(aiBase) {
  if (!aiBase) return "";
  const candidates = [
    path.join(aiBase, "dsh", "package.json"),
    path.join(aiBase, "..", "package.json"),
  ];
  for (const fp of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(fp, "utf8"));
      if (pkg && typeof pkg.version === "string") return pkg.version;
    } catch {
      /* 下一个 */
    }
  }
  return "";
}

function readText(fp, textCache) {
  let text = textCache.get(fp);
  if (text === undefined) {
    try {
      text = fs.readFileSync(fp, "utf8");
    } catch {
      text = "";
    }
    textCache.set(fp, text);
  }
  return text;
}

/**
 * 一条补丁里哪些文件**还没打上**。
 *
 * 面板的状态是整条补丁一个值（任一文件打上就算 applied），所以一条 5 文件的
 * 补丁可能在面板上显示「已应用」，实际有 1 个文件没跟上。这里把那些文件点出来，
 * 只在报告里附带，不改面板语义。
 */
function gapsOf(files, patch, textCache) {
  const out = [];
  for (const key of fileKeysOf(patch)) {
    const fp = files[key];
    if (!fp) continue;
    for (const one of Array.isArray(fp) ? fp : [fp]) {
      if (!one) continue;
      const text = readText(one, textCache);
      if (!text) continue;
      if (!patchAppliedLike(asLf(text), patch)) out.push(one);
    }
  }
  return out;
}

/**
 * 跑一次完整自检。
 *
 * @param {object} core   lib/core.js 的命名空间（需要 patchStatus / ALL_PATCHES / targetFiles）
 * @param {object} opts   { aiBase, dshHome }
 * @returns {Promise<object>}
 */
export async function checkPatchDrift(core, opts = {}) {
  const dshHome = opts.dshHome || process.env.DSH_HOME || "";
  const aiBase = opts.aiBase || "";

  // 内核没解开时没有任何补丁能落地 —— 这是「失效」的第一种原因，必须单独报出来，
  // 不能笼统算成一批 missing_file（那看起来像全部补丁都写错了，实际只是没得写）。
  if (!aiBase) {
    const prev0 = readStamp(dshHome);
    const counts = { applied: 0, pending: 0, skipped: 0, unmatched: 0, missing_file: 0, na: 0 };
    writeStamp(dshHome, { kernel: "", at: new Date().toISOString(), counts, stale: [], noAiBase: true });
    return {
      kernel: "",
      previous: prev0?.kernel || "",
      versionChanged: false,
      noAiBase: true,
      counts,
      stale: [],
      drift: [],
      rows: [],
    };
  }

  // 状态一律问 core：面板、CLI、自检读同一份判定，才不会互相打脸。
  const status = await core.patchStatus(aiBase);
  const patches = core.ALL_PATCHES || [];
  const files = core.targetFiles(aiBase, dshHome);
  const textCache = new Map();

  const counts = { applied: 0, pending: 0, skipped: 0, unmatched: 0, missing_file: 0, na: 0 };
  const stale = [];
  const rows = [];

  for (const patch of patches) {
    const st = status[patch.id] || "na";
    counts[st] = (counts[st] || 0) + 1;
    // 整体已应用、但个别文件没跟上的，单独列出来（不改面板语义，只做提示）。
    const gaps = st === "applied" ? gapsOf(files, patch, textCache) : [];
    rows.push({ id: patch.id, name: patch.name, status: st, layer: patch.layer, gaps });

    // 「落不了地」= 原文对不上（skipped / unmatched / missing_file）。
    // pending 不算问题，那是还没点「应用」。
    if (st === "skipped" || st === "unmatched" || st === "missing_file") {
      let pattern = "";
      for (const key of fileKeysOf(patch)) {
        if (pattern) break;
        const fp = files[key];
        if (!fp) continue;
        for (const one of Array.isArray(fp) ? fp : [fp]) {
          if (!one) continue;
          const miss = remainingWork(asLf(readText(one, textCache)), patch);
          if (miss.missed.length > 0) {
            pattern = String(miss.missed[0] || "").slice(0, 80);
            break;
          }
        }
      }
      stale.push({ id: patch.id, name: patch.name, layer: patch.layer, status: st, pattern });
    }
  }

  // 与上次快照比对：只有「状态变差」才值得报警。
  // 首次运行没有快照，只记录基线，不报警（否则一装上就红一片，没人会再看它）。
  const now = kernelVersion(aiBase);
  const prev = readStamp(dshHome);
  const prevStatus = prev?.statuses || null;

  const drift = [];
  if (prevStatus) {
    for (const row of rows) {
      const before = prevStatus[String(row.id)];
      if (!before) continue; // 上次没有这条（新增补丁），不算漂移
      if (severity(row.status) > severity(before)) {
        const detail = stale.find((s) => s.id === row.id);
        drift.push(detail || { id: row.id, name: row.name, layer: row.layer, status: row.status, pattern: "" });
      }
    }
  }

  const statuses = {};
  for (const row of rows) statuses[String(row.id)] = row.status;

  writeStamp(dshHome, {
    kernel: now,
    at: new Date().toISOString(),
    counts,
    statuses,
    stale: stale.map((s) => ({ id: s.id, name: s.name, status: s.status, pattern: s.pattern })),
  });

  return {
    kernel: now,
    previous: prev?.kernel || "",
    versionChanged: Boolean(prev?.kernel) && prev.kernel !== now,
    counts,
    stale,
    drift,
    rows,
  };
}

/** 越大越糟。用于判断一条补丁这次是不是比上次更差。 */
function severity(status) {
  return { applied: 0, na: 0, pending: 1, skipped: 2, unmatched: 2, missing_file: 2 }[status] ?? 1;
}

/** 把自检结果渲染成人能读的一段日志。 */
export function formatDriftReport(result) {
  const lines = [];

  if (result.noAiBase) {
    lines.push("[dsh-prompt-anchor] ⚠ 找不到内核插件根（aiBase）—— 补丁一条都打不上。");
    lines.push(
      "    原因通常是 app.asar 还没解开：桌面端要在插件面板点「应用」，它会把 app.asar 解到 resources/app 再重启。"
    );
    lines.push("    另一种原因是 DSH 升级后换了安装路径，旧路径失效 —— 这时点一次「应用」会重新定位。");
    return lines.join("\n");
  }

  const c = result.counts || {};
  const dead = (c.skipped || 0) + (c.unmatched || 0) + (c.missing_file || 0);
  lines.push(
    `[dsh-prompt-anchor] 补丁自检：已应用 ${c.applied || 0} · 待应用 ${c.pending || 0} · 落不了地 ${dead} · 不适用 ${
      c.na || 0
    }（内核 ${result.kernel || "未知"}）`
  );

  if (result.versionChanged) {
    lines.push(`[dsh-prompt-anchor] 检测到 DSH 内核版本变化：${result.previous} → ${result.kernel}`);
  }

  if (result.drift && result.drift.length > 0) {
    lines.push(
      `[dsh-prompt-anchor] ⚠ 本次升级导致 ${result.drift.length} 条补丁失配（DSH 改了这些代码，pattern 已对不上）：`
    );
    for (const s of result.drift.slice(0, 12)) {
      lines.push(`    #${s.id} ${s.name} [${s.layer}]`);
      lines.push(`       pattern: ${s.pattern}`);
    }
    if (result.drift.length > 12) lines.push(`    …还有 ${result.drift.length - 12} 条，详见 ${STAMP_FILE}`);
    lines.push(
      "[dsh-prompt-anchor] 处理办法：打开插件面板点「应用」重打一遍；仍失配的条目需要更新 pattern（见 lib/core.js 对应 id 的 replacements）。"
    );
  } else if (result.stale && result.stale.length > 0) {
    lines.push(
      `[dsh-prompt-anchor] 有 ${result.stale.length} 条补丁在这版内核上落不了地（与上次快照相同，不是本次升级造成的）。`
    );
    for (const s of result.stale.slice(0, 6)) lines.push(`    #${s.id} ${s.name} [${s.layer}] ${s.status}`);
    if (result.stale.length > 6) lines.push(`    …还有 ${result.stale.length - 6} 条，详见 ${STAMP_FILE}`);
  }

  const gappy = (result.rows || []).filter((r) => r.status === "applied" && r.gaps && r.gaps.length > 0);
  if (gappy.length > 0) {
    lines.push(`[dsh-prompt-anchor] 另有 ${gappy.length} 条补丁整体已应用，但有个别文件没跟上：`);
    for (const r of gappy.slice(0, 6)) {
      lines.push(`    #${r.id} ${r.name} → ${r.gaps.map((fp) => path.basename(String(fp))).join("、")}`);
    }
    if (gappy.length > 6) lines.push(`    …还有 ${gappy.length - 6} 条`);
  }

  return lines.join("\n");
}
