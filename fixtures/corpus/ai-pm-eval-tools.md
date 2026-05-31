# AI 时代的产品经理 —— 度量 AI 质量与开源工具

> 固定语料源文件。每个 `### chunk:<id>` 是一个可检索片段;其 `> 来源:` 行是带入元数据的权威引用(source + url + retrievedAt)。
> 工作流内的 stub 语料常量必须与之逐字同步;LIVE Supabase 由 `scripts/Refresh-Corpus.ps1` 从源白名单刷新,stub 保持 pinned 快照。
> 主题:度量 AI 质量 + 开源社区评测工具。retrievedAt: 2026-05-31

### chunk:rag-eval-faithfulness
开源社区给出了评测 RAG 的标准做法:要分别评检索与生成两段——检索看 context precision / recall(召回到的上下文准不准、全不全),生成看 faithfulness(忠实度:答案是否扎根于检索到的上下文)与 answer relevancy(答案相关性);这些可用开源工具 Ragas / DeepEval 简化。RAG 本身则是"无需微调即可扩展模型知识"的常用手段。
> 来源:Hugging Face LLM/Agents Course(mlabonne 等)与 Ragas / DeepEval 开源评测框架。https://github.com/mlabonne/llm-course · 检索 2026-05-31

### chunk:trust-reliability
在 OpenAI、Google、Amazon 等公司 50+ 个企业级 AI 部署中,一条反复出现的教训是:"obsessing about customer trust and reliability is an underrated driver of successful AI products"(对客户信任与可靠性的执着,是 AI 产品成功被严重低估的驱动力)。评测必要但非万灵药——为可靠性与"优雅失败"路径而设计,才是把 demo 变成用户敢依赖的产品的关键。
> 来源:Lenny Rachitsky 等 — Lenny's Newsletter《Why most AI products fail》(2026)。https://www.lennysnewsletter.com/p/what-openai-and-google-engineers-learned · 检索 2026-05-31
