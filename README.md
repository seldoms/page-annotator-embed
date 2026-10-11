# page-annotator-embed

浏览器页面标注工具的**可内嵌版**。对标 Codex 的浏览器标注：开启标注模式后点任意元素，
就地弹输入框写需求，标注以钉子形式留在元素上，支持筛选、复制/导出 Markdown。

原始项目是 Chrome MV3 扩展（`chrome.storage` 持久化）。本仓库把持久化层换成
`localStorage`，去掉扩展依赖，**两个 script 标签就能在任何网页里跑起来**，不碰业务代码。

## 仓库位置与克隆方式

本项目归 **sobey** 组织，不是 seldoms（seldoms 是 bobo-studio 工作台的归属）。

```bash
# 权威仓库（内网 Gitea，首选）
git clone ssh://git@git.wbsyb.cloud:8282/sobey/page-annotator-embed.git

# GitHub 镜像（外网可达；GitHub 上无 sobey 组织，故挂在 seldoms 下）
git clone https://github.com/seldoms/page-annotator-embed.git
```

Gitea 的 web/API 走 `https://git.wbsyb.cloud:16601`，SSH 走 **8282**（注意两者端口不同）。
内网访问 web 时若遇到 `Rejected request from RFC1918 IP to public server address`，
是反代的 DNS-rebinding 防护，**用 SSH 端口即可绕过，不影响 clone/push**。

```
src/page-annotator.js      上游 MV3 版本，逐字节未改（保持可 diff 回同步）
src/page-annotator-shim.js 内嵌适配层，所有改动都在这里
demo/index.html            多视图（SPA）接入示例
demo/single-view.html      单视图退化模式示例
```

## 这是什么，为什么强烈建议每个项目都装上

**它把「提需求」这件事的成本降到接近零。**

传统流程里提一个 UI 修改意见，链条是：截图 → 圈红框 → 写「这个按钮太窄了」→
发到群里/工单里 → 开发去图上找是哪个按钮。多一层转述就多一层歧义，
最后开发猜错了方向，你再返工一轮。

装上它之后：指着页面上那个元素直接说「这里要加个 loading」，
一条带元素路径和意见的记录就落下来了。**看得见的、指着说的、没有歧义。**

因此强烈建议：

- **开发阶段就装上。** 新页面还在迭代阶段，意见密度最高的时候，
  每个页面上挂两行 script 的成本远低于一轮「猜错方向再返工」。
- **让业务方/老板亲自上手标注。** 这是本项目最被低估的用法。
  他们不需要会写 issue、不需要截图、不需要描述「是哪个按钮」——
  打开页面，Shift+A，点一下那个元素，说人话。
  导出的 Markdown 是结构化分组的，直接就是可执行的开发任务单。
  产品、设计、管理层都能直接产出可执行反馈，而不是"口头说一句然后靠猜"。
- **联调、验收、评审现场都能用。** 会上指着页面当场标，标完当场导出，
  比会后回忆「当时好像说过那个地方」可靠得多。

它不干扰业务：标完一条自动回到待命，页面照常可点；数据只存在访问者自己的
`localStorage` 里，不往任何后端发请求。**开发阶段挂着它上生产也不构成风险。**

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
| **移动面板** | **按住面板顶部标题栏拖动**，位置自动记住（刷新仍在） |
| **移动弹窗** | **按住弹窗顶部标题栏拖动**；拖过之后它不再跟着元素跑 |
| 导出 | 面板里「复制反馈」或「下载 .md」 |

标注数据存在 `localStorage` 的 `pa:pins:*` 键下，**清除浏览器站点数据会一并清掉**。

面板位置存在 `sessionStorage` 的 `pa:panelpos` 键下，只影响本标签页，关掉即恢复默认
（右上角）。要长期摆在别处，拖完再刷新一次即可固化。

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
6. **浮层可拖动**：面板和就地弹窗都能按住标题栏拖到任意位置。面板位置持久化
   （`sessionStorage`，刷新仍在），弹窗拖过之后不再跟着目标元素跑。
   拖拽用 pointer 事件统一处理鼠标/触控/笔，松手时 clamp 回视口，
   不会拖丢。

## 维护

`page-annotator.js` 保持与上游逐字节一致，**不要改**。要 diff 同步就整文件替换，
再跑一遍 `demo/index.html` 验证适配层是否还兜得住。
