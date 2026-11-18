# NOVA — cadena de cuatro proveedores IA

Fecha de actualización: 18 de noviembre de 2026

## Configuración implementada

NOVA utiliza cuatro proveedores secuenciales desde el servidor. Solo se llama al siguiente cuando el anterior no está configurado, falla, supera su límite, agota el tiempo, devuelve una respuesta vacía/no válida o responde en otro idioma.

1. **OpenRouter Free (principal)** — `https://openrouter.ai/api/v1/chat/completions`, modelo `openrouter/free`. Se mantienen los límites de coste de entrada y salida en cero para evitar enrutamiento a inferencia pagada.
2. **Z.AI (respaldo 2)** — `https://api.z.ai/api/paas/v4/chat/completions`, modelo fijo `glm-4.7-flash`, secreto `ZAI_API_KEY`.
3. **Novita (respaldo 3)** — `https://api.novita.ai/openai/chat/completions`, modelo fijo `apodex/apodex-1.1-mini`, secreto `NOVITA_API_KEY`.
4. **Cloudflare Workers AI (respaldo 4)** — endpoint REST de la cuenta, modelo fijo `@cf/zai-org/glm-4.7-flash`, secretos `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID`.

Los identificadores de Z.AI, Novita y Cloudflare están fijados en código; no se admite seleccionar desde variables de entorno un ID alternativo que pueda tener precio distinto. OpenRouter mantiene su control de precio máximo $0/$0 y sus filtros de proveedor. Ninguna clave está escrita en el código, documentación, HTML o ZIP.

## Precio y límites

Las fichas oficiales consultadas muestran tarifa de tokens $0/$0 para Z.AI `glm-4.7-flash` y Novita `apodex/apodex-1.1-mini`. Esto solo describe el precio por token del modelo listado y no garantiza cuota ilimitada, disponibilidad permanente ni 3.000 peticiones por día.

OpenRouter Free sigue sujeto al límite estándar publicado para cuentas sin créditos (50 solicitudes/día, 20/min); NOVA reserva un margen local (45/día, 18/min). Cloudflare Workers AI Free concede una asignación medida en Neurons (no en peticiones); NOVA limita la reserva estimada local a 7.500 Neurons/día. Los proveedores pueden cambiar sus límites, precios y disponibilidad.

## Comportamiento y seguridad

- La cadena es secuencial y se detiene ante la primera respuesta válida.
- Un error de un proveedor no impide intentar el siguiente.
- Si los cuatro fallan, NOVA devuelve un mensaje controlado e indica contactar con `@luvnt`.
- Las credenciales solo se leen desde variables/secrets del servidor: `OPENROUTER_API_KEY`, `ZAI_API_KEY`, `NOVITA_API_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
- La conversación directa en Telegram sigue procesando `/start`, `/help`, `/menu` y demás comandos existentes. Los mensajes que comienzan por `/` no se envían a NOVA, salvo `/nova` o `/Nova`; texto normal permanece disponible para NOVA después de los flujos existentes.
- NOVA conserva lectura estricta en Supabase: `users` y `payments` filtrados por el Telegram ID autenticado; `plan_prices` y `settings` como catálogo global. No se agregan operaciones de escritura.
- El contexto mínimo de la cuenta puede ser enviado al proveedor que termine atendiendo la petición. Antes de producción, revisa la política de tratamiento de datos de cada proveedor y asegúrate de tener las autorizaciones y bases legales necesarias.

## Pruebas locales

Comando: `npm test`

Resultado: **21 pruebas superadas, 0 fallidas**.

Incluye simulaciones para: estado de cuatro proveedores sin filtrar claves; OpenRouter como primer proveedor; cadena de respaldo completa OpenRouter → Z.AI → Novita → Cloudflare; parada cuando Z.AI o Novita responden; modo Cloudflare-only; validación Telegram; aislamiento por Telegram ID; mensajes en español; y ausencia de operaciones de escritura en Supabase.

Las pruebas son simuladas. No se ha llamado a las APIs externas con claves reales ni a Supabase/Telegram de producción.

## Variables de entorno

```env
NOVA_ENABLED=false
OPENROUTER_API_KEY=
NOVA_OPENROUTER_MODEL=openrouter/free
OPENROUTER_SITE_URL=
OPENROUTER_APP_NAME=VPN CUBA NOVA
NOVA_OPENROUTER_DAILY_LIMIT=45
NOVA_OPENROUTER_RPM_LIMIT=18
ZAI_API_KEY=
NOVITA_API_KEY=
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_API_TOKEN=
NOVA_CLOUDFLARE_DAILY_NEURON_LIMIT=7500
```

Configura las claves en los secretos/variables del servidor (por ejemplo, Secrets de Replit o variables del host). No subas `.env` real al repositorio. `NOVA_ENABLED` sigue en `false` en el ejemplo; actívala solo después de validar staging.

## Documentación oficial

- Z.AI pricing: https://docs.z.ai/guides/overview/pricing
- Z.AI API chat completions: https://docs.z.ai/api-reference/llm/chat-completion
- Novita modelo Apodex 1.1 Mini: https://novita.ai/models/model-detail/apodex-apodex-1.1-mini?from=pricing
- Novita API docs: https://novita.ai/docs/api-reference/model-apis
- OpenRouter free models: https://openrouter.ai/collections/free-models
- OpenRouter provider selection: https://openrouter.ai/docs/guides/routing/provider-selection
- Cloudflare GLM-4.7-Flash: https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/
- Cloudflare Workers AI pricing: https://developers.cloudflare.com/workers-ai/platform/pricing/
