'use strict';

// Valores de reserva que ya utiliza el catálogo público cuando plan_prices
// no tiene una fila para algún plan. Mantener esta fuente compartida evita
// que el frontend y NOVA muestren importes diferentes.
module.exports = {
  basico: { cup: 900, mobile: 400, usdt: 0.7, stars: 150, ton: 2.0 },
  avanzado: { cup: 1800, mobile: 900, usdt: 1.4, stars: 270, ton: 3.0 },
  cuba_vip: { cup: 1200, mobile: 500, usdt: 2.0, stars: 180, ton: 2.2 },
  premium: { cup: 1500, mobile: 700, usdt: 1.1, stars: 210, ton: 2.5 },
  gaming_pro: { cup: 2000, mobile: 1300, usdt: 4.0, stars: 300, ton: 3.5 },
  anual: { cup: 15000, mobile: 10000, usdt: 30, stars: 2100, ton: 26.0 },
  express: { cup: 300, mobile: 150, usdt: 1.0, stars: 100, ton: 1.5 },
};
