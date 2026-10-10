-- =====================================================================
-- Tutombola! — Tablas (Supabase / PostgreSQL)
-- Copia de referencia de la estructura actual. NO contiene datos ni claves.
-- Todas las tablas tienen RLS activado y sin políticas: no se pueden leer
-- ni escribir directamente; el acceso es solo mediante las funciones api_*
-- (ver 02-funciones.sql), que exigen la clave del servidor.
-- =====================================================================

-- Clave del servidor (se guarda solo su hash SHA-256)
create table public.app_secret (
  id integer not null default 1 primary key check (id = 1),
  hash text not null
);

-- Organizadores (clientes de Tutombola!) y el dueño de la plataforma
create table public.organizadores (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  pass_hash text,                                   -- scrypt
  nombre text not null,
  celular text,
  es_dueno boolean not null default false,
  trial_hasta timestamptz,                          -- fin de la prueba gratis (se fija al conectar Mercado Pago)
  pagado_hasta timestamptz,                         -- fin de la suscripción paga
  acepta_transferencia boolean not null default true,
  alias text,
  titular text,
  mp_user_id text,                                  -- id de la cuenta de Mercado Pago conectada
  mp_tokens text,                                   -- credenciales de Mercado Pago CIFRADAS por el servidor
  mp_conectado_at timestamptz,
  bloqueado boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Cuentas de Mercado Pago que ya usaron la prueba gratis (una por cuenta)
create table public.pruebas_mp (
  mp_user_id text primary key,
  organizador_id uuid not null references public.organizadores(id),
  created_at timestamptz not null default now()
);

-- Tómbolas
create table public.tombolas (
  id uuid primary key default gen_random_uuid(),
  organizador_id uuid not null references public.organizadores(id),
  slug text not null unique,                        -- link público: /t/<slug>
  nombre text not null,
  premio text not null default '',
  precio integer not null check (precio > 0),
  minutos_reserva integer not null default 15,
  info_sorteo text not null default 'Se sortea por Lotería Nacional una vez completa la tómbola.',
  numero_ganador integer check (numero_ganador between 0 and 99),
  detalle_ganador text,
  estado text not null default 'activa' check (estado in ('activa','pausada','finalizada')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tombolas_org_idx on public.tombolas (organizador_id);

-- Compras / reservas
create table public.compras (
  id uuid primary key default gen_random_uuid(),
  tombola_id uuid not null references public.tombolas(id),
  codigo text not null unique default upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6)),
  nombre text not null,
  celular text not null,
  numeros integer[] not null,
  estado text not null default 'reservada'
    check (estado in ('reservada','pendiente','aprobada','rechazada','vencida','cancelada','excepcion','devuelta')),
  comprobante_path text,
  nota_admin text,
  reservado_hasta timestamptz,
  monto numeric(12,2),
  mp_payment_id text,
  metodo_pago text,
  pagado_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index compras_tombola_idx on public.compras (tombola_id);
create index compras_celular_idx on public.compras (celular);
create index compras_estado_idx on public.compras (estado);

-- Los 100 casilleros (00–99) de cada tómbola
create table public.casilleros (
  tombola_id uuid not null references public.tombolas(id),
  n integer not null check (n between 0 and 99),
  estado text not null default 'libre' check (estado in ('libre','reservado','pendiente','pagado')),
  compra_id uuid references public.compras(id),
  reservado_hasta timestamptz,
  primary key (tombola_id, n)
);
create index casilleros_compra_idx on public.casilleros (compra_id);

-- Comprobantes de transferencia (privados)
create table public.comprobantes (
  compra_id uuid primary key references public.compras(id),
  mime text not null,
  nombre_archivo text,
  data bytea not null,
  created_at timestamptz not null default now()
);

-- Pagos de Mercado Pago de las tómbolas (para no procesar dos veces el mismo pago)
create table public.pagos (
  payment_id text primary key,
  compra_id uuid references public.compras(id),
  monto numeric(12,2),
  estado_mp text,
  metodo text,
  resultado text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Pagos de suscripción a Tutombola!
create table public.pagos_suscripcion (
  payment_id text primary key,
  organizador_id uuid not null references public.organizadores(id),
  monto numeric(12,2),
  dias integer not null,
  origen text not null default 'mercadopago',   -- 'mercadopago' o 'manual'
  created_at timestamptz not null default now()
);

-- Seguridad: RLS activo sin políticas en todas las tablas
alter table public.app_secret enable row level security;
alter table public.organizadores enable row level security;
alter table public.pruebas_mp enable row level security;
alter table public.tombolas enable row level security;
alter table public.compras enable row level security;
alter table public.casilleros enable row level security;
alter table public.comprobantes enable row level security;
alter table public.pagos enable row level security;
alter table public.pagos_suscripcion enable row level security;

-- Nota: en la base existen además las tablas "config" y "numeros", de la
-- primera versión (una sola tómbola). Ya no se usan.
