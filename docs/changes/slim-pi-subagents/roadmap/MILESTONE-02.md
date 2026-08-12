# 状态: 已关闭
# 类型: deliberate
# 阻塞于: MILESTONE-01

## 问题

新扩展暴露面的形状定稿:
- 工具数量与命名 (单 subagent 工具? wait 工具是否独立)
- schema 参数集 (目标 ~8-20 个参数, 对照现 63 个)
- 工具描述文案 — 这份文案是以后每次请求注入的 token, 须逐段斟酌
- chain 的表达形态 (承 M1 结论落地为具体参数/语法)
- 包名, 目录名, 装载方式 (本地扩展目录 vs npm 包)

依据: B-surface-trim.md 的 token 账本, C-rewrite.md 的官方示例 API 面.

产物: 设计定稿文件, 写入 docs/changes/slim-pi-subagents/milestone-02/.
