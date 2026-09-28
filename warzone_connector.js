/**
 * Warzone Shop API connector
 * API V1: https://api.warzoneshop.in/api/v1
 *
 * IMPORTANTE:
 * - La API usa X-API-Key.
 * - POST /order es una compra real.
 * - Un HTTP 500 es ambiguo: el pedido puede haberse creado.
 *   Por eso NO se reembolsa automáticamente después de un 500.
 * - Después de un 500 se consulta GET /orders y se busca el pedido.
 * - Si GET /orders tampoco puede verificarse, la orden local queda reservada
 *   para revisión; el cliente NO recibe reembolso en ese punto.
 */

const BASE_URL = process.env.WARZONE_API_BASE_URL || 'https://api.warzoneshop.in/api/v1';
const API_KEY = process.env.WARZONE_API_KEY;

// Usa exactamente el mismo markup fijo que el resto de la tienda.
const MARKUP_USD = 3;
const REQUEST_INTERVAL_MS = 350; // ~2.85 req/s, por debajo del límite de 3 req/s.

let lastRequestAt = 0;
let requestQueue = Promise.resolve();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function rateLimitedFetch(url, options = {}) {
  // Serializamos las peticiones del proceso para no superar el límite de Warzone.
  const run = async () => {
    const wait = Math.max(0, REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt));
    if (wait) await sleep(wait);
    lastRequestAt = Date.now();
    return fetch(url, options);
  };

  const current = requestQueue.then(run, run);
  requestQueue = current.catch(() => {});
  return current;
}

function requireKey() {
  if (!API_KEY) {
    throw new Error('Falta WARZONE_API_KEY en las variables de entorno.');
  }
}

async function parseResponse(response) {
  const text = await response.text();
  let data = null;

  if (text) {
    try { data = JSON.parse(text); }
    catch (_) { data = { error: text.slice(0, 1000) }; }
  }

  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    data: data || {},
  };
}

function retryAfterMs(headers) {
  const value = headers?.get?.('retry-after');
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.max(seconds * 1000, 500), 30000);
  }
  return 1500;
}

async function request(path, { method = 'GET', body = null, retryGet = true } = {}) {
  requireKey();

  const options = {
    method,
    headers: {
      'X-API-Key': API_KEY,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
  };
  if (body) options.body = JSON.stringify(body);

  let attempts = 0;

  while (true) {
    const response = await rateLimitedFetch(`${BASE_URL}${path}`, options);
    const parsed = await parseResponse(response);

    // GET sí puede reintentarse ante 500.
    if (parsed.status === 500 && method === 'GET' && retryGet && attempts < 1) {
      attempts++;
      await sleep(1000);
      continue;
    }

    // Warzone indica que 503 no llegó al purchase path y es seguro reintentar.
    if (parsed.status === 503 && attempts < 1) {
      attempts++;
      await sleep(1000);
      continue;
    }

    // 429: respetar Retry-After y hacer un solo reintento.
    if (parsed.status === 429 && attempts < 1) {
      attempts++;
      await sleep(retryAfterMs(parsed.headers));
      continue;
    }

    return parsed;
  }
}

function normalizeOrder(order) {
  if (!order) return null;
  return {
    external_order_code: order.order_id,
    service_id: order.service_id,
    quantity: Number(order.quantity),
    status: order.status,
    items: Array.isArray(order.delivered_products) ? order.delivered_products : [],
    amount: Number(order.amount),
    created_at: order.created_at,
  };
}

async function getBalance() {
  const r = await request('/me');
  if (!r.ok) {
    throw new Error(r.data?.error || `Warzone /me HTTP ${r.status}`);
  }
  return Number(r.data.wallet_balance || 0);
}

async function getProducts() {
  const r = await request('/products');
  if (!r.ok) {
    throw new Error(r.data?.error || `Warzone /products HTTP ${r.status}`);
  }
  return Array.isArray(r.data.services) ? r.data.services : [];
}

async function getOrders(page = 1, limit = 200) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const r = await request(`/orders?page=${Number(page) || 1}&limit=${safeLimit}`);
  if (!r.ok) {
    throw new Error(r.data?.error || `Warzone /orders HTTP ${r.status}`);
  }
  return r.data;
}

async function getOrder(orderId) {
  const encoded = encodeURIComponent(String(orderId));
  const r = await request(`/order/${encoded}`);
  if (r.status === 404) return null;
  if (!r.ok) {
    throw new Error(r.data?.error || `Warzone /order/${orderId} HTTP ${r.status}`);
  }
  return r.data?.order || null;
}

/**
 * Busca un pedido que haya aparecido después de la captura previa.
 * Esto reduce el riesgo de confundirlo con una compra anterior idéntica.
 */
function findNewMatchingOrder(ordersData, beforeIds, serviceId, qty, startedAtMs) {
  const orders = Array.isArray(ordersData?.orders) ? ordersData.orders : [];

  const matches = orders.filter(order => {
    const id = String(order.order_id || '');
    if (!id || beforeIds.has(id)) return false;
    if (String(order.service_id) !== String(serviceId)) return false;
    if (Number(order.quantity) !== Number(qty)) return false;

    if (order.created_at) {
      // La API documenta created_at en IST (UTC+05:30).
      const created = parseWarzoneDate(order.created_at);
      if (created && created.getTime() + 30000 < startedAtMs) return false;
    }
    return true;
  });

  matches.sort((a, b) => {
    const da = parseWarzoneDate(a.created_at)?.getTime() || 0;
    const db = parseWarzoneDate(b.created_at)?.getTime() || 0;
    return db - da;
  });

  return matches[0] || null;
}

function parseWarzoneDate(value) {
  if (!value) return null;
  // Warzone entrega "YYYY-MM-DD HH:mm:ss" en IST.
  const m = String(value).match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/
  );
  if (!m) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const [, y, mo, d, h, mi, s] = m.map(Number);
  // Convertimos IST (UTC+05:30) a UTC.
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s) - (5.5 * 60 * 60 * 1000));
}

/**
 * Crea una orden real.
 *
 * 500:
 *   - NO se devuelve false inmediatamente.
 *   - Se consulta /orders.
 *   - Si aparece la orden, se considera creada.
 *   - Si no aparece, se permite reembolsar.
 *   - Si /orders no puede verificarse, se marca como ambiguous.
 */
async function createOrder({ serviceId, qty }) {
  requireKey();

  const quantity = Number(qty);
  if (!serviceId) {
    return { success: false, safeToRefund: true, error: { code: 'missing_service_id', message: 'Falta service_id.' } };
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000) {
    return { success: false, safeToRefund: true, error: { code: 'invalid_quantity', message: 'quantity debe ser un entero entre 1 y 10000.' } };
  }

  const startedAtMs = Date.now();

  // Captura previa de IDs para distinguir una orden nueva de una antigua.
  let beforeIds = new Set();
  try {
    const before = await getOrders(1, 200);
    beforeIds = new Set((before.orders || []).map(o => String(o.order_id)));
  } catch (e) {
    // No bloqueamos la compra por un fallo de la lectura previa.
    console.warn('⚠️ Warzone: no se pudo tomar snapshot previo de /orders:', e.message);
  }

  const response = await request('/order', {
    method: 'POST',
    body: { service_id: String(serviceId), quantity },
    retryGet: false,
  });

  if (response.status === 200 && response.data?.success) {
    return {
      success: true,
      external_order_code: response.data.order_id,
      items: Array.isArray(response.data.products) ? response.data.products : [],
      instructions: '',
      total_cost: Number(response.data.total_cost),
      new_balance: Number(response.data.new_balance),
    };
  }

  // 500 = resultado ambiguo: el pedido puede existir.
  if (response.status === 500) {
    console.error('⚠️ Warzone POST /order devolvió 500. Verificando /orders antes de reembolsar...');

    try {
      const after = await getOrders(1, 200);
      const found = findNewMatchingOrder(after, beforeIds, serviceId, quantity, startedAtMs);

      if (found) {
        const normalized = normalizeOrder(found);

        // success = pedido cobrado y con entrega disponible.
        if (normalized.status === 'success' && normalized.items.length) {
          return {
            success: true,
            verified_after_500: true,
            external_order_code: normalized.external_order_code,
            items: normalized.items,
            instructions: '',
            total_cost: normalized.amount,
            provider_status: normalized.status,
          };
        }

        // "undelivered" cuenta como pagado según la documentación.
        // No se devuelve el saldo del cliente porque el proveedor ya cobró.
        return {
          success: false,
          ambiguous: true,
          provider_charged: true,
          external_order_code: normalized.external_order_code,
          provider_status: normalized.status,
          error: {
            code: 'order_created_undelivered',
            message: `Warzone creó la orden ${normalized.external_order_code}, pero todavía no hay productos entregados.`,
          },
        };
      }

      // /orders respondió correctamente y no existe la orden nueva:
      // Warzone documenta que 500 puede ser ambiguo, pero en este caso
      // podemos tratarlo como no cobrado.
      return {
        success: false,
        safeToRefund: true,
        verified_absent_after_500: true,
        error: {
          code: 'order_not_found_after_500',
          message: 'Warzone respondió 500 y la orden no apareció en GET /orders.',
        },
      };
    } catch (verifyError) {
      // Nunca reembolsar si no pudimos determinar qué pasó.
      return {
        success: false,
        ambiguous: true,
        verification_failed: true,
        error: {
          code: 'verification_failed_after_500',
          message: `POST /order devolvió 500 y GET /orders no pudo verificarse: ${verifyError.message}`,
        },
      };
    }
  }

  // 503/429 no llegan al purchase path según la documentación.
  if (response.status === 503 || response.status === 429) {
    return {
      success: false,
      safeToRefund: true,
      error: {
        code: `http_${response.status}`,
        message: response.data?.error || `Warzone HTTP ${response.status}`,
      },
    };
  }

  // 400/401/403/404/405/413: no hay motivo para asumir un cobro.
  return {
    success: false,
    safeToRefund: true,
    error: {
      code: `http_${response.status}`,
      message: response.data?.error || `Warzone HTTP ${response.status}`,
    },
  };
}

/**
 * Sincroniza Warzone con la tabla shop_products existente.
 *
 * El precio de venta sigue la misma regla que Qamify y GGSoma:
 * precio final = coste de la API + 3 USD fijos.
 */
async function syncCatalog(db) {
  if (!API_KEY) {
    return { source: 'warzone', skipped: true, reason: 'WARZONE_API_KEY no configurada' };
  }


  const services = await getProducts();
  const currentIds = [];

  for (const service of services) {
    const externalId = String(service.service_id);
    currentIds.push(externalId);

    const cost = service.price == null ? null : Number(service.price);
    const stock = Number(service.stock || 0);
    const orderable = Boolean(service.orderable) && cost !== null && stock > 0;

    // Igual que Qamify y GGSoma: +3 USD fijos al coste del proveedor.
    const finalPrice = cost === null ? null : Math.round((cost + MARKUP_USD) * 100) / 100;

    await db.upsertShopProduct({
      source: 'warzone',
      external_id: externalId,
      external_ref: externalId,
      name: service.name || externalId,
      description: service.pricing === 'unavailable'
        ? 'Producto temporalmente no disponible.'
        : `Stock disponible: ${stock}`,
      instructions: '',
      your_price_usd: cost,
      final_price_usd: finalPrice,
      stock,
      min_qty: 1,
      max_qty: Number(service.price_tiers?.at?.(-1)?.max_qty || service.max_qty || 10000),
      raw_data: service,
    });
  }

  if (currentIds.length) {
    await db.deactivateMissingShopProducts('warzone', currentIds);
  }

  return {
    source: 'warzone',
    synced: currentIds.length,
    orderable: services.filter(s => s.orderable).length,
    markup_usd: MARKUP_USD,
  };
}

module.exports = {
  getBalance,
  getProducts,
  getOrders,
  getOrder,
  createOrder,
  syncCatalog,
};
