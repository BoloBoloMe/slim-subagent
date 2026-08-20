# /// script
# requires-python = ">=3.10"
# dependencies = ["pyyaml"]
# ///
# subagent-llm-select 的算分器: 一条命令给出委派结论, LLM 只需判画像 + 抄输出.
# 用法: uv run python score.py <画像> [thinking偏好] [--exclude <model>]...
# --exclude: 从候选剔除指定模型 (对抗任务互斥用), 可重复; 全名 provider/model 或裸 model id
# (裸 id 同名跨 provider 时全部命中); 不在模型目录的排除项会报错.
# 数据源 (pi 约定路径): 评分表 ~/.pi/agent/slim-subagent/llm-scores.yaml,
# 模型目录/价格/thinking 支持集 ~/.pi/agent/models-store.json, scoped 列表 ~/.pi/agent/settings.json.
# 规则与权重本脚本为唯一真相源; 分数数据在评分表 (per-device).
import argparse
import fnmatch
import json
import os
import sys
from pathlib import Path

import yaml

DIMS = ["coding", "knowledge", "longctx", "multimodal", "stability", "price", "speed"]
PROFILES = {  # 权重顺序 = DIMS; 0 = 不参与 (N/A 重归一化)
    "coding": [0.40, 0.10, 0.20, 0.0, 0.10, 0.10, 0.10],
    "research": [0.05, 0.35, 0.25, 0.0, 0.10, 0.10, 0.15],
    "review": [0.30, 0.20, 0.20, 0.0, 0.10, 0.05, 0.15],
    "vision": [0.10, 0.15, 0.10, 0.40, 0.10, 0.05, 0.10],  # multimodal 为门槛
    "long-doc": [0.10, 0.15, 0.45, 0.0, 0.10, 0.10, 0.10],
    "cheap-batch": [0.10, 0.05, 0.05, 0.0, 0.10, 0.35, 0.35],
    "general": [1 / 7] * 7,
}
REQUIRED = {"vision": "multimodal"}  # 画像 → 必需维度 (N/A 即过滤)
LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

AGENT_DIR = Path.home() / ".pi" / "agent"
SCORES = AGENT_DIR / "slim-subagent" / "llm-scores.yaml"
STORE = AGENT_DIR / "models-store.json"
MODELS_JSON = AGENT_DIR / "models.json"  # 自定义 provider (如网关), 合并入目录, 覆盖同名
SETTINGS = AGENT_DIR / "settings.json"
AUTH = AGENT_DIR / "auth.json"


def fail(msg: str) -> None:
    print(f"score.py: {msg}")
    sys.exit(1)


def authed_providers() -> set[str]:
    """有凭证 = auth.json 有条目, 或 models.json apiKey 非空 (字面量, 或 $ENV 引用的环境变量存在)."""
    out = set(json.loads(AUTH.read_text(encoding="utf-8")).keys())
    for provider, spec in STORE_OBJ.items():
        key = spec.get("apiKey")
        if not key:
            continue
        if key.startswith("$"):
            if os.environ.get(key[1:]):
                out.add(provider)
        else:
            out.add(provider)
    return out


def load_scoped() -> list[str]:
    """scoped = enabledModels (glob) 匹配目录 ∩ 有凭证 provider. --models CLI flag 不在内 (脚本不可得)."""
    patterns = json.loads(SETTINGS.read_text(encoding="utf-8")).get("enabledModels") or []
    authed = authed_providers()
    out = []
    for provider, spec in STORE_OBJ.items():
        if provider not in authed:
            continue
        for m in spec.get("models", []):
            full = f"{provider}/{m['id']}"
            if any(fnmatch.fnmatch(full, p) or fnmatch.fnmatch(m["id"], p) for p in patterns):
                out.append(full)
    return out


def price_scores(scoped: list[str], baseline: str) -> dict[str, float]:
    """单位成本 = 0.75×input + 0.25×output; 价格分 = 基准单位成本 ÷ 该模型单位成本."""
    units = {}
    for provider, spec in STORE_OBJ.items():
        for m in spec.get("models", []):
            full = f"{provider}/{m['id']}"
            if full in scoped or full == baseline:
                c = m.get("cost") or {}
                units[full] = 0.75 * c.get("input", 0) + 0.25 * c.get("output", 0)
    base = units.get(baseline)
    if not base:
        fail(f"基准 {baseline} 不在模型目录; 走 bootstrap 重定基准")
    return {m: base / u for m, u in units.items() if u > 0}


def supported_levels(model_id: str) -> list[str]:
    """与 pi-ai 同规: reasoning=false 仅 off; map 中 null 不支持; xhigh/max 须显式映射; 无 map 则 off~high."""
    provider, mid = model_id.split("/", 1)
    model = next((m for m in STORE_OBJ.get(provider, {}).get("models", []) if m["id"] == mid), None)
    if not model or not model.get("reasoning"):
        return ["off"]
    tmap = model.get("thinkingLevelMap")
    if tmap is None:
        return LEVELS[:5]
    # pi 规则: 键存在且值为 null → 不支持; 键缺失 → 支持, 但 xhigh/max 必须显式映射.
    return [l for l in LEVELS if (tmap[l] is not None if l in tmap else l not in ("xhigh", "max"))]


def clamp(level: str, supported: list[str]) -> str:
    """与 pi-ai clampThinkingLevel 同规: 先向上后向下取最近."""
    if level in supported:
        return level
    i = LEVELS.index(level) if level in LEVELS else -1
    for j in range(max(i, 0), len(LEVELS)):
        if LEVELS[j] in supported:
            return LEVELS[j]
    for j in range(i - 1, -1, -1):
        if LEVELS[j] in supported:
            return LEVELS[j]
    return supported[0] if supported else "off"


class Extend(argparse.Action):
    """--exclude 可重复且每次可给多个值, 累加不覆盖."""
    def __call__(self, parser, ns, values, option_string=None):
        getattr(ns, self.dest).extend(values)


def excluded_match(full: str, excluded: set[str]) -> bool:
    """全名或裸 model id 命中即排除."""
    return full in excluded or full.split("/", 1)[1] in excluded


def main() -> None:
    p = argparse.ArgumentParser(prog="score.py")
    p.add_argument("profile", choices=list(PROFILES))
    p.add_argument("thinking", nargs="?", default="high", choices=LEVELS)
    p.add_argument("--exclude", action=Extend, nargs="*", default=[], metavar="MODEL",
                   help="从候选剔除的模型 (对抗任务互斥用, 可重复/可多值; "
                        "裸 id 同名跨 provider 全命中)")
    args = p.parse_args()
    profile, pref, excluded = args.profile, args.thinking, set(args.exclude)
    # 排除项必须是目录内模型: 拦拼写错, 也防 --exclude 贪心吞掉后置位置参数后静默.
    known = {f"{pr}/{m['id']}" for pr, spec in STORE_OBJ.items() for m in spec.get("models", [])}
    known |= {f.split("/", 1)[1] for f in known}
    unknown = excluded - known
    if unknown:
        fail(f"排除项不在模型目录: {', '.join(sorted(unknown))} (检查拼写; "
             f"裸 id 会命中所有同名 provider)")
    if not SCORES.exists():
        fail(f"评分表不存在: {SCORES} — 走 SKILL.md 的 bootstrap 流程建立")
    table = yaml.safe_load(SCORES.read_text(encoding="utf-8"))
    baseline = table["baseline"]
    entries = table.get("models") or {}

    scoped = load_scoped()
    if not scoped:
        fail("scoped 列表为空 (检查 settings.json enabledModels 与 auth.json)")
    prices = price_scores(scoped, baseline)
    weights = PROFILES[profile]
    required = REQUIRED.get(profile)

    rows = []
    for full in scoped:
        if excluded_match(full, excluded):
            continue
        entry = entries.get(full)
        unscored = entry is None
        scores = {d: (entry.get(d, 1) if entry else 1) for d in DIMS}
        scores["price"] = prices.get(full, 1.0)
        if required and scores.get(required) is None:
            continue  # 必需维度 N/A → 过滤
        pairs = [(w, scores[d]) for w, d in zip(weights, DIMS) if w > 0 and scores[d] is not None]
        wsum = sum(w for w, _ in pairs)
        total = sum(w * s for w, s in pairs) / wsum if wsum else 0.0
        rows.append((total, full, unscored, clamp(pref, supported_levels(full))))

    if not rows:
        fail(f"--exclude {' '.join(sorted(excluded))} 清空了候选; 减少排除项")
    # D026: 已评分按总分降序, 未评分恒殿后 (但未被过滤, 仅存它时仍会被选).
    rows.sort(key=lambda r: (r[2], -r[0]))
    print(f"画像: {profile}" + (f" (排除: {', '.join(sorted(excluded))})" if excluded else ""))
    for i, (total, full, unscored, thinking) in enumerate(rows, 1):
        tag = " [未评分]" if unscored else ""
        print(f"{i}. {full}  {total:.3f}  thinking={thinking}{tag}")
    if rows:
        _, best, _, thinking = rows[0]
        print(f"委派: model={best} thinking={thinking}")


STORE_OBJ = json.loads(STORE.read_text(encoding="utf-8"))
if MODELS_JSON.exists():
    STORE_OBJ.update(json.loads(MODELS_JSON.read_text(encoding="utf-8")).get("providers", {}))
main()
