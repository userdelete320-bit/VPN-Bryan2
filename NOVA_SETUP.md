# NOVA — instalación y operación

NOVA aparece en el Centro de soporte como una conversación separada. Permanece desactivada por defecto (`NOVA_ENABLED=false`), por lo que el ZIP puede desplegarse sin activar el chat. Los tickets humanos y las rutas de soporte existentes siguen separados.

## Proveedores de IA

NOVA usa dos APIs, en este orden:

1. **OpenRouter Free (principal)** — llama al endpoint OpenAI-compatible con `NOVA_OPENROUTER_MODEL=openrouter/free`. Ese alias selecciona automáticamente un modelo gratuito que admita la solicitud. En el nivel gratuito, OpenRouter publica 20 solicitudes/minuto y 50 solicitudes/día; NOVA se limita localmente a 18 por minuto y 45 por día para conservar margen. Las variantes gratis con sufijo `:free` no cuestan tokens y no requieren comprar créditos. El código rechaza un ID de modelo OpenRouter que no sea `openrouter/free` ni termine en `:free`, para no enviar accidentalmente solicitudes a modelos de pago. Los intentos fallidos pueden contar para el límite diario.
2. **Cloudflare Workers AI (respaldo)** — modelo `@cf/zai-org/glm-4.7-flash`, disponible en Workers Free. Cloudflare ofrece 10.000 neurons al día sin coste en Workers Free; NOVA reserva como máximo 7.500 neurons estimadas al día y añade un margen del 50% al cálculo. Si OpenRouter devuelve error, agota su cuota, o genera una respuesta inválida/no española, NOVA intenta Cloudflare.

Los límites cambian y dependen de la cuenta, modelo y proveedor. Estas APIs gratuitas no son ilimitadas, no garantizan capacidad para 10.000 clientes y no constituyen un SLA de producción. En OpenRouter la cuota básica indicada es 50 solicitudes/día; para Cloudflare el cupo gratuito se mide en neurons, no en un número fijo de solicitudes.

## Crear las claves

### OpenRouter

1. Crea una cuenta en [OpenRouter](https://openrouter.ai/).
2. En [Keys](https://openrouter.ai/settings/keys), crea una API key.
3. Mantén el uso en modelos gratuitos (`openrouter/free`) y no compres créditos si el objetivo es no pagar por inferencia.
4. Copia la clave solo al secreto `OPENROUTER_API_KEY` del servidor.

La solicitud incluye `provider.data_collection="deny"`, `provider.zdr=true` y `provider.max_price={prompt:0, completion:0}`. Los dos primeros filtros piden proveedores sin recopilación y endpoints ZDR; el último impone un tope de precio cero para que OpenRouter no enrute inferencia pagada. Esto puede reducir la disponibilidad: si no hay un endpoint gratuito que cumpla, NOVA pasa a Cloudflare. OpenRouter documenta que pueden existir endpoints con retención limitada por seguridad; para aplicar una política más estricta, activa también ZDR Only en los ajustes de privacidad de tu cuenta OpenRouter.

### Cloudflare Workers AI

1. Crea o utiliza una cuenta de [Cloudflare](https://dash.cloudflare.com/).
2. Abre **Workers AI** y selecciona **Use REST API**.
3. Usa **Create a Workers AI API Token** y guarda el token que genera Cloudflare.
4. Copia el **Account ID** de esa misma pantalla.
5. Añade `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID` a los secretos del servidor.
6. Mantén la cuenta en **Workers Free**. El plan Workers Paid cobra el uso de neurons que exceda la asignación gratuita; no cambies a un plan de pago si no deseas cargos.

El token debe tener los permisos Workers AI indicados por la plantilla oficial de Cloudflare para REST API. No uses un token global de administrador si puedes crear uno limitado a Workers AI.

## Variables de entorno

Usa `.env.example` como referencia y configura:

```env
NOVA_ENABLED=false
OPENROUTER_API_KEY=...
NOVA_OPENROUTER_MODEL=openrouter/free
OPENROUTER_SITE_URL=https://vpn-cuba.com
OPENROUTER_APP_NAME=VPN CUBA NOVA
NOVA_OPENROUTER_DAILY_LIMIT=45
NOVA_OPENROUTER_RPM_LIMIT=18
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...
NOVA_CLOUDFLARE_DAILY_NEURON_LIMIT=7500
```

El modelo Cloudflare está fijado en el código a `@cf/zai-org/glm-4.7-flash`, que está disponible en Workers Free; no se permite configurarlo a un modelo que pueda requerir un plan de pago. Las claves son independientes: NOVA funciona con OpenRouter, con Cloudflare o con ambos. Para tener respaldo automático, configura las dos. `/status` informa si cada una está configurada sin revelar claves.

## Protección de datos

OpenRouter recibe `data_collection=deny` y `zdr=true` por solicitud. La aplicación solo usa endpoints de inferencia; no activa herramientas de búsqueda ni plugins. Si no hay endpoint de OpenRouter que cumpla la política ZDR, se utiliza Cloudflare Workers AI. Cloudflare declara que Workers AI procesa el Customer Content solo durante el tiempo necesario para prestar el servicio y el modelo seleccionado se marca Zero Data Retention.

El servidor consulta en modo exclusivamente lectura los datos del cliente autenticado en Telegram y el catálogo. No se envían el Telegram ID, notas internas, capturas, claves, TXID, direcciones ni archivos de configuración. El resumen de pagos (importe, método, estado y fecha) y el plan del cliente sí se transmiten al proveedor que genere la respuesta para dar atención personalizada. El proveedor que responda procesará ese contexto; no actives la función si no aceptas esa transferencia. La redacción automática de mensajes es una protección adicional, no una garantía para detectar todos los datos sensibles.

## Datos de Supabase consultados

- `users`: plan, marca VIP, velocidades, datos de prueba y estado de mensajería del bot.
- `payments`: hasta 25 registros recientes del mismo Telegram ID. Se remiten al modelo solo los últimos 8 y campos permitidos; nunca capturas, notas, TXID ni archivos de conexión.
- `plan_prices`: tarifas estándar actuales, con fallback marcado cuando el catálogo público usa un valor predeterminado.
- `settings` (`key=plan_availability`): disponibilidad actual. Si la consulta falla, NOVA no inventa disponibilidad ni llama al modelo.

La cuenta consultada se determina únicamente por el Telegram ID extraído de `X-Telegram-Init-Data` y su firma validada con `BOT_TOKEN`. El cliente no puede sustituir ese ID desde el cuerpo de la solicitud. NOVA solo puede informar sobre ese mismo cliente; no puede consultar a terceros.

## Activación gradual y pruebas

1. Mantén `NOVA_ENABLED=false` durante el primer despliegue.
2. Verifica que `/api/nova/status` (o el montaje correspondiente en el servidor) muestra los proveedores esperados como configurados.
3. Prueba en un entorno de staging con una cuenta de cliente autorizada. Comprueba primero OpenRouter y después simula un error para verificar el fallback de Cloudflare.
4. Comprueba que los tickets humanos, pagos y las demás rutas siguen funcionando.
5. Solo después cambia `NOVA_ENABLED=true`.

Los contadores de cuota de esta versión son locales al proceso Node. Si despliegas varias instancias, cada una tendrá su propio contador; no existe una cuota global distribuida ni se creó una tabla para ello. Mantén las cuotas de cuenta de los proveedores como límite definitivo y monitoriza respuestas 429/503.

## Restricciones funcionales

NOVA lee la cuenta y el catálogo, pero no escribe datos. No activa, renueva ni cancela servicios; no aprueba pagos; no modifica saldos; no entrega configuraciones; no diagnostica el estado técnico de los túneles. Los planes Express siguen sin guardar duración elegida en `payments`, por lo que NOVA no calcula su vencimiento y deriva a `@luvnt`.

Las pruebas incluidas son simuladas: no contactan APIs externas ni Supabase real. Las cuentas y claves reales deben validarse en staging antes de activar el chat en producción.
