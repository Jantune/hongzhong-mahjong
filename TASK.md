# 实施记录

阶段：规则引擎已验收；主代理完成第二版 UI 重构，规则引擎与评分模块保持原实现。特殊规则中“翻红中回墙重翻”“豪华七对必须四张实牌”“海底含正常/补摸后余墙 ≤4”“特殊杠不占组”记录为当前暂定口径。

## 固定接口

UI 使用 `createGame({cap,seed,dealer,scores,round})`、`nextRound(state)`、`legalActions(state,seat)`、`applyAction(state,action)`、`visibleState(state,seat)`、`aiChoose(state,seat)`、`autoStep(state)`、`validateState(state)`。人类和 AI 的动作都来自 `legalActions`，提交时保留完整 action 对象。

UI 保存完整牌局状态，只把 `visibleState(state, 0)` 传给渲染层；其他座位只显示暗牌数量。人类手牌按牌种排序的只是显示副本，不会改变引擎手牌顺序；最后摸入牌以间隔标记。皮和赖在手牌、指示牌、牌河及特殊杠中有显著标记。桌面显示庄家、累计分数、每席副露、特殊杠和各自牌河。

反应阶段由引擎的 `legalActions` 判定下一位待回应座位，兼容响应对象从空对象开始和只记录已回应座位的状态，不依赖响应对象中的来源字段。南家若没有吃、碰、杠、和等可操作选项会自动过；有可操作选项时暂停等待玩家。托管开关可临时让 AI 接管南家，切换时会取消旧 timer。显式 URL `seed` 在重开时保持复现；没有显式 seed 时重开使用新的 `Date.now()`。下一局清除旧 timer、选中牌和等待状态，并通过 `nextRound` 继续。下一局按钮在 `phase !== 'done'` 时保持禁用。

## 验收

```powershell
node --check app.mjs
npm test
```

主代理已验收 `npm test`：31/31 通过；批量 AI 对局 220 局全部胡牌、0 荒庄，最长 264 步。新增的 3 条构造测试——抢杠、多胡时庄家顺序、碰优先于吃——均已亲跑通过。浏览器已验收连续皮杠、出牌后三家 AI 轮转、整局结算、关闭托管、下一局连庄与累计分数保留，控制台无 warning/error。

## UI 第二版

- `tiles.mjs` 独立绘制麻将牌面，筒条使用内联 SVG，万字、风牌与三元牌使用字面，皮赖同时有颜色和文字角标。
- `index.html` 与 `style.css` 重构为米白外框、绿色牌桌、手牌操作区和本局信息侧栏。牌河可滚动，窄屏手牌自适应并在手机上分行。
- 当前行动座位高亮，中央显示最近打出的牌；新摸牌固定在手牌末尾并留间隔。
- 支持 Enter 确认出牌、Esc 取消选择；规则与结算使用原生 dialog，支持焦点约束及关闭后回看结算。
- 浏览器实际完成回车出牌、托管整局、结算与规则弹窗开关；390px 窄屏检查无文档水平溢出。UI 改动后 `npm test` 再次 31/31 通过，控制台无 warning/error。
