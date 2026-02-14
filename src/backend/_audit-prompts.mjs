// Audit: Send 4 test prompts to the chat API and capture path logs
const TENANT_ID = '00000000-0000-4000-a000-000000000001';
const BASE = 'http://localhost:3000';

const prompts = [
  'what is your pricing?',
  'giá cả?',
  'bao nhiêu tiền?',
  'prix?',
];

(async () => {
  for (const msg of prompts) {
    const sessionId = `audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    console.log(`\n── PROMPT: "${msg}" (session: ${sessionId}) ──`);
    try {
      const res = await fetch(`${BASE}/api/tenants/${TENANT_ID}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, message: msg }),
      });
      const data = await res.json();
      const resp = typeof data.response === 'string' ? data.response : JSON.stringify(data);
      console.log(`STATUS: ${res.status}`);
      console.log(`RESPONSE (first 300 chars): ${resp.substring(0, 300)}`);
      console.log(`TOOLS: ${JSON.stringify(data.meta?.tools_used || [])}`);
    } catch (e) {
      console.error(`ERROR: ${e.message}`);
    }
    // Small delay between requests
    await new Promise(r => setTimeout(r, 1500));
  }
})();
