# NOVA — Matriz de acceso a datos y aislamiento

## Principio

El modelo no recibe credenciales Supabase y no puede elegir tablas, columnas, filtros o consultas. El backend valida el Telegram ID desde el contexto auténtico del bot o `initData` firmado y construye un contexto limitado a ese ID. Las lecturas esenciales `users` y `payments` fallan cerradas; lecturas secundarias devuelven `available=false` ante error y no se presentan como cero.

## Datos privados por cliente

| Tabla / función | Filtro aplicado | Qué puede llegar al modelo | Qué se excluye |
|---|---|---|---|
| `users` | `telegram_id = ID autenticado` | plan, marca VIP, velocidades registradas, datos de pruebas, XP/recompensas y descuento/referral metadata limitado | ID, email/teléfono, campos secretos y credenciales |
| `payments` | `telegram_id = ID autenticado` | plan, importe, moneda inferida del método, estado y fechas, marca de configuración enviada | capturas, notas, TXID, direcciones y archivos |
| `referrals` | `referrer_id = ID autenticado` | totales por nivel, pagados y descuentos no utilizados | nombres, usernames, IDs y detalles de los referidos |
| Monedero de referidos (RPC) | Desactivado en NOVA hasta auditar el SQL | Ningún saldo se transmite todavía | Se evita ejecutar una función cuya definición no está versionada |
| `trial_history`, `xp_log`, `coupon_usage` | `telegram_id = ID autenticado` | historial limitado de pruebas, actividad XP y cupones propios | datos de terceros |
| `shop_balances`, `shop_topups`, `shop_orders` | `telegram_id = ID autenticado` | saldo, estado/importe de recargas, productos y estados de pedidos propios | direcciones de depósito, TXID y códigos de entrega privados |
| `support_tickets` | `telegram_id = ID autenticado` | tickets propios, estado y asunto | tickets de terceros |
| `support_messages` | `ticket_id` previamente obtenido de tickets propios | últimos mensajes user/admin, recortados y redactados | otros roles, IDs de remitentes, tickets ajenos |
| `resellers` | `telegram_id = ID autenticado` | estado y saldos propios | revendedores ajenos |
| `reseller_sales`, `reseller_withdrawals`, `reseller_clients` | `reseller_id` obtenido del registro propio | sumas, cantidades y estados agregados | nombres, usernames, Telegram ID y transacciones individuales de clientes del revendedor |
| `reseller_clients` para cliente | `client_telegram_id = ID autenticado` | indicador de vinculación sí/no | identidad del revendedor |

## Datos generales permitidos

- `plan_prices`: filas de catálogo y precios realmente guardados.
- `settings`: solo `key=plan_availability`.
- `shop_products`: solo productos activos y campos comerciales seleccionados.
- `coupons`: solo cupones activos, no agotados y no vencidos.
- `announcements` y `popup_announcement`: solo avisos de empresa activos y vigentes.
- `reseller_config`: parámetros comerciales permitidos, solo cuando el usuario tiene una ficha propia de revendedor.

## Exclusiones

No se proporcionan `config_files`, `plan_files`, `trial_files`, capturas, storage, claves, tokens, contraseñas, direcciones de billetera, TXID, notas administrativas, informes de todos los usuarios, estadísticas generales privadas, logs administrativos ni filas de otros clientes. `usdt_payments` queda fuera hasta que el código/schema demuestre un vínculo inequívoco con el Telegram ID autenticado. `referral_withdrawals` también queda fuera: el código actual solo muestra una consulta administrativa global y el esquema de propiedad del registro no está confirmado. NOVA no debe intentar filtrar una tabla privada por una columna supuesta.

## Límite técnico pendiente

El bot existente usa una función SQL `get_referral_wallet` para mostrar el monedero, pero su definición no está versionada en el repositorio. NOVA no la invoca: se mantiene desactivada hasta revisar el SQL real y confirmar que solo lee y limita el resultado al Telegram ID recibido. Las estadísticas propias de referidos sí se consultan directamente desde `referrals` con `referrer_id = ID autenticado`, entregando solo agregados y nunca identidades.

## Precios en USD

La lectura actual de `plan_prices` solo selecciona `cup`, `mobile`, `usdt`, `stars` y `ton`; no existe una columna USD en el código de consulta. Los importes USD escritos en el prompt del usuario no se han fijado como constantes. Añadir una columna/campo confirmado a `plan_prices` antes de hacer que NOVA cotice esos importes.

## Transferencia a proveedores

Un proveedor de IA que recibe el contexto puede haberlo procesado aunque devuelva timeout/error. En tal caso un proveedor posterior podría recibir de nuevo parte del mismo contexto al ejecutarse el fallback. Se transmite solo el contexto construido y redactado, pero la política de privacidad y los términos de cada proveedor deben revisarse antes del uso real con información de clientes.
