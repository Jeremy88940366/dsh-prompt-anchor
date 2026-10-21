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
 *   1. 逐条把 patch 的 pattern 拿到当前内核源码里试匹配，给出
 *      applied / pending / stale 三态；
 *   2. 把 DSH 内核版本号记进本地快照，下次启动时如果版本变了、
 *      而且有补丁从 applied 掉成 stale，就明确报「DSH 升级导致 N 条补丁失配」。
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

function cloneRegExp(pattern, global) {
  let flags = String(pattern.flags || "").replace("g", "");
  if (global) flags += "g";
  return new RegExp(pattern.source, flags);
}

function matchesPattern(hay, pattern) {
  if (pattern instanceof RegExp) return cloneRegExp(pattern, false).test(hay);
  return hay.includes(asLf(pattern));
}

function patchReplacements(p) {
  if (Array.isArray(p.replacements)) return p.replacements;
  return (p.patterns ?? []).map((pat) => ({ pattern: pat, replace: p.replace }));
}

function fileKeysOf(p) {
  return Array.isArray(p.file) ? p.file : [p.file];
}

/** 一条补丁在给定文件文本上的状态。 */
function statusOf(text, patch) {
  const hay = asLf(text);
  let total = 0;
  let hit = 0;
  const missed = [];
  for (const { pattern, replace } of patchReplacements(patch)) {
    if (!pattern || typeof replace !== "string") continue;
    total += 1;
    if (matchesPattern(hay, pattern)) {
      hit += 1;
    } else {
      missed.push(pattern instanceof RegExp ? `/${pattern.source}/` : asLf(pattern));
    }
  }
  if (total === 0) return { status: "na", total, hit, missed };
  if (hit === total) return { status: "pending", total, hit, missed };
  if (hit === 0) return { status: "stale", total, hit, missed };
  return { status: "partial", total, hit, missed };
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

/** 当前内核版本号（读 app.asar 里的 package.json 或解开的目录）。 */
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

/**
 * 跑一次完整自检。
 *
 * @param {object} core   lib/core.js 的命名空间（需要 targetFiles / ALL_PATCHES）
 * @param {object} opts   { aiBase, dshHome }
 * @returns {{ kernel: string, previous: string, counts: object, stale: Array, drift: Array }}
 */
export function checkPatchDrift(core, opts = {}) {
  const dshHome = opts.dshHome || process.env.DSH_HOME || "";
  const aiBase = opts.aiBase || "";

  // 内核没解开时没有任何补丁能落地 —— 这是「失效」的第一种原因，必须单独报出来，
  // 不能笼统算成 82 条 missing_file（那看起来像全部补丁都写错了，实际只是没得写）。
  if (!aiBase) {
    const now = "";
    const prev = readStamp(dshHome);
    const counts = { applied: 0, pending: 0, stale: 0, partial: 0, na: 0, missing_file: 0 };
    writeStamp(dshHome, { kernel: now, at: new Date().toISOString(), counts, stale: [], noAiBase: true });
    return {
      kernel: now,
      previous: prev?.kernel || "",
      versionChanged: false,
      noAiBase: true,
      counts,
      stale: [],
      drift: [],
      rows: [],
    };
  }

  const files = core.targetFiles(aiBase, dshHome);
  const patches = core.ALL_PATCHES || [];

  // 每个目标文件只读一次
  const textCache = new Map();
  const textOf = (fp) => {
    if (textCache.has(fp)) return textCache.get(fp);
    let text = "";
    try {
      text = fs.readFileSync(fp, "utf8");
    } catch {
      text = "";
    }
    textCache.set(fp, text);
    return text;
  };

  const counts = { applied: 0, pending: 0, stale: 0, partial: 0, na: 0, missing_file: 0 };
  const stale = [];
  const rows = [];

  for (const patch of patches) {
    const keys = fileKeysOf(patch);
    const paths = [];
    for (const key of keys) {
      const fp = files[key];
      if (!fp) continue;
      for (const p of Array.isArray(fp) ? fp : [fp]) if (p) paths.push(p);
    }
    if (paths.length === 0) {
      counts.missing_file += 1;
      rows.push({ id: patch.id, name: patch.name, status: "missing_file", layer: patch.layer });
      continue;
    }

    // 一条补丁可能对应多个文件：取"最能说明问题"的那个状态。
    // 排序用意：pending（还能打）最乐观；partial / stale 都算失配，要报出来。
    let best = null;
    for (const fp of paths) {
      const s = statusOf(textOf(fp), patch);
      if (!best || rank(s.status) < rank(best.status)) best = { ...s, fp };
    }
    const status = best.status;
    counts[status] = (counts[status] || 0) + 1;
    rows.push({ id: patch.id, name: patch.name, status, layer: patch.layer, file: best.fp });

    // partial 也要报：一条补丁里只要有一条 pattern 对不上，那次替换就永远打不上，
    // 效果和完全失配一样 —— 只是没失配得那么彻底。
    if (status === "stale" || status === "partial") {
      stale.push({
        id: patch.id,
        name: patch.name,
        layer: patch.layer,
        file: best.fp,
        status,
        // 只留前 80 字符，够定位是哪段代码
        pattern: String(best.missed[0] || "").slice(0, 80),
        missedCount: best.missed.length,
        total: best.total,
      });
    }
  }

  function rank(s) {
    // 越小越值得先看：stale 完全打不上，partial 打一半，pending 只是还没打
    return { stale: 0, partial: 1, pending: 2, na: 3 }[s] ?? 9;
  }

  // 与上次快照比对：只有「状态变差」才值得报警。
  // 判据是每条补丁的 status 排序位次 —— stale 比 partial 差，partial 比 pending 差。
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
        drift.push(
          detail || {
            id: row.id,
            name: row.name,
            layer: row.layer,
            file: row.file,
            status: row.status,
            pattern: "",
            total: 0,
          }
        );
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
    stale: stale.map((s) => ({ id: s.id, name: s.name, file: s.file, status: s.status, pattern: s.pattern })),
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
  return { applied: 0, pending: 0, na: 0, partial: 2, stale: 3 }[status] ?? 1;
}

/** 把自检结果渲染成人能读的一段日志。 */
export function formatDriftReport(result) {
  const lines = [];

  if (result.noAiBase) {
    lines.push(
      "[dsh-prompt-anchor] ⚠ 找不到内核插件根（aiBase）—— 补丁一条都打不上。"
    );
    lines.push(
      "    原因通常是 app.asar 还没解开：桌面端要在插件面板点「应用」，它会把 app.asar 解到 resources/app 再重启。"
    );
    lines.push(
      "    另一种原因是 DSH 升级后换了安装路径，旧路径失效 —— 这时点一次「应用」会重新定位。"
    );
    return lines.join("\n");
  }

  const c = result.counts || {};
  lines.push(
    `[dsh-prompt-anchor] 补丁自检：待应用 ${c.pending || 0} · 已应用 ${c.applied || 0} · 失配 ${c.stale || 0} · 部分 ${c.partial || 0} · 文件缺失 ${c.missing_file || 0}（内核 ${result.kernel || "未知"}）`
  );

  if (result.versionChanged) {
    lines.push(
      `[dsh-prompt-anchor] 检测到 DSH 内核版本变化：${result.previous} → ${result.kernel}`
    );
  }

  if (result.drift && result.drift.length > 0) {
    lines.push(
      `[dsh-prompt-anchor] ⚠ 本次升级导致 ${result.drift.length} 条补丁失配（DSH 改了这些代码，pattern 已对不上）：`
    );
    for (const s of result.drift.slice(0, 12)) {
      lines.push(`    #${s.id} ${s.name} [${s.layer}] → ${path.basename(String(s.file || ""))}`);
      lines.push(`       pattern: ${s.pattern}`);
    }
    if (result.drift.length > 12) {
      lines.push(`    …还有 ${result.drift.length - 12} 条，详见 ${STAMP_FILE}`);
    }
    lines.push(
      `[dsh-prompt-anchor] 处理办法：打开插件面板点「应用」重打一遍；仍失配的条目需要更新 pattern（见 lib/core.js 对应 id 的 replacements）。`
    );
  } else if (result.stale && result.stale.length > 0) {
    lines.push(
      `[dsh-prompt-anchor] 有 ${result.stale.length} 条补丁失配（与上次快照相同，不是本次升级造成的）。`
    );
  }

  return lines.join("\n");
}
