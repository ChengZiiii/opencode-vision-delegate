# review-deltas — fix-v2-knob-capture-timing（实现 ↔ spec delta 对账）

Repo: opencode-vision-bridge · Change: `fix-v2-knob-capture-timing` (approved, not archived)
Reviewed at HEAD `ccb4c82`; implementation commits `d790b4d` (plugin + dist) / `6bfbbec` (tests) / `66dc8ac` (docs) / `ccb4c82` (P2 verdict). `plugin.ts` unchanged between `d790b4d` and HEAD (verified: `git diff d790b4d HEAD -- plugin.ts src` empty).

## 总判决：CLEAN（可进下一波）— 无 spec↔实现阻塞项

VT-2 MODIFIED 逐字携带全部存量场景并新增 2 个排序场景，全部有实现落点与测试；never-write 红线（config 兜底绝不写文件）代码与测试双重核实。以下非阻塞跟进项（处置建议）在归档/发布波处理：

| # | 发现 | 建议 |
| --- | --- | --- |
| N1 | 能力映射懒刷新（`refreshV2AgentsMap`，plugin.ts:1177）是真实 v2 行为改动（context 钩子期重建 agent→能力映射），proposal 第 3 条覆盖，但 **delta 只改了 VT-2，未落任何场景**——归档后主 spec 不描述该行为 | 二选一：归档前给 delta 补一个小场景（挂 VT-2 或做 VH-2 MODIFIED），或按"README 已记限制 + 行为细节非场景级"接受（routing 语义未变，只是数据时机）。倾向补 delta（成本低） |
| N2 | live spec **VH-2** 文本（specs/vision-bridge/spec.md:959-963）仍写旋钮 "SHALL be resolved … **via the agent domain**"，而 VT-2 修正后允许无域 getter 宿主走 config 文件兜底——仅在"域 getter 不可用"的宿主上两文有张力（2.3.2 getter 存活，实际不触发；且 VH-2 明写 defer 到 "the exact VT-2 … contract"，可读作引用 VT-2） | 记限制/后续小 delta 对齐 VH-2 措辞；非本 change 义务 |
| N3 | 探针报告跨仓引用落空：design.md:106-108 引用 forge 工作区 `reports/probe-v2-surface-report.md`，该文件在 opencode-forge/reports/ **不存在**（仅 design.md 记录在案） | 按派发指示以 design.md P2 判决（:105-125）为准并注明；归档前补回探针报告文件或修正引用 |
| N4 | 任务腿仍开：4.2 真实 2.3.2 宿主 live verify（P2 判决明言 execute 时域记录序列化为 `{}`，**哪一层实际服务不可判定**，留给 4.2 观察）、4.3 发布 | 归档/发布门，非 delta-实现偏差 |
| N5 | 能力映射刷新测试断言弱（测试自述 "Indirect observable: none yet"，仅断言不抛 + 无注入） | 可接受（v2 路由以请求 model 为主信号）；若 N1 补场景则顺带补一条可观察断言 |

## 1. delta → 实现（specs/vision-bridge/spec.md — MODIFIED VT-2）

先核**逐字携带**：live VT-2（specs/vision-bridge/spec.md:487-510）存量 2 场景标题与 Given/when/then 同 delta（delta:24-35）逐字一致（比对通过）；delta 扩展需求正文（v2 不得依赖 transform 期序、必须观察 MERGED 记录、不得把空快照当未配置）+ 新增 2 场景。合规。

| Scenario | 判定 | 证据 |
| --- | --- | --- |
| No override produces a fixable error（存量） | **VERIFIED** | `runVisionAnalyze` 空模型 → 字节同前缀 `vision_analyze: model not configured: set agent["vision-agent"].model …`（plugin.ts:619-623）；测试 `v2 knobs: unset model -> exact VT-2 'model not configured' error, no HTTP request`（tests/v2-setup.test.mjs:321）+ `v2 knobs fallback: … empty config dir -> exact 'model not configured' error`（:516，正则逐字断言 + `captured.length === 0` 无 HTTP） |
| Override preserved by the plugin（存量，never-write） | **VERIFIED** | 代码侧：`readV2AgentKnobs` 只读记录、`readOpencodeConfigFile`（:1113-1132）仅 `existsSync`+`readFileSync`、`stripJsoncForParse`（:1066）纯函数——全插件唯一 `writeFileSync` 是既有图片落盘（:468，IMAGE_TMP_DIR）；测试侧：`v2 knobs fallback: … JSONC config fixture -> knobs resolve, zero file writes`（:472）断言 config 文件字节不变 + 目录零新增 |
| **Config merged after transform still resolves**（新增） | **VERIFIED** | `resolveV2Knobs()`（:1137-1170）首选域 getter（merged 记录），transform 空快照不阻断；测试 `v2 knobs ordering: transform sees undefined, domain getter returns merged record -> execute resolves model`（:443）——live 失败序成为回归测试（model `{id,providerID,variant}` 折叠为 `providerID/id`，temperature 同步） |
| **No post-merge observation point degrades honestly**（新增） | **VERIFIED** | 源序末端 unset → 精确 VT-2 错误、不发明模型、不发请求；测试 :516（同上） |

需求正文新增 SHALL 条款核对：

- "SHALL NOT depend on transform-time ordering"：域 getter 首位（2.3.2 P2 判决：execute 时域 handle 存活）；无 getter 宿主 → config 兜底（与 config→agent merge 读同一文件，取值等价，design.md:119-124）。**成立**。
- "SHALL NOT treat a transform-time empty snapshot as unset"：快照仅作**中间源**（:1148-1149，design.md:91-95 记录保留理由），空则继续下落——排序测试即此断言。**成立**。
- disable 门：注册闸懒解析（:1465 `if (!resolveV2Knobs().disabled …)`）+ execute 期独立守卫（:614-618）。**成立**（测试 :335 `disabled vision-agent suppresses tool registration`）。

## 2. 实现 → delta（scope creep / 缺漏盘点）

1. **能力映射懒刷新**（`refreshV2AgentsMap` 挂 context 钩子，:1490-1495）：proposal 第 3 条明文（"same deferred treatment **or** an explicit documented limitation"——实现两者都给了，README:20 记录限制）。判定：proposal 覆盖、**delta 缺场景**（见 N1）。处置：补 delta（建议）或记限制接受。
2. **transform 快照保留为中间源**：design.md:91-95 明文（保既有 wired-test 腿）。边界观察（非违规）：在"draft 在 transform 期已带记录且无域 getter"的宿主上，快照会**遮蔽** config 兜底——若用户此后改 config 文件，解析到 setup 期旧值（staleness 边角）。VT-2 的 SHALL 未被违反（该快照在此类宿主上就是 merged 观测）；2.3.2 排序下快照恒空、无影响。处置：记限制（design 已记理由），无需改。
3. **config 兜底顺带发布 `config` 引用**（`:1155-1159` 把 fileConfig 并入 knobs.config，使 VT-5 的 baseURL/apiKey 解析链也能看见 config 文件里的 provider 配置）：这是兜底读取的自然副产品，让无域宿主的 endpoint/key 解析与宿主行为一致。delta VT-2 只谈旋钮；VT-5 未改。判定：低风险增强、方向与"读宿主同一发现路径"一致；处置：记限制/在 N1 的 delta 补丁里顺带一句，或接受。
4. 未发现其他 delta 外行为：v1 config-hook 快照零改动（diff 全部落在 v2 类型区 :917-935、懒解析块 :1046-1208、v2Setup :1375-1495）；create-only 契约未动（测试 :429 仍在跑）。

## 3. design 决策核对（fix shape + 非目标）

| 决策 | 判定 | 证据 |
| --- | --- | --- |
| 主机制 = 域 getter（probe 先行，typeof 守卫） | **成立** | `V2AgentDomainHandle`（:917-935，get/list 可选 + `?.`/typeof）；P2 判决：execute 时 handle 存活（design.md:110-112） |
| 兜底 = 只读 config 文件（OPENCODE_CONFIG_DIR 感知 + JSONC 容忍 + 永不写） | **成立** | `opencodeConfigDir`（:154-159，OPENCODE_CONFIG_DIR ?? XDG ~/.config/opencode）+ `readOpencodeConfigFile`（:1113-1132，json→jsonc 序、注释/尾逗剥离）；zero-write 测试双重断言；全插件唯一写点是既有图片落盘 |
| 双源皆无 → 字节同错误前缀、绝不发明模型 | **成立** | :1159-1168 unset 返回 + :619-623 错误；测试 :516 正则逐字 |
| 旋钮字段语义零变化（model/disable/temperature/extraBody、`{id,providerID,variant}` 折叠复用 readV2AgentKnobs） | **成立** | :1150-1159 复用既有折叠；测试 :350/:370（temperature/extraBody 传播、legacy 平记录形）均绿 |
| 非目标：VT-2 语义/前缀零变化 | **成立** | 前缀正则逐字断言 ×2；SKILL 路由分类未动 |
| 非目标：v1 零改动 | **成立** | `git show d790b4d -- plugin.ts` 全部 hunk 在 v2 区；v1 快照路径原样 |
| 非目标：create-only 重注册契约不动 | **成立** | 注册逻辑未改（禁用闸除外）；测试 `v2 agent create-only: existing vision-agent record is not overwritten` 绿 |
| probe 判决与实现一致 | **成立** | design.md:65-87（1.1/1.2）→ 源序/守卫实现；:105-125（P2）→ 分层源序不变的结论与代码一致（getter 首位、兜底读同一文件） |

## 4. 测试覆盖（delta 场景 → 测试名清单）

tests/v2-setup.test.mjs 新增 4 条（6bfbbec）+ 既有旋钮套件：

- `v2 knobs ordering: transform sees undefined, domain getter returns merged record -> execute resolves model`（:443）→ 新场景 1（live 失败序回归）
- `v2 knobs fallback: no domain getter + JSONC config fixture -> knobs resolve, zero file writes`（:472）→ 新场景 2 前半 + 存量"Override preserved"（zero-write）
- `v2 knobs fallback: no domain getter + empty config dir -> exact 'model not configured' error`（:516）→ 新场景 2 + 存量"No override"
- `v2 capability map: post-merge domain list/get refreshes agents map at context time`（:534）→ N1 行为（弱断言，N5）
- 既有 VT-2/VT-7 旋钮套件随懒解析全绿：`unset model -> exact VT-2 error`（:321）、`disabled vision-agent suppresses tool registration`（:335）、`temperature + extraBody propagate`（:350）、`legacy flat record shape`（:370）、`not-image-capable model -> VT-2 error category`（:389）

## 5. 复核实测（只读命令）

- `node --test tests/*.test.mjs`（全量 5 文件）→ **107 pass / 0 fail**（与 implement 报告声称一致；v1 套件零回归）
- `bun run typecheck` → exit 0
- `npx openspec validate --all` → **2 passed / 0 failed**（仅既有 INFO 长文本提示）
- `dist/index.js` 已含新面（:13580 `stripJsoncForParse` / :13619 `readOpencodeConfigFile` / :13634 `resolveV2Knobs` / :13664 `refreshV2AgentsMap`）——implement 报告的 bundle blocker 已在 d790b4d 中解除（dist 随该提交入库）

## 6. 结论

CLEAN：delta↔实现双向对账无阻塞项；never-write 红线双重核实；v1 零回归。跟进项 N1-N5（能力映射补 delta 或记限制、VH-2 措辞张力、探针报告文件跨仓引用落空、4.2 live verify 与 4.3 发布门、弱断言测试）交主会话在归档/发布波裁决。
