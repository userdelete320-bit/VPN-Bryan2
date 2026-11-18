'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');

process.env.SUPABASE_URL = 'https://supabase.test.invalid';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.BOT_TOKEN = 'test-telegram-bot-token';
process.env.OPENROUTER_API_KEY = 'test-openrouter-api-key';
process.env.CLOUDFLARE_API_TOKEN = 'test-cloudflare-api-token';
process.env.CLOUDFLARE_ACCOUNT_ID = 'a'.repeat(32);
process.env.NOVA_ENABLED = 'true';
process.env.NOVA_OPENROUTER_DAILY_LIMIT = '45';
process.env.NOVA_CLOUDFLARE_DAILY_NEURON_LIMIT = '7500';

const queryLog = [];
let dbFailure = false;
let settingsFailure = false;
let openRouterCalls = 0;
let cloudflareCalls = 0;
let capturedProviderBody = null;
let capturedOpenRouterUrl = null;

const fakeRows = {
  users: {
    maybeSingle: {
      vip: true,
      plan: 'basico',
      plan_price: 900,
      vip_since: '2026-11-01T10:00:00.000Z',
      speed_download: 4,
      speed_upload: 2,
      is_active: true,
      trial_requested: false,
      trial_received: false,
      created_at: '2026-10-01T10:00:00.000Z',
      last_activity: '2026-11-16T10:00:00.000Z',
    },
  },
  payments: [{
    plan: 'basico', price: 900, method: 'transfer', status: 'approved',
    created_at: '2026-11-01T09:00:00.000Z', approved_at: '2026-11-01T09:05:00.000Z',
    config_sent: true, config_sent_at: '2026-11-01T10:00:00.000Z',
    // Estos campos representan información que NO se selecciona ni se envía a NOVA.
    screenshot_url: 'https://private.invalid/screenshot.png',
    notes: 'nota interna privada',
  }],
  plan_prices: [
    { plan: 'basico', cup: 945, mobile: 410, usdt: 1.6, stars: 160, ton: 2.1, updated_at: '2026-11-16T08:00:00.000Z' },
    { plan: 'avanzado', cup: 1800, mobile: 900, usdt: 2.8, stars: 270, ton: 3.0, updated_at: '2026-11-16T08:00:00.000Z' },
  ],
  settings: { value: JSON.stringify({ basico: false, avanzado: true }) },
};

class FakeQuery {
  constructor(table) {
    this.table = table;
    this.selection = null;
    this.filters = {};
    this.actions = [];
    queryLog.push(this);
  }
  select(fields) { this.actions.push('select'); this.selection = fields; return this; }
  eq(key, value) { this.filters[key] = String(value); return this; }
  order() { return this; }
  limit() { return this; }
  insert() { this.actions.push('insert'); throw new Error('NOVA test blocked a database write'); }
  update() { this.actions.push('update'); throw new Error('NOVA test blocked a database write'); }
  delete() { this.actions.push('delete'); throw new Error('NOVA test blocked a database write'); }
  upsert() { this.actions.push('upsert'); throw new Error('NOVA test blocked a database write'); }
  maybeSingle() {
    if (dbFailure || (settingsFailure && this.table === 'settings')) return Promise.resolve({ data: null, error: new Error('simulated database failure') });
    return Promise.resolve({ data: fakeRows[this.table]?.maybeSingle ?? fakeRows[this.table] ?? null, error: null });
  }
  then(resolve, reject) {
    if (dbFailure || (settingsFailure && this.table === 'settings')) return Promise.resolve({ data: null, error: new Error('simulated database failure') }).then(resolve, reject);
    return Promise.resolve({ data: fakeRows[this.table] || [], error: null }).then(resolve, reject);
  }
}

const fakeSupabaseClient = { from: (table) => new FakeQuery(table) };
const expressStub = {
  Router() {
    return {
      stack: [],
      get(path, handler) { this.stack.push({ method: 'GET', path, handler }); return this; },
      post(path, handler) { this.stack.push({ method: 'POST', path, handler }); return this; },
    };
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'express') return expressStub;
  if (request === '@supabase/supabase-js') return { createClient: () => fakeSupabaseClient };
  if (request === 'dotenv') return { config() {} };
  return originalLoad.call(this, request, parent, isMain);
};

const db = require('../supabase');
const router = require('../routes/nova');
Module._load = originalLoad;

function telegramInitData(userId) {
  const params = new URLSearchParams();
  params.set('auth_date', String(Math.floor(Date.now() / 1000)));
  params.set('user', JSON.stringify({ id: userId }));
  const checkString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  return `${params.toString()}&hash=${hash}`;
}

const chatHandler = router.stack.find(route => route.method === 'POST' && route.path === '/chat').handler;
const statusHandler = router.stack.find(route => route.method === 'GET' && route.path === '/status').handler;

test('el estado informa qué proveedores están configurados sin exponer secretos', () => {
  const response = {
    headers: {},
    set(name, value) { this.headers[name] = value; return this; },
    json(value) { this.body = value; return this; },
  };
  statusHandler({}, response);
  assert.equal(response.body.enabled, true);
  assert.deepEqual(response.body.providers, { openrouter: true, cloudflare: true });
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.doesNotMatch(JSON.stringify(response.body), /test-openrouter-api-key|test-cloudflare-api-token/);
});

async function invokeChat({ message = '¿Qué plan tengo y cuándo vence?', authId = '123456789', body = {}, invalidAuth = false } = {}) {
  let initData = telegramInitData(authId);
  if (invalidAuth) initData = initData.replace(/hash=([a-f0-9])/i, (_match, first) => `hash=${first.toLowerCase() === '0' ? '1' : '0'}`);
  const req = {
    body: { message, ...body },
    get(name) { return name.toLowerCase() === 'x-telegram-init-data' ? initData : undefined; },
  };
  const res = {
    statusCode: 200,
    headersSent: false,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; this.headersSent = true; return this; },
  };
  await chatHandler(req, res);
  return res;
}

test('NOVA lee el perfil y los pagos usando solamente el Telegram ID validado', async () => {
  const before = queryLog.length;
  const previousConfiguredModel = process.env.NOVA_OPENROUTER_MODEL;
  process.env.NOVA_OPENROUTER_MODEL = 'openai/model-with-paid-pricing';
  global.fetch = async (url, options) => {
    if (url.includes('openrouter.ai')) {
      openRouterCalls += 1;
      capturedProviderBody = JSON.parse(options.body);
      capturedOpenRouterUrl = url;
    } else if (url.includes('api.cloudflare.com')) {
      cloudflareCalls += 1;
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          usage: { prompt_tokens: 700, completion_tokens: 200, total_tokens: 900 },
          choices: [{ message: { content: 'Tu registro muestra el Plan Básico y un pago aprobado. La vigencia se calcula desde la entrega de la configuración.' } }],
        };
      },
    };
  };

  const response = await invokeChat({
    authId: '123456789',
    body: { telegramId: '999999999', customerId: '999999999' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.success, true);
  assert.match(capturedProviderBody.messages[0].content, /Plan Básico/);
  assert.match(capturedProviderBody.messages[0].content, /945/);
  assert.match(capturedProviderBody.messages[0].content, /vigente_segun_fecha_de_entrega/);
  assert.match(capturedProviderBody.messages[0].content, /puede_recibir_mensajes_segun_el_campo_is_active/);
  assert.doesNotMatch(capturedProviderBody.messages[0].content, /\"account_status\"/);
  assert.match(capturedProviderBody.messages[0].content, /puede_recibir_mensajes_segun_el_campo_is_active/);
  assert.doesNotMatch(capturedProviderBody.messages[0].content, /"account_status"/);
  assert.doesNotMatch(capturedProviderBody.messages[0].content, /private\.invalid|nota interna privada|999999999/);

  const newQueries = queryLog.slice(before);
  const userQuery = newQueries.find(query => query.table === 'users');
  const paymentQuery = newQueries.find(query => query.table === 'payments');
  assert.equal(userQuery.filters.telegram_id, '123456789');
  assert.equal(paymentQuery.filters.telegram_id, '123456789');
  assert.doesNotMatch(userQuery.selection, /email|phone|password|secret/i);
  assert.doesNotMatch(paymentQuery.selection, /screenshot|notes|txid|address|config_file/i);
  assert.match(paymentQuery.selection, /original_price/);
  assert.equal(openRouterCalls, 1);
  assert.equal(cloudflareCalls, 0);
  assert.equal(capturedOpenRouterUrl, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(capturedProviderBody.model, 'openrouter/free');
  if (previousConfiguredModel === undefined) delete process.env.NOVA_OPENROUTER_MODEL;
  else process.env.NOVA_OPENROUTER_MODEL = previousConfiguredModel;
  assert.equal(capturedProviderBody.provider.data_collection, 'deny');
  assert.equal(capturedProviderBody.provider.zdr, true);
  assert.equal(capturedProviderBody.provider.allow_fallbacks, false);
  assert.deepEqual(capturedProviderBody.provider.max_price, { prompt: 0, completion: 0 });
});


test('NOVA rechaza una firma Telegram inválida antes de consultar la base de datos', async () => {
  const beforeQueries = queryLog.length;
  const beforeProvider = openRouterCalls;
  const beforeCloudflare = cloudflareCalls;
  const response = await invokeChat({ invalidAuth: true, authId: '999999991' });
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.code, 'TELEGRAM_AUTH_REQUIRED');
  assert.equal(queryLog.length, beforeQueries);
  assert.equal(openRouterCalls, beforeProvider);
  assert.equal(cloudflareCalls, beforeCloudflare);
});

test('NOVA entrega catálogo desde plan_prices y disponibilidad de settings', async () => {
  assert.ok(capturedProviderBody);
  const prompt = capturedProviderBody.messages[0].content;
  assert.match(prompt, /plan_prices/);
  assert.match(prompt, /settings/);
  assert.match(prompt, /"availability":"disponible"/);
  assert.match(prompt, /"availability":"agotado"/);
  assert.match(prompt, /"duration":"90 días"/);
  assert.match(prompt, /"name":"Plan Express"/);
  assert.match(prompt, /"duration":"7 días"/);
  assert.match(prompt, /precios_fijos_mostrados_por_la_interfaz_publica/);
  assert.match(prompt, /\"PayPal_USD\":3/);
});

test('NOVA no calcula vencimiento antes de que la configuración conste como enviada', async () => {
  fakeRows.payments[0].config_sent = false;
  const realNow = Date.now;
  Date.now = () => realNow() + 60_000; // Evita colisiones con límites temporales en pruebas largas.
  let response;
  try { response = await invokeChat({ authId: '123456788' }); }
  finally { Date.now = realNow; }
  assert.equal(response.statusCode, 200);
  assert.match(capturedProviderBody.messages[0].content, /esperando_entrega_de_configuracion/);
  assert.doesNotMatch(capturedProviderBody.messages[0].content, /"expires_at":"/);
  fakeRows.payments[0].config_sent = true;
});


test('una renovación aprobada aún sin configurar no borra la vigencia de la última configuración entregada', async () => {
  const previousPayments = fakeRows.payments;
  fakeRows.payments = [
    { plan: 'basico', price: 900, method: 'transfer', status: 'approved', created_at: '2026-11-15T09:00:00.000Z', approved_at: '2026-11-15T09:05:00.000Z', config_sent: false, config_sent_at: null },
    { plan: 'basico', price: 900, method: 'transfer', status: 'approved', created_at: '2026-11-01T09:00:00.000Z', approved_at: '2026-11-01T09:05:00.000Z', config_sent: true, config_sent_at: '2026-11-01T10:00:00.000Z' },
  ];
  const realNow = Date.now;
  Date.now = () => realNow() + 180_000;
  let response;
  try { response = await invokeChat({ authId: '123456784' }); }
  finally { Date.now = realNow; fakeRows.payments = previousPayments; }
  assert.equal(response.statusCode, 200);
  const prompt = capturedProviderBody.messages[0].content;
  assert.match(prompt, /latest_approved_payment_waiting_for_configuration\":true/);
  assert.match(prompt, /2026-12-01T10:00:00.000Z/);
});

test('si OpenRouter falla, NOVA utiliza Cloudflare Workers AI como respaldo gratuito', async () => {
  const beforeOpenRouter = openRouterCalls;
  const beforeCloudflare = cloudflareCalls;
  const previousConfiguredModel = process.env.NOVA_OPENROUTER_MODEL;
  process.env.NOVA_OPENROUTER_MODEL = 'openai/model-with-paid-pricing';
  global.fetch = async (url, options) => {
    if (url.includes('openrouter.ai')) {
      openRouterCalls += 1;
      return { ok: false, status: 429, async json() { return { error: 'rate limited' }; } };
    }
    if (url.includes('api.cloudflare.com')) {
      cloudflareCalls += 1;
      const body = JSON.parse(options.body);
      assert.equal(body.model, '@cf/zai-org/glm-4.7-flash');
      assert.equal(body.stream, false);
      return {
        ok: true,
        status: 200,
        async json() {
          return { choices: [{ message: { content: 'Según los datos disponibles, tu plan es el Básico. La vigencia se calcula desde la entrega de la configuración.' } }] };
        },
      };
    }
    throw new Error('URL de proveedor inesperada');
  };

  const response = await invokeChat({ authId: '123456780' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.provider, 'Cloudflare Workers AI');
  assert.equal(openRouterCalls, beforeOpenRouter + 1);
  assert.equal(cloudflareCalls, beforeCloudflare + 1);
});

test('NOVA puede funcionar solo con Cloudflare cuando no hay clave de OpenRouter', async () => {
  const previousOpenRouterKey = process.env.OPENROUTER_API_KEY;
  const beforeOpenRouter = openRouterCalls;
  const beforeCloudflare = cloudflareCalls;
  process.env.OPENROUTER_API_KEY = '';
  global.fetch = async (url, options) => {
    assert.ok(url.includes('api.cloudflare.com'));
    assert.equal(options.headers.Authorization, 'Bearer test-cloudflare-api-token');
    cloudflareCalls += 1;
    return {
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content: 'Puedo consultar tu plan y los pagos registrados de tu propia cuenta.' } }] };
      },
    };
  };
  try {
    const response = await invokeChat({ authId: '123456779' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.provider, 'Cloudflare Workers AI');
    assert.equal(openRouterCalls, beforeOpenRouter);
    assert.equal(cloudflareCalls, beforeCloudflare + 1);
  } finally {
    process.env.OPENROUTER_API_KEY = previousOpenRouterKey;
  }
});

test('un fallo de Supabase se cierra sin llamar al proveedor', async () => {
  dbFailure = true;
  const callsBefore = openRouterCalls;
  const cloudflareCallsBefore = cloudflareCalls;
  const response = await invokeChat({ authId: '123456787' });
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, 'CUSTOMER_DATA_UNAVAILABLE');
  assert.equal(openRouterCalls, callsBefore);
  assert.equal(cloudflareCalls, cloudflareCallsBefore);
  dbFailure = false;
});


test('si falla la consulta de disponibilidad, NOVA no inventa que el plan esté disponible', async () => {
  settingsFailure = true;
  const callsBefore = openRouterCalls;
  const cloudflareCallsBefore = cloudflareCalls;
  const response = await invokeChat({ authId: '123456785' });
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, 'CUSTOMER_DATA_UNAVAILABLE');
  assert.equal(openRouterCalls, callsBefore);
  assert.equal(cloudflareCalls, cloudflareCallsBefore);
  settingsFailure = false;
});

test('un mensaje en inglés se rechaza sin consultar la base de datos ni los proveedores', async () => {
  const beforeQueries = queryLog.length;
  const beforeProvider = openRouterCalls;
  const beforeCloudflare = cloudflareCalls;
  const response = await invokeChat({ message: 'Hello, what is my plan?' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.languageRejected, true);
  assert.match(response.body.reply, /solo puedo atenderte en español/i);
  assert.equal(queryLog.length, beforeQueries);
  assert.equal(openRouterCalls, beforeProvider);
  assert.equal(cloudflareCalls, beforeCloudflare);
});

test('las consultas de NOVA no ejecutan operaciones de escritura', () => {
  for (const query of queryLog) {
    assert.equal(query.actions.some(action => ['insert', 'update', 'delete', 'upsert'].includes(action)), false);
  }
});

test('las funciones nuevas de lectura existen en la capa Supabase', async () => {
  assert.equal(typeof db.getNovaCustomerSnapshot, 'function');
  assert.equal(typeof db.getNovaPlanCatalog, 'function');
  const snapshot = await db.getNovaCustomerSnapshot('123456789');
  const catalog = await db.getNovaPlanCatalog();
  assert.equal(snapshot.user.vip, true);
  assert.equal(snapshot.payments[0].status, 'approved');
  assert.equal(catalog.prices[0].cup, 945);
  assert.equal(catalog.prices.find(row => row.plan === 'basico').price_source, 'supabase_plan_prices');
  assert.equal(catalog.prices.find(row => row.plan === 'gaming_pro').price_source, 'project_default_used_by_public_catalog');
  assert.equal(catalog.prices.find(row => row.plan === 'gaming_pro').cup, 2000);
});
