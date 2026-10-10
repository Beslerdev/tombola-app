# Tutombola! — Resumen del proyecto

*Actualizado: 10/10/2026*

Plataforma web para que cualquier organizador cree y venda **tómbolas de números del 00 al 99** online. Los compradores eligen sus números desde el celular o la PC, pagan con Mercado Pago o por transferencia, y los números vendidos quedan tachados en la grilla. El organizador paga una **suscripción mensual** por usar la plataforma.

---

## 1. Cómo evolucionó

| Etapa | Qué se hizo |
|---|---|
| **1. Tómbola única** | Grilla 00–99, reserva con tiempo límite, pago por transferencia y comprobante, panel de administración con contraseña, aviso de tómbola completa y carga del ganador (Lotería Nacional). |
| **2. Pago automático** | Integración con **Mercado Pago Checkout Pro**: el comprador paga en la pantalla oficial de Mercado Pago y el número se confirma solo. |
| **3. Correcciones** | Ventanas de confirmación propias (el navegador de WhatsApp/Instagram bloqueaba las nativas); liberación automática del número si el comprador vuelve de Mercado Pago sin pagar. |
| **4. Plataforma Tutombola!** | Varios organizadores, cada uno con su cuenta, sus tómbolas y su forma de cobro. Suscripción mensual, prueba gratis y panel del dueño. |
| **5. Prueba gratis antiabuso** | 7 días que empiezan al conectar Mercado Pago, **una sola vez por cuenta de Mercado Pago**. |
| **6. Ganador** | El cartel del ganador muestra el nombre de quien compró el número. |

---

## 2. Links

| Qué | Dirección |
|---|---|
| Página de la plataforma | https://tombola-app.onrender.com |
| Registro de organizadores | https://tombola-app.onrender.com/registro |
| Ingreso | https://tombola-app.onrender.com/ingresar |
| Panel del organizador | https://tombola-app.onrender.com/panel |
| Panel del dueño (solo Dario) | https://tombola-app.onrender.com/dueno |
| Términos y condiciones | https://tombola-app.onrender.com/terminos |
| Tómbola de ejemplo | https://tombola-app.onrender.com/t/iphone-18 |
| Tómbola de prueba de pago ($10) | https://tombola-app.onrender.com/t/prueba-de-pago |

**Cuenta del dueño:** el email de Dario (sin vencimiento). La contraseña quedó escrita en el chat: conviene cambiarla desde *Mi panel → Mi cuenta*.

---

## 3. Cómo funciona

### Para el comprador
1. Recibe el link de la tómbola (por WhatsApp, Instagram, etc.).
2. Toca uno o varios números libres y toca **Reservar**.
3. Ingresa nombre y celular. Los números quedan **reservados** (15 minutos por defecto) con cuenta regresiva.
4. Paga:
   - **Con Mercado Pago** (dinero en cuenta, débito o crédito): se confirma solo y ve **"¡Pago exitoso!"**.
   - **Por transferencia** al alias del organizador: sube el comprobante y queda **"En verificación"** hasta que el organizador lo aprueba.
5. En **Mis números** consulta sus números y su estado con su celular.
6. Si cancela en Mercado Pago y vuelve, el número se libera al instante. Si cierra la pestaña sin volver, se libera al vencer la reserva.

**Colores de la grilla:** blanco = libre · rojo = su elección · amarillo rayado = reservado · gris rayado = en verificación · azul oscuro tachado = vendido · dorado = ganador.

### Para el organizador (cliente de Tutombola!)
1. Se registra con email y contraseña y acepta los términos.
2. En **Cobros** elige cómo cobrar:
   - **Conectar con Mercado Pago**: entra con *su* cuenta y autoriza. La plata va **directo a su cuenta**.
   - **Transferencia a su alias**: carga alias y titular y aprueba los comprobantes a mano.
3. Crea sus tómbolas (nombre, premio, precio, minutos de reserva). Cada una tiene **link propio** y botón para compartir por WhatsApp.
4. Desde **Gestionar** ve compras, comprobantes, a quién pertenece cada número, pausa o finaliza la venta y publica el número ganador.
5. En su panel ve el **contador de días** de su plan y el botón **Renovar**.

### Para el dueño (Dario)
- Ve todos los organizadores: en prueba, al día, vencidos o sin activar.
- Ve los pagos de suscripción recibidos y lo cobrado en los últimos 30 días.
- Puede **sumar días** (pagos por fuera de Mercado Pago o cortesías), **generar una contraseña nueva** a un organizador, y **bloquear o desbloquear** cuentas.
- Su propia tómbola es una más dentro de la plataforma.

---

## 4. Modelo de negocio

| Concepto | Definición |
|---|---|
| Suscripción | **$12.000 por mes** (30 días), pagada con Mercado Pago a la cuenta de Dario |
| Prueba gratis | **7 días**, empiezan al **conectar Mercado Pago** |
| Límite de prueba | **Una prueba por cuenta de Mercado Pago**, aunque se registren varios emails |
| Sin Mercado Pago | Quien cobra solo por transferencia no tiene prueba: se suscribe directamente |
| Si no renueva | Las tómbolas se **suspenden**: no aceptan compras nuevas, los números vendidos se respetan, y al renovar se reactivan |
| Dinero de las tómbolas | Va **directo** al organizador. Tutombola! no recibe ni administra esos fondos |

---

## 5. Pagos y verificación

| Medio | ¿Automático? | Cómo se confirma |
|---|---|---|
| **Mercado Pago (Checkout Pro)** | **Sí** | Mercado Pago avisa a la app; la app **consulta el pago a Mercado Pago** (no confía en el navegador) y confirma los números. |
| **Transferencia + comprobante** | **No** | El organizador revisa su cuenta y toca **Aprobar** o **Rechazar**. Un comprobante falso nunca confirma un número por sí solo, pero lo deja bloqueado hasta que se rechace. |

**Casos especiales (Mercado Pago):** si alguien paga después de que venció su reserva y el número ya lo tomó otro, o paga un monto menor, la compra queda en **Atención → "Devolver dinero"** para que el organizador devuelva el pago y lo marque como devuelto.

**Verificación automática de transferencias:** no está disponible. Mercado Pago no ofrece una forma documentada de consultar transferencias entrantes a un alias. Quedó pendiente una **prueba** (transferir $10 al alias y ver si aparece en la API) para evaluarlo. **Recomendación:** que los organizadores cobren solo con Mercado Pago para que todo sea automático.

---

## 6. Configuración de Mercado Pago (hecha una sola vez por el dueño)

- Aplicación **Tombola-App** en Mercado Pago Developers (Checkout Pro, API de Preferences), N.º de aplicación / Client ID **8377767481802723**.
- Credenciales de producción activadas (industria: Servicio de informática; sitio: tombola-app.onrender.com).
- URL de redireccionamiento OAuth: `https://tombola-app.onrender.com/api/mp/oauth/callback`
- Permisos: read, write, offline access. PKCE: No.
- El Access Token, el Client ID y el Client Secret están cargados en Render.
- La cuenta de Mercado Pago de Dario está conectada como organizador.

> Los clientes **no** repiten nada de esto: solo tocan "Conectar con Mercado Pago" y autorizan.

---

## 7. Infraestructura

| Pieza | Detalle |
|---|---|
| Código | GitHub: **Beslerdev/tombola-app** (público, sin claves en el código) |
| Servidor | **Render**, servicio `tombola-app` (plan gratuito, región Oregon). Se despliega solo con cada cambio en GitHub. |
| Base de datos | **Supabase**, proyecto `tombola` (región São Paulo) |
| Tecnología | Node.js + Express; páginas HTML/CSS/JS sin frameworks |

### Variables de entorno en Render
| Variable | Para qué |
|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Conexión a la base |
| `DB_API_KEY` | Clave del servidor para acceder a la base |
| `TOKEN_SECRET` | Firma de las sesiones |
| `ENC_KEY` | Cifrado de las credenciales de Mercado Pago de cada organizador |
| `MP_ACCESS_TOKEN` | Cobro de suscripciones en la cuenta de Dario |
| `MP_CLIENT_ID`, `MP_CLIENT_SECRET` | Botón "Conectar con Mercado Pago" |
| `PRECIO_SUSCRIPCION`, `DIAS_SUSCRIPCION` | 12000 y 30 |
| `ADMIN_PASSWORD` | De la primera versión; ya no se usa |

### Seguridad
- Las tablas no son accesibles directamente: todo pasa por funciones de la base que exigen la clave del servidor.
- La reserva de números es atómica: dos personas no pueden quedarse con el mismo número.
- Contraseñas guardadas con hash (scrypt). Credenciales de Mercado Pago de cada organizador **cifradas**.
- Comprobantes privados: solo los ve el organizador de esa tómbola.
- Límite de intentos en ingreso y registro.

### Páginas
| Ruta | Archivo |
|---|---|
| `/` | `public/inicio.html` |
| `/ingresar`, `/registro` | `public/cuenta.html` |
| `/panel` | `public/panel.html` |
| `/panel/t/:id` | `public/gestion.html` |
| `/t/:slug` | `public/tombola.html` |
| `/dueno` | `public/dueno.html` |
| `/terminos` | `public/terminos.html` |

### Tablas principales
`organizadores`, `tombolas`, `casilleros` (100 por tómbola), `compras`, `comprobantes`, `pagos`, `pagos_suscripcion`, `pruebas_mp`. Las tablas `config` y `numeros` son de la primera versión y ya no se usan.

---

## 8. Pendientes y recomendaciones

**Antes de vender**
- [ ] **Prueba de pago real**: comprar un número de $10 en `/t/prueba-de-pago` **con otra cuenta de Mercado Pago o con una tarjeta sin iniciar sesión** (Mercado Pago no permite pagarse a uno mismo).
- [ ] **Prueba de cliente nuevo**: que alguien de confianza se registre, conecte *su* Mercado Pago y cree una tómbola.
- [ ] **Dominio propio** (por ejemplo `tutombola.com.ar`).
- [ ] **Plan pago de Render**: en el gratuito, la primera visita tras un rato sin uso tarda ~50 segundos.
- [ ] **Revisión legal** de los términos (están como borrador) y consultar con Mercado Pago si permite esta actividad. Las rifas suelen requerir autorización provincial y los procesadores restringen los juegos de azar.
- [ ] **Recuperar contraseña por email** (hoy el dueño genera una nueva desde su panel).
- [ ] Cambiar la contraseña del dueño, que quedó escrita en el chat.
- [ ] Limpiar datos de prueba: organizador "Org Prueba", tómbolas `prueba-claude` y `prueba-de-pago`, compras de prueba.

**A evaluar**
- [ ] Prueba de transferencia al alias para ver si se puede verificar automáticamente.
- [ ] Mostrar el ganador como "Nombre + inicial del apellido" en lugar del nombre completo.

---

## 9. App para celular (analizado, no implementado)

1. **App instalable desde el navegador (PWA)** — *recomendado primero*: ícono propio, pantalla completa, posibles notificaciones. Poco trabajo, sin tiendas ni costos, y se actualiza sola.
2. **Google Play**: se "envuelve" la PWA (PWABuilder/Bubblewrap). Requiere cuenta de desarrollador (pago único, ~US$25), dominio propio, ficha con capturas y política de privacidad, período de prueba cerrado con testers, y la revisión de Google.
   - ⚠️ **Riesgo principal**: las políticas de Google Play sobre **sorteos y juegos de azar con dinero real**. Verificar la política vigente antes de invertir.
3. **App Store (iPhone)**: ~US$99/año, más estricta. No recomendada por ahora.
4. Los **compradores** siguen usando el link: no van a instalar una app para comprar un número.
