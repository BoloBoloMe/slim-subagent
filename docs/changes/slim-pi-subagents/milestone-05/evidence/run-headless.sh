#!/usr/bin/env bash
# M5 e2e 冒烟辅助: 干净环境 headless 运行新扩展一次.
# usage: run-headless.sh '<prompt>' [timeout_seconds]
# - 剥离本会话 (subagent) 继承的 PI_SUBAGENT_*/PI_OFFLINE/PI_SESSION_* env, 避免污染子进程.
# - 加载形态 (两阶段测试期): pi -ne -e ./slim-subagent/index.ts --no-session -p '<prompt>'.
# - 父会话 --mode json: text 模式下模型上下文无工具 details, 无法回显; json 模式事件流
#   的 toolResult message_end 携带 content+details 权威全量 (M5 证据捕获机制).
# - timeout 兜底 (默认 300s).
set -u
cd /var/mnt/DATA/Workspace/subagent
PROMPT="$1"
TMO="${2:-300}"
timeout "$TMO" env \
  -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_DEPTH -u PI_SUBAGENT_MAX_DEPTH \
  -u PI_SUBAGENT_RUN_ID -u PI_SUBAGENT_PARENT_RUN_ID -u PI_SUBAGENT_CHILD_AGENT \
  -u PI_SUBAGENT_FANOUT_CHILD -u PI_SUBAGENT_CHILD_INDEX -u PI_SUBAGENT_PARENT_CHILD_INDEX \
  -u PI_SUBAGENT_PARENT_DEPTH -u PI_SUBAGENT_PARENT_SESSION -u PI_SUBAGENT_PARENT_ROOT_RUN_ID \
  -u PI_SUBAGENT_ORCHESTRATOR_SESSION_ID -u PI_SUBAGENT_ORCHESTRATOR_TARGET \
  -u PI_SUBAGENT_SESSION_ID -u PI_SUBAGENT_INTERCOM_SESSION_NAME -u PI_SUBAGENT_WAIT_TOOL_ENABLED \
  -u PI_SUBAGENT_INHERIT_SKILLS -u PI_SUBAGENT_INHERIT_PROJECT_CONTEXT \
  -u PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR -u PI_SUBAGENT_PARENT_CONTROL_INBOX \
  -u PI_SUBAGENT_PARENT_EVENT_SINK -u PI_SUBAGENT_PARENT_CAPABILITY_TOKEN \
  -u PI_SUBAGENT_REQUIRED_TOOLS -u PI_SUBAGENT_TOOL_DIAGNOSTIC_PATH \
  -u PI_SUBAGENT_PI_CODING_AGENT_PACKAGE_ROOT -u PI_SESSION_FILE -u PI_SESSION_ID -u PI_OFFLINE \
  pi -ne -e ./slim-subagent/index.ts --no-session --mode json -p "$PROMPT"
