/**
 * DigitalCore API connector
 * Docs: https://digitalcore.top/docs
 *
 * Reglas de la tienda:
 * - El coste que devuelve DigitalCore es la base.
 * - La tienda aplica +3 USD fijos por unidad.
 * - La cantidad se recibe desde el sistema de tienda existente (qty).
 * - No trasladamos al cliente los descuentos/tier wholesale de DigitalCore.
 *
 * Importante:
 * - Un error 5xx/red es ambiguo: NO se reembolsa automáticamente.
 * - Los errores documentados de validación/saldo/stock sí son seguros para
 *   devolver el saldo porque DigitalCore no completa la compra en esos casos.
 */

const BASE_URL = process.env.DIGITALCORE_API_BASE_URL || 'https://digitalcore.top';
const API_KEY = process.env.DIGITALCORE_API_KEY;
const MARKUP_USD = 3;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function requireKey() {
  if (!API_KEY) {
    throw new Error('Falta DIGITALCORE_API_KEY en las variables de entorno.');
  }
}

async function parseResponse(response) {
  const text = await response.text();
  let data = {};

  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = { error: text.slice(0, 1000) };
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

async function request(path, { method = 'GET', body = null } = {}) {
  requireKey();

  const options = {
    method,
    headers: {
      'Api-Key': API_KEY,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
  };

  if (body) options.body = JSON.stringify(body);

  // Solo reintentamos GET ante un 429/503. Nunca repetimos automáticamente
  // un POST de compra porque podría crear una orden duplicada.
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`${BASE_URL}${path}`, options);
    const parsed = await parseResponse(response);

    if ((parsed.status === 429 || parsed.status === 503) && method === 'GET' && attempt === 0) {
      await sleep(1000);
      continue;
    }

    return parsed;
  }

  throw new Error('DigitalCore: no se pudo completar la petición.');
}

function normalizeProduct(product) {
  if (!product || product.id == null) return null;

  const cost = Number(product.price);
  if (!Number.isFinite(cost)) return null;

  const stock = product.stock == null ? null : Number(product.stock);
  const safeStock = Number.isFinite(stock) ? Math.max(0, Math.floor(stock)) : null;

  // DigitalCore permite hasta 1000 unidades por compra.
  // Si conocemos el stock, el selector queda limitado también por ese stock.
  const maxQty = safeStock === null ? 1000 : Math.min(safeStock, 1000);

  return {
    source: 'digitalcore',
    external_id: String(product.id),
    external_ref: String(product.id),
    name: product.name || String(product.id),
    description: product.description || product.details || '',
    instructions: product.instructions || product.terms || '',
    your_price_usd: cost,
    stock: safeStock,
    min_qty: 1,
    max_qty: maxQty,
    raw: product,
  };
}

async function getBalance() {
  const r = await request('/api/user/me');
  if (!r.ok) {
    throw new Error(r.data?.error || r.data?.message || `DigitalCore /api/user/me HTTP ${r.status}`);
  }
  return Number(r.data?.balance || 0);
}

async function getProducts() {
  const r = await request('/api/user/products');
  if (!r.ok) {
    throw new Error(r.data?.error || r.data?.message || `DigitalCore /api/user/products HTTP ${r.status}`);
  }

  const products = Array.isArray(r.data) ? r.data : (Array.isArray(r.data?.products) ? r.data.products : []);
  return products.map(normalizeProduct).filter(Boolean);
}

async function getOrder(orderId) {
  const encoded = encodeURIComponent(String(orderId));
  const r = await request(`/api/user/order?id=${encoded}`);
  if (r.status === 404) return null;
  if (!r.ok) {
    throw new Error(r.data?.error || r.data?.message || `DigitalCore order HTTP ${r.status}`);
  }
  return r.data;
}

/**
 * Crea una compra en DigitalCore.
 *
 * 5xx/network = ambiguo: el caller mantiene el saldo reservado.
 * 4xx documentados = seguro para reembolsar.
 */
async function createOrder({ productId, qty }) {
  requireKey();

  const quantity = Number(qty);
  if (!productId) {
    return {
      success: false,
      safeToRefund: true,
      error: { code: 'missing_product_id', message: 'Falta el ID del producto de DigitalCore.' },
    };
  }

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
    return {
      success: false,
      safeToRefund: true,
      error: { code: 'invalid_quantity', message: 'count debe ser un entero entre 1 y 1000.' },
    };
  }

  let response;
  try {
    response = await request('/api/user/buy', {
      method: 'POST',
      body: {
        id: String(productId),
        count: quantity,
      },
    });
  } catch (err) {
    return {
      success: false,
      ambiguous: true,
      error: { code: 'network_error', message: err.message },
    };
  }

  if (response.ok && response.data?.success) {
    const rawItems = Array.isArray(response.data.items) ? response.data.items : [];
    const items = rawItems.map(item => {
      if (typeof item === 'string') return item;
      if (item == null) return '';
      return item.content || item.key || item.value || item.url || JSON.stringify(item);
    }).filter(Boolean);

    return {
      success: true,
      external_order_code: response.data.order_id,
      items,
      instructions: '',
      total_cost: Number(response.data.total_amount),
      provider_view_url: response.data.view_url || null,
    };
  }

  // Estos errores indican que DigitalCore rechazó la compra.
  if ([400, 401, 404].includes(response.status)) {
    return {
      success: false,
      safeToRefund: true,
      error: {
        code: response.data?.error || `http_${response.status}`,
        message: response.data?.message || response.data?.error || `DigitalCore HTTP ${response.status}`,
      },
    };
  }

  // 429/5xx y cualquier respuesta inesperada quedan como ambiguas.
  // No repetimos el POST ni devolvemos el saldo automáticamente.
  return {
    success: false,
    ambiguous: true,
    error: {
      code: response.data?.error || `http_${response.status}`,
      message: response.data?.message || response.data?.error || `DigitalCore HTTP ${response.status}`,
    },
  };
}

module.exports = {
  MARKUP_USD,
  getBalance,
  getProducts,
  getOrder,
  createOrder,
};
