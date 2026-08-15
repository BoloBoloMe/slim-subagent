# 状态: 已关闭
# 类型: prototype
# 阻塞于: MILESTONE-03

## 问题

B/C — Widget 面板 + Footer 摘要原型 (基于 M03 骨架, 假数据): `setWidget` (aboveEditor/belowEditor) + `setFooter`/`setStatus`.

与用户确认手感:
- widget 高度预算 (几行不压迫 composer), aboveEditor vs belowEditor;
- 与 plan-mode 等其他扩展 widget 的堆叠共存行为;
- footer 摘要与 pi 内建 footer 的信息竞争/宽度冲突;
- B/C 升级与否的成本判断材料 (决策在 M07 拍板, 不在本站).

调用 `prototype` skill. 完成标准: 原型文件已写, B/C 升级决策材料齐备.
