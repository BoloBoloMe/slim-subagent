# /// script
# requires-python = ">=3.10"
# dependencies = ["pyyaml"]
# ///
# subagent-llm-select 的算分器: 一条命令给出委派结论, LLM 只需判画像 + 抄输出.
# 用法: uv run python score.py <画像> [thinking偏好]
# 数据源 (pi 约定路径): 评分表 ~/.pi/agent/slim-subagent/llm-scores.yaml,
# 模型目录/价格/thinking 支持集 ~/.pi/agent/models-store.json, scoped 列表 ~/.pi/agent/settings.json.
# 规则与权重本脚本为唯一真相源; 分数数据在评分表 (per-device).
import fnmatch
import json
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
SETTINGS = AGENT_DIR / "settings.json"
AUTH = AGENT_DIR / "auth.json"


def fail(msg: str) -> None:
    print(f"score.py: {msg}")
    sys.exit(1)


def load_scoped() -> list[str]:
    """scoped = enabledModels (glob) 匹配目录 ∩ 有凭证 provider. --models CLI flag 不在内 (脚本不可得)."""
    patterns = json.loads(SETTINGS.read_text()).get("enabledModels") or []
    authed = set(json.loads(AUTH.read_text()).keys())
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
        fail(f"基准 {baseline} 不在模型目录, 无法派生价格分")
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


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] not in PROFILES:
        fail(f"用法: score.py <画像> [thinking偏好]; 画像 = {'/'.join(PROFILES)}")
    profile, pref = sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "high"
    if not SCORES.exists():
        fail(f"评分表不存在: {SCORES} — 走 SKILL.md 的 bootstrap 流程建立")
    table = yaml.safe_load(SCORES.read_text())
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

    rows.sort(reverse=True)
    print(f"画像: {profile}")
    for i, (total, full, unscored, thinking) in enumerate(rows, 1):
        tag = " [未评分]" if unscored else ""
        print(f"{i}. {full}  {total:.3f}  thinking={thinking}{tag}")
    if rows:
        _, best, _, thinking = rows[0]
        print(f"委派: model={best} thinking={thinking}")


STORE_OBJ = json.loads(STORE.read_text())
main()
