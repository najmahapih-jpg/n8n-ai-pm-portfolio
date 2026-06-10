# AI 时代的产品经理 —— 2026 招聘信号与作品集工件

> 固定语料源文件。每个 `### chunk:<id>` 是一个可检索片段;其 `> 来源:` 行是带入元数据的权威引用(source + url + retrievedAt)。
> 工作流内的 stub 语料常量必须与之逐字同步;主题:2026 年 AI-PM 招聘信号、作品集项目排序与配套工件。
> 素材提炼自仓库内 deep-research 报告(n8n-oss-review-and-best-practices-2026.md §4/§7,Exa 检索 2026-05-30),逐条保留原始出处。retrievedAt: 2026-05-30

### chunk:own-system-behavior
2026 年的 AI-PM 招聘共识之一:AI 产品经理不是被雇来设计功能,而是被雇来掌控系统行为(own system behavior)。只展示输出、不展示控制机制(评测、护栏、失败处理)的作品集会被静默筛掉;能解释「系统为什么这样表现、怎么约束它」的候选人才有差异化。
> 来源:Akhil Tiwari — The Product Space《What an AI PM Portfolio Must Show in 2026》(2026-01-14)。https://theproductspace.substack.com/p/what-an-ai-pm-portfolio-must-show · 检索 2026-05-30

### chunk:hireability-ranking
InstitutePM 对 12 个 AI-PM 作品集项目按可雇佣性排序:评测框架(Eval Harness)排第一——被称为 2026 年单一最高信号项目,几乎没有 PM 候选人真正建过,能谈 LLM-as-judge 偏差、golden dataset、pass@k 就进前 5%;RAG 是最抢手技能,要点是来源引用与检索失败时说「我不知道」;工具调用 agent 是前沿;漂移监控则是大多数作品集失败的地方。
> 来源:InstitutePM《12 AI PM Portfolio Projects Ranked by Hireability (2026)》(2026-05-10)。https://www.institutepm.com/knowledge-hub/ai-pm-learning-by-building-projects · 检索 2026-05-30

### chunk:failure-analysis-decisions
2026 年 AI 作品集的通行要求是四件配套工件:行为规格(behavior spec,取代传统 PRD)、评测准则(eval rubric)、失败分析(failure analysis——主动展示失败案例与处置)、以及 DECISIONS.md(记录为什么选这个模型、这种分块、这个向量库)。光有能跑的 demo 而没有这些控制工件,会被视为没有系统思维。
> 来源:Klement Gunndu — dev.to《5 AI Portfolio Projects That Actually Get You Hired in 2026》(2026-03-07)。https://dev.to/klement_gunndu/5-ai-portfolio-projects-that-actually-get-you-hired-in-2026-5bpl · 检索 2026-05-30

### chunk:go-build-something
对想转型 AI-PM 的人,最有效的一条建议是 Go Build Something:亲手把一个真实的东西做出来并部署,能讲清你 prototyped、built、deployed 的全过程,远胜于任何证书或纸面分析——招聘方要看的是动手证据与系统思维。
> 来源:Jaclyn Konzelmann《If you want to get hired as an AI PM — Go Build Something》(2026-02-12)。https://blog.jaclynkonzelmann.com/p/if-you-want-to-get-hired-as-an-ai · 检索 2026-05-30
