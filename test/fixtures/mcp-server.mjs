// 完全本地的协议测试服务，不访问 QQ、外部网络或用户文件。
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export function fixtureServer(onCall = () => {}) {
  const server = new Server({ name: 'qq-agent-test', version: '1.0.0' }, { capabilities: { tools: {} } });
  const schema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false };
  server.setRequestHandler(ListToolsRequestSchema, async ({ params }) => params?.cursor === 'page2'
    ? { tools: [
      { name: 'find-item', description: '同名规范化碰撞测试', inputSchema: schema },
      { name: 'slow', description: '超时测试', inputSchema: { type: 'object' } },
      { name: 'large', description: '结果截断测试', inputSchema: { type: 'object' } },
      { name: 'error', description: '工具错误测试', inputSchema: { type: 'object' } },
      { name: 'broken', description: '无法编译的 Schema', inputSchema: { type: 'object', properties: { x: { $ref: '#/$defs/missing' } } } }
    ] }
    : { tools: [{ name: 'find.item', description: '返回输入文本和结构化信息', inputSchema: schema }], nextCursor: 'page2' });
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    onCall(params);
    if (params.name === 'slow') await new Promise((resolve) => setTimeout(resolve, 1800));
    if (params.name === 'error') return { isError: true, content: [{ type: 'text', text: '模拟工具执行失败' }] };
    if (params.name === 'large') return { content: [{ type: 'text', text: '字'.repeat(10000) }] };
    return {
      content: [{ type: 'text', text: `echo:${params.arguments?.text || 'ok'}` }],
      structuredContent: { fixture: true, pid: process.pid, explicitEnv: process.env.QQ_MCP_FIXTURE_VALUE || '', inheritedSecret: process.env.QQ_MCP_MUST_NOT_INHERIT || '' }
    };
  });
  return server;
}

if (process.argv.includes('--stdio')) {
  await fixtureServer().connect(new StdioServerTransport());
}
