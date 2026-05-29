import { workflow, trigger, tool, sticky } from '@n8n/workflow-sdk';

// Thin MCP-server layer over the existing, eval-backed Lead Intelligence API.
// The MCP Server Trigger exposes a single tool (score_lead) that an MCP client
// (e.g. Claude via the official n8n MCP) can call; the tool delegates to the
// deterministic lead-scoring workflow (id xhZ0XMNvi4LeVWzk), whose 11-fixture
// pin-data eval remains the regression backstop for the scoring logic itself.

const scoreLeadTool = tool({
  type: '@n8n/n8n-nodes-langchain.toolWorkflow',
  version: 2.2,
  config: {
    name: 'score_lead',
    position: [560, 240],
    parameters: {
      description: 'Score and route a single B2B lead. Provide a lead object (email, companyName, companyDomain, requestedProduct or message, intentSignals, employeeCount, industry, country, plan). Returns: grade (A-D), priorityScore, icpFitScore, intentScore, owner queue/team, follow-up SLA hours, a redacted audit reference, and policyVersion. The scoring is deterministic and explainable.',
      source: 'database',
      workflowId: {
        __rl: true,
        mode: 'id',
        value: 'xhZ0XMNvi4LeVWzk',
        cachedResultName: 'Portfolio - Lead Intelligence API'
      },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: null
      }
    }
  }
});

const mcpServer = trigger({
  type: '@n8n/n8n-nodes-langchain.mcpTrigger',
  version: 2,
  config: {
    name: 'Lead Scoring MCP Server',
    position: [220, 240],
    parameters: {
      authentication: 'none',
      path: 'lead-scoring'
    },
    subnodes: {
      tools: [scoreLeadTool]
    }
  }
});

const overview = sticky(
  '## Lead Scoring MCP Tool v0.1.0\\nExposes the deterministic Lead Intelligence API as an agent-callable MCP tool. An MCP client connects to the MCP Server Trigger SSE endpoint and calls score_lead; the Call n8n Workflow Tool delegates to workflow xhZ0XMNvi4LeVWzk and returns the structured scoring result. Local-only: authentication is none for local use - add bearer/header auth before any network exposure (the SSE endpoint is unauthenticated by default).',
  [mcpServer],
  { color: 4 }
);

export default workflow('lead-scoring-mcp-tool', 'Portfolio - Lead Scoring MCP Tool')
  .add(overview)
  .add(mcpServer);
