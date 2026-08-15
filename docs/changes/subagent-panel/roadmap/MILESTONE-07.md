# 状态: 已关闭
# 类型: deliberate
# 阻塞于: MILESTONE-02, MILESTONE-04, MILESTONE-05, MILESTONE-06

## 问题

交互评审 + PRD 定稿. 把原型轮的全部手感转化为决策, 逐条盘问固化:

- 密度/截断/省略规则 (来自 M04);
- 快捷键方案与"按钮"隐喻的改道呈现 ([Open session]/[Copy runId]/[Diagnose] → registerCommand + registerShortcut 的文案与键位);
- B/C 形态升级与否 (来自 M05 的成本材料);
- tab 组织/键盘流/Esc 层级 (来自 M06);
- M02 的契约修订合并校对;
- 迷雾 F1 回访: per-child 实时进度升级与否 — 升级则裂出新里程碑插入实现走廊. (**已决**: M04 用户拍板升级 → MILESTONE-17, 此项过账即可)
- **形态裁决已落地** (2026-08-15 用户实测拍板): 保留 Inline Run Card (变体 C), 砍 Widget 面板 — M15 范围收窄为仅 footer; 过账即可, 不再盘.
- **footer 摘要 (§4.2) 存废**: 唯一遗留形态问题; 约束 = 与内建 footer 共存 (setFooter factory 拿 footerData 做两行), 不顶掉内建信息.
- **spinner 动效**: active 图标须转圈 (用户硬性需求); inline 卡随数据更新重绘, 动效需组件内置 timer + requestRender — 技术可行性先入 M12 验证, M07 只需确认需求优先级.

调用 `deliberate` skill, 产物根目录 `docs/changes/subagent-panel/milestone-07/`.

完成标准: 盘问闭环, PRD 从草稿转确认版落盘.
