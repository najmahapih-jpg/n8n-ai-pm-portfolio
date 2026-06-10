# Portfolio Self-Knowledge — 工作流契约与 ADR 摘要

> 固定语料源文件。每个 `### chunk:<id>` 是一个可检索片段;其 `> 来源:` 行是带入元数据的权威引用(source + url + retrievedAt)。
> 工作流内的 stub 语料常量逐字派生自这些片段、必须保持同步;LIVE Supabase 由 `scripts/Ingest-Corpus.ps1` 刷新。
> 主题:作品集**自描述域**——九个 n8n Workflow-as-Code 仓库的安全模型、诚实性机制与互联结构,提炼自各仓库的 workflow-contract / ADR / eval-plan(内部一手文档,无外部 URL)。retrievedAt: 2026-06-10

### chunk:pf-gateway-security
作品集的统一入口是 interaction-gateway(签名网关):每个请求必须带 HMAC-SHA256 签名(对时间戳加请求体的精确字节签名,带重放窗口),超大请求体直接 413 拒绝,载荷中的疑似秘密(API key、Bearer token 等)在路由前被剥离并计数,intent 必须命中白名单否则 422 不路由。这些控制全部 fail-closed:空密钥、过期时间戳一律拒绝。安全核心是纯函数,由 20 项核心断言加 171 项编译后差分断言离线验证。
> 来源:Internal Portfolio Docs — interaction-gateway workflow-contract 与 ADR-0001。检索 2026-06-10

### chunk:pf-rag-abstention
RAG 知识助手的诚实性由三层机制保证:每个回答必须引用真实检索到的语料片段(引用完整性门:引用了未检索到的片段即失败);检索得分低于阈值时返回「我没有足够的信息」而不是编造;live 向量检索(Supabase pgvector)出错或为空时降级为对同一语料的确定性 TF-IDF 检索,并如实标注 retrievalSource,绝不产生假弃答。
> 来源:Internal Portfolio Docs — rag-knowledge-assistant ADR-0001 与 workflow-contract。检索 2026-06-10

### chunk:pf-drift-integrity
定时漂移监控的简报完整性由两个以运行记录为准的检查保证:简报末尾机器追加的 METRICS 行逐项与记录重新核对;摘要散文中出现的任何通过率形状的数字(百分比或 0 到 1 的小数)必须等于记录里真实存在的比率——LLM 或注入的摘要若声称数据不支持的通过率,这次运行直接判失败。简报卡片(飞书)也从同一记录确定性生成,红绿色由 drift.any 决定。
> 来源:Internal Portfolio Docs — scheduled-drift-monitor ADR-0001 与 eval-plan。检索 2026-06-10

### chunk:pf-agent-guardrails
自治代理(autonomous agent)在四条护栏内工作:工具白名单与网关 intent 一字不差,代理无法调用任何未注册目标;步数上限防止无限循环;不安全请求直接拒绝且零工具调用;工具失败(下游 4xx)如实返回 ok:false,绝不编造结果。代理轨迹由统一的 rubric 评分,同一套 rubric 同时评判确定性 stub 规划器和真实 LLM 规划器。
> 来源:Internal Portfolio Docs — autonomous-agent eval-plan 与 workflow-contract。检索 2026-06-10

### chunk:pf-eval-honest
评测台(eval harness)给任意被测系统打分:可核对的事实用确定性断言,主观质量用 LLM-as-judge,且裁判本身永不被当作真值——裁判与人工标注的一致率被持续校准,并设有裁判漂移护栏。全套评测默认走可复现的 stub 路径,CI 离线即可全绿;live 模型评测是显式 opt-in。
> 来源:Internal Portfolio Docs — llm-eval-harness eval-plan 与 honest-eval 框架说明。检索 2026-06-10

### chunk:pf-connected-loop
九个仓库构成一个互联系统:评测台(A)把 RAG 助手(B)当黑盒被测系统打分;漂移监控(D)定期保鲜 B 的语料并跟踪 A 的评分是否漂移;签名网关把所有工作流变成进程内可调用的目标;自治代理把它们当工具编排;飞书适配器提供进出双向的聊天入口。每个仓库都有离线验证门、canonical 一致性门和逐文件提交纪律。
> 来源:Internal Portfolio Docs — 跨仓库 registry 与 adopt-on-your-n8n 部署文档。检索 2026-06-10
