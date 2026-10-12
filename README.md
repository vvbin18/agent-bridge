# Agent Bridge

Agent Bridge 是一个基于本地文件的多 Agent 协作工具。它使用 Markdown 保存讨论记录，用单个状态文件管理发言权，并提供本机浏览器页面引导用户创建、查看和继续会话。运行时只依赖 Node.js 标准库。

> 项目状态：早期版本。当前使用记录主要来自 Windows 本地、两个 Agent 的 `chat` 讨论。三个及以上 Agent 与跨平台行为尚未充分测试；`build` 模式尚未实际试用，请谨慎使用；参见[测试状态与已知限制](#测试状态与已知限制)。

## 功能与边界

- 每个会话对应 `sessions/<会话ID>.discussion.md`，页面可阅读记录，也可切换、恢复已有会话。
- `agents.json` 可配置参与者 ID 和显示名称；交接目标可以是任意已注册 Agent。
- `chat` 模式用于只读分析；`build` 模式允许在当前任务范围内修改业务文件，并要求执行者提交、另一个 Agent 审核后才能由 Agent 结束。
- 用户可暂停、恢复、插话、选择追问后的第一个 Agent，并在 Agent 提问时直接到对应聊天窗口答复。
- 页面只监听 `127.0.0.1`，启动时尝试打开默认浏览器。

本工具只管理共享文件和发言权。它**不会**启动 Agent 客户端、调用模型 API、发送提示词，或唤醒已经停止回复的 Agent。`wait` 是一次有超时的轮询，不是后台常驻服务；客户端停止后，需要用户再次发送页面提供的提示词。

## 环境要求

- Node.js 18 或更新版本；无需 `npm install`。
- 每个 Agent 都能读取项目文件并运行终端命令，且工作目录指向**同一个项目根目录**。
- 浏览器页面在运行工具的计算机本地使用。Windows 提供双击脚本；macOS/Linux 由 Node.js 尝试调用系统命令打开浏览器，实际兼容性尚未验证。

## 快速开始

先在需要协作的项目根目录克隆仓库：

```powershell
git clone https://github.com/vvbin18/agent-bridge.git .agent-bridge
```

### Windows：双击打开页面

在文件管理器进入 `.agent-bridge` 目录，双击 `start-ui.cmd`。脚本会检查 Node.js 是否可用、启动本地页面服务，并尝试打开默认浏览器。保持弹出的终端窗口运行；关闭进程后页面服务停止。

### 命令行启动

在目标项目根目录运行：

```powershell
node .agent-bridge/start
```

若已进入 `.agent-bridge` 目录，也可以运行 `node start`。页面会尝试在默认浏览器打开；若没有自动打开，请使用终端打印的 `http://127.0.0.1:<端口>/` 地址。

页面中的最短流程：

1. 点击“开启新会话”，填写话题、选择 `chat` 或 `build` 模式，并指定第一个 Agent。
2. 创建后复制页面给出的提示词，发送到该 Agent 的聊天窗口。
3. Agent 按 `AGENTS.md` 协议发言和交接。需要下一个 Agent 参与时，在其聊天窗口发送对应提示词。
4. 会话结束后，可在页面底部填写追问，**指定由哪个 Agent 开始**，再复制新提示词继续。

已有上下文的 Agent 可使用简短提示词；首次加入或上下文丢失时请选择完整提示词。页面根据该 Agent 是否在当前讨论记录中发过言预选版本，用户可以手动切换。

### 在项目中更新

```powershell
git -C .agent-bridge pull
```

会话记录和运行状态由工具仓库内的 `.gitignore` 排除。若目标项目本身也是 Git 仓库，且不打算将本工具作为子模块提交，请在**目标项目**的 `.gitignore` 中加入 `/.agent-bridge/`。

`agents.json` 是仓库内的配置文件。若在每个项目中修改了它，更新工具时 Git 可能提示本地改动或合并冲突；请先检查配置差异，再执行拉取。

## 配置 Agent

初始 `agents.json` 提供 `agent-a` 和 `agent-b`。每个 ID 必须唯一，以小写字母开头，可包含小写字母、数字、`_`、`-`，最长 32 个字符；`user` 为保留 ID。`name` 是记录标题中的显示名称。

例如增加第三个 Agent：

```json
{
  "agents": [
    { "id": "agent-a", "name": "Agent A" },
    { "id": "agent-b", "name": "Agent B" },
    { "id": "agent-c", "name": "Agent C" }
  ]
}
```

配置在读取时生效，无需修改脚本。已有会话依赖原来的 ID；修改或删除 ID 前，应确认没有正在使用该 ID 的会话。**三个及以上 Agent 的端到端协作目前尚未验证。**

## 页面与协作流程

### 新建、查看和继续会话

左侧列出当前会话与历史会话；主区域显示 Markdown 讨论记录。新建会话会创建独立的 `.discussion.md` 文件，不会自动继承上一会话的全文。历史会话若有对应状态文件，可切换并继续；仅有记录文件的历史会话可阅读，但不能通过页面恢复发言状态。

状态含义：

| 状态 | 含义 | 用户下一步 |
| --- | --- | --- |
| `running` | 会话进行中，`speaker` 指向当前发言者 | 将提示词发送给当前 Agent；用户可以插话 |
| `waiting_user` | Agent 通过 `ask` 提问并等待答复 | 在提问的 Agent 聊天窗口直接答复 |
| `paused` | 讨论暂停 | 用户恢复后再继续 |
| `finished` | 本轮会话结束 | 在页面填写追问、选择开始 Agent，或新建会话 |

当 Agent 提问时，问题正文应出现在其聊天回复中；用户无需手动执行 `reply`。收到答复的 Agent 应按协议记录原文并继续。若提问的客户端已经停止，仍需用户重新发送提示词。

### `chat` 与 `build`

`chat` 是默认模式，只分析和讨论，不修改业务文件。`build` 由用户选择或切换后，按设计允许 Agent 在当前任务范围内执行修改。执行者用 `submit` 记录完成情况，再移交另一个 Agent；审核者核对后用 `approve` 确认，随后才能由 Agent `finish`。用户仍可自行结束会话。

`mode chat|build` 只切换协作模式，不改变发言权，也不会自动解除暂停或等待用户答复。`build` 的执行与审核约束由桥接状态检查，但代码质量和业务正确性仍需参与者自行核对。

**注意：`build` 模式尚未实际试用，其修改、交接和审核流程也未经过端到端验证。请谨慎使用；建议先在可回退的测试项目中验证完整流程，再考虑用于重要项目。**

## 命令行使用

不使用页面时，可在目标项目根目录运行 `node .agent-bridge/bridge.js <命令>`。先执行 `agents` 和 `status`，确认参与者、模式、当前发言者和讨论文件路径。完整参数以 `help` 输出为准。

| 目的 | 示例 |
| --- | --- |
| 查看参与者和状态 | `agents`、`status` |
| 新建会话 | `new --topic "讨论一个问题" --first agent-a` |
| 新建执行会话 | `new --topic "完成一个任务" --mode build --first agent-a` |
| 发言与交接 | `say agent-a --text "分析结果"`、`handoff agent-a agent-b` |
| 等待发言权 | `wait agent-b --timeout 45` |
| 向用户提问与记录答复 | `ask agent-a --text "待确认问题"`、`reply agent-a --text "用户答复"` |
| 恢复已结束会话 | `reopen --first agent-b --text "补充问题"` |
| 切换模式或暂停 | `mode build`、`pause`、`resume` |
| 执行、审核与结束 | `submit agent-a --text "结果"`、`approve agent-b --text "审核结论"`、`finish agent-b` |
| 扩充会话额度 | `extend --messages 20 --handoffs 5` |

例如：

```powershell
node .agent-bridge/bridge.js agents
node .agent-bridge/bridge.js status
node .agent-bridge/bridge.js new --topic "分析当前方案" --first agent-a
node .agent-bridge/bridge.js say agent-a --text "分析结论"
node .agent-bridge/bridge.js handoff agent-a agent-b
```

长文本或含复杂引号、换行的内容建议放入 UTF-8 文件，并使用 `say <id> --file <路径>`，避免命令行转义导致格式丢失。长发言应在文件中写成段落或 Markdown 列表。

`init` 可用于首次初始化，包括读取旧版 `discussion.md` 草稿；`new` 会保存上一会话的状态并开启独立话题。`reopen` 仅适用于 `finished` 状态，保留原会话文件和计数。默认上限为 40 条 Agent 发言、10 次交接；达到上限后由用户执行 `extend`。`help` 可查看全部命令。

## 文件与本地数据

```text
.agent-bridge/
├── bridge.js       # 状态和发言权命令
├── start.js        # 本机页面服务
├── start           # node start 入口
├── start-ui.cmd    # Windows 双击入口
├── ui.html         # 页面
├── agents.json     # Agent 配置
├── AGENTS.md       # 协作协议
├── README.md
├── LICENSE
├── .gitignore
├── state.json      # 运行后生成；当前会话状态
└── sessions/       # 运行后生成；会话记录和历史状态
```

`state.json` 与 `sessions/` 是每个项目的本地数据，已在仓库的 `.gitignore` 中排除；旧版 `discussion.md`、`history/` 和锁文件也被排除。不要将包含真实项目分析内容的会话文件或旧版打包文件上传到公开仓库。

会话记录按时间戳命名。删除历史会话时，应确认该文件不属于当前会话；如需同时移除其发言状态，还需移除同名 `.state.json`。不要直接改写正在使用的讨论记录；Agent 发言应通过 `bridge.js` 写入。

## 测试状态与已知限制

目前尚未建立自动化测试和 CI。以下是已实际使用及尚未验证的场景，供使用前参考：

| 场景 | 当前状态 |
| --- | --- |
| Windows 本地两个 Agent 的 `chat` 讨论、交接和结束 | 有实际使用记录；仍缺系统性回归测试 |
| 三个及以上 Agent 的交接、等待和页面引导 | **尚未进行端到端测试** |
| `build` 模式的执行、退回修改、`submit/approve` 审核闭环 | 尚未实际试用或进行端到端验证；请谨慎使用 |
| macOS/Linux 启动与自动打开浏览器 | 代码包含对应分支，尚未在这些平台验证 |
| 多客户端长时间并发、进程异常中断后的恢复 | 尚未进行压力或故障注入测试 |

此外，`wait` 默认等待 45 秒，超时即返回；它不会保持 Agent 客户端在后台运行。页面需要用户手动向不同 Agent 的客户端发送提示词。本机页面仅供本地使用，不是面向公网部署的服务。

## 许可

本项目采用 [MIT License](LICENSE)，版权署名为 `vvbin`。
