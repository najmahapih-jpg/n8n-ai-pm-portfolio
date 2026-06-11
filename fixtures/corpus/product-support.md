# Product Knowledge Base — Support & Known Issues

> 固定语料源文件。每个 `### chunk:<id>` 是一个可检索片段;其 `> 来源:` 行是带入元数据的权威引用(source + url + retrievedAt)。
> 工作流内的 stub 语料常量("Stub Retrieve"节点)逐字派生自这些片段、必须保持同步;LIVE Supabase 由 `scripts/Ingest-Corpus.ps1` 从源白名单刷新,stub 保持 pinned 快照以保证 CI 可复现。
> 这是为作品集示例「分析仪表盘产品」准备的**合成**产品支持语料(无任何真实客户数据);它让 rag 在 agent 的 bug→rag→support-triage 协作里充当「已知问题大脑」。retrievedAt: 2026-06-06

### chunk:known-export-mobile-crash
The data export button crashes the mobile app on both iOS and Android when a report is exported to CSV or PDF. This is a known issue affecting mobile app versions 2.2 and 2.3; a fix is scheduled for version 2.4. Workaround: run the export from the desktop web app instead, where export works normally. Owning team: product-engineering. Severity: high. 移动端 App 在将报表导出为 CSV 或 PDF 时会崩溃,这是影响近期移动端版本的已知问题,临时方案是改用桌面网页版导出,修复已排入下一个版本,负责团队为产品工程组,严重级别为高。
> 来源:Internal Product Knowledge Base — Known Issues。检索 2026-06-06

### chunk:known-dashboard-slow
The analytics dashboard loads slowly, often taking ten seconds or more, for workspaces with large datasets. The known cause is unbounded client-side aggregation of the trend charts. A server-side aggregation fix is in progress. Workaround: narrow the dashboard date range, or open a saved view with fewer segments. Owning team: product-engineering. Severity: medium. 大数据量工作区的分析看板加载缓慢是已知问题,原因是趋势图在客户端做了无上限聚合,临时方案是缩小看板日期范围或改用分段更少的已保存视图,严重级别为中。
> 来源:Internal Product Knowledge Base — Known Issues。检索 2026-06-06

### chunk:known-sso-login-loop
Single sign-on users are sometimes stuck in a login redirect loop after their session expires. The known cause is the browser blocking third-party cookies. Workaround: allow cookies for the app domain, or sign in with the email-and-password fallback. Owning team: platform-security. Severity: high. 单点登录用户在会话过期后可能陷入登录跳转循环,这是已知问题,原因是浏览器拦截了第三方 Cookie,临时方案是允许应用域名的 Cookie 或改用邮箱密码方式登录,严重级别为高。
> 来源:Internal Product Knowledge Base — Known Issues。检索 2026-06-06

### chunk:doc-export-howto
To export data, open any report or dashboard, click the Export button, and choose a format: CSV, XLSX, or PDF. Exports run in the background, and you receive an email with a download link when the file is ready. Large exports over one million rows are queued and may take a few minutes. 导出数据时,打开任意报表或看板,点击导出按钮并选择 CSV、XLSX 或 PDF 格式,导出在后台运行,文件就绪后会通过邮件发送下载链接,超过一百万行的大型导出会进入队列。
> 来源:Internal Product Knowledge Base — Product Docs。检索 2026-06-06

### chunk:doc-dashboard-overview
The analytics dashboard has three areas. KPI cards at the top show headline metrics, trend charts in the middle show changes over time, and a data table at the bottom lists the underlying records. You can filter the whole dashboard by date range, by segment, and by saved views that you create and share with your team. 分析看板分为三个区域,顶部 KPI 卡片展示关键指标,中部趋势图展示随时间的变化,底部数据表列出底层记录,整个看板可按日期范围、分段和已保存视图筛选。
> 来源:Internal Product Knowledge Base — Product Docs。检索 2026-06-06

### chunk:faq-mobile-support
The mobile app supports viewing dashboards, reports, and notifications. Some administrative features, including data export, user management, and billing, are available on the desktop web app only and not on mobile. 移动端 App 支持查看看板、报表和通知,而数据导出、用户管理、账单等管理功能仅在桌面网页版提供,移动端不可用。
> 来源:Internal Product Knowledge Base — Product Docs。检索 2026-06-06

### chunk:known-import-csv-encoding
Importing a CSV file that is not UTF-8 encoded (for example GBK or GB2312 exports from older spreadsheet tools) shows garbled Chinese characters in the imported records. This is a known issue; an encoding auto-detection fix is planned for version 2.5. Workaround: re-save the file as UTF-8 (in Excel use Save As - CSV UTF-8) before importing. Owning team: product-engineering. Severity: medium. 导入非 UTF-8 编码(例如 GBK 或 GB2312)的 CSV 文件会出现中文乱码,这是已知问题,临时方案是先把文件另存为 UTF-8 编码的 CSV 再导入,编码自动检测的修复已在计划中。
> 来源:Internal Product Knowledge Base — Known Issues。检索 2026-06-10

### chunk:known-notification-delay
Email notifications can be delayed by up to thirty minutes during peak hours. The known cause is queue worker saturation in the notification service; an autoscaling fix is in progress. Workaround: rely on in-app notifications, which are delivered in real time and are not affected. Owning team: platform-infra. Severity: low. 高峰时段邮件通知最多可能延迟三十分钟,这是已知问题,原因是通知服务的队列工作进程饱和,临时方案是依赖实时送达、不受影响的应用内通知,严重级别为低。
> 来源:Internal Product Knowledge Base — Known Issues。检索 2026-06-10

### chunk:doc-api-rate-limits
The public API allows 100 requests per minute per token on the standard plan and 1000 on the enterprise plan. Requests over the limit receive HTTP 429 with a Retry-After header. Integrations should use exponential backoff and batch endpoints where possible; sustained higher throughput requires an enterprise token. 公开 API 的限流为标准版每令牌每分钟 100 次请求、企业版 1000 次,超限请求会收到 HTTP 429 与 Retry-After 响应头,集成方应使用指数退避并尽量使用批量端点。
> 来源:Internal Product Knowledge Base — Product Docs。检索 2026-06-10

### chunk:doc-permissions-roles
The product has three workspace roles. Admins manage billing, users, and security settings. Editors create and edit dashboards and reports and can run exports. Viewers can view shared dashboards and export the data they can see, but cannot edit. Only an admin can change a member role, and the change takes effect the next time that member signs in. 产品有三种工作区角色,管理员负责账单、用户与安全设置,编辑者可创建和编辑看板报表并运行导出,查看者只能查看共享看板并导出可见数据,只有管理员能变更成员角色。
> 来源:Internal Product Knowledge Base — Product Docs。检索 2026-06-10

### chunk:doc-data-retention
Analytics event data is retained for thirteen months on the standard plan and thirty-six months on the enterprise plan; data older than the retention window is dropped from dashboards and exports. When a workspace is deleted, all of its data is permanently purged after a thirty-day grace period and cannot be recovered. 分析事件数据在标准版保留十三个月、企业版保留三十六个月,超出保留窗口的数据会从看板和导出中移除,工作区删除后经过三十天宽限期所有数据将被永久清除且无法恢复。
> 来源:Internal Product Knowledge Base — Product Docs。检索 2026-06-10
