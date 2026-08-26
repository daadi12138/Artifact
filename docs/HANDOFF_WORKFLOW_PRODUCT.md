# Artifact 工作流产品交接文档

更新时间：2026-08-26
工作目录：`/Users/luoshuai/workspace/artifact`

## 1. 交接结论

当前项目已经完成了工作流产品化所需的大部分核心服务能力：项目导入、Git Worktree 隔离、真实 Agent 编码与验证、Artifact Schema、审批、暂停/补充说明、重试和进程丢失恢复、工作流草稿与不可变发布版本。

当前尚未完成的是前端主页面的最后接线：新的工作流库和运行工作台组件已经存在，但 `page.tsx` 仍然主要使用旧的“编辑器直接运行 / 运行记录抽屉”模型。因此当前状态不是可发布状态，下一步应优先完成 UI 状态边界和入口改造，再做视觉和浏览器验证。

## 2. 产品目标

产品分为两个明确阶段：

```text
工作流编辑器
  -> 选择模板或创建草稿
  -> 编辑节点、数据流、执行器和输入契约
  -> 自动保存草稿
  -> 发布不可变版本

运行工作台
  -> 选择已发布工作流版本
  -> 输入文字、上传本地文件/图片、添加网页参考地址
  -> 创建独立 Run 和 Worktree
  -> 查看每个节点的公开活动、Attempt、Artifact 和代码 Diff
  -> 审批、暂停、补充说明、继续、取消、失败节点重试
  -> 检查最终 Worktree、分支、测试结果和交付 Diff
```

Electron 和 CLI 都应直接调用 `artifact-core`，Electron 不通过执行 CLI 命令完成业务。

## 3. 已完成能力

### 3.1 工作流库与版本

主要实现位于：

- [`src/workflow-config.ts`](/Users/luoshuai/workspace/artifact/src/workflow-config.ts)
- [`src/app/api/workflow/route.ts`](/Users/luoshuai/workspace/artifact/src/app/api/workflow/route.ts)
- [`src/app/workflow-library.tsx`](/Users/luoshuai/workspace/artifact/src/app/workflow-library.tsx)

已实现：

- 工作流库持久化到 `.artifact/workflows.json`。
- 保留旧版 `.artifact/workflow.json` 的迁移逻辑。
- 内置模板：功能交付、问题修复与代码审核、UI 实现。
- 草稿更新接口：`PUT /api/workflow`。
- 模板创建接口：`POST /api/workflow { action: "create" }`。
- 发布接口：`POST /api/workflow { action: "publish", id }`。
- 发布版本不可变，草稿后续修改不会改变既有发布版本。
- 工作流定义包含节点、边、输入契约和输出 Schema 信息。

### 3.2 Run、Worktree 和恢复

主要实现位于：

- [`src/run-manager.ts`](/Users/luoshuai/workspace/artifact/src/run-manager.ts)
- [`src/app/api/runs/route.ts`](/Users/luoshuai/workspace/artifact/src/app/api/runs/route.ts)
- [`src/app/api/runs/[id]/route.ts`](/Users/luoshuai/workspace/artifact/src/app/api/runs/%5Bid%5D/route.ts)

已实现：

- Run 启动时冻结输入、项目环境和工作流发布版本引用。
- 每个 Run 使用独立 Git Worktree 和临时分支。
- Agent 节点通过 Codex 或 Claude Code 适配器执行真实只读分析或工作区写入。
- 验证命令只在 Worktree 中执行。
- 命令首次使用时进入审批；允许后写入项目命令白名单。
- 每个节点有独立 Attempt 历史，重试不会覆盖旧 Attempt。
- 支持人工审批、拒绝、取消。
- 支持暂停运行、添加操作员说明、从新 Attempt 继续。
- 支持 `process_lost` 后恢复未完成 Run。
- 支持从失败节点重试，并复用有效的上游 Artifact。
- 支持在 Electron 中打开 Worktree。

### 3.3 Artifact Schema 和公开活动

已实现：

- Artifact 版本化、原子写入、内容哈希和上游血缘。
- Artifact payload 在写入时校验 Schema。
- 已覆盖 `run-input`、`operator-note`、`code-diff` 等核心类型。
- 下游节点通过明确的 Artifact ID 消费上游版本，不使用模糊的运行时 `latest` 查找。
- 运行事件中只展示公开的输入、命令、状态、输出、产物和操作员动作。
- 不持久化、不显示私有 Chain-of-Thought；界面必须继续保持这一边界。

### 3.4 执行器配置

当前生产可用执行器：

- Codex
- Claude Code

未来扩展卡片已存在但不可运行：

- Gemini CLI
- Grok Build
- OpenCode
- Pi

执行器配置和模型发现主要位于：

- [`src/executor-config.ts`](/Users/luoshuai/workspace/artifact/src/executor-config.ts)
- [`src/app/executor-settings.tsx`](/Users/luoshuai/workspace/artifact/src/app/executor-settings.tsx)

已实现：

- 本机执行器扫描和连接状态。
- Codex 模型目录读取。
- Claude CLI 模型别名读取。
- 模型选择白名单校验。
- 不保存 API Key；优先使用各 CLI 自己的登录状态。

## 4. 当前前端状态和已知缺口

### 4.1 新组件已存在，但尚未挂载

新运行工作台位于：

- [`src/app/run-workspace.tsx`](/Users/luoshuai/workspace/artifact/src/app/run-workspace.tsx)

它已经包含：

- 只选择已发布工作流版本。
- 文字需求输入。
- 本地文件和图片上传，并冻结为 Data URL 附件。
- HTTP(S) 网页参考地址输入。
- 最近运行列表。
- 节点轨道和节点状态。
- 输入、公开活动、Artifact、Diff 四个页签。
- 命令审批和人工审批。
- 暂停、补充说明、继续、取消、失败节点重试。
- Worktree Finder 打开入口。

但是 `page.tsx` 当前没有将它作为 `activeView === 'runs'` 的主内容挂载，仍然渲染旧的 `RunsView`。

### 4.2 `page.tsx` 仍是旧状态模型

主要文件：

- [`src/app/page.tsx`](/Users/luoshuai/workspace/artifact/src/app/page.tsx)

当前仍存在：

- 旧的单工作流 `nodes` / `edges` 状态。
- 旧的 `/api/workflow` 单定义加载和自动保存逻辑。
- 编辑器直接调用 `/api/runs` 的 `runWorkflow`。
- 旧 `RunsView` 和 `DetailPanel`。
- 编辑器顶部仍然有“运行”按钮，尚未改为“发布版本”。
- 工作流导航默认不是工作流库入口。

虽然文件已经导入 `RunWorkspace`、`WorkflowLibraryView` 和 `WorkflowMode`，但这些导入尚未完成实际接线。

### 4.3 当前类型检查错误

最近一次 `npm run typecheck` 结果：失败，只有两个明确错误：

1. `src/app/page.tsx:769`
   - 使用了 `Play` 图标，但顶部 `lucide-react` 导入列表没有 `Play`。
2. `src/app/page.tsx:871`
   - `stateLabel` 的状态映射缺少 `paused`，但 `NodeState` 已包含该状态。

这两个错误应在继续重构前修掉，避免后续错误噪声。

### 4.4 样式缺口

现有样式主要覆盖旧编辑器：

- [`src/app/styles.css`](/Users/luoshuai/workspace/artifact/src/app/styles.css)
- [`src/app/chrome.css`](/Users/luoshuai/workspace/artifact/src/app/chrome.css)
- [`src/app/canvas.css`](/Users/luoshuai/workspace/artifact/src/app/canvas.css)

`run-workspace.tsx` 和 `workflow-library.tsx` 使用了大量 `run-*`、`workflow-library-*` 类名，但当前样式还没有完整补齐。因此即使挂载组件，也需要补一轮 VS Code 风格的密集布局、滚动区域、按钮状态、节点轨道、Artifact 面板和响应式约束。

## 5. 推荐实施顺序

### 第一步：修复基线类型错误

在 [`src/app/page.tsx`](/Users/luoshuai/workspace/artifact/src/app/page.tsx) 中：

- 导入 `Play`。
- 在旧 `stateLabel` 中补 `paused: '已暂停'`。

然后运行：

```bash
npm run typecheck
```

### 第二步：在 `page.tsx` 接入工作流库

新增或整理状态：

```ts
const [workflows, setWorkflows] = useState<WorkflowRecordView[]>([])
const [templates, setTemplates] = useState<WorkflowTemplateView[]>([])
const [workflowMode, setWorkflowMode] = useState<'library' | 'editor'>('library')
const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null)
const [workflowBusyId, setWorkflowBusyId] = useState<string | null>(null)
```

加载 `/api/workflow` 后：

- 保存 `workflows` 和 `templates`。
- 默认选中第一个工作流草稿。
- 将选中的 draft 转换为画布需要的 `WorkflowNode[]`，统一补 `state: 'idle'`。
- 不再让编辑器直接以旧的无 `id` 形式更新默认工作流。

### 第三步：草稿自动保存和模板/发布动作

- 画布节点和边变化后，向 `/api/workflow` 发送包含 `id` 的 `PUT`。
- 导入工作流时更新当前选中草稿，而不是写回旧的默认定义接口。
- 模板创建调用 `POST /api/workflow`，成功后刷新库并进入编辑器。
- 发布调用 `POST /api/workflow { action: 'publish', id }`，成功后刷新库。
- 发布前可在编辑器顶部显示“草稿已保存 / 有未保存修改 / 已发布 vN”。

### 第四步：拆分三个主视图

主渲染逻辑建议变成：

```tsx
{activeView === 'workflow' && workflowMode === 'library' && (
  <WorkflowLibraryView ... />
)}
{activeView === 'workflow' && workflowMode === 'editor' && (
  <WorkflowView ... />
)}
{activeView === 'runs' && (
  <RunWorkspace
    workflows={workflows}
    projectName={projectName}
    onEditWorkflow={openWorkflowEditor}
  />
)}
```

具体交互：

- 点击“工作流”默认进入库。
- 点击“编辑草稿”进入编辑器。
- 编辑器增加“返回工作流库”。
- 编辑器主动作从“运行”改成“发布”或“发布新版本”。
- 库中的“运行已发布工作流”进入 `runs`。
- `RunWorkspace` 只允许选择 `published.at(-1)` 存在的工作流。

### 第五步：收敛旧运行代码

短期可以保留旧 `RunsView`、`DetailPanel` 和旧 `runWorkflow` 以降低改动风险，但它们不能继续作为主入口。

接线稳定后再删除或隔离：

- 旧 `RunsView`。
- 编辑器内的审批 footer。
- 编辑器底部运行日志中依赖旧 Run 状态的内容。
- `openRunWorkflow` 这类把运行状态写回编辑器节点的逻辑。

编辑器底部可以保留“编辑活动 / 保存状态”，但不要继续展示会误导用户的旧运行状态。

### 第六步：补齐运行工作台样式

建议在 [`src/app/chrome.css`](/Users/luoshuai/workspace/artifact/src/app/chrome.css) 末尾新增运行工作台样式，或新建并在 [`src/app/layout.tsx`](/Users/luoshuai/workspace/artifact/src/app/layout.tsx) 引入独立 CSS。

至少覆盖：

- `.workflow-library-view`
- `.workflow-record-list`
- `.workflow-record`
- `.workflow-template-grid`
- `.run-workspace`
- `.run-launch-*`
- `.run-history-rail`
- `.run-console`
- `.run-node-rail`
- `.run-node-item`
- `.run-console-main`
- `.run-console-tabs`
- `.run-event-list`
- `.console-artifact-list`
- `.diff-panel`
- `.run-context-panel`
- `.run-approval-card`
- `.run-steering-card`
- `.run-retry-card`

设计约束：

- 延续现有 VS Code 风格：活动栏、主侧栏、工作区和右侧上下文栏。
- 高频拖拽、平移、缩放、快捷键不加动画。
- 只为偶发菜单、面板切换和状态提示使用 `transform` / `opacity` 过渡。
- 使用现有 `--ease-out`、`--ease-in-out` token。
- 添加 `prefers-reduced-motion` 处理。
- 不使用嵌套卡片和过度圆角。

## 6. 验证清单

### 自动验证

```bash
npm run typecheck
npm test
npm run build
```

当前已知结果：

- `npm test`：20/20 通过。
- `npm run typecheck`：2 个前端错误，见第 4.3 节。
- `npm run build`：本次交接前未重新执行，应在接线完成后执行。

### 浏览器手工验证

启动：

```bash
npm run dev
```

然后访问 `http://127.0.0.1:3000`，按以下路径检查：

1. 初始进入项目设置，导入或创建 Git 项目。
2. 进入“工作流”，确认默认显示工作流库，而不是直接显示画布。
3. 使用“功能交付”模板创建新草稿。
4. 编辑节点名称、执行器、输入边和输出 Schema，刷新页面确认草稿保留。
5. 点击“发布”，确认库中出现 `已发布 v1`。
6. 修改草稿并再次发布，确认出现 `v2`，旧 v1 不变。
7. 进入“运行”，确认只能选择已发布工作流。
8. 输入一句文字需求，上传图片或文件，添加一个 HTTP(S) 参考地址。
9. 开始运行，确认输入被冻结并生成 `run-input` Artifact。
10. 在节点轨道查看状态和公开活动，不出现私有思考过程。
11. 遇到命令审批时允许或拒绝，确认允许后成为项目白名单默认授权。
12. 运行中暂停，填写操作员说明，继续后确认产生新的 Attempt 和 `operator-note` Artifact。
13. 代码节点完成后查看 `code-diff` Artifact，确认可读取 Diff。
14. 失败后从当前节点重试，确认旧 Attempt 保留且下游状态正确恢复。
15. 在 Electron 中点击 Worktree 入口，确认能在 Finder 打开隔离目录。

## 7. 重要边界和风险

- 不要把 Agent 的私有 Chain-of-Thought 做成 UI 功能；只展示公开活动、输入、命令、输出、Artifact 和摘要。
- 不要让 Electron 通过 shell 调 CLI 执行业务；两者都应调用 `artifact-core`。
- 不要把用户导入的工作目录当作 Agent 写入目录；所有写入必须进入 Run Worktree。
- 不要让运行引用可变草稿；Run 必须引用发布版本快照。
- 不要允许未审查的命令默认执行。
- 未签名和未公证的 macOS 构建仅适合本地测试和内部分发。
- 工作目录当前没有可用的 `.git` 元数据，`git status` 会报 `not a git repository`；不要据此清理或回滚文件。

## 8. 当前文件优先级

继续开发时建议按以下顺序阅读：

1. [`src/app/page.tsx`](/Users/luoshuai/workspace/artifact/src/app/page.tsx)：主入口，当前最需要接线。
2. [`src/app/run-workspace.tsx`](/Users/luoshuai/workspace/artifact/src/app/run-workspace.tsx)：新的运行工作台。
3. [`src/app/workflow-library.tsx`](/Users/luoshuai/workspace/artifact/src/app/workflow-library.tsx)：工作流库 UI 契约。
4. [`src/workflow-config.ts`](/Users/luoshuai/workspace/artifact/src/workflow-config.ts)：草稿、模板和发布版本。
5. [`src/run-manager.ts`](/Users/luoshuai/workspace/artifact/src/run-manager.ts)：Run、Attempt、Worktree、恢复和 Artifact。
6. [`src/app/executor-settings.tsx`](/Users/luoshuai/workspace/artifact/src/app/executor-settings.tsx)：执行器和模型配置。
7. [`src/app/chrome.css`](/Users/luoshuai/workspace/artifact/src/app/chrome.css)：桌面工作台布局样式。

## 9. 完成定义

今天这项拆分完成的最低标准：

- `npm run typecheck` 通过。
- `npm test` 保持 20/20 通过或新增测试后全部通过。
- `npm run build` 通过。
- 浏览器可以完成“创建模板 -> 编辑草稿 -> 发布 v1 -> 运行发布版本 -> 查看节点活动和 Artifact”。
- Electron 可以完成同一流程，且不通过执行 CLI 命令承载业务。
- 运行状态、审批、暂停/继续、重试和代码 Diff 在运行工作台中可操作。
