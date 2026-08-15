# 状态: 已关闭
# 类型: deliberate
# 阻塞于: MILESTONE-07

## 问题

实现方案定稿 (施工闸门, 实现走廊唯一入口):

- 模块划分: logger / projection / viewer / diagnose 等文件如何切, 与现有 index.ts/single.ts/resume.ts 的边界;
- 测试策略: 复用 test/ 基建 (`node --test`), 覆盖梯度;
- 施工顺序: 吸收 PRD §12 与契约审计行号表, 确认 M09–M14/M17 的先后与并行;
- 提交策略: 每个里程碑的 commit 边界.

调用 `deliberate` skill, 产物根目录 `docs/changes/subagent-panel/milestone-08/`.

完成标准: 方案确认, 施工图纸齐备, M09 可开工.
