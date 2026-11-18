# NOVA — proveedores gratuitos OpenRouter + Cloudflare Workers AI

Fecha de verificación: 16 de noviembre de 2026

## Configuración implementada

NOVA utiliza dos proveedores independientes, ambos desde el servidor:

1. **OpenRouter Free (principal)** — endpoint `https://openrouter.ai/api/v1/chat/completions`, modelo `openrouter/free`.
2. **Cloudflare Workers AI Free (respaldo)** — endpoint OpenAI-compatible de la cuenta Cloudflare, modelo fijo `@cf/zai-org/glm-4.7-flash`.

No queda ninguna referencia de configuración a Groq. No se añadieron dependencias ni se modificó el esquema de Supabase.

## Protecciones de coste

### OpenRouter

- Solo se admite `openrouter/free` o un modelo cuyo ID termine en `:free`. Si se configura por error un modelo de pago, el servidor vuelve a `openrouter/free`.
- Cada solicitud incluye `max_price: { prompt: 0, completion: 0 }` como techo de coste por token.
- La selección de endpoint usa `data_collection: deny`, `zdr: true` y `allow_fallbacks: false`.
- El límite local se establece por defecto en 18 solicitudes/minuto y 45/día, por debajo de los topes publicados de 20/minuto y 50/día para variantes gratuitas. Los intentos fallidos también se cuentan localmente.

OpenRouter informa que los modelos de su colección Free tienen precio de modelo de $0; las variantes `:free` no requieren comprar créditos. Su límite público para las variantes gratuitas es de 20 solicitudes/minuto y 50/día para una cuenta sin compras de créditos. El alias `openrouter/free` selecciona automáticamente un modelo gratuito disponible.

La petición aplica el filtro de datos y el requisito ZDR de OpenRouter. Su documentación explica que el modo `zdr=true` restringe a endpoints ZDR, aunque también puede admitir endpoints con retención por seguridad si la política de privacidad de la cuenta lo permite. Para una política más estricta, activa ZDR Only desde la configuración de privacidad de OpenRouter.

### Cloudflare Workers AI

- Modelo fijado en el código a `@cf/zai-org/glm-4.7-flash`; no hay una variable para cambiarlo accidentalmente a uno que exija pago.
- El catálogo oficial marca este modelo como multilingüe (más de 100 idiomas) y Zero Data Retention.
- La cuota gratuita publicada es de 10.000 neurons/día en Workers Free; al agotarse, las solicitudes adicionales fallan. En Workers Paid, el consumo superior a esa asignación se factura, por lo que debe mantenerse la cuenta en Workers Free para asegurar que el exceso no derive en cargos.
- El límite local de NOVA reserva como máximo 7.500 neurons/día estimadas y calcula el consumo con la tabla oficial del modelo: 5.500 neurons por millón de tokens de entrada y 36.400 por millón de tokens de salida, más un margen del 50%. Esta es una estimación local conservadora; el consumo autoritativo es el que informa Cloudflare.

## Comportamiento del respaldo

- Primero intenta OpenRouter si tiene clave y no agotó la cuota local.
- Si OpenRouter está limitado, devuelve error, no responde, se agota el tiempo o devuelve una respuesta no española/vacía, intenta Cloudflare si está configurado y queda cuota local.
- También funciona con Cloudflare como único proveedor si no hay clave de OpenRouter.
- Si ambos proveedores fallan o se agotan, NOVA entrega un error controlado y deriva a `@luvnt`.
- Los mensajes escritos principalmente en otro idioma se rechazan antes de consultar Supabase o cualquiera de los proveedores.
- Los datos privados del cliente se consultan desde Supabase en modo de solo lectura y el resumen mínimo se envía únicamente al proveedor que atienda esa petición. Las claves nunca llegan al navegador.

## Variables de entorno

```env
NOVA_ENABLED=false
OPENROUTER_API_KEY=
NOVA_OPENROUTER_MODEL=openrouter/free
OPENROUTER_SITE_URL=
OPENROUTER_APP_NAME=VPN CUBA NOVA
NOVA_OPENROUTER_DAILY_LIMIT=45
NOVA_OPENROUTER_RPM_LIMIT=18
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_API_TOKEN=
NOVA_CLOUDFLARE_DAILY_NEURON_LIMIT=7500
```

Mantener `NOVA_ENABLED=false` hasta verificar las credenciales y probar con una cuenta de staging. No introducir las claves en `public/`, frontend, repositorio público o conversaciones.

## Pruebas locales

Comando: `npm test`

Resultado: **13 pruebas superadas, 0 fallidas**.

Se simularon OpenRouter y Cloudflare; no se enviaron peticiones a APIs externas ni a Supabase de producción. Se comprobó el orden principal/respaldo, modo solo Cloudflare, protección de precio cero, parámetros de privacidad, límites y rutas de lectura. También se comprobaron 20 archivos JavaScript y 13 scripts inline de HTML sin errores de sintaxis.

## Límites que no se deben ocultar

Los proveedores gratuitos no son ilimitados ni tienen SLA. OpenRouter Free ofrece solo 50 solicitudes/día bajo la cuota estándar; Workers AI Free limita el uso por neurons y comparte esa cuota con otros usos de la cuenta Cloudflare. Por tanto, esta combinación no puede garantizar atender 10.000 clientes ni todos sus mensajes diariamente. Si el consumo supera las cuotas, NOVA dejará de responder por IA y derivará a soporte humano; no se ha habilitado facturación de pago desde el código.

Los contadores de cuota de la aplicación son locales al proceso Node y no son un limitador distribuido. La cuota autoritativa sigue siendo la del proveedor. Si se despliegan varios procesos/instancias, cada uno mantiene su propio contador local.

## Documentación oficial consultada

- OpenRouter Free Models: https://openrouter.ai/collections/free-models
- OpenRouter Pricing: https://openrouter.ai/pricing
- OpenRouter Provider Selection / data policies / ZDR: https://openrouter.ai/docs/guides/routing/provider-selection
- Cloudflare GLM-4.7-Flash: https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/
- Cloudflare Workers AI Pricing: https://developers.cloudflare.com/workers-ai/platform/pricing/
- Cloudflare OpenAI-compatible REST API: https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/
