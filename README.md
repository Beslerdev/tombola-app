# Tómbola 00–99

App web (celular y PC) para vender los 100 números de una tómbola.

- **Participantes** (`/`): eligen uno o varios números libres, cargan nombre y celular, y tienen unos minutos de reserva (configurable, 8 por defecto) para transferir al alias y subir el comprobante. Con su celular consultan sus números en "Mis números".
- **Administrador** (`/admin`): verifica comprobantes (aprobar / rechazar), ve todas las compras y a quién pertenece cada número, edita nombre, premio, precio, alias y titular, y publica el número ganador de Lotería Nacional.
- Los números pagados se muestran tachados en la grilla. Al venderse los 100 aparece el aviso de **tómbola completa** para todos.

## Arquitectura

- `server.js`: Express. Sirve las páginas y una API que llama a funciones de Postgres en Supabase.
- Supabase (proyecto `tombola`): tablas `config`, `compras`, `numeros`, `comprobantes`. Las tablas tienen RLS sin políticas; el acceso es solo mediante funciones `api_*` que exigen la clave del servidor (`DB_API_KEY`). La reserva es atómica (bloqueo de filas), así dos personas no pueden quedarse con el mismo número.
- Los comprobantes se guardan en la base (privados) y solo los ve el administrador.

## Variables de entorno

| Variable | Descripción |
|---|---|
| `SUPABASE_URL` | URL del proyecto Supabase |
| `SUPABASE_ANON_KEY` | Clave anon/publishable del proyecto |
| `DB_API_KEY` | Clave del servidor (su hash está en `app_secret`) |
| `ADMIN_PASSWORD` | Contraseña del panel `/admin` |
| `TOKEN_SECRET` | Secreto para firmar la sesión del admin |
| `MP_ACCESS_TOKEN` | Access Token de producción de Mercado Pago. Si está, el pago es con Checkout Pro y se confirma solo; si no, se usa transferencia + comprobante |

## Pagos con Mercado Pago

1. Al reservar se crea una preferencia de Checkout Pro con `external_reference` = id de la compra y vencimiento igual al de la reserva (sin Rapipago/Pago Fácil, `binary_mode`).
2. Mercado Pago notifica a `/api/mp/webhook`; el servidor **consulta el pago a la API de MP** (no confía en el aviso) y si está aprobado confirma los números.
3. Al volver del checkout, la página consulta `/api/pago/estado` como respaldo del webhook.
4. Si el pago llega tarde y el número ya fue tomado, o el monto no coincide, la compra queda en estado `excepcion` para que el admin devuelva el dinero.

## Local

```
npm install
SUPABASE_URL=... SUPABASE_ANON_KEY=... DB_API_KEY=... ADMIN_PASSWORD=... TOKEN_SECRET=... npm start
```
