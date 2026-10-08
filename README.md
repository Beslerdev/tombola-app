# Tutombola!

Plataforma para que organizadores vendan tómbolas 00–99 online.

- **Organizadores** se registran solos (`/registro`), tienen 7 días de prueba y después una suscripción mensual que pagan con Mercado Pago a la cuenta de Tutombola!. Si no renuevan, sus tómbolas se suspenden (no aceptan compras nuevas; lo vendido se respeta).
- Cada organizador crea tómbolas con link propio (`/t/<slug>`) y elige cómo cobrar:
  - **Mercado Pago** conectado por OAuth: el pago va a su cuenta y se confirma solo (webhook + verificación al volver).
  - **Transferencia a su alias**: el comprador sube el comprobante y el organizador lo aprueba.
- **Dueño** (`/dueno`): organizadores, vencimientos, pagos de suscripción, sumar días, generar contraseña, bloquear.

## Páginas

| Ruta | Qué es |
|---|---|
| `/` | Página de la plataforma |
| `/ingresar`, `/registro` | Cuenta del organizador |
| `/panel` | Panel del organizador: suscripción, tómbolas, cobros, cuenta |
| `/panel/t/:id` | Gestión de una tómbola |
| `/t/:slug` | Página pública de la tómbola |
| `/dueno` | Panel del dueño |

## Variables de entorno

| Variable | Descripción |
|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Proyecto Supabase |
| `DB_API_KEY` | Clave del servidor para las funciones `api_*` (su hash está en `app_secret`) |
| `TOKEN_SECRET` | Firma de sesiones |
| `ENC_KEY` | 32 bytes hex para cifrar los tokens de Mercado Pago de los organizadores |
| `MP_ACCESS_TOKEN` | Access Token de producción de la cuenta de Tutombola! (cobro de suscripciones) |
| `MP_CLIENT_ID`, `MP_CLIENT_SECRET` | Aplicación de Mercado Pago para "Conectar con Mercado Pago" (OAuth). Redirect URI: `<PUBLIC_URL>/api/mp/oauth/callback` |
| `PRECIO_SUSCRIPCION`, `DIAS_SUSCRIPCION` | Por defecto 12000 y 30 |

## Datos

Tablas: `organizadores`, `tombolas`, `casilleros` (100 por tómbola), `compras`, `comprobantes`, `pagos`, `pagos_suscripcion`. Todas con RLS sin políticas; el acceso es solo por funciones `api_*` que exigen `DB_API_KEY`. Las tablas `config` y `numeros` quedaron de la versión de una sola tómbola y no se usan.
