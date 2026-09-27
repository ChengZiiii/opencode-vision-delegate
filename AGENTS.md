# AGENTS.md — OpenCode Vision Bridge 开发规则

## 项目简介

给纯文本模型（GLM、DeepSeek 等）"眼睛"的 opencode 插件。核心能力：注册原生
`vision_analyze` 工具 + `vision-agent` 子代理回退，让文本模型能对截图/图片做
结构化视觉判断（返回模板 JSON）。

- 行为规范：`openspec/specs/vision-bridge/spec.md`（改行为前必读）
- 用户文档：`README.md`

## 架构总览

| 文件 | 职责 |
| ---- | ---- |
| `plugin.ts` | 插件入口，**双入口同包**：`server`（hooks API，v1）+ `setup`（v2 前向兼容）。v1 提供 config hook（注册 agent/skill、捕获模型旋钮）、`tool` hook（注册 `vision_analyze`）、`permission.ask`、messages/system transform、skills.paths 注册；v2 `setup` 经 `ctx.agent`/`ctx.skill` 注册子代理与 skill |
| `src/vision-http.ts` | 纯函数核心：请求构建、响应解析、endpoint/API key 解析、HTTP 调用。**无 @opencode-ai 依赖、无副作用**——plugin.ts 打包它，tests 直接 import 它 |
| `SKILL.md` | 视觉意图检测与委托路由（工具优先 → 子代理回退） |
| `tests/vision-http.test.mjs` | node:test 单测（stub `globalThis.fetch`） |
| `dist/index.js` | 构建产物，**自包含**（内含 @opencode-ai/plugin + zod，见关键设计决策） |

## v1 / v2 双入口（改架构前必读）

- **npm 安装（`opencode plugin`，写 v1 `plugin` 数组）→ v1 loader 只读 `server`，
  全功能**。官方文档现行的插件 API 就是 hooks 形态。
- v2 loader（读 v2 `plugins` 配置 / 目录扫描）只调 `setup`。**v2 @1.18 没有
  tool 域、没有 messages/system transform、没有 permission.ask**——`setup` 只能
  注册子代理 + skill（结构化类型 + 可选链，宿主形状变了静默降级，不抛错）。
- 两入口写的是**不相交的注册系统**（v1 `cfg.agent` vs v2 AgentDraft），并存无
  冲突；`readV1Plugin` 只看 `server` 键，多余键被忽略（v1.18.32 源码已核实）。
- 上游 v2 补齐 tool 注册后：把工具/transform 挪进 `setup`，`server` 保留到
  v1 退役。

## 视觉路由机制（改行为前必读）

1. **多模态模型**：图片 FilePart 原样直达，system transform 注入 `[vision:native]`，
   明确禁止委托。
2. **纯文本模型**：messages transform 把图片落盘到
   `<系统临时目录>/opencode-vision-delegate/` 并改写为 `[vision:dropped-image]` 标记 →
   SKILL.md 引导调用 `vision_analyze` 工具。
3. **工具错误分类（skill 据此分支，勿乱改前缀）**：
   - `model not configured` → 提示用户配置，**不回退**子代理
   - `provider error` → 回退派发 `vision-agent` 子代理
   - `invalid response` → skill Step 6 重试一次
   - `missing image` → 报错并指名路径，不发请求
4. **模型旋钮**：唯一入口是 `agent["vision-agent"].model`（插件**绝不写入**
   `model`/`disable`）；`disable: true` 同时关闭工具注册与子代理。

## 开发循环

1. 编辑 `plugin.ts` / `src/` → 重建 dist → 重启 opencode → 测试：
   ```powershell
   # 常驻自动重建
   bun build ./plugin.ts --outfile ./dist/index.js --target node --format esm --watch
   # 或一次性：bun run bundle
   ```
2. **SKILL.md 改动零手动**：本地 `file://` 安装时 skill 经 `skills.paths`
   从包目录直扫（opencode 的 skill 扫描读的是活配置，插件推送即生效，
   `skill/index.ts` 无信任门控）；npm/github 安装同样如此——包内
   SKILL.md 随 `files` 发布，单通道发现。
   改完重启即生效，无同步步骤。
3. **沙盒隔离测试**（不污染真实配置）：
   ```powershell
   $env:OPENCODE_CONFIG_DIR = "<临时>/config"
   $env:OPENCODE_TEST_HOME  = "<临时>/home"   # 仅影响插件内的目录解析
   opencode
   ```
   注意：这只隔离 **opencode 运行时**。`opencode plugin` 安装器子命令
   无视 `OPENCODE_CONFIG_DIR`，`--global` 永远写真实全局配置（含
   `git+file://`/tgz 源，JSONC 注释无损但会追加条目）——沙盒里测安装
   要手写临时 config 引用插件 spec，不要用安装器（详见避坑文档 4.5
   第 5 条）。
4. **终验强制官方安装模式**：任何合并/发布的改动，终验必须走
   `opencode plugin github:ChengZiiii/opencode-vision-delegate --global
   [--force]` → agent list / 冒烟全过才算完；`file://` 只算内环便利，
   **不算验证**（npm 发布后同理，用 npm 名再走一轮）。push 前可先用本地
   git 源等价测：`opencode plugin "git+file:///<仓库绝对路径>" --global`；
   publish 前可先 `npm pack` 后用本地 tgz 路径装一遍。文件布局（包外写入、
   临时目录）变动时，加一轮 README 四步完整卸载 + 重装，确认环境还原。
   通用规则与完整避坑清单：`../opencode-plugin-dev-pitfalls.md`。
5. **排错**：`opencode --print-logs` 看插件加载错误；改动不生效先清
   `~/.cache/opencode/packages/` 包缓存。

## 文件账本（改布局前必读）

插件对自己的文件体系记账，卸载才可能干净（详见避坑文档第 6 节）：

- **包内**：自有资源（SKILL.md）从 `import.meta.url` 相对解析，三种运行
  形态（源码 / dist / store 安装）一套逻辑，缺失无害降级。
- **安装器写的**：config `plugin` 数组条目 + store 目录，README 卸载
  章节已覆盖。
- **插件包外写的**：仅 `<系统临时目录>/opencode-vision-delegate/`（图片
  物化）。config hook 的运行时注入不落盘、随插件移除即消失。新增任何
  包外写入必须先更新 README 卸载章节再动代码。

## 测试与构建（硬性检查）

```powershell
node --test tests/*.test.mjs   # 单测。注意：Node 24 下 `node --test tests/` 目录形式不可用
bun run typecheck
bun run bundle
```

- 所有纯逻辑改动必须带/更新单测（stub fetch 即可，无需真实 API）。
- **bundle 严禁加 `--packages external`**：dist 必须自包含——单文件安装
  没有 node_modules，运行时无法解析 `@opencode-ai/plugin`。
- **dist 随仓库提交**（不在 .gitignore）：`opencode plugin` 的 github 源
  安装经 arborist/pacote 做依赖准备，**manifest 严禁声明六个触发脚本名
  （preinstall/install/postinstall/prepack/prepare/build）或 `workspaces`
  字段**（第 7 触发器）——任何一个都会触发内层 npm install，在编译版
  opencode 二进制内必挂（"git dep preparation failed"，上游
  anomalyco/opencode#49704 同款结论）。构建脚本因此叫 `bundle`；
  npm 发布前手动 `bun run bundle` 后直接 `npm publish`。

## 关键设计决策（勿轻易推翻，改前先讨论）

1. **双请求形状**：OpenAI `/chat/completions`（`data:` image_url）与 Anthropic
   `/messages`（base64 image 块），按 endpoint URL 是否含 `/anthropic` 选择。
   原因（实机验证）：`api.minimaxi.com` 的 OpenAI 兼容端点会**静默丢弃 `data:`
   图片**（模型答"无图"），Anthropic 风格端点才能送达。内置 endpoint 映射
   （minimax 家族）指向 anthropic 风格 URL。
2. **图片字节不经过 shell**：base64 经 Node 读写（`readFileSync`/`writeFileSync`），
   禁止把 base64 塞进命令行——截图可能含敏感内容，不能进 shell 历史。
3. **endpoint/key 解析顺序**（勿乱改）：config `options.baseURL` → provider env
   中 `*_HOST` 类变量 → catalog `api` 字段 → 内置映射 → 明确报错。
   key：auth.json（type `api`）→ provider env 变量。
4. **开关语义**：`agent["vision-agent"].disable = true` = 一键全关（工具 + 子代理），
   这是用户唯一认可的关闭方式。
5. **权限钩子防御式写法**：`permission.ask` 里工具名按首中优先级链检查
   （`metadata.tool` → `permission` → `id` → `type`，不同运行时版本字段不一
   致）；只升 `ask→allow`，永不覆盖 `deny`。
6. **v2 setup 只创建不覆盖**：`draft.get("vision-agent")` 存在即跳过——用户的
   配置和核心 config-agent 插件对已存在条目有完全所有权；字段名用 v2 的
   `system`（v1 是 `prompt`），不碰 `model`/`disabled`/`permissions`。
   domain 访问与 draft 方法均有 `?.` + typeof 守卫，宿主形状漂移时该注册
   静默跳过而非抛错。
7. **skill 发现 = skills.paths 直扫，无镜像同步**：opencode 的 skill 扫描读
   活配置对象（`skill/index.ts` `cfg.skills.paths` → `**/SKILL.md`），绝对路径
   照扫、无信任门控（kilo 的 `skill_path_origins` 是 Kilo 私有机制，opencode
   不存在）。**禁止重新引入模块加载时的 SKILL.md 镜像复制**——上游 kilo 项目
   已通过 openspec change `remove-skill-mirror-sync`（spec RB-9）明确废除，
   本移植亦经实机验证（中立目录 + 全新沙盒）skills.paths 单通道足够。
   单文件安装靠 README 记载的手动复制（包内无安装器脚本）。

## 安装方式

三种方式任选其一（插件 id 均为 `"vision"`，**并存会重复注册冲突**）：

- **npm（主推）**：`opencode plugin opencode-vision-delegate --global` 安装并自动
  patch `~/.config/opencode/opencode.json` 的 `plugin` 数组。**版本升级必须删
  store 目录后重装**（`--force` 会沿用首次安装钉死的版本号，拉不到新版本；
  npm spec 可能有 `<name>` 与 `<name>@latest` 两个 store 目录，都要删），
  细见 README 升级章节与避坑文档第 5 节。
- **GitHub 源（已实机验证）**：`opencode plugin
  github:ChengZiiii/opencode-vision-delegate --global`，走同一 store；分支/标签
  用 `#<ref>`。registry 安装最稳（tarball 路径完全不进 git 准备流程）。
- **本地包**：opencode.json 的 `plugin` 数组写 `"file:///<仓库绝对路径>"`。
  skill 经 `skills.paths` 从包内直扫，无同步步骤。
- **单文件**：复制 `dist/index.js` 到 `~/.config/opencode/plugin/vision.js`；
  **skill 需手动复制** SKILL.md 到 `~/.config/opencode/skills/vision/SKILL.md`
  （包内无安装器脚本）。

## OpenSpec 规格工作流（libretto）

所有**行为改动**走完整流程，禁止直接改代码：

```
explore → propose → 用户批准 → apply → verify → archive
```

1. `openspec new change <kebab-name>`，按 CLI `instructions --json` 依次写
   proposal / specs(deltas) / design / tasks
2. delta spec 规则：
   - 只写变化：`## ADDED` / `## MODIFIED` / `## REMOVED Requirements`
   - **MODIFIED 块必须携带主 spec 中该需求的全部既有场景**，否则归档会拒绝
   - 场景用 Given/when/then，需求用 SHALL
3. 校验：`openspec validate --all`
4. 实施 → 三维验证（只报告不改码）
5. **实现与 spec 出现偏差时，先改 delta spec 再归档**（spec 是事实源）
6. 归档需用户明确指示：`openspec archive <name> --yes`
7. 提交按 conventional 风格：`plugin:` / `skill:` / `tests:` / `docs:` / `chore:`

视觉相关改动必须保持 `agent["vision-agent"].model` 旋钮、错误分类前缀、
开关语义三者的向后兼容。

## 提交规范

按 conventional 风格：`plugin:` / `skill:` / `tests:` / `docs:` / `chore:`。
视觉相关改动必须保持 `agent["vision-agent"].model` 旋钮、错误分类前缀、
开关语义三者的向后兼容。
