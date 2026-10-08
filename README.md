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

## Local

```
npm install
SUPABASE_URL=... SUPABASE_ANON_KEY=... DB_API_KEY=... ADMIN_PASSWORD=... TOKEN_SECRET=... npm start
```
