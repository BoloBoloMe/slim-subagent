// line-protocol.ts — 行协议解析 (架构深化 候选壹: 从 runProcess 闭包拆出的深模块).
// 职责: stdout 块 → 按 \n 切段 → 单行字节上限防御 → turn_end/agent_end 巨型聚合行投影 → 完整行抛出.
// 接口即测试面: createLineProtocol + push/end/limitExceeded + onLine/onLimit 两个回调;
// 终止动作 (SIGTERM/SIGKILL) 不在本模块 — onLimit 只报诊断, 由调用方 (runProcess → termination 调度器) 执行.
// 日志: L13 protocol.output_limit / L14 aggregate.projection 随模块走 (logCtx 注入 mode/agent).

import { logEvent } from "./log.ts";

// ---- M3-01 考察点 5 + EXECUTION.md 调和 9: 16MB 单行上限 (防御) + failProtocol + 聚合投影. ----
// 单行超上限 → onLimit: 调用方记录 protocolError + error=formatProtocolOutputLimit + 终止序列;
// turn_end/agent_end 巨型聚合行 (并行图片 payload 撑爆单行) 由投影替换为保留 type/willRetry 的合成事件, 不误杀.
// MAX_PENDING_LINE_BYTES 默认 16MB (可注入): 测试用小值 env 覆盖 (ISSUE-02 风险提示, 不真造 16MB 行).
export const MAX_PENDING_LINE_BYTES = 16 * 1024 * 1024;
// 注入缝: SLIM_SUBAGENT_PENDING_LINE_BYTES env 为正整数时覆盖行上限 (惰性读取, 测试在 execute 前设 env);
// 非法/缺省回退 16MB. 与 PI_SUBAGENT_PI_BINARY/FAKE_PI_SCENARIO 同为测试注入 env 模式.
export function readPendingLineLimit(): number {
  const fromEnv = Number(process.env.SLIM_SUBAGENT_PENDING_LINE_BYTES);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : MAX_PENDING_LINE_BYTES;
}
const MAX_PROTOCOL_DIAGNOSTIC_BYTES = 4096;
const MAX_PROJECTED_JSON_DEPTH = 256;
const MAX_CAPTURED_FIELD_LEN = 64;

// failProtocol 诊断载荷 (旧码 ProtocolOutputLimit 同形; SingleResult.protocolError 字段类型).
export interface ProtocolOutputLimit {
  code: "protocol_output_limit";
  stream: "stdout" | "stderr";
  limitBytes: number;
  observedBytes: number;
  diagnosticPrefix: string;
  diagnosticTail: string;
}

// 旧码 formatProtocolOutputLimit 原文 (failProtocol 报错形态).
export function formatProtocolOutputLimit(limit: ProtocolOutputLimit): string {
  return `${limit.code}: child ${limit.stream} line exceeded ${limit.limitBytes} bytes (observed at least ${limit.observedBytes} bytes without a newline).`;
}

// ---- M3-01 考察点 5: turn_end/agent_end 巨型聚合行投影 (旧码 PI_AGGREGATE_EVENT_PROJECTOR 移植). ----
// pi JSON 模式先发粒度事件再发聚合 turn_end/agent_end (重复载荷); 并行图片读取可使单条聚合记录超行上限,
// 而每个粒度事件都合法. 只把语法合法且冗余的记录替换为运行方消费的生命周期字段 (type/willRetry), 不误杀.
// 旧码为完整 JSON tokenizer; slim 移植同构状态机, 数字语法稍宽松 (对防御目的无影响: 投影输出由本函数构造, 恒合法).
interface AggregateProjection {
  push(text: string): boolean;
  finish(): string | undefined;
}

type ProjContainer = { kind: "object" | "array"; state: string; key?: string };

function createAggregateProjection(): AggregateProjection {
  // 输入已是 string (行读取器已 toString), 无需 TextDecoder 再解码.
  const stack: ProjContainer[] = [];
  let rootClosed = false;
  let inString = false;
  let stringRole: "key" | "value" | undefined;
  let stringValue = "";
  let captureString = false;
  let escaped = false;
  let unicodeDigits = 0;
  let unicodeValue = "";
  let literal: { expected: string; index: number; value: boolean | null } | undefined;
  let inNumber = false;
  let valid = true;
  let eventType: string | undefined;
  let willRetry: boolean | undefined;

  const parent = (): ProjContainer | undefined => stack[stack.length - 1];

  // 顶层 type (字符串) / willRetry (布尔) 捕获; 嵌套层不捕获 (旧码 isTopLevelField 同款).
  const completeValue = (value?: string | boolean | null): void => {
    const c = parent();
    if (!c) {
      rootClosed = true;
      return;
    }
    if (c.kind === "object") {
      if (stack.length === 1 && c.key === "type" && typeof value === "string") eventType = value;
      if (stack.length === 1 && c.key === "willRetry" && typeof value === "boolean") willRetry = value;
      c.key = undefined;
      c.state = "comma-or-end";
    } else c.state = "comma-or-end";
  };

  const startValue = (char: string): boolean => {
    const c = parent();
    const key = c?.kind === "object" ? c.key : undefined;
    if (char === "{" || char === "[") {
      if (stack.length >= MAX_PROJECTED_JSON_DEPTH) return false;
      stack.push(char === "{" ? { kind: "object", state: "key-or-end" } : { kind: "array", state: "value-or-end" });
      return true;
    }
    if (char === '"') {
      inString = true;
      stringRole = "value";
      stringValue = "";
      captureString = key === "type" && stack.length === 1;
      escaped = false;
      unicodeDigits = 0;
      return true;
    }
    if (char === "t") literal = { expected: "true", index: 1, value: true };
    else if (char === "f") literal = { expected: "false", index: 1, value: false };
    else if (char === "n") literal = { expected: "null", index: 1, value: null };
    else if (char === "-" || (char >= "0" && char <= "9")) inNumber = true;
    else return false;
    return true;
  };

  const closeContainer = (): boolean => {
    stack.pop();
    completeValue();
    return true;
  };

  const openString = (): boolean => {
    const c = parent();
    if (!c || c.kind !== "object") return false;
    inString = true;
    stringRole = "key";
    stringValue = "";
    // 旧码同款: key 字符串仅在顶层累积 (嵌套 key 不消费, 空值无害); captureString 须在此显式重置,
    // 否则沿用上一值字符串的 capture 状态, 顶层 key 不累积 → type/willRetry 永远捕获不到.
    captureString = stack.length === 1;
    escaped = false;
    unicodeDigits = 0;
    return true;
  };

  const processChar = (char: string): boolean => {
    if (inString) {
      if (unicodeDigits > 0) {
        if (!/[0-9a-fA-F]/.test(char)) return false;
        unicodeValue += char;
        unicodeDigits--;
        if (unicodeDigits === 0 && captureString) {
          if (stringValue.length >= MAX_CAPTURED_FIELD_LEN) return false;
          stringValue += String.fromCharCode(Number.parseInt(unicodeValue, 16));
        }
        return true;
      }
      if (escaped) {
        escaped = false;
        if (char === "u") {
          unicodeDigits = 4;
          unicodeValue = "";
          return true;
        }
        if (!'"\\/bfnrt'.includes(char)) return false;
        if (captureString) {
          if (stringValue.length >= MAX_CAPTURED_FIELD_LEN) return false;
          stringValue += ({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" } as Record<string, string>)[char] ?? char;
        }
        return true;
      }
      if (char === "\\") {
        escaped = true;
        return true;
      }
      if (char === '"') {
        inString = false;
        if (stringRole === "key") {
          const c = parent();
          if (!c || c.kind !== "object") return false;
          c.key = stringValue;
          c.state = "colon";
        } else completeValue(captureString ? stringValue : undefined);
        return true;
      }
      if (char.charCodeAt(0) < 0x20) return false;
      if (captureString) {
        if (stringValue.length >= MAX_CAPTURED_FIELD_LEN) return false;
        stringValue += char;
      }
      return true;
    }
    if (literal) {
      if (char !== literal.expected[literal.index]) return false;
      literal.index++;
      if (literal.index === literal.expected.length) {
        const v = literal.value;
        literal = undefined;
        completeValue(v);
      }
      return true;
    }
    if (inNumber) {
      if (char === "," || char === "}" || char === "]" || char === " " || char === "\t" || char === "\r" || char === "\n") {
        inNumber = false;
        completeValue();
        return processChar(char);
      }
      if (!/[0-9eE.+-]/.test(char)) return false;
      return true;
    }
    if (char === " " || char === "\t" || char === "\r" || char === "\n") return true;
    const c = parent();
    if (!c) return rootClosed ? false : startValue(char);
    if (c.kind === "object") {
      if (c.state === "key-or-end" || c.state === "key") {
        if (char === "}" && c.state === "key-or-end") return closeContainer();
        if (char !== '"') return false;
        return openString();
      }
      if (c.state === "colon") {
        if (char !== ":") return false;
        c.state = "value";
        return true;
      }
      if (c.state === "value") return startValue(char);
      if (char === ",") {
        c.state = "key";
        return true;
      }
      if (char === "}") return closeContainer();
      return false;
    }
    if (c.state === "value-or-end" || c.state === "value") {
      if (char === "]" && c.state === "value-or-end") return closeContainer();
      return startValue(char);
    }
    if (char === ",") {
      c.state = "value";
      return true;
    }
    if (char === "]") return closeContainer();
    return false;
  };

  const processText = (text: string): boolean => {
    for (const char of text) if (!processChar(char)) return false;
    return true;
  };

  return {
    push(text: string) {
      if (!valid) return false;
      valid = processText(text);
      return valid;
    },
    finish() {
      if (inNumber) {
        inNumber = false;
        completeValue();
      }
      if (!valid || inString || literal || stack.length !== 0 || !rootClosed) return undefined;
      if (eventType === "turn_end") return '{"type":"turn_end"}';
      if (eventType === "agent_end" && typeof willRetry === "boolean") return JSON.stringify({ type: "agent_end", willRetry });
      return undefined;
    },
  };
}

// 旧码 PI_AGGREGATE_EVENT_PROJECTOR.accepts 同款: 只接受 turn_end/agent_end 前缀的巨型聚合行.
function acceptsAggregatePrefix(prefix: string): boolean {
  return prefix.startsWith('{"type":"turn_end"') || prefix.startsWith('{"type":"agent_end"');
}

// ---- 行读取器 (旧码 createBoundedLineReader 简化版同构): 残段字节计数, 单行超限 → 投影或 onLimit. ----

export interface LineProtocolLimitDiag {
  limitBytes: number;
  observedBytes: number;
  prefix: string;
  tail: string;
}

export interface LineProtocolHandlers {
  onLine(line: string): void; // 完整行 (普通 JSON 行或投影合成事件)
  onLimit(diag: LineProtocolLimitDiag): void; // 单行超限 (只发一次; 终止动作归调用方)
}

export interface LineProtocol {
  push(chunk: string): void; // stdout data 块
  end(): void; // close 收束: flush 残段 (投影残段合法 → 合成事件; 非法 → onLimit)
  readonly limitExceeded: boolean;
}

export function createLineProtocol(
  opts: { maxPendingLineBytes?: number; logCtx: { mode: "single" | "parallel" | "resume"; agent: string } },
  handlers: LineProtocolHandlers,
): LineProtocol {
  // 行上限本次运行固定快照 (env 可注入小值, 测试用; 默认 16MB).
  const maxPendingLineBytes = opts.maxPendingLineBytes ?? readPendingLineLimit();
  const logCtx = opts.logCtx;
  let buffer = "";
  let pendingLineBytes = 0;
  let limitExceeded = false;
  let projecting = false;
  let projection: AggregateProjection | undefined;
  let projectedBytes = 0;
  let projectedPrefix = "";
  let projectedTail = "";

  const diagnosticTail = (prior: string, segment: string): string =>
    (prior + segment).slice(-MAX_PROTOCOL_DIAGNOSTIC_BYTES);

  // failProtocol (旧码 execution.ts 同款语义): 只发一次 onLimit; L13 记录.
  const failProtocol = (observedBytes: number, prefix: string, tail: string): void => {
    if (limitExceeded) return;
    limitExceeded = true;
    // L13 (error): 协议输出超限 — failProtocol 记录 (stream/limitBytes/observedBytes).
    logEvent({ level: "error", event: "protocol.output_limit", ...logCtx, data: { stream: "stdout", limitBytes: maxPendingLineBytes, observedBytes } });
    handlers.onLimit({ limitBytes: maxPendingLineBytes, observedBytes, prefix, tail });
  };

  // 追加一段 (行内容/残段): 超限 → 前缀命中聚合事件则进投影 (合法才合成, 否则 fail), 其余直接 fail.
  const appendSegment = (segment: string): void => {
    if (segment.length === 0 || limitExceeded) return;
    if (projecting) {
      projectedBytes += Buffer.byteLength(segment);
      projectedTail = diagnosticTail(projectedTail, segment);
      if (projection?.push(segment) !== true) {
        failProtocol(projectedBytes, projectedPrefix, projectedTail);
      }
      return;
    }
    const observedBytes = pendingLineBytes + Buffer.byteLength(segment);
    if (observedBytes > maxPendingLineBytes) {
      const prior = buffer;
      const prefix = (prior + segment).slice(0, MAX_PROTOCOL_DIAGNOSTIC_BYTES);
      const tail = diagnosticTail(prior, segment);
      if (acceptsAggregatePrefix(prefix)) {
        const candidate = createAggregateProjection();
        if (!candidate.push(prior) || !candidate.push(segment)) {
          failProtocol(observedBytes, prefix, tail);
          return;
        }
        buffer = "";
        pendingLineBytes = 0;
        projecting = true;
        projection = candidate;
        projectedPrefix = prefix;
        projectedTail = tail;
        projectedBytes = observedBytes;
        return;
      }
      failProtocol(observedBytes, prefix, tail);
      return;
    }
    buffer += segment;
    pendingLineBytes = observedBytes;
  };

  // 行收束: 投影行 → finish 合成事件 (非法 → fail); 普通行 → onLine.
  const finishLine = (): void => {
    if (projecting) {
      const projected = projection?.finish();
      if (projected === undefined) {
        // L14 (debug): 投影失败 — 先记 debug 再 failProtocol (L14→L13 序列).
        logEvent({ level: "debug", event: "aggregate.projection", ...logCtx, data: { projectedBytes, ok: false } });
        failProtocol(projectedBytes, projectedPrefix, projectedTail);
      } else {
        logEvent({ level: "debug", event: "aggregate.projection", ...logCtx, data: { projectedBytes, ok: true } });
        handlers.onLine(projected);
      }
    } else if (pendingLineBytes > 0) {
      handlers.onLine(buffer);
    }
    buffer = "";
    pendingLineBytes = 0;
    projecting = false;
    projection = undefined;
    projectedPrefix = "";
    projectedTail = "";
    projectedBytes = 0;
  };

  return {
    push(chunk: string): void {
      if (limitExceeded) return;
      // 按 \n 逐段: 每段 (行内容) 先 append (超限检查/投影喂入), 再 finishLine (行收束).
      let start = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] !== "\n") continue;
        appendSegment(chunk.slice(start, i));
        if (limitExceeded) return;
        finishLine();
        if (limitExceeded) return;
        start = i + 1;
      }
      appendSegment(chunk.slice(start));
    },
    end(): void {
      // 残段 flush 仅在未超限时进行 — 超限后不再处理 stdout;
      // 投影残段在 close 收束: 合法 → 合成事件, 非法 → onLimit (旧码 reader.end() 同款).
      if (limitExceeded) return;
      if (projecting) {
        finishLine();
      } else if (buffer.trim()) {
        handlers.onLine(buffer);
      }
    },
    get limitExceeded() {
      return limitExceeded;
    },
  };
}
