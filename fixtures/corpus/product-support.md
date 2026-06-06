# Product Knowledge Base — Support & Known Issues

> 固定语料源文件。每个 `### chunk:<id>` 是一个可检索片段;其 `> 来源:` 行是带入元数据的权威引用(source + url + retrievedAt)。
> 工作流内的 stub 语料常量("Stub Retrieve"节点)逐字派生自这些片段、必须保持同步;LIVE Supabase 由 `scripts/Ingest-Corpus.ps1` 从源白名单刷新,stub 保持 pinned 快照以保证 CI 可复现。
> 这是为作品集示例「分析仪表盘产品」准备的**合成**产品支持语料(无任何真实客户数据);它让 rag 在 agent 的 bug→rag→support-triage 协作里充当「已知问题大脑」。retrievedAt: 2026-06-06

### chunk:known-export-mobile-crash
The data export button crashes the mobile app on both iOS and Android when a report is exported to CSV or PDF. This is a known issue affecting mobile app versions 2.2 and 2.3; a fix is scheduled for version 2.4. Workaround: run the export from the desktop web app instead, where export works normally. Owning team: product-engineering. Severity: high.
> 来源:Internal Product Knowledge Base — Known Issues。检索 2026-06-06

### chunk:known-dashboard-slow
The analytics dashboard loads slowly, often taking ten seconds or more, for workspaces with large datasets. The known cause is unbounded client-side aggregation of the trend charts. A server-side aggregation fix is in progress. Workaround: narrow the dashboard date range, or open a saved view with fewer segments. Owning team: product-engineering. Severity: medium.
> 来源:Internal Product Knowledge Base — Known Issues。检索 2026-06-06

### chunk:known-sso-login-loop
Single sign-on users are sometimes stuck in a login redirect loop after their session expires. The known cause is the browser blocking third-party cookies. Workaround: allow cookies for the app domain, or sign in with the email-and-password fallback. Owning team: platform-security. Severity: high.
> 来源:Internal Product Knowledge Base — Known Issues。检索 2026-06-06

### chunk:doc-export-howto
To export data, open any report or dashboard, click the Export button, and choose a format: CSV, XLSX, or PDF. Exports run in the background, and you receive an email with a download link when the file is ready. Large exports over one million rows are queued and may take a few minutes.
> 来源:Internal Product Knowledge Base — Product Docs。检索 2026-06-06

### chunk:doc-dashboard-overview
The analytics dashboard has three areas. KPI cards at the top show headline metrics, trend charts in the middle show changes over time, and a data table at the bottom lists the underlying records. You can filter the whole dashboard by date range, by segment, and by saved views that you create and share with your team.
> 来源:Internal Product Knowledge Base — Product Docs。检索 2026-06-06

### chunk:faq-mobile-support
The mobile app supports viewing dashboards, reports, and notifications. Some administrative features, including data export, user management, and billing, are available on the desktop web app only and not on mobile.
> 来源:Internal Product Knowledge Base — Product Docs。检索 2026-06-06
