/** Handles split UTF-8 code points, CRLF, multi-line data and a final frame without a blank line. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      if (buffer.length > 262144) throw new Error('SSE frame too large');
      if (chunk.done && buffer && !buffer.endsWith('\n')) buffer += '\n';
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (!line) {
          if (data.length) yield data.join('\n');
          data = [];
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
          if (data.reduce((sum, item) => sum + item.length, 0) > 262144) throw new Error('SSE frame too large');
        }
      }
      if (chunk.done) { if (data.length) yield data.join('\n'); break; }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
