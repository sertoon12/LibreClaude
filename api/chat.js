import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const IS_LOCAL = process.env.VERCEL !== '1' && process.env.VERCEL_ENV == null;

if (IS_LOCAL) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const envPath   = path.resolve(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const idx = t.indexOf('=');
      if (idx === -1) continue;
      const key = t.slice(0, idx).trim();
      const val = t.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

const GITHUB_MODEL_MAP = {
  'mistral-ai/Codestral-2501':          'Codestral-2501',
  'openai/gpt-4o':                      'gpt-4o',
  'openai/gpt-4o-mini':                 'gpt-4o-mini',
  'openai/gpt-4.1':                     'gpt-4.1',
  'openai/gpt-4.1-mini':               'gpt-4.1-mini',
  'openai/o1-mini':                     'o1-mini',
  'deepseek/DeepSeek-R1':              'DeepSeek-R1',
  'deepseek/DeepSeek-V3-0324':         'DeepSeek-V3-0324',
  'meta/Llama-3.3-70B-Instruct':       'Llama-3.3-70B-Instruct',
  'meta/Meta-Llama-3.1-405B-Instruct': 'Meta-Llama-3.1-405B-Instruct',
  'mistral-ai/Mistral-Large-2411':     'Mistral-Large-2411',
  'microsoft/Phi-4':                   'Phi-4',
  'xai/grok-3':                        'grok-3',
};

const GROQ_MODEL_MAP = {
  'llama-3.3-70b-versatile': 'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant':    'llama-3.1-8b-instant',
  'openai/gpt-oss-20b':      'gpt-oss-20b',
  'openai/gpt-oss-120b':     'gpt-oss-120b',
  'qwen/qwen3-32b':          'qwen/qwen3-32b',
};

// Rate limit / daily quota error patterns
const RATE_LIMIT_PATTERNS = [
  'rate limit', 'ratelimit', 'rate_limit',
  'quota exceeded', 'daily limit', 'daily quota',
  'too many requests', 'limit exceeded',
  'x-ratelimit', 'requests per day',
];

function isRateLimitError(msg = '') {
  const lower = msg.toLowerCase();
  return RATE_LIMIT_PATTERNS.some(p => lower.includes(p));
}

async function searchWeb(query) {
  if (!query) return null;

  const tavilyResult = await searchTavily(query);
  if (tavilyResult) return tavilyResult;

  // Fallback: free, no API key, used when Tavily key is missing,
  // fails, or its quota is exhausted.
  return await searchDuckDuckGo(query);
}

const STOCKNEST_PROXY_URL = 'https://stocknest-proxy.witoonzaba57.workers.dev';

// Common English words that look like tickers but rarely are one,
// to cut down on false positives when scanning for $5-letter words.
const TICKER_STOPWORDS = new Set([
  'I', 'A', 'OK', 'THE', 'AND', 'FOR', 'YOU', 'ARE', 'CAN', 'NOT', 'BUT',
  'ALL', 'NEW', 'NOW', 'WHY', 'HOW', 'WHO', 'YES', 'NO', 'IT', 'IS', 'IN',
  'ON', 'TO', 'OF', 'AI', 'API', 'URL', 'CEO', 'CTO', 'USD', 'PDF',
]);

function detectTickers(text = '') {
  const found = new Set();

  for (const m of text.matchAll(/\$([A-Za-z]{1,5})\b/g)) {
    found.add(m[1].toUpperCase());
  }

  for (const m of text.matchAll(/(?:หุ้น|ราคา)\s*([A-Za-z]{1,5})\b/gi)) {
    found.add(m[1].toUpperCase());
  }

  for (const m of text.matchAll(/\b([A-Z]{2,5})\b/g)) {
    const t = m[1];
    if (!TICKER_STOPWORDS.has(t)) found.add(t);
  }

  return [...found].slice(0, 3);
}

async function getStockQuote(ticker) {
  try {
    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`;
    const proxyUrl = `${STOCKNEST_PROXY_URL}?url=${encodeURIComponent(yahooUrl)}`;
    const r = await fetch(proxyUrl, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;

    const data = await r.json();
    const result = data?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta || meta.regularMarketPrice == null) return null;

    const price      = meta.regularMarketPrice;
    const prevClose  = meta.chartPreviousClose ?? meta.previousClose ?? price;
    const change     = price - prevClose;
    const pct        = prevClose ? (change / prevClose) * 100 : 0;
    const currency   = meta.currency || '';
    const exchange   = meta.fullExchangeName || meta.exchangeName || '';
    const symbol     = meta.symbol || ticker;

    return `Ticker: ${symbol} (${exchange})\nPrice: ${price.toFixed(2)} ${currency}\nChange: ${change >= 0 ? '+' : ''}${change.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)\nPrevious close: ${prevClose.toFixed(2)} ${currency}`;
  } catch {
    return null;
  }
}

async function getStockContext(text) {
  const tickers = detectTickers(text);
  if (!tickers.length) return null;

  const quotes = await Promise.all(tickers.map(getStockQuote));
  const lines = quotes.filter(Boolean);
  if (!lines.length) return null;

  return lines.join('\n\n');
}

async function searchTavily(query) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return null;

  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: key,
        query,
        search_depth: 'basic',
        max_results: 5,
        include_answer: true,
      }),
    });

    if (!r.ok) return null;
    const data = await r.json();

    const parts = [];
    if (data.answer) parts.push(`Quick answer: ${data.answer}`);
    (data.results || []).slice(0, 5).forEach((res, i) => {
      parts.push(`[${i + 1}] ${res.title}\n${res.content}\nSource: ${res.url}`);
    });

    return parts.length ? parts.join('\n\n') : null;
  } catch {
    return null;
  }
}

async function searchDuckDuckGo(query) {
  try {
    const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      },
    });
    if (!r.ok) return null;
    const html = await r.text();

    const results = [];
    const blockRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    const stripTags = s => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').trim();

    let m;
    while ((m = blockRe.exec(html)) && results.length < 5) {
      let url = m[1];
      const uddg = url.match(/uddg=([^&]+)/);
      if (uddg) { try { url = decodeURIComponent(uddg[1]); } catch {} }
      results.push({
        title: stripTags(m[2]),
        snippet: stripTags(m[3]),
        url,
      });
    }

    if (!results.length) return null;

    return results
      .map((res, i) => `[${i + 1}] ${res.title}\n${res.snippet}\nSource: ${res.url}`)
      .join('\n\n');
  } catch {
    return null;
  }
}

function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return part.text ?? '';
        if (part?.type === 'image') return '[image]';
        return '';
      })
      .join('\n')
      .trim();
  }
  return String(content ?? '');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (!body || typeof body === 'string') {
    try {
      const raw = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => resolve(data));
        req.on('error', reject);
      });
      body = raw ? JSON.parse(raw) : {};
    } catch { body = {}; }
  }

  const messages      = body.messages || [];
  const frontendModel = body.model    || 'mistral-ai/Codestral-2501';
  const username      = body.username || 'User';

  let apiUrl, apiKey, modelId, provider;

  if (frontendModel in GITHUB_MODEL_MAP) {
    provider = 'github';
    apiUrl   = 'https://models.inference.ai.azure.com/chat/completions';
    apiKey   = process.env.GITHUB_TOKEN;
    modelId  = GITHUB_MODEL_MAP[frontendModel];
  } else if (frontendModel in GROQ_MODEL_MAP) {
    provider = 'groq';
    apiUrl   = 'https://api.groq.com/openai/v1/chat/completions';
    apiKey   = process.env.GROQ_API_KEY;
    modelId  = GROQ_MODEL_MAP[frontendModel];
  } else {
    provider = 'github';
    apiUrl   = 'https://models.inference.ai.azure.com/chat/completions';
    apiKey   = process.env.GITHUB_TOKEN;
    modelId  = frontendModel;
  }

  writeLog(IS_LOCAL, { provider, model: modelId, status: 'calling', msgCount: messages.length });

  if (!apiKey) {
    return res.status(500).json({ error: `Missing API key for: ${provider}` });
  }

  const lastUserMsg = [...messages].reverse().find(m => m?.role === 'user');
  const searchQuery = lastUserMsg ? flattenContent(lastUserMsg.content) : '';
  const [searchResults, stockResults] = await Promise.all([
    searchWeb(searchQuery),
    getStockContext(searchQuery),
  ]);

  const extraContext = [
    stockResults ? `Live stock quotes (from Yahoo Finance):\n\n${stockResults}` : null,
    searchResults ? `Web search results:\n\n${searchResults}` : null,
  ].filter(Boolean).join('\n\n---\n\n');

  const today = new Date().toISOString().slice(0, 10);
  const systemMsg = {
    role: 'system',
    content: extraContext
      ? `You are LibreClaude, a helpful AI assistant. The user's name is ${username}. Today's date is ${today}. Be concise, accurate, and friendly.\n\nHere is current information relevant to the user's latest message — use it to answer questions about recent events, current facts, or live stock prices, and present it naturally in your own words (don't just dump the raw data, but do include the key numbers):\n\n${extraContext}`
      : `You are LibreClaude, a helpful AI assistant. The user's name is ${username}. Today's date is ${today}. Be concise, accurate, and friendly. If asked about very recent events you're unsure of, say you may not have up-to-date information.`,
  };

  const validRoles = new Set(['user', 'assistant', 'system']);
  const apiMessages = [
    systemMsg,
    ...messages
      .filter(m => validRoles.has(m?.role))
      .map(m => ({
        role:    m.role,
        content: flattenContent(m.content),
      }))
      .filter(m => m.content.length > 0),
  ];

  try {
    const upstream = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model:       modelId,
        messages:    apiMessages,
        max_tokens:  2048,
        temperature: 0.7,
      }),
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      const errMsg = data?.error?.message || data?.error || `Error ${upstream.status}`;

      if (upstream.status === 429 || isRateLimitError(errMsg)) {
        writeLog(IS_LOCAL, { provider, model: modelId, status: 429, error: errMsg });
        return res.status(429).json({ error: 'DAILY_LIMIT_REACHED' });
      }

      writeLog(IS_LOCAL, { provider, model: modelId, status: upstream.status, error: errMsg });
      return res.status(upstream.status).json({ error: errMsg });
    }

    const content = data?.choices?.[0]?.message?.content ?? '';
    writeLog(IS_LOCAL, { provider, model: modelId, status: 200, chars: content.length });
    return res.status(200).json({ content });

  } catch (err) {
    writeLog(IS_LOCAL, { provider, model: modelId, error: err.message });
    return res.status(502).json({ error: 'Unable to reach the API server.' });
  }
}

function writeLog(isLocal, info) {
  if (!isLocal) return;
  try {
    const logPath = path.resolve(process.cwd(), 'logs.txt');
    let logs = [];
    if (fs.existsSync(logPath)) {
      try { logs = JSON.parse(fs.readFileSync(logPath, 'utf8') || '[]'); } catch { logs = []; }
    }
    if (!Array.isArray(logs)) logs = [logs];
    logs.push({ timestamp: new Date().toISOString(), endpoint: 'api/chat', ...info });
    if (logs.length > 50) logs.splice(0, logs.length - 50);
    fs.writeFileSync(logPath, JSON.stringify(logs, null, 2));
  } catch (e) { console.error('Log write error:', e); }
                                             }  'xai/grok-3':                        'grok-3',
};

const GROQ_MODEL_MAP = {
  'llama-3.3-70b-versatile': 'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant':    'llama-3.1-8b-instant',
  'openai/gpt-oss-20b':      'gpt-oss-20b',
  'openai/gpt-oss-120b':     'gpt-oss-120b',
  'qwen/qwen3-32b':          'qwen/qwen3-32b',
};

// Rate limit / daily quota error patterns
const RATE_LIMIT_PATTERNS = [
  'rate limit', 'ratelimit', 'rate_limit',
  'quota exceeded', 'daily limit', 'daily quota',
  'too many requests', 'limit exceeded',
  'x-ratelimit', 'requests per day',
];

function isRateLimitError(msg = '') {
  const lower = msg.toLowerCase();
  return RATE_LIMIT_PATTERNS.some(p => lower.includes(p));
}

async function searchWeb(query) {
  if (!query) return null;

  const tavilyResult = await searchTavily(query);
  if (tavilyResult) return tavilyResult;

  // Fallback: free, no API key, used when Tavily key is missing,
  // fails, or its quota is exhausted.
  return await searchDuckDuckGo(query);
}

async function searchTavily(query) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return null;

  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: key,
        query,
        search_depth: 'basic',
        max_results: 5,
        include_answer: true,
      }),
    });

    if (!r.ok) return null;
    const data = await r.json();

    const parts = [];
    if (data.answer) parts.push(`Quick answer: ${data.answer}`);
    (data.results || []).slice(0, 5).forEach((res, i) => {
      parts.push(`[${i + 1}] ${res.title}\n${res.content}\nSource: ${res.url}`);
    });

    return parts.length ? parts.join('\n\n') : null;
  } catch {
    return null;
  }
}

async function searchDuckDuckGo(query) {
  try {
    const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      },
    });
    if (!r.ok) return null;
    const html = await r.text();

    const results = [];
    const blockRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    const stripTags = s => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').trim();

    let m;
    while ((m = blockRe.exec(html)) && results.length < 5) {
      let url = m[1];
      // DDG wraps links in a redirect; try to pull the real target if present
      const uddg = url.match(/uddg=([^&]+)/);
      if (uddg) { try { url = decodeURIComponent(uddg[1]); } catch {} }
      results.push({
        title: stripTags(m[2]),
        snippet: stripTags(m[3]),
        url,
      });
    }

    if (!results.length) return null;

    return results
      .map((res, i) => `[${i + 1}] ${res.title}\n${res.snippet}\nSource: ${res.url}`)
      .join('\n\n');
  } catch {
    return null;
  }
}

function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return part.text ?? '';
        if (part?.type === 'image') return '[image]';
        return '';
      })
      .join('\n')
      .trim();
  }
  return String(content ?? '');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (!body || typeof body === 'string') {
    try {
      const raw = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => resolve(data));
        req.on('error', reject);
      });
      body = raw ? JSON.parse(raw) : {};
    } catch { body = {}; }
  }

  const messages      = body.messages || [];
  const frontendModel = body.model    || 'mistral-ai/Codestral-2501';
  const username      = body.username || 'User';

  let apiUrl, apiKey, modelId, provider;

  if (frontendModel in GITHUB_MODEL_MAP) {
    provider = 'github';
    apiUrl   = 'https://models.inference.ai.azure.com/chat/completions';
    apiKey   = process.env.GITHUB_TOKEN;
    modelId  = GITHUB_MODEL_MAP[frontendModel];
  } else if (frontendModel in GROQ_MODEL_MAP) {
    provider = 'groq';
    apiUrl   = 'https://api.groq.com/openai/v1/chat/completions';
    apiKey   = process.env.GROQ_API_KEY;
    modelId  = GROQ_MODEL_MAP[frontendModel];
  } else {
    provider = 'github';
    apiUrl   = 'https://models.inference.ai.azure.com/chat/completions';
    apiKey   = process.env.GITHUB_TOKEN;
    modelId  = frontendModel;
  }

  writeLog(IS_LOCAL, { provider, model: modelId, status: 'calling', msgCount: messages.length });

  if (!apiKey) {
    return res.status(500).json({ error: `Missing API key for: ${provider}` });
  }

  const lastUserMsg = [...messages].reverse().find(m => m?.role === 'user');
  const searchQuery = lastUserMsg ? flattenContent(lastUserMsg.content) : '';
  const searchResults = await searchWeb(searchQuery);

  const today = new Date().toISOString().slice(0, 10);
  const systemMsg = {
    role: 'system',
    content: searchResults
      ? `You are LibreClaude, a helpful AI assistant. The user's name is ${username}. Today's date is ${today}. Be concise, accurate, and friendly.\n\nHere is current information from a web search relevant to the user's latest message — use it to answer questions about recent events, news, or current facts, and cite it naturally in your own words (don't just dump the raw search results):\n\n${searchResults}`
      : `You are LibreClaude, a helpful AI assistant. The user's name is ${username}. Today's date is ${today}. Be concise, accurate, and friendly. If asked about very recent events you're unsure of, say you may not have up-to-date information.`,
  };

  const validRoles = new Set(['user', 'assistant', 'system']);
  const apiMessages = [
    systemMsg,
    ...messages
      .filter(m => validRoles.has(m?.role))
      .map(m => ({
        role:    m.role,
        content: flattenContent(m.content),
      }))
      .filter(m => m.content.length > 0),
  ];

  try {
    const upstream = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model:       modelId,
        messages:    apiMessages,
        max_tokens:  2048,
        temperature: 0.7,
      }),
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      const errMsg = data?.error?.message || data?.error || `Error ${upstream.status}`;

      // Detect daily / rate limit errors
      if (upstream.status === 429 || isRateLimitError(errMsg)) {
        writeLog(IS_LOCAL, { provider, model: modelId, status: 429, error: errMsg });
        return res.status(429).json({ error: 'DAILY_LIMIT_REACHED' });
      }

      writeLog(IS_LOCAL, { provider, model: modelId, status: upstream.status, error: errMsg });
      return res.status(upstream.status).json({ error: errMsg });
    }

    const content = data?.choices?.[0]?.message?.content ?? '';
    writeLog(IS_LOCAL, { provider, model: modelId, status: 200, chars: content.length });
    return res.status(200).json({ content });

  } catch (err) {
    writeLog(IS_LOCAL, { provider, model: modelId, error: err.message });
    return res.status(502).json({ error: 'Unable to reach the API server.' });
  }
}

function writeLog(isLocal, info) {
  if (!isLocal) return;
  try {
    const logPath = path.resolve(process.cwd(), 'logs.txt');
    let logs = [];
    if (fs.existsSync(logPath)) {
      try { logs = JSON.parse(fs.readFileSync(logPath, 'utf8') || '[]'); } catch { logs = []; }
    }
    if (!Array.isArray(logs)) logs = [logs];
    logs.push({ timestamp: new Date().toISOString(), endpoint: 'api/chat', ...info });
    if (logs.length > 50) logs.splice(0, logs.length - 50);
    fs.writeFileSync(logPath, JSON.stringify(logs, null, 2));
  } catch (e) { console.error('Log write error:', e); }
}
