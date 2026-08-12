// ISSUE-02 TS-002 顺带修: 寻址链 (c) 级包名验证 (M3-04 考察点 1).
// 规格: argv[1] CLI 脚本须 realpath 后仍 runnable (.mjs/.cjs/.js) 且向上找 package.json
// `name === "@earendil-works/pi-coding-agent"` 才命中 (c), 否则落到下一级 (d) 包 bin 解析.
// 旧实现只查扩展名+existsSync, 弱于规格 — 本文件为其补测试 (命中/不命中落下一级).
// 注: TS-002 常规切片不得测试寻址链每级分支, 但本补强是上轮 review 明确要求 (任务范围含对应测试);
// getPiInvocation 仅暴露 execPath/argv1 两个可选注入点 (M3-04 规格允许的裁剪面), 不改默认行为.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getPiInvocation } from "../single.ts";

// (c) 级判定需 PI_SUBAGENT_PI_BINARY 未设 (寻址链第 1 级优先于 (c)).
function withoutPiBinary<T>(fn: () => T): T {
  const prevBinary = process.env.PI_SUBAGENT_PI_BINARY;
  delete process.env.PI_SUBAGENT_PI_BINARY;
  try {
    return fn();
  } finally {
    if (prevBinary === undefined) delete process.env.PI_SUBAGENT_PI_BINARY;
    else process.env.PI_SUBAGENT_PI_BINARY = prevBinary;
  }
}

test("TC-A1 addressing level (c) hits script under pi package root (realpath canonical)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "addr-test-"));
  try {
    // 命中: 包根 package.json name 匹配 + realpath 后仍 runnable.
    const pkgDir = path.join(tmp, "pi-pkg");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
    const realCli = path.join(pkgDir, "real-cli.mjs");
    fs.writeFileSync(realCli, "console.log('fake pi cli');\n");
    const linkCli = path.join(pkgDir, "cli-link.mjs");
    fs.symlinkSync(realCli, linkCli); // 软链入口 → realpath 应解析到真实脚本

    const inv = withoutPiBinary(() => getPiInvocation(["a", "b"], { argv1: linkCli }));
    assert.equal(inv.command, process.execPath, "(c) 命中应以 node 加载脚本");
    assert.deepEqual(inv.args, [fs.realpathSync(linkCli), "a", "b"], "应返回 realpath 后的脚本路径");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("TC-A2 addressing level (c) misses wrong package name, falls to (d) package bin", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "addr-test-"));
  try {
    // 不命中: 包名不匹配 → (c) 拒绝, 落 (d) 包 bin 解析 (dev 软链解析到本机 pi 包 dist/cli.js).
    const otherDir = path.join(tmp, "other-pkg");
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(path.join(otherDir, "package.json"), JSON.stringify({ name: "some-other-package" }));
    const fakeCli = path.join(otherDir, "fake-cli.mjs");
    fs.writeFileSync(fakeCli, "console.log('not pi');\n");

    const inv = withoutPiBinary(() => getPiInvocation(["x", "y"], { argv1: fakeCli }));
    assert.equal(inv.command, process.execPath, "(d) 包 bin 以 node 加载");
    assert.notEqual(inv.args[0], fakeCli, "(c) 不应命中非 pi 包脚本");
    assert.ok(inv.args[0].endsWith(path.join("dist", "cli.js")), `(d) 应解析到 pi 包 bin, 实际: ${inv.args[0]}`);
    assert.deepEqual(inv.args.slice(1), ["x", "y"], "业务 args 原样保留");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
