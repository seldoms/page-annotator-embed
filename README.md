# page-annotator-embed

浏览器页面标注工具的**可内嵌版**。对标 Codex 的浏览器标注：开启标注模式后点任意元素，
就地弹输入框写需求，标注以钉子形式留在元素上，支持筛选、复制/导出 Markdown。

原始项目是 Chrome MV3 扩展（`chrome.storage` 持久化）。本仓库把持久化层换成
`localStorage`，去掉扩展依赖，**两个 script 标签就能在任何网页里跑起来**，不碰业务代码。

```
src/page-annotator.js      上游 MV3 版本，逐字节未改（保持可 diff 回同步）
src/page-annotator-shim.js 内嵌适配层，所有改动都在这里
demo/index.html            最小可跑示例
```

## 接入

```html
<script>
  // 可选。不配也能跑，会退化成「单视图」模式，全部标注归到一个分组。
  window.PageAnnotator = { config: {
    viewNames: { home: '首页', detail: '详情页' },  // 视图 id → 面板/导出里的展示名
    viewOrder: ['home', 'detail'],                // 面板分组与导出章节顺序
    viewAttr:  'data-view'                        // 单页应用切视图时改哪个 body 属性
  } };
</script>
<script src="src/page-annotator-shim.js" defer></script>
<script src="src/page-annotator.js" defer></script>
```

**shim 必须先加载**（它要先装好 `chrome.storage` 的替身）。

### 单页应用（SPA）

只在 `location` 上做的路由（如 hash 路由、或自己管状态的框架）会让
`location.pathname + search` 恒为 `/`，所有页面的标注会混进同一个桶。
这时要配 `viewNames`，并在切视图时改 `body` 的 `viewAttr` 属性：

```js
document.body.dataset.view = 'detail';
```

插件会监听到属性变化，按视图分桶存标注、切视图时自动清理并重画钉子。

**多页应用**（每次导航真的换 location）天然无需配置。

### 配置项

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `viewNames` | `object` | `{}` | 视图 id → 展示名。不传即单视图模式 |
| `viewOrder` | `string[]` | `[]` | 分组与导出章节顺序，当前视图永远排最前 |
| `viewAttr` | `string` | `data-view` | 从 `document.body` 读取的视图属性名 |

## 用法

| 操作 | 快捷键 / 入口 |
|---|---|
| 进入 / 结束标注 | `Shift+A`，或点右下角浮动按钮 |
| 提交标注 | 就地弹层里 `Enter` |
| 放弃当前这条 | `Esc` 或点弹层外（会删掉刚落的钉子） |
| 连续标注 | 面板里开「连续标注」，提交后不退出标注模式 |
| 导出 | 面板里「复制反馈」或「下载 .md」 |

标注数据存在 `localStorage` 的 `pa:pins:*` 键下，**清除浏览器站点数据会一并清掉**。

## 相对原版扩展改了什么

1. **持久化**：`chrome.storage.local` → `localStorage`，同签名 Promise 接口，
   `onChanged` 用自定义事件模拟。视图分桶、读全部桶、编辑/删除路由都走这层。
2. **标完自动暂停**：扩展版点元素是 `preventDefault` + `stopPropagation`，
   **标注开着的时候整个页面点不动**。改成提交一条后自动退出标注模式，
   面板里可开「标完一条自动暂停」关掉这个行为。
3. **交互**：Codex 式就地弹层 —— 贴被点元素弹出、越界自动翻边、滚动跟随。
4. **视觉**：纯白净版（白底 + 中性灰阶 + 单一强调色），说明文字收进右上角「?」。
5. **功能补齐**：导出聚合所有视图并生成干净 Markdown（不再漏内部键）、
   下载按钮、筛选框、清空二次确认（两次点击，非原生 `confirm`）、
   钉子按 `cssPath` 重定位（元素挪动/窗口缩放后自动跟随）。

## 维护

`page-annotator.js` 保持与上游逐字节一致，**不要改**。要 diff 同步就整文件替换，
再跑一遍 `demo/index.html` 验证适配层是否还兜得住。
