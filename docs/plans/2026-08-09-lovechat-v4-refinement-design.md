# lovechat v4 精修设计

日期：2026-08-09
状态：已确认（用户选择"精修现有夜空风"）

## 设计方向

保留 v3 紫蓝粉渐变 + 玻璃拟态的骨架，把"材质、光影、层次、动效"四件事做到位，让现有设计从"好看"升级到"有质感"。

## 设计决策

| 项 | 选择 |
|---|---|
| 整体策略 | 不换骨架，专注**层次、光影、动效细节、字体** |
| 核心字体 | 保留 Instrument Serif 品牌字；正文升级到**更精致的中文搭配** |
| 主色调 | 保留紫蓝粉（--accent-purple #a855f7、--accent-pink #ec4899） |
| 表面处理 | 玻璃拟态做减法：**只在卡片用**，按钮/输入框改成**磨砂质感 + 微光边框** |
| 阴影 | 三档分层（极浅、正常、强烈）+ 顶部高光内阴影（让卡片"浮起来"） |
| 动效 | 收口到**3 个有节奏的过渡**，其余微交互靠 transition 200ms 撑住 |
| 一处大胆决策 | **正文中文换成"得意黑+Sleek 配对"**（标题）+ **PingFang SC SF Compact**（正文），更轻更有质感 |

## 关键精修点

### 1. 阴影层次化（解决"塑料感"）
```
当前: 一档 box-shadow-lg 用到底
精修:
  --shadow-xs: 0 1px 2px rgba(0, 0, 0, 0.15)         // 输入框、按钮静止
  --shadow-sm: 0 4px 12px rgba(0, 0, 0, 0.2)        // 卡片
  --shadow-md: 0 12px 32px rgba(0, 0, 0, 0.3)       // 浮层
  --shadow-glow: 0 0 32px rgba(168, 85, 247, 0.35)  // 主按钮辉光
  --shadow-glow-strong: 0 0 48px rgba(236, 72, 153, 0.5)  // 强调态
```
卡片加 **inset top 高光**：`box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1)` → 让卡片有"实体感"

### 2. 玻璃拟态减法（解决"塑料感"）
- 顶栏、输入栏保留 backdrop-filter（功能性需要，模糊下方内容）
- **按钮、消息气泡、设置项、动态卡片**：去 backdrop-filter，改用**纯色微透（surface 8% 不模糊）+ 边框微光**
- 原因：玻璃拟态泛滥失去焦点，反而显得廉价

### 3. 字体升级
- 主标题（brand-name）：保留 Instrument Serif，**加细微 letter-spacing 收紧 + text-shadow 微微发光**
- 正文：保持 PingFang SC（系统字），但**加大字间距 (line-height 1.65)，让中文更舒展**
- 时间戳等数据：保留 ui-monospace（等宽数字的关键）
- 加 **Instrument Sans 配对**（display 用 Serif，body 用 Sans，形成 serif/sans 节奏）

### 4. 气泡升级（消息区最显眼，必须做精）
- 我方气泡：从扁平渐变升级到**带内部高光 + 边框**：linear-gradient + inset 0 1px 0 rgba(255,255,255,0.25)
- 对方气泡：从单层玻璃升级到**双层边框**（内 1px 浅白、外 1px 暗紫）模拟磨砂
- 气泡尾巴：现在的"星点+拖尾线"保留（签名元素），但**拖尾线换更细的发光梯度（0.5px + 大模糊）**
- 阴影：我方气泡投影从 0 4px 14px 升级到 **0 8px 24px rgba(168, 85, 247, 0.45)**（有色辉光）
- 时间戳：和气泡间距加大，加 **淡紫色分隔线小竖条**（视觉锚点）

### 5. 动效收口
删掉/收敛当前零散动效，只保留：
- **气泡入场**（已有，加 springy 弹性）：opacity + translateY(8px) → 0 + scale(0.96 → 1)
- **主按钮按下反馈**：scale(0.96) + 加深渐变
- **通话头像光环**：已有，保留

新增：
- **背景星点缓慢呼吸**（60s 周期 opacity 0.7 ↔ 1.0），让夜空"活"起来
- **顶栏在线指示灯**：现有脉冲升级为**双层脉冲**（内核 + 外晕）
- **输入框 focus 时边框渐变流动**（conic-gradient 旋转）

### 6. 通话覆盖层升级
- 大头像：**外加一层旋转光环**（虚线圆 8s 转一圈），只在"通话中"状态显示
- 接听按钮：绿色升级为**渐变 + 顶部高光 + 大辉光**
- 挂断按钮：红色升级同上
- 卡片背景：从 6% 白色升级为 **10% 白色 + 32px backdrop blur**，边缘用细高光

### 7. 设置面板、动态卡片
- 加**顶部细高光线**（box-shadow inset 0 1px 0 white 10%）所有卡片统一
- 头像预览：现在 44px → **52px**，边框光圈 2px → 3px，更突出
- 动态卡片头像：升级到 **40px + 紫色渐变光圈**

### 8. 一处大胆（justify the risk）
**渐变背景加一层径向扫光**：body 背景除了固定的四色辐射，再叠一层 `radial-gradient(ellipse at 30% 0%, rgba(236, 72, 153, 0.08), transparent 60%)` 让左上角有**淡淡粉色探照灯**，像月光从窗外漏进来。
风险：可能让深色背景偏粉；缓解：低饱和（alpha 0.08），移动时静止（避免引起眩晕）。

## 配色（精修后变量）

```
/* 主体保持 */
--bg-base: #0a0b1e
--bg-1: #1a1244
--accent-purple: #a855f7
--accent-pink: #ec4899
--accent-blush: #f0abfc

/* 新增 - 字体颜色梯度 */
--text-strong: rgba(255, 255, 255, 1)        /* 标题 */
--text-primary: rgba(255, 255, 255, 0.92)    /* 正文 */
--text-secondary: rgba(255, 255, 255, 0.68)
--text-tertiary: rgba(255, 255, 255, 0.42)
--text-faint: rgba(255, 255, 255, 0.22)

/* 新增 - 表面质感 */
--surface: rgba(255, 255, 255, 0.05)         /* 不模糊，纯透色 */
--surface-hover: rgba(255, 255, 255, 0.09)
--surface-strong: rgba(255, 255, 255, 0.11)
--surface-glass: rgba(255, 255, 255, 0.06)   /* 配合 backdrop-filter 的玻璃 */

/* 新增 - 边框 */
--border-subtle: rgba(255, 255, 255, 0.08)
--border-default: rgba(255, 255, 255, 0.14)
--border-strong: rgba(255, 255, 255, 0.22)
--border-accent: rgba(168, 85, 247, 0.5)
```

## 排版节奏

| 元素 | 字体 | 尺寸 | 重量 | 间距 |
|---|---|---|---|---|
| brand-name | Instrument Serif Italic | 44px | 400 | letter-spacing -1.5px |
| peer-name | Instrument Sans Bold | 16px | 700 | - |
| 消息气泡 | PingFang SC | 15px | 400 | line-height 1.65 |
| meta 时间 | ui-monospace | 10.5px | 500 | letter-spacing 0.5px |
| 输入框 | PingFang SC | 15px | 400 | - |
| button | PingFang SC | 14px | 600 | letter-spacing 1px |

## 实现要点

- **不引入新依赖**（沿用 Google Fonts: Instrument Serif，加 Instrument Sans）
- **保留所有 class/id**（app.js 业务代码不动）
- **保留 ?v=2 资源引用**（这次纯样式调整，旧缓存也兼容，但建议升 v=4 强制刷新）
- **响应式**：移动端优先；桌面端保留 max-width 640px 居中
- **减弱动效偏好**：保留尊重（@media prefers-reduced-motion 已存在）

## 文件改动

- `public/style.css` —— **主要改动**，预计 +200/-100 行
- `public/index.html` —— 加 Instrument Sans 字体 link，可能需要升级资源版本号到 v=4

## 验证

1. 浏览器快照：登录页（卡片精修、星点呼吸、字体提升）
2. 主界面快照：消息列表（气泡精修、阴影分层）、输入栏（去玻璃化）
3. 通话覆盖层快照（光环旋转、按钮升级）
4. 动态视图快照（卡片质感提升）
5. 移动端 375px 宽适配（现有响应式规则验证）
6. 31 项 e2e 全绿（业务逻辑不受影响）