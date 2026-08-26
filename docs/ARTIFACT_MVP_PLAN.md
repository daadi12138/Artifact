# artifact MVP 实施计划

版本：0.1  
日期：2026-08-20  
状态：Planning Baseline

## 1. 执行摘要

本产品是一款本地优先、以 Artifact 为中心的 Agent Workflow Orchestrator。

它不负责创造新的 Coding Agent，而是将 DeepSeek Harness、Codex、Claude Code、Playwright、Git 等执行器统一到同一种步骤契约中，通过版本化中间产物、可视化 DAG、自动验证和人工审批，将一个项目或需求稳定推进为可审查的代码结果。

MVP 的核心价值不是“多个 Agent 聊天协作”，而是：

```text
明确输入
  -> 可替换执行器
  -> 结构化 Artifact
  -> 自动验证
  -> 人工 Gate
  -> 可恢复的下一步骤
  -> 独立 Worktree 中的代码结果
```

产品本身使用轻量的 Next.js + TypeScript 技术栈，通过 CLI 启动本地服务。目标项目不绑定 Next.js 或任何特定框架。

## 2. 已确认的产品决策

| 主题 | MVP 决策 |
|---|---|
| 运行形态 | 本地优先，macOS 单用户，无登录 |
| 产品技术栈 | Next.js + React + TypeScript |
| 启动方式 | CLI 启动本地服务，不自动打开浏览器，终端输出 URL |
| 目标项目 | 支持已有项目，也支持从零创建项目；不限制目标技术栈 |
| 项目识别 | 规则 + AI 自动检测，用户确认后冻结项目命令配置 |
| 新项目选型 | Agent 生成 Architecture Spec，用户批准后创建 |
| 工作流编辑 | Web 可视化拖拽 DAG |
| 工作流能力 | 串行、只读并行、条件分支、人工审批；不支持任意循环 |
| 自动修复 | Visual QA 使用有最大次数的复合节点 |
| Agent 管理 | 内置角色，可为角色选择 DeepSeek Harness、Codex 或 Claude Code |
| Agent 协作 | 只通过版本化 Artifact 传递，不共享聊天历史 |
| Harness 集成 | 独立子进程 + Executor Adapter，不 fork Harness |
| Artifact 类型 | 内置核心类型，同时允许用 JSON Schema 扩展 |
| 数据存储 | 项目内 `.artifact/` + SQLite；默认整体加入 `.gitignore` |
| 代码隔离 | 每个 Workflow Run 使用独立 Git Worktree 和临时分支 |
| 并行写入 | 只读步骤可并行；同一 Worktree 的写入步骤串行 |
| Git 权限 | 不自动提交、不自动创建 PR、不自动合并 |
| 结果交付 | 保留 Worktree 和临时分支，展示 Diff 和路径，由用户自行提交 |
| Figma | 单向导入 Figma 文件或页面，保存为版本化 Artifact |
| 本地安全 | 项目目录内执行，关键命令人工确认，MVP 不使用容器 |

## 3. 产品定义

### 3.1 一句话定位

管理研发中间产物，编排不同 AI Agent 与验证工具，将项目需求稳定推进为可审查代码结果的本地工作流系统。

### 3.2 核心用户任务

用户应该能够：

1. 导入已有 Git 项目，或从需求创建新项目。
2. 自动识别并确认项目的安装、启动、构建、测试和预览方式。
3. 在画布中搭建由 Agent、工具、验证和审批节点组成的 DAG。
4. 为不同 Agent 节点选择 DeepSeek Harness、Codex 或 Claude Code。
5. 明确声明每个节点消费和产生的 Artifact 类型。
6. 运行工作流并实时查看节点状态、Agent 活动和中间产物。
7. 在审批节点比较版本、评论、批准或请求修改。
8. 从失败节点恢复、从旧 Artifact 重跑或 Fork 一次 Run。
9. 在独立 Worktree 中检查最终 Diff，并自行完成提交和 PR。

### 3.3 MVP 不做

- 云端 SaaS、账号体系、团队协作和 RBAC。
- Docker 或远程沙箱。
- 自动 Commit、自动创建 PR、自动 Merge 或自动 Deploy。
- Figma 双向同步或代码回写 Figma。
- 任意工作流循环、动态 DAG 和子工作流。
- 完全开放的代码插件系统和 Agent Marketplace。
- 后端、移动端或特定框架的官方生成质量承诺。
- 多个写入 Agent 并行修改同一份代码。

## 4. MVP 黄金路径

MVP 内置一个可修改的官方模板：

```text
Requirement
  -> [新项目时] Architecture Spec
  -> UI Spec
  -> Human Approval
  -> Implementation
  -> Start Project
  -> Playwright Scenario
  -> Screenshot
  -> Visual QA + Bounded Auto Fix
  -> Engineering Approval
  -> Git Diff
```

说明：

- 对已有项目，Architecture Spec 可替换为 Project Context。
- UI Spec 可以引用 Figma Import Artifact；Figma 不是必选输入。
- 目标项目若没有可运行的 Web 界面，则不能使用 Screenshot 和 Visual QA 节点，但仍可使用通用 Agent、Shell、测试、审批和 Git Diff 节点。
- MVP 最终交付本地 Worktree、临时分支、Diff、测试报告和 QA 报告，不自动创建 PR。

## 5. 核心领域模型

### 5.1 Project

Project 是产品顶层实体，绑定一个 Git 仓库和一个 `.artifact/` 控制目录。

主要字段：

```ts
interface Project {
  id: string
  name: string
  repositoryPath: string
  gitRoot: string
  source: 'existing' | 'generated'
  status: 'initializing' | 'ready' | 'invalid' | 'archived'
  activeEnvironmentId: string | null
  createdAt: string
  updatedAt: string
}
```

### 5.2 Project Environment

任意技术栈通过 Project Environment 契约接入，而不是由 Workflow Engine 猜测命令。

```ts
interface ProjectEnvironment {
  id: string
  projectId: string
  version: number
  detectedStack: Array<{
    category: string
    name: string
    version?: string
    evidence: string[]
  }>
  commands: {
    install?: CommandSpec
    dev?: CommandSpec
    build?: CommandSpec
    test?: CommandSpec
    lint?: CommandSpec
    typecheck?: CommandSpec
  }
  webPreview?: {
    enabled: boolean
    preferredPort?: number
    healthcheckPath?: string
    readyPattern?: string
    routes?: string[]
  }
  confirmedByUser: boolean
  confirmedAt?: string
}

interface CommandSpec {
  command: string
  cwd: string
  envAllowlist: string[]
  timeoutMs: number
}
```

检测流程：

1. 规则扫描 manifest、lockfile、构建配置、CI 和 README。
2. 检测 Agent 给出候选技术栈和命令，并附证据。
3. 用户确认或修改。
4. 保存一个不可变版本；一次 Workflow Run 固定引用该版本。

### 5.3 Workflow Definition

Workflow Definition 是可视化 DAG 的版本化定义。

```ts
interface WorkflowDefinitionVersion {
  id: string
  workflowId: string
  version: number
  name: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  inputSchema: JsonSchema
  createdAt: string
}
```

已启动的 Run 永远引用定义快照，不随画布后续编辑变化。

### 5.4 Workflow Run

```ts
type RunStatus =
  | 'created'
  | 'preparing'
  | 'running'
  | 'awaiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

interface WorkflowRun {
  id: string
  projectId: string
  workflowDefinitionVersionId: string
  environmentVersionId: string
  baseGitRef: string
  branchName: string
  worktreePath: string
  status: RunStatus
  startedAt?: string
  endedAt?: string
}
```

### 5.5 Step Run 与 Attempt

Step Run 表示 DAG 节点的业务状态；Attempt 表示一次具体执行。

```ts
type StepStatus =
  | 'blocked'
  | 'ready'
  | 'queued'
  | 'running'
  | 'validating'
  | 'awaiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'skipped'

interface StepRun {
  id: string
  runId: string
  nodeId: string
  status: StepStatus
  resolvedInputBindings: ArtifactVersionRef[]
  activeAttemptId?: string
}

interface StepAttempt {
  id: string
  stepRunId: string
  attempt: number
  executorId: string
  executorConfigSnapshot: unknown
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  startedAt?: string
  endedAt?: string
  exitReason?: string
  cost?: UsageRecord
}
```

重试创建新的 Attempt，不覆盖旧 Attempt。重新运行已成功节点时创建新的输出 Artifact Version，并使下游节点进入需要重算状态。

## 6. Artifact 系统

### 6.1 Artifact 原则

1. Artifact 是一等业务实体，不是日志附件。
2. Artifact Version 一旦写入便不可修改。
3. 每个版本必须记录精确输入版本、创建步骤、执行器和内容哈希。
4. Artifact 内容必须通过所属类型的 Schema 验证。
5. 无效输出也要保存为候选版本和执行证据，但不能自动成为可消费版本。
6. 下游只消费明确绑定的版本，不使用模糊的 `latest` 运行时查找。

### 6.2 Artifact Type

内置类型：

- `requirement`
- `architecture-spec`
- `project-context`
- `ui-spec`
- `figma-import`
- `design-token`
- `component-spec`
- `code-change`
- `screenshot-set`
- `test-report`
- `visual-qa-report`
- `git-diff`
- `agent-report`

用户可以导入 JSON Schema 创建扩展类型。MVP 不提供 Schema 版本迁移；修改 Schema 会创建新的 Artifact Type Version。

### 6.3 Artifact Version

```ts
interface ArtifactVersion {
  id: string
  artifactId: string
  typeVersionId: string
  version: number
  status:
    | 'candidate'
    | 'validating'
    | 'awaiting_approval'
    | 'approved'
    | 'rejected'
    | 'valid'
    | 'invalid'
    | 'superseded'
  inputVersions: ArtifactVersionRef[]
  producer: {
    runId: string
    stepRunId: string
    attemptId: string
    executorId: string
  }
  manifestPath: string
  contentHash: string
  createdAt: string
}
```

### 6.4 文件布局

```text
.artifact/
├── config.yaml
├── artifact.db
├── schemas/
│   └── custom/
├── artifacts/
│   └── <artifact-id>/
│       └── v0001/
│           ├── manifest.json
│           ├── payload.json
│           └── files/
├── runs/
│   └── <run-id>/
│       ├── manifest.json
│       ├── events.jsonl
│       └── logs/
├── worktrees/
│   └── <run-id>/
└── cache/
```

初始化时建议将整个 `.artifact/` 加入 `.gitignore`。修改 `.gitignore` 前展示变更并由用户确认。

### 6.5 原子写入

Executor 不直接创建正式 Artifact Version：

1. Executor 写入 Attempt 临时目录。
2. Artifact Manager 计算哈希并执行 Schema 和文件检查。
3. 在 SQLite 事务中分配版本号、写入关系和状态。
4. 原子移动文件目录。
5. 发布 `artifact.version.created` 事件。

崩溃恢复时扫描未完成的 staging 记录，选择完成提交或标记失败，不允许出现数据库已成功但文件缺失的静默状态。

## 7. Workflow Engine

### 7.1 节点类型

MVP 提供：

| 节点 | 作用 |
|---|---|
| Agent | 调用一个 Agent Executor，读取 Artifact，产生结构化 Artifact |
| Command | 执行已确认的项目命令或受审批的自定义命令 |
| Playwright | 执行浏览器场景、收集 DOM、Console、Network 和截图 |
| Validation | 执行 Schema、命令、测试、图像或自定义规则验证 |
| Approval | 等待用户批准、拒绝或请求修改 |
| Git Diff | 生成结构化 Diff Artifact，不提交代码 |
| Condition | 基于结构化 Artifact 字段选择分支 |
| Visual QA Loop | 有次数上限的复合节点 |

通用 Agent 节点允许配置：角色、Executor、输入端口、输出 Artifact Type、Prompt Template、权限级别和超时。

### 7.2 边与端口

每个节点使用类型化端口。编辑器在连线时检查 Artifact Type 与 Schema Version 兼容性。

```ts
interface NodePort {
  id: string
  artifactTypeId: string
  required: boolean
  cardinality: 'one' | 'many'
}
```

边传递的是 Artifact Version 选择规则；Run 启动后，规则会解析为精确版本并保存。

### 7.3 调度规则

- 所有必需输入已就绪时，节点由 `blocked` 进入 `ready`。
- Approval 节点不占用 Executor Slot。
- 只读节点可以并行。
- 对同一 Run Worktree 具有写权限的节点必须获取排他锁。
- 不同 Run 有独立 Worktree，可以并行执行。
- 条件节点只能读取结构化字段，MVP 使用受限 JSON Logic，不执行任意 JavaScript。
- 进程重启后，从 SQLite 中恢复未完成 Run；正在执行且无法重连的 Attempt 标记为 `failed: process_lost`，由用户决定重试。

### 7.4 Visual QA 复合节点

内部固定状态：

```text
Capture Actual
  -> Deterministic Checks
  -> Vision Review
  -> Pass? --------------------> Complete
       no
       -> Produce QA Report
       -> Coding Fix
       -> Run Relevant Tests
       -> next iteration
```

配置：

```ts
interface VisualQaLoopConfig {
  maxIterations: number // 默认 3，最大 5
  requiredViewports: Array<{ width: number; height: number }>
  failSeverity: 'low' | 'medium' | 'high'
  pixelThreshold?: number
  requireTestsAfterFix: boolean
}
```

达到上限仍失败时，节点进入失败并保留每轮 Screenshot、QA Report 和 Code Change 的完整链路。

## 8. Executor 架构

### 8.1 统一契约

DeepSeek Harness、Codex、Claude Code、Playwright 和 Git 均是 Executor Adapter。

```ts
interface ExecutorAdapter {
  id: string
  kind: 'agent' | 'browser' | 'command' | 'git'

  probe(): Promise<ExecutorCapabilities>
  prepare(ctx: ExecutionContext): Promise<PreparedExecution>
  execute(
    prepared: PreparedExecution,
    emit: (event: ExecutionEvent) => void,
    signal: AbortSignal
  ): Promise<ExecutionResult>
  dispose(): Promise<void>
}
```

统一事件：

- `execution.started`
- `message.delta`
- `tool.started`
- `tool.completed`
- `file.changed`
- `artifact.proposed`
- `approval.requested`
- `usage.updated`
- `execution.completed`
- `execution.failed`

### 8.2 Agent 输入包

Agent 不接收上游聊天记录，而接收确定性 Input Package：

```text
input-package/
├── instruction.md
├── manifest.json
├── artifacts/
│   ├── requirement-v2/
│   └── ui-spec-v3/
├── project-context.json
└── output-contract.json
```

`manifest.json` 固定记录 Artifact ID、Version、Hash 和本地只读路径。Prompt 中要求 Agent 将正式结果写入指定 staging 目录，并满足 Output Contract。

### 8.3 DeepSeek Harness Adapter

- 以独立子进程启动，不引用 Harness 内部业务模块。
- 优先使用其 JSON-RPC stdio 协议或稳定 SDK 边界。
- 每个 Step Attempt 创建独立 Harness Session。
- Project Worktree 作为工作目录，权限由平台生成的 Harness Profile 控制。
- Harness Session ID 写入 Attempt，用于查看完整执行轨迹。
- Harness 升级通过 Adapter 兼容测试吸收，不让 Workflow Schema 依赖 Harness 类型。

### 8.4 Codex 与 Claude Code Adapter

- 通过各自非交互 CLI/SDK 子进程接入。
- 启动前执行版本和能力探测，保存版本快照。
- 将各自事件流映射为统一 Execution Event。
- 不假设两个 Agent 支持相同的继续会话、审批或工具协议。
- 平台只依赖最小共同能力：工作目录、指令、取消、退出状态、文本流、工具/文件事件和结构化结果文件。

### 8.5 Executor Capability

```ts
interface ExecutorCapabilities {
  available: boolean
  version?: string
  supportsStreaming: boolean
  supportsResume: boolean
  supportsStructuredOutput: boolean
  supportsToolApproval: boolean
  supportsImages: boolean
}
```

工作流启动前进行 preflight。缺少必需能力时阻止运行，而不是执行到中途才失败。

## 9. 内置 Agent 角色

角色和 Executor 分离。角色定义工作目标、权限和 Artifact 契约，Executor 定义如何运行。

### 9.1 Product Agent

输入：用户需求、Project Context。  
输出：Requirement Artifact。  
要求：User Story、业务规则、范围、边界条件、验收标准必须结构化。

### 9.2 Architecture Agent

仅用于新项目或显式架构变更。  
输出：Architecture Spec，包括技术栈、目录、运行命令、测试策略和关键依赖。  
必须经过人工审批才能创建项目。

### 9.3 UI Spec Agent

输入：Requirement、Project Context、可选 Figma Import。  
输出：UI Spec、Component Spec、Design Tokens。  
必须包含页面结构、组件树、状态、交互、响应式规则、可访问性和可验证验收条件。

### 9.4 Coding Agent

输入：批准的规格、项目上下文、明确文件范围。  
输出：Code Change、Agent Report。  
直接在 Run Worktree 中修改，但不能提交。

### 9.5 Browser Agent

输入：Requirement 或 UI Spec、Preview 配置。  
输出：Playwright Scenario 或 Browser Report。  
实际浏览器执行由 Playwright Executor 完成，避免让模型拥有浏览器基础设施生命周期。

### 9.6 Visual QA Agent

输入：目标 Figma/Design Artifact、实际截图、DOM/CSS 快照、确定性 Diff。  
输出：结构化 Visual QA Report。  
不得只输出自然语言评价。

## 10. Figma 单向导入

MVP 输入：Figma File/Page URL + 本地凭据。

导入内容：

- 文件、页面和节点身份。
- 指定 Frame 的渲染图。
- 节点树和基础布局属性。
- 颜色、字体、间距、圆角等可提取变量。
- Component/Instance 基础关系。
- 原始 API 响应快照及内容哈希。

输出 `figma-import` Artifact。再次导入创建新版本，不覆盖旧版本。

MVP 明确不承诺将任意 Figma 文件完美转换为 Design Tokens。导入结果是 UI Spec Agent 和 Visual QA 的证据输入，不是无损设计格式。

## 11. Visual QA 设计

Visual QA 采用三层证据，避免完全依赖视觉模型：

### 11.1 确定性检查

- Playwright 断言。
- DOM 结构和可访问性树。
- 计算样式：尺寸、间距、字体、颜色和位置。
- Console Error 和失败 Network Request。
- 目标区域像素差异和截图尺寸一致性。

### 11.2 图像差异

- 固定浏览器版本、字体、设备像素比和 Viewport。
- 支持遮罩动态区域。
- 保存 expected、actual 和 diff 三张图。
- 像素阈值只作为证据，不单独决定所有视觉质量结论。

### 11.3 Vision 语义判断

Vision Agent 根据上述证据判断层级、视觉一致性和难以用规则描述的问题。

统一 Issue Schema：

```ts
interface VisualQaIssue {
  id: string
  category:
    | 'layout'
    | 'spacing'
    | 'typography'
    | 'color'
    | 'responsive'
    | 'accessibility'
    | 'behavior'
  severity: 'low' | 'medium' | 'high'
  selector?: string
  region?: { x: number; y: number; width: number; height: number }
  expected?: unknown
  actual?: unknown
  evidenceFiles: string[]
  confidence: number
  recommendation: string
}
```

## 12. Git 与 Worktree

### 12.1 Run 创建

1. 检查 Git 仓库健康状态。
2. 记录用户选择的 Base Ref 和对应 Commit SHA。
3. 创建 `artifact/run-<short-id>` 临时分支。
4. 在 `.artifact/worktrees/<run-id>/` 创建 Worktree。
5. 所有写入 Executor 只在该 Worktree 中执行。

已有项目当前工作区可以有未提交修改，但这些修改不会自动进入 Run。若用户需要它们作为基础，必须先提交或明确创建快照；MVP 不静默复制 dirty changes。

### 12.2 Run 完成

产品展示：

- Worktree 路径。
- 临时分支名。
- 文件 Diff。
- 测试和 QA 结果。
- “在编辑器中打开”和“复制终端命令”。

产品不自动 Commit、Push 或创建 PR。用户确认代码后在 Worktree 中自行执行 Git 操作。

### 12.3 清理

清理 Worktree 属于显式破坏性操作，需要二次确认。存在未提交修改时默认拒绝清理，并展示导出 Patch 或保留 Worktree 的选项。

## 13. Human Approval

审批不是简单布尔字段，而是版本选择和流程决策。

```ts
interface ApprovalDecision {
  id: string
  stepRunId: string
  artifactVersionIds: string[]
  decision: 'approved' | 'rejected' | 'changes_requested'
  comment?: string
  createdAt: string
}
```

审批界面必须同时展示：

- 输入和输出 Artifact。
- 与上一版本的结构化或视觉 Diff。
- 生成者、模型、Executor 版本和执行时间。
- 验证结果。
- Agent 轨迹入口。
- Approve、Request Changes、Reject、Rerun。

`Request Changes` 会创建一条新的反馈 Artifact，并启动配置好的修订节点；不得修改已经产生的 Artifact 内容。

## 14. Web Console 信息架构

### 14.1 Projects

- 已有仓库导入。
- 新项目创建。
- Project Environment 检测和确认。
- 最近运行状态。

### 14.2 Workflow Editor

使用可视化画布，包含：

- 左侧节点面板。
- 中央 DAG 画布。
- 右侧节点配置 Inspector。
- 输入输出 Artifact 端口。
- Agent Role 和 Executor 选择。
- Schema 兼容错误。
- 工作流验证、版本保存和运行入口。

MVP 不做 BPMN，也不追求通用低代码平台。画布只表达本产品支持的执行语义。

### 14.3 Run Console

```text
┌─────────────┬──────────────────────────┬──────────────────┐
│ DAG / Steps │ Artifact Preview         │ Activity         │
│             │ Spec / Screenshot / Diff │ Agent / Tools    │
│             │ Approval / QA             │ Logs / Duration  │
└─────────────┴──────────────────────────┴──────────────────┘
```

- DAG 节点实时状态。
- 当前 Step 和 Attempt。
- Artifact 版本时间线。
- 可停止运行。
- 可从失败步骤重试。
- 可从旧 Artifact Fork Run。

### 14.4 Artifact Explorer

- 按类型、Run 和状态筛选。
- 版本历史和依赖关系。
- JSON、Markdown、图片、代码 Diff 和报告专用 Renderer。
- 输入/输出 Lineage 图。

### 14.5 Agent Settings

- DeepSeek Harness、Codex、Claude Code 可用性探测。
- 内置角色到 Executor 的映射。
- 模型、Prompt Template、权限和超时。
- 凭据只显示配置状态，不回显明文。

## 15. 推荐技术架构

### 15.1 技术选型

| 层 | 选择 | 原因 |
|---|---|---|
| Web/Backend | Next.js App Router，Node Runtime | 单一 TypeScript 应用，本地部署简单 |
| UI | React、Tailwind CSS、Radix/shadcn 基础组件 | 快速建立稳定的操作型界面 |
| DAG Editor | `@xyflow/react` | 成熟的节点、端口和画布交互能力 |
| 数据库 | SQLite + Drizzle ORM | 无服务依赖、迁移明确、类型安全 |
| Schema | Zod + JSON Schema + Ajv | 内部类型与用户扩展 Artifact 验证兼顾 |
| 客户端状态 | TanStack Query + 小型 Zustand UI Store | 服务端数据和画布临时状态分离 |
| 实时事件 | Server-Sent Events | 本地单向事件流足够，复杂度低于 WebSocket |
| CLI | Commander | 初始化、启动、状态和恢复命令 |
| 进程管理 | Node child_process + tree kill abstraction | 管理 Agent、Dev Server 和测试进程 |
| 浏览器 | Playwright | E2E、截图、DOM、Console 和 Network |
| 图像差异 | `pixelmatch` 或 Playwright snapshot primitives | 确定性视觉证据 |
| 日志 | Pino，文件 JSONL | 结构化、本地可检索 |

### 15.2 进程拓扑

```text
artifact dev
  └── Local App Process
      ├── Next.js Web/API
      ├── Workflow Coordinator
      ├── SQLite
      └── Child Process Supervisor
          ├── DeepSeek Harness
          ├── Codex
          ├── Claude Code
          ├── Project Dev Server
          └── Playwright/Test Commands
```

Next.js 以持久本地 Node 服务运行，不按 Serverless 约束设计。长任务由进程内 Coordinator 管理，API Route 只提交命令和查询状态，不持有长请求。

### 15.3 代码组织

保持一个轻量 pnpm workspace：

```text
apps/
└── web/                  # Next.js UI、API、SSE
packages/
├── core/                 # 领域类型、状态机、事件
├── workflow/             # DAG 验证、调度、恢复
├── artifacts/            # Schema、版本、文件存储
├── executors/            # Executor 接口和内置 Adapter
├── project/              # 检测、环境、Worktree、进程
├── database/             # Drizzle schema 和 migrations
└── cli/                  # init/dev/status/resume
```

不要为每个节点或 Artifact Type 建独立 package。只有存在清晰依赖边界的模块才拆包。

## 16. API 边界

建议内部 API：

```text
POST   /api/projects/import
POST   /api/projects/create
POST   /api/projects/:id/detect
POST   /api/projects/:id/environments/:version/confirm

GET    /api/workflows
POST   /api/workflows
POST   /api/workflows/:id/versions
POST   /api/workflows/:id/validate

POST   /api/runs
GET    /api/runs/:id
POST   /api/runs/:id/cancel
POST   /api/runs/:id/resume
POST   /api/runs/:id/steps/:stepId/retry
POST   /api/runs/:id/fork
GET    /api/runs/:id/events

GET    /api/artifacts/:id/versions
GET    /api/artifact-versions/:id
GET    /api/artifact-versions/:id/content

POST   /api/approvals/:stepRunId/decisions
GET    /api/executors
POST   /api/executors/:id/probe
```

所有变更接口使用 command id 做幂等控制，避免浏览器重试重复创建 Run、Attempt 或审批记录。

## 17. 数据库表

MVP 最少需要：

- `projects`
- `project_environment_versions`
- `workflow_definitions`
- `workflow_definition_versions`
- `workflow_runs`
- `step_runs`
- `step_attempts`
- `artifact_types`
- `artifact_type_versions`
- `artifacts`
- `artifact_versions`
- `artifact_version_inputs`
- `step_input_bindings`
- `approval_decisions`
- `execution_events`
- `executor_configs`
- `process_records`
- `command_idempotency`

大文本、图片、日志和模型原始输出不进入 SQLite Blob，数据库只存元数据和相对路径。

## 18. 安全与权限

### 18.1 默认安全边界

- 服务只绑定 `127.0.0.1`。
- CLI 生成随机本地 session token，浏览器请求必须携带。
- 校验 Origin，防止其他网页调用本地 API。
- Figma、模型和 GitHub 凭据存入 macOS Keychain，不进入项目目录或日志。
- Prompt 和 Artifact 中的疑似密钥默认遮蔽。
- 子进程使用明确 cwd 和环境变量 allowlist。
- 禁止 Agent 写出 Run Worktree 与 Artifact Staging 范围，能力允许时再由 Harness/Codex 自身沙箱加强。

### 18.2 命令审批

命令分级：

- `trusted-project-command`：用户确认过的 install/build/test/dev 命令。
- `read-only`：Git status、文件读取和项目检测。
- `workspace-write`：只允许写 Run Worktree。
- `elevated`：网络安装、系统路径、凭据或未知命令，必须逐次审批。
- `blocked`：删除仓库、重置主工作区、自动推送和自动合并等 MVP 禁止行为。

## 19. CLI 规格

```bash
artifact init [path]       # 初始化或导入项目
artifact dev               # 启动本地服务，打印 URL
artifact status            # 查看服务、项目和活跃 Run
artifact run [workflow]    # 可选：从终端启动工作流
artifact resume <run-id>   # 恢复可恢复的 Run
artifact doctor            # 检查 Git、Node、Agent CLI、Playwright 等依赖
```

`artifact dev` 成功输出示例：

```text
artifact is running
Project: /path/to/project
URL: http://127.0.0.1:4317
Press Ctrl+C to stop the local service.
```

不自动打开浏览器。端口占用时选择可用端口并明确打印。

## 20. 可靠性要求

### 20.1 必须满足的不变量

- Run 使用的 Workflow 和 Environment 都是不可变版本快照。
- Step 开始前输入必须解析为精确 Artifact Version。
- Artifact Version 不可变且内容哈希可验证。
- 一个 Run 同时最多有一个 Worktree Writer。
- 审批绑定具体 Artifact Version，不能批准一个浮动别名。
- Executor 成功不等于 Step 成功；输出验证通过后 Step 才能成功。
- 进程崩溃不能把 `running` 永久保留为假状态。
- 删除 Worktree 不能丢失未提交修改。

### 20.2 失败分类

- `configuration_error`
- `executor_unavailable`
- `permission_denied`
- `process_failed`
- `process_lost`
- `timeout`
- `invalid_artifact`
- `validation_failed`
- `approval_rejected`
- `git_conflict`
- `cancelled`

不同失败类型决定是否可自动重试。配置错误、权限拒绝和无效 Artifact 默认不自动重试。

## 21. 测试策略

### 21.1 单元测试

- DAG 验证和拓扑排序。
- 状态机合法迁移。
- Artifact 版本和哈希。
- 条件表达式。
- 权限分类。
- Executor 事件映射。

### 21.2 契约测试

每个 Executor 使用同一组 Adapter Contract Tests：

- 能力探测。
- 正常执行。
- 结构化输出。
- 取消和超时。
- 子进程异常退出。
- 输出目录越界。
- 事件顺序和终态唯一性。

### 21.3 集成测试

- SQLite + Artifact 文件原子提交。
- 服务重启后的 Run 恢复。
- Worktree 创建、保留和安全清理。
- Approval 后流程继续。
- Step 重试产生新 Attempt 和 Artifact Version。
- Visual QA 有界循环。

### 21.4 E2E Fixture Projects

为了验证“目标技术栈无关”，至少维护三类小型 Fixture：

1. Node Web 项目。
2. 非 Node 的 CLI 或 API 项目。
3. 从空目录创建的新项目。

官方 UI 黄金路径可以先用一个稳定 Web Fixture 做质量基线，但核心 Workflow 和 Artifact 测试不能依赖 Next.js。

## 22. 实施里程碑

以下按工程量而非自然周估算。一个熟悉 TypeScript、Git 和 Agent CLI 的全职工程师，MVP 约为 16-22 工程周；两名工程师可并行但不会线性减半。

### M0：架构验证，1-2 工程周

交付：

- Next.js 本地服务和 CLI 启动骨架。
- SQLite/Drizzle migration。
- 三个 Agent CLI/Harness 的能力探测 Spike。
- Git Worktree 创建与保留 Spike。
- 一个硬编码的 Agent -> Artifact -> Agent 演示。

退出标准：同一 Requirement Artifact 能分别交给两个不同 Executor，生成并验证下游 Artifact。

### M1：Artifact Kernel，2-3 工程周

交付：

- Artifact Type/Version/Input 数据模型。
- JSON Schema 注册与 Ajv 验证。
- 文件存储、哈希、原子提交和恢复。
- Artifact Explorer 基础页。

退出标准：Artifact 可创建多版本、追踪输入、验证、比较并在重启后完整恢复。

### M2：Workflow Kernel，3-4 工程周

交付：

- Workflow Definition Version。
- DAG 验证、节点状态机、Step Attempt。
- 调度、只读并行、Worktree Writer Lock。
- 重试、取消、重启恢复和 SSE。
- Approval 节点。

退出标准：无 UI 画布也能通过种子 Workflow 完成暂停、批准、失败重试和恢复。

### M3：Executor Layer，3-4 工程周

交付：

- Executor Adapter SDK。
- DeepSeek Harness、Codex、Claude Code Adapter。
- 统一事件和 Input Package。
- Agent 配置与 Role 映射。
- 进程 Supervisor、取消和超时。

退出标准：同一个 Agent 节点只修改 Executor 配置即可由三种 Agent 运行，输出满足同一个 Artifact Schema。

### M4：Project 与 Git，2-3 工程周

交付：

- 已有项目导入。
- 新项目 Architecture Spec 审批和创建。
- 规则 + Agent 项目检测。
- Environment 确认和版本冻结。
- Run Worktree、临时分支、Diff 和编辑器打开。

退出标准：用户当前工作区保持不变，Run 修改完整留存在独立 Worktree。

### M5：Visual Workflow，3-4 工程周

交付：

- Playwright Executor 和 Dev Server 生命周期。
- Screenshot Set、DOM/CSS、Console/Network Artifact。
- Figma 单向导入。
- Visual QA 三层验证。
- 有界自动修复复合节点。

退出标准：一个 Web Fixture 能在视觉问题注入后生成定位明确的 QA Issue，并在最多三轮内修复或可解释地失败。

### M6：Visual Editor 与产品闭环，2-3 工程周

交付：

- React Flow DAG 编辑器。
- 节点面板、Inspector、类型化端口和验证。
- Run Console、Approval Review、Artifact Lineage。
- 官方黄金路径模板。
- Doctor、错误恢复体验和安装文档。

退出标准：新用户无需修改数据库或代码，即可导入项目、编辑模板、运行、审批、查看 QA 和打开最终 Worktree。

### M7：稳定化与内测，2 工程周

交付：

- 10-20 个真实项目试运行。
- 失败分类和诊断完善。
- 性能、磁盘清理、敏感信息检查。
- 数据库和 Workflow Definition 迁移测试。

退出标准见下一节。

## 23. MVP 验收标准

### 23.1 功能验收

- 能导入任意 Git 项目并保存用户确认的命令配置。
- 能从需求和批准的 Architecture Spec 创建新项目。
- 能在 Web 中构建合法 DAG，并阻止 Artifact 类型不兼容的连线。
- 三种 Agent Executor 至少各完成一次真实步骤。
- Agent 之间只通过 Artifact Input Package 传递上下文。
- Workflow 可以暂停审批、拒绝、请求修改、重试和恢复。
- 每个 Run 使用独立 Worktree，当前工作区不被修改。
- 能导入 Figma 页面并创建版本化 Artifact。
- Visual QA 最多循环指定次数，不会无限运行。
- 最终展示 Worktree、Diff、测试报告和 QA 报告。

### 23.2 可靠性指标

- 受控 Fixture 的完整黄金路径成功率 >= 80%。
- 中途杀死本地服务后，可诊断恢复率 = 100%。
- Artifact 关系和内容哈希一致性 = 100%。
- 当前用户工作区被 Agent 意外修改次数 = 0。
- 无限循环或无终态执行次数 = 0。
- 所有失败都能归入明确失败分类，并保留执行证据。

### 23.3 产品指标

- Time to Reviewable Worktree。
- 从需求到第一次可运行结果的时间。
- 每个 Run 的人工介入次数。
- Step 一次成功率和平均重试次数。
- Artifact 被拒绝/修订次数。
- Visual QA 自动收敛率和平均修复轮数。
- 用户最终保留 Agent Diff 的比例。

第一阶段不应承诺任意项目 30-60 分钟完成。应先对限定的内测样本建立可重复基线，再逐步扩大项目类型。

## 24. 首批开发任务

开始实施时，按以下顺序创建任务：

1. 建立 pnpm workspace、Next.js、CLI 和数据库 migration。
2. 写出领域类型与状态机测试，不先做工作流画布。
3. 实现 Artifact Type、Version、Input 和原子文件存储。
4. 实现静态 Workflow Definition 和单线程调度器。
5. 实现 Approval、Retry、Cancel 和进程重启恢复。
6. 定义 Executor Contract Test Suite。
7. 先接通一个最稳定的 Agent Executor，再按同一契约接另外两个。
8. 实现 Project Environment 检测和确认。
9. 实现 Worktree 生命周期和 Writer Lock。
10. 接入 Playwright、截图、DOM/CSS 和确定性 QA。
11. 接入 Figma Import 和 Vision QA。
12. 实现 Visual QA Loop。
13. 最后实现 React Flow 编辑器和完整 Run Console。

## 25. 需要尽早验证的高风险假设

### 风险一：三个 Agent 的结构化输出一致性

缓解：所有 Adapter 采用文件型 Output Contract；模型文本不是正式 Artifact。失败输出进入候选区并经过 Schema 验证。

### 风险二：任意技术栈的启动和验证不可预测

缓解：自动检测只是建议，用户必须确认 Project Environment；Workflow 启动前运行 preflight。Web QA 只对声明了可用 Preview 的项目开放。

### 风险三：本地长进程恢复困难

缓解：记录 PID、启动时间、命令哈希和端口；重启时验证进程身份。不能可靠重连的 Agent Attempt 明确失败并支持从冻结输入重试。

### 风险四：Visual QA 无法收敛

缓解：确定性证据优先、Issue 必须可定位、有界循环、每轮运行相关测试，超过次数交回人工。

### 风险五：可视化编辑器吞噬 MVP 时间

缓解：先完成可由种子 JSON 驱动的 Workflow Kernel；画布只编辑内置节点和通用 Agent 节点，不做通用低代码能力。

### 风险六：DeepSeek Harness 快速变化

缓解：只依赖子进程/SDK 稳定边界，锁定兼容版本，维护 Adapter Contract Tests，不 fork 核心代码。

## 26. 产品边界总结

MVP 的中心不是画布、聊天窗口或某个模型，而是四个稳定契约：

```text
Artifact Contract
  定义什么结果可以被下游消费

Workflow Contract
  定义何时执行、暂停、重试和恢复

Executor Contract
  定义不同 Agent 和工具如何被统一调用

Validation Contract
  定义一个步骤何时真正成功
```

只要这四个契约稳定，DeepSeek Harness、Codex、Claude Code、Figma、Playwright 以及未来新增的 Agent 都是可替换部件，而不是产品架构的中心。
