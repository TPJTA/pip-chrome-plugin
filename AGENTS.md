# 仓库 Agent 规则

本文件适用于整个仓库。任何更深层目录中的 `AGENTS.md` 可以为该目录补充规则；如有冲突，以更深层规则为准。

## 代码修改与版本号

任何会修改产品代码、运行时行为、构建逻辑或发布内容的任务，都必须在同一次提交中更新版本号。

1. 开始修改前，读取 `package.json` 和 `manifest.json` 的当前 `version`；两处版本必须始终一致。
2. 根据本次提交的实际影响，按 Semantic Versioning 选择且只选择一次升级：
   - `PATCH`：向后兼容的缺陷修复、稳定性或性能修复，以及不改变既有公开行为的内部实现调整。
   - `MINOR`：向后兼容的新功能、新设置、新权限能力或可观察行为扩展。
   - `MAJOR`：不兼容变更、既有行为或配置的破坏性变更，或需要用户迁移的变更。
3. 同步修改 `package.json` 与 `manifest.json`；不得只更新其中一个，也不得让版本号倒退。
4. 一个逻辑代码提交只升级一次版本。版本级别由该提交中影响最大的变更决定；不得为了多个文件或多个修复重复升级。
5. 纯文档、注释、测试、格式化或 Agent/仓库流程规则变更，在不影响扩展运行、构建或发布产物时不升级版本号。
6. 提交前检查两处版本相等，并运行与改动相关的测试、构建、lint 或类型检查。若验证失败，不得提交。
7. 只精确暂存本任务产生的文件或代码块；不得暂存、提交或回滚开始任务前已有或并发产生的改动。

## Outcome Engineering 工作流

当用户明确要求使用 Outcome Engineering，或要求以“先确认结果、再自主实现并独立验收”的方式端到端交付软件时，必须使用 `.agents/skills/outcome-engineering/SKILL.md`，并遵守以下规则。下列内容只是仓库级约束摘要；Skill 及其引用协议是完整、权威的执行说明。

### 1. 人类控制边界

- 人类负责结果语义、不可接受的失败、必须保持的不变量、范围边界和额外权限；Agent 负责技术计划、实现、常规修复和证据收集。
- 用户说 `pause` 或 `stop` 时，立即中断所有活动子 Agent，并在已有运行状态时记录 `PAUSED`。只有用户明确恢复后才能继续。
- 用户将事项标记为 `must-have-human`，或任务涉及语义变更、弱化不变量、扩大权限、凭据、生产操作或不可逆操作时，记录并报告 `NEEDS_HUMAN`。
- 合同审批不自动授权部署、使用凭据、删除、购买、对外发送消息或其他超出原请求的操作；这些动作仍需单独授权。

### 2. Contract 前置门禁

- 写 Contract 前，先检查需求、代码、测试、配置、文档和相关 Git 历史，只向人类询问无法从仓库确定的意图、价值判断、优先级、失败容忍度或权限问题。
- 至少明确：行动者与初始状态、可观察成功结果、不可接受的反例、不变量、非目标、外部依赖与权限边界，以及实际可取得的验收证据。
- 高影响未决项必须由人类明确回答，不得擅自假设；低影响假设记录到对应版本的 `assumptions.md`。每轮最多集中询问七项，且只有在人类确认没有其他约束后才结束澄清。
- 每个 Outcome Contract 独立存放在 `.outcomes/<id>/v<version>/contract.md`。每条 Acceptance Claim 必须包含具体 `Counterexample`、允许的证据类型、唯一 Verifier 类别和仓库相对 Scope。
- Contract 在澄清完成前保持 `DRAFT`。语义确定后改为 `FROZEN`，生成 `decision-summary.md`，并向人类同时展示完整 Contract、Contract SHA-256 与摘要 SHA-256。
- 只有人类明确批准这两个精确哈希后，才可通过 Skill runtime 创建只写一次的 `approval.json`。初始化前必须通过严格 lint。
- 已初始化的 Contract、决策摘要和批准记录不可原地修改。任何语义变更都创建新的 `vN+1` 目录，重新澄清、冻结、审批和初始化。
- `.outcomes/` 默认不进入 Git；若仓库尚未忽略它，应在首次运行前加入 `.gitignore`，除非用户明确选择其他证据存储策略。

### 3. 隔离角色与自主交付

- 当前上下文是 Coordinator，只负责澄清、审批门禁、调度、状态校验、修复路由和最终报告；不得修改产品代码，也不得评估 Acceptance Claim。
- 实现必须交给一个不继承父对话、可保留句柄并可再次触发的 Builder 子 Agent。所有产品代码修改和 Builder 证据由该 Builder 负责。
- 每个 Verifier 类别、每一轮验证都必须使用全新的、不继承 Coordinator 或 Builder 对话的子 Agent；Verifier 不得修改产品代码，也不得信任 Builder 的叙述作为证据。
- 启动实现前必须确认环境同时支持：无上下文继承的子 Agent、可复用并主动触发的 Builder 句柄、完成状态观察，以及暂停时中断所有子 Agent。任一能力缺失时停止并报告 `NEEDS_AUTOMATION_HOST`，不得在单一上下文中假装角色隔离。
- Builder 达到机器状态 `IMPLEMENTED` 后，才可按 Verifier 类别顺序启动独立验证。必须通过 runtime 的 `status` 和 `validate` 确认状态，不能只接受文字形式的完成声明。

### 4. 证据、修复与终态

- Builder 和对应的独立 Verifier 都必须分别提供 Contract 要求的每一种当前有效证据；验证从每条 Claim 的 `Counterexample` 开始。
- Claim 验证失败是可修复的 `CLAIM_REJECTED`，不是 Outcome 终态。Coordinator 将结构化反例发送给同一个 Builder 修复，再用全新 Verifier 身份开始下一轮。
- 默认最多三轮验证（初始一轮加两轮修复）；薄切片探针最多一轮。修复预算耗尽或同一阻塞在无代码、状态或证据变化时重复出现，记录 `BLOCKED`。
- 每次 Builder 完成、Verifier 轮次结束和修复轮次结束后，只向用户发送简短的意图级进展：正在验证哪个已批准结果、当前轮次，以及仍存在的反例。不要输出原始任务状态转储。
- 仅以下机器确认状态可作为工作流终点：`ACCEPTED`、`BLOCKED`、`REJECTED`、`NEEDS_HUMAN`、`NEEDS_AUTOMATION_HOST` 或用户要求的 `PAUSED`。其中 `REJECTED` 只用于用户明确永久终止，而非普通 Claim 失败。
- 终态必须写入 `evidence-report.md`，包含意图到证据的映射、过程摘要、已测试反例、缺失或失效证据、残余风险、信任级别和后续选项。
- 本地 runtime 证据只能声明 `INTERNAL_COHERENCE`；只有证据与审查身份由 Builder 无法修改的 CI、审批服务或外部系统托管时，才能声明 `EXTERNAL_ATTESTATION`。

## Git 提交

- 任何实际修改文件的实现任务，在相关验证通过后必须创建一次 Git 提交；只读任务或没有文件变化时不得创建空提交。
- 提交信息应以一句话说明改了什么以及原因，禁止使用 `update`、`fix bug` 等含义不清的描述。
- 除非用户明确要求，不得执行 push、amend、rebase、强制推送或其他改写历史的操作。
