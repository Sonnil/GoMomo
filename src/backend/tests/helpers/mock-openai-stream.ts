/**
 * Shared helper: creates an AsyncIterable that mimics the OpenAI
 * streaming response shape expected by chat-handler.ts.
 *
 * Usage in tests:
 *   createMock.mockResolvedValue(createMockStream('Hello!'));
 *
 * The production code does:
 *   const completion = await openai.chat.completions.create({ ..., stream: true });
 *   for await (const chunk of completion) { ... }
 *
 * Each chunk has the shape:
 *   { choices: [{ delta: { content?, tool_calls? }, finish_reason? }] }
 */

interface MockToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

interface MockStreamChunk {
  choices: [{
    delta: {
      content?: string;
      tool_calls?: MockToolCallDelta[];
    };
    finish_reason?: string | null;
  }];
}

/**
 * Build an async-iterable stream from a simple text response.
 * Emits one chunk with the full content, then a finish chunk.
 */
export function createMockStream(content: string): AsyncIterable<MockStreamChunk> {
  const chunks: MockStreamChunk[] = [
    { choices: [{ delta: { content }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ];
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < chunks.length) return { value: chunks[i++], done: false };
          return { value: undefined as any, done: true };
        },
      };
    },
  };
}

/**
 * Build an async-iterable stream that triggers a tool call.
 * The tool call is emitted in a single chunk for simplicity.
 */
export function createMockToolStream(
  toolCallId: string,
  fnName: string,
  fnArgs: Record<string, unknown>,
): AsyncIterable<MockStreamChunk> {
  const chunks: MockStreamChunk[] = [
    {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: toolCallId,
            type: 'function',
            function: { name: fnName, arguments: JSON.stringify(fnArgs) },
          }],
        },
        finish_reason: null,
      }],
    },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < chunks.length) return { value: chunks[i++], done: false };
          return { value: undefined as any, done: true };
        },
      };
    },
  };
}
