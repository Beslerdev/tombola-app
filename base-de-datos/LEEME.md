# Base de datos de Tutombola!

Copia de **referencia** de la estructura de la base (Supabase, proyecto `tombola`). Sirve para entender cómo está armada o para recrearla en un proyecto nuevo.

**No contiene datos ni claves.** Modificar estos archivos no cambia nada en la base real.

| Archivo | Contenido |
|---|---|
| `01-tablas.sql` | Tablas, columnas, restricciones e índices |
| `02-funciones.sql` | Lógica (reservas, pagos, prueba gratis, suscripción) y las funciones `api_*` que usa el servidor |

## Recrear la base en un proyecto nuevo
1. Ejecutar `01-tablas.sql` y luego `02-funciones.sql` en el editor SQL de Supabase.
2. Generar una clave nueva para el servidor y guardar su hash:
   ```sql
   insert into app_secret (hash) values (encode(sha256(convert_to('CLAVE_NUEVA', 'UTF8')), 'hex'));
   ```
   y cargar `CLAVE_NUEVA` en Render como `DB_API_KEY`.
3. Crear la cuenta del dueño registrándose en la web y luego marcarla:
   ```sql
   update organizadores set es_dueno = true where email = 'EMAIL_DEL_DUEÑO';
   ```

## Tablas
- **organizadores**: cuentas de los clientes (y del dueño), plan y forma de cobro.
- **pruebas_mp**: cuentas de Mercado Pago que ya usaron la prueba gratis.
- **tombolas**: cada tómbola con su link (`slug`), precio, estado y ganador.
- **casilleros**: los 100 números de cada tómbola y su estado.
- **compras**: reservas y compras de los participantes.
- **comprobantes**: archivos de transferencias (privados).
- **pagos**: pagos de Mercado Pago ya procesados.
- **pagos_suscripcion**: pagos de los organizadores a Tutombola!.
- **app_secret**: hash de la clave del servidor.
