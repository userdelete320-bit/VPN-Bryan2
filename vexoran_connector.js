/**
 * Vexoran Reseller API connector.
 * Docs: https://docs.vexoran.app
 * Base URL: https://api.vexoran.app
 * Auth: Authorization: Bearer <VEXORAN_API_KEY>
 *
 * Safety:
 * - Every order includes external_order_id to make retries idempotent.
 * - A definitive failure can be refunded locally.
 * - If Vexoran reports refund: "held" or the result is uncertain, the
 *   local order remains reserved; do not refund automatically.
 */

const BASE_URL = (process.env.VEXORAN_API_BASE_URL || 'https://api.vexoran.app').replace(/\/$/, '');
const API_KEY = process.env.VEXORAN_API_KEY;
const REQUEST_INTERVAL_MS = 1050; // Vexoran permits 60 requests per 60 seconds per key.

let lastRequestAt = 0;
let requestQueue = Promise.resolve();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function requireKey() {
  if (!API_KEY) throw new Error('Falta VEXORAN_API_KEY en las variables de entorno.');
}

async function rateLimitedFetch(url, options = {}) {
  const run = async () => {
    const wait = Math.max(0, REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt));
    if (wait) await sleep(wait);
    lastRequestAt = Date.now();
    return fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(30000) });
  };
  const current = requestQueue.then(run, run);
  requestQueue = current.catch(() => {});
  return current;
}

async function request(action, { method = 'GET', params = {}, body = null } = {}) {
  requireKey();
  const url = new URL(BASE_URL);
  url.searchParams.set('action', action);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }

  const response = await rateLimitedFetch(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await response.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); }
    catch (_) { data = { error: text.slice(0, 1000) }; }
  }
  return { ok: response.ok, status: response.status, headers: response.headers, data };
}

function normalizeOrderStatus(order) {
  const status = String(order?.status || '').toLowerCase();
  if (status === 'delivered') return 'delivered';
  if (['cancelled', 'canceled', 'refunded', 'failed'].includes(status)) return 'failed';
  return status || 'unknown';
}

function successfulOrder(order) {
  const status = normalizeOrderStatus(order);
  if (status !== 'delivered') return null;
  const content = typeof order.data === 'string' ? order.data.trim() : '';
  return {
    success: true,
    external_order_code: order.order_id || null,
    items: content ? [content] : [],
    instructions: order.delivery_instructions || '',
    total_cost: Number(order.amount || 0),
  };
}

async function findOrderByExternalId(externalOrderId) {
  const response = await request('orders', { params: { limit: 100, offset: 0 } });
  if (!response.ok) throw new Error(response.data?.error || `Vexoran orders HTTP ${response.status}`);
  const orders = Array.isArray(response.data.orders) ? response.data.orders : [];
  return orders.find(order => String(order.external_order_id || '') === String(externalOrderId)) || null;
}

async function getBalance() {
  const response = await request('balance');
  if (!response.ok) throw new Error(response.data?.error || `Vexoran balance HTTP ${response.status}`);
  const balance = Number(response.data.balance);
  if (!Number.isFinite(balance)) throw new Error('Vexoran devolvió un saldo no válido.');
  return balance;
}

async function getProducts() {
  const response = await request('products');
  if (!response.ok) throw new Error(response.data?.error || `Vexoran products HTTP ${response.status}`);
  if (!Array.isArray(response.data.products)) throw new Error('Vexoran no devolvió una lista de productos válida.');
  return response.data.products;
}

async function createOrder({ productId, qty, idempotencyKey }) {
  if (!productId) {
    return { success: false, safeToRefund: true, error: { code: 'missing_product_id', message: 'Falta el ID del producto Vexoran.' } };
  }
  if (!idempotencyKey) {
    return { success: false, safeToRefund: true, error: { code: 'missing_idempotency_key', message: 'Falta la clave de idempotencia de la orden.' } };
  }

  const body = {
    product_id: String(productId),
    quantity: Math.max(1, Math.floor(Number(qty) || 1)),
    external_order_id: String(idempotencyKey).slice(0, 200),
  };

  let response;
  try {
    response = await request('order', { method: 'POST', body });
  } catch (error) {
    // Un timeout/conexión cortada no prueba que la orden no se haya creado.
    try {
      const existing = await findOrderByExternalId(body.external_order_id);
      if (existing) {
        const success = successfulOrder(existing);
        if (success) return { ...success, verified_after_network_error: true };
        if (normalizeOrderStatus(existing) === 'failed') {
          return { success: false, safeToRefund: true, error: { code: 'order_failed_after_network_error', message: `Vexoran registró la orden ${existing.order_id || ''} como fallida/cancelada.` } };
        }
        return { success: false, ambiguous: true, external_order_code: existing.order_id, error: { code: 'order_pending_after_network_error', message: 'Vexoran registró la orden, pero aún no figura como entregada.' } };
      }
    } catch (verifyError) {
      return { success: false, ambiguous: true, verification_failed: true, error: { code: 'verification_failed_after_network_error', message: `No se pudo confirmar el resultado de Vexoran: ${verifyError.message}` } };
    }
    return { success: false, ambiguous: true, error: { code: 'network_error_order_outcome_unknown', message: `La conexión falló y no se pudo confirmar si Vexoran creó la orden: ${error.message}` } };
  }

  if (response.ok && String(response.data.status || '').toLowerCase() === 'delivered') {
    return successfulOrder(response.data);
  }

  // A duplicate external_order_id means an earlier attempt may already exist.
  if (response.status === 409 && response.data.error === 'duplicate_external_order_id') {
    try {
      const existing = await findOrderByExternalId(body.external_order_id);
      if (existing) {
        const success = successfulOrder(existing);
        if (success) return { ...success, verified_after_duplicate: true };
        if (normalizeOrderStatus(existing) === 'failed') {
          return { success: false, safeToRefund: true, error: { code: 'duplicate_order_failed', message: `La orden previa ${existing.order_id || ''} está cancelada.` } };
        }
        return { success: false, ambiguous: true, external_order_code: existing.order_id, error: { code: 'duplicate_order_pending', message: 'Vexoran está procesando una orden con esta clave. No se reembolsará automáticamente.' } };
      }
      return { success: false, ambiguous: true, error: { code: 'duplicate_order_not_found_yet', message: 'Vexoran detectó una orden duplicada, pero todavía no aparece en el historial.' } };
    } catch (error) {
      return { success: false, ambiguous: true, verification_failed: true, error: { code: 'duplicate_verification_failed', message: error.message } };
    }
  }

  // Vexoran explicitly says these 502 outcomes are definitive and the provider
  // balance has already been refunded or is being refunded.
  if (response.status === 502 && ['refunded', 'processing'].includes(String(response.data.refund || '').toLowerCase())) {
    return { success: false, safeToRefund: true, error: { code: response.data.reason || 'upstream_delivery_failed', message: response.data.message || response.data.error || 'Vexoran no pudo entregar el producto; el saldo del proveedor fue devuelto o está en proceso.' } };
  }

  // refund: held means the upstream order may exist: keep the customer's funds reserved.
  if (response.status === 502 && String(response.data.refund || '').toLowerCase() === 'held') {
    return { success: false, ambiguous: true, provider_charged: true, external_order_code: response.data.order_id || null, error: { code: response.data.detail || 'upstream_delivery_pending', message: response.data.message || response.data.error || 'Vexoran dejó la orden pendiente de resolución manual.' } };
  }

  // Reconcile unexpected server errors before deciding whether to refund.
  if (response.status >= 500) {
    try {
      const existing = await findOrderByExternalId(body.external_order_id);
      if (existing) {
        const success = successfulOrder(existing);
        if (success) return { ...success, verified_after_server_error: true };
        if (normalizeOrderStatus(existing) === 'failed') {
          return { success: false, safeToRefund: true, error: { code: 'order_failed_after_server_error', message: response.data.message || response.data.error || 'Vexoran confirmó que la orden falló.' } };
        }
        return { success: false, ambiguous: true, external_order_code: existing.order_id, error: { code: 'order_pending_after_server_error', message: 'La orden existe en Vexoran, pero no está entregada todavía.' } };
      }
    } catch (error) {
      return { success: false, ambiguous: true, verification_failed: true, error: { code: 'verification_failed_after_server_error', message: `Vexoran HTTP ${response.status}; no se pudo verificar la orden: ${error.message}` } };
    }
    return { success: false, ambiguous: true, error: { code: `vexoran_http_${response.status}_unknown`, message: response.data.message || response.data.error || `Vexoran HTTP ${response.status}; resultado de la orden incierto.` } };
  }

  return {
    success: false,
    safeToRefund: true,
    error: {
      code: response.data.reason || response.data.error || `vexoran_http_${response.status}`,
      message: response.data.message || response.data.error || `Vexoran respondió HTTP ${response.status}.`,
    },
  };
}

module.exports = { getBalance, getProducts, createOrder };
