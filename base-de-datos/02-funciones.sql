-- =====================================================================
-- Tutombola! — Funciones de la base (Supabase / PostgreSQL)
-- Copia de referencia de las funciones en uso. NO contiene datos ni claves.
--
-- * Funciones internas (sin prefijo api_): contienen la lógica.
-- * Funciones api_*: las únicas que puede llamar el servidor. Todas empiezan
--   verificando la clave del servidor con _chk(p_key).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Seguridad
-- ---------------------------------------------------------------------
create or replace function public._chk(p_key text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_key is null or encode(sha256(convert_to(p_key, 'UTF8')), 'hex') <> (select hash from app_secret where id = 1) then
    raise exception 'NO_AUTORIZADO';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Lógica de organizadores y suscripción
-- ---------------------------------------------------------------------
-- ¿Puede vender? (dueño, o prueba / suscripción vigente, y no bloqueado)
create or replace function public.org_activa(p_org uuid) returns boolean
language sql stable set search_path = public as $$
  select coalesce((select not bloqueado and (es_dueno or now() < coalesce(greatest(trial_hasta, pagado_hasta), '-infinity'::timestamptz))
                   from organizadores where id = p_org), false)
$$;

-- Datos del organizador que ve el panel (sin contraseña ni credenciales)
create or replace function public.org_json(o organizadores) returns json
language sql stable set search_path = public as $$
  select json_build_object('id', o.id, 'email', o.email, 'nombre', o.nombre, 'celular', o.celular, 'es_dueno', o.es_dueno,
    'trial_hasta', o.trial_hasta, 'pagado_hasta', o.pagado_hasta,
    'vence', case when o.es_dueno then null else greatest(o.trial_hasta, o.pagado_hasta) end,
    'prueba_disponible', not o.es_dueno and o.trial_hasta is null,
    'en_prueba', o.trial_hasta is not null and now() < o.trial_hasta and (o.pagado_hasta is null or o.pagado_hasta <= o.trial_hasta),
    'activa', org_activa(o.id), 'bloqueado', o.bloqueado,
    'acepta_transferencia', o.acepta_transferencia, 'alias', o.alias, 'titular', o.titular,
    'mp_conectado', o.mp_tokens is not null, 'mp_user_id', o.mp_user_id, 'mp_conectado_at', o.mp_conectado_at, 'created_at', o.created_at)
$$;

-- ---------------------------------------------------------------------
-- Lógica de reservas y pagos
-- ---------------------------------------------------------------------
-- Libera reservas vencidas
create or replace function public.liberar_vencidas() returns void
language plpgsql set search_path = public as $$
begin
  update compras set estado = 'vencida', updated_at = now() where estado = 'reservada' and reservado_hasta < now();
  update casilleros set estado = 'libre', compra_id = null, reservado_hasta = null where estado = 'reservado' and reservado_hasta < now();
end $$;

-- Reserva números (atómica: bloquea las filas para que dos personas no tomen el mismo número)
create or replace function public.reservar_t(p_tombola uuid, p_numeros integer[], p_nombre text, p_celular text) returns json
language plpgsql set search_path = public as $$
declare v_t tombolas; v_ocupados int[]; v_compra compras;
begin
  if p_numeros is null or array_length(p_numeros, 1) is null then raise exception 'SIN_NUMEROS'; end if;
  select * into v_t from tombolas where id = p_tombola;
  if not found then raise exception 'NO_EXISTE'; end if;
  if v_t.estado <> 'activa' or v_t.numero_ganador is not null then raise exception 'TOMBOLA_CERRADA'; end if;
  if not org_activa(v_t.organizador_id) then raise exception 'SUSPENDIDA'; end if;
  perform liberar_vencidas();
  perform 1 from casilleros where tombola_id = p_tombola and n = any(p_numeros) order by n for update;
  select array_agg(n order by n) into v_ocupados from casilleros where tombola_id = p_tombola and n = any(p_numeros) and estado <> 'libre';
  if v_ocupados is not null then raise exception 'NO_DISPONIBLE:%', array_to_string(v_ocupados, ','); end if;
  insert into compras (tombola_id, nombre, celular, numeros, reservado_hasta, monto)
  values (p_tombola, p_nombre, p_celular, (select array_agg(distinct x order by x) from unnest(p_numeros) x),
          now() + make_interval(mins => v_t.minutos_reserva),
          (select count(distinct x) from unnest(p_numeros) x) * v_t.precio)
  returning * into v_compra;
  update casilleros set estado = 'reservado', compra_id = v_compra.id, reservado_hasta = v_compra.reservado_hasta
   where tombola_id = p_tombola and n = any(p_numeros);
  return json_build_object('id', v_compra.id, 'codigo', v_compra.codigo, 'numeros', v_compra.numeros,
                           'reservado_hasta', v_compra.reservado_hasta, 'monto', v_compra.monto);
end $$;

-- El comprador subió un comprobante: pasa a "en verificación"
create or replace function public.confirmar_comprobante(p_compra uuid, p_path text) returns void
language plpgsql set search_path = public as $$
declare v compras;
begin
  select * into v from compras where id = p_compra for update;
  if not found then raise exception 'NO_EXISTE'; end if;
  if v.estado <> 'reservada' then raise exception 'ESTADO_INVALIDO:%', v.estado; end if;
  if v.reservado_hasta + interval '1 minute' < now() then raise exception 'VENCIDA'; end if;
  update compras set estado = 'pendiente', comprobante_path = p_path, reservado_hasta = null, updated_at = now() where id = p_compra;
  update casilleros set estado = 'pendiente', reservado_hasta = null where compra_id = p_compra;
end $$;

-- El comprador cancela su reserva
create or replace function public.cancelar_reserva(p_compra uuid) returns void
language plpgsql set search_path = public as $$
begin
  update compras set estado = 'cancelada', updated_at = now() where id = p_compra and estado = 'reservada';
  if not found then raise exception 'ESTADO_INVALIDO'; end if;
  update casilleros set estado = 'libre', compra_id = null, reservado_hasta = null where compra_id = p_compra;
end $$;

-- El organizador aprueba un pago (transferencia)
create or replace function public.aprobar_compra(p_compra uuid) returns void
language plpgsql set search_path = public as $$
declare v compras; v_ocup text;
begin
  select * into v from compras where id = p_compra for update;
  if not found or v.estado not in ('pendiente','reservada','vencida','excepcion') then raise exception 'ESTADO_INVALIDO'; end if;
  perform 1 from casilleros where tombola_id = v.tombola_id and n = any(v.numeros) for update;
  select string_agg(n::text, ',') into v_ocup from casilleros
   where tombola_id = v.tombola_id and n = any(v.numeros) and not (estado = 'libre' or compra_id = v.id);
  if v_ocup is not null then raise exception 'NO_DISPONIBLE:%', v_ocup; end if;
  update casilleros set estado = 'pagado', compra_id = v.id, reservado_hasta = null where tombola_id = v.tombola_id and n = any(v.numeros);
  update compras set estado = 'aprobada', reservado_hasta = null, nota_admin = null, updated_at = now() where id = v.id;
end $$;

-- El organizador rechaza o anula una compra (libera los números)
create or replace function public.rechazar_compra(p_compra uuid, p_nota text) returns void
language plpgsql set search_path = public as $$
begin
  update compras set estado = 'rechazada', nota_admin = p_nota, updated_at = now()
   where id = p_compra and estado in ('pendiente','aprobada','reservada');
  if not found then raise exception 'ESTADO_INVALIDO'; end if;
  update casilleros set estado = 'libre', compra_id = null, reservado_hasta = null where compra_id = p_compra;
end $$;

-- Registra un pago aprobado de Mercado Pago (idempotente).
-- Resultado: 'aprobada' | 'excepcion' (pagó tarde o de menos: devolver) | 'duplicado' | 'sin_compra'
create or replace function public.registrar_pago(p_compra uuid, p_payment_id text, p_monto numeric, p_metodo text) returns text
language plpgsql set search_path = public as $$
declare v compras; v_prev pagos; v_ocupados int; v_res text;
begin
  select * into v_prev from pagos where payment_id = p_payment_id;
  if found and v_prev.resultado is not null then return v_prev.resultado; end if;
  select * into v from compras where id = p_compra for update;
  if not found then
    v_res := 'sin_compra';
  elsif v.estado = 'aprobada' and v.mp_payment_id = p_payment_id then
    v_res := 'aprobada';
  elsif v.estado in ('aprobada','excepcion','devuelta') then
    v_res := 'duplicado';
  elsif p_monto + 0.01 < v.monto then
    update compras set estado = 'excepcion', nota_admin = 'Pagó un monto menor al total. Devolver el dinero.',
      mp_payment_id = p_payment_id, metodo_pago = p_metodo, pagado_at = now(), updated_at = now() where id = v.id;
    update casilleros set estado = 'libre', compra_id = null, reservado_hasta = null where compra_id = v.id and estado <> 'pagado';
    v_res := 'excepcion';
  else
    perform 1 from casilleros where tombola_id = v.tombola_id and n = any(v.numeros) order by n for update;
    select count(*) into v_ocupados from casilleros
      where tombola_id = v.tombola_id and n = any(v.numeros) and not (estado = 'libre' or compra_id = v.id);
    if v_ocupados = 0 then
      update casilleros set estado = 'pagado', compra_id = v.id, reservado_hasta = null where tombola_id = v.tombola_id and n = any(v.numeros);
      update compras set estado = 'aprobada', mp_payment_id = p_payment_id, metodo_pago = p_metodo,
        pagado_at = now(), reservado_hasta = null, nota_admin = null, updated_at = now() where id = v.id;
      v_res := 'aprobada';
    else
      update casilleros set estado = 'libre', compra_id = null, reservado_hasta = null where compra_id = v.id and estado <> 'pagado';
      update compras set estado = 'excepcion', nota_admin = 'Pagó cuando la reserva ya había vencido y algún número fue tomado por otra persona. Devolver el dinero.',
        mp_payment_id = p_payment_id, metodo_pago = p_metodo, pagado_at = now(), updated_at = now() where id = v.id;
      v_res := 'excepcion';
    end if;
  end if;
  insert into pagos (payment_id, compra_id, monto, estado_mp, metodo, resultado)
  values (p_payment_id, v.id, p_monto, 'approved', p_metodo, v_res)
  on conflict (payment_id) do update set resultado = excluded.resultado, estado_mp = 'approved', updated_at = now();
  return v_res;
end $$;

-- =====================================================================
-- API: cuentas de organizadores
-- =====================================================================
create or replace function public.api_org_crear(p_key text, p_email text, p_hash text, p_nombre text, p_celular text) returns json
language plpgsql security definer set search_path = public as $$
declare o organizadores;
begin
  perform _chk(p_key);
  if exists (select 1 from organizadores where email = lower(p_email)) then raise exception 'EMAIL_EXISTE'; end if;
  insert into organizadores (email, pass_hash, nombre, celular) values (lower(p_email), p_hash, p_nombre, p_celular) returning * into o;
  return org_json(o);
end $$;

create or replace function public.api_org_login(p_key text, p_email text) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform _chk(p_key);
  return (select json_build_object('id', id, 'pass_hash', pass_hash, 'bloqueado', bloqueado) from organizadores where email = lower(p_email));
end $$;

create or replace function public.api_org_get(p_key text, p_org uuid) returns json
language plpgsql security definer set search_path = public as $$
begin perform _chk(p_key); return (select org_json(o) from organizadores o where id = p_org); end $$;

create or replace function public.api_org_tokens(p_key text, p_org uuid) returns text
language plpgsql security definer set search_path = public as $$
begin perform _chk(p_key); return (select mp_tokens from organizadores where id = p_org); end $$;

create or replace function public.api_org_update(p_key text, p_org uuid, p json) returns json
language plpgsql security definer set search_path = public as $$
declare j jsonb := p::jsonb; o organizadores;
begin
  perform _chk(p_key);
  update organizadores set
    nombre = coalesce(j->>'nombre', nombre),
    celular = case when j ? 'celular' then j->>'celular' else celular end,
    acepta_transferencia = coalesce((j->>'acepta_transferencia')::boolean, acepta_transferencia),
    alias = case when j ? 'alias' then nullif(j->>'alias', '') else alias end,
    titular = case when j ? 'titular' then nullif(j->>'titular', '') else titular end,
    pass_hash = coalesce(j->>'pass_hash', pass_hash),
    mp_tokens = case when j ? 'mp_tokens' then j->>'mp_tokens' else mp_tokens end,
    mp_user_id = case when j ? 'mp_user_id' then j->>'mp_user_id' else mp_user_id end,
    mp_conectado_at = case when j ? 'mp_tokens' then (case when j->>'mp_tokens' is null then null else now() end) else mp_conectado_at end,
    updated_at = now()
  where id = p_org returning * into o;
  return org_json(o);
end $$;

create or replace function public.api_org_por_mp_user(p_key text, p_mp_user text) returns uuid
language plpgsql security definer set search_path = public as $$
begin perform _chk(p_key); return (select id from organizadores where mp_user_id = p_mp_user limit 1); end $$;

-- Conectar Mercado Pago e iniciar la prueba gratis (una sola vez por cuenta de Mercado Pago)
-- Resultado 'prueba': 'otorgada' | 'usada' | 'ya_tenia' | 'no_aplica'
create or replace function public.api_org_conectar_mp(p_key text, p_org uuid, p_tokens text, p_mp_user text) returns json
language plpgsql security definer set search_path = public as $$
declare o organizadores; v_prueba text;
begin
  perform _chk(p_key);
  select * into o from organizadores where id = p_org for update;
  if not found then raise exception 'NO_EXISTE'; end if;
  update organizadores set mp_tokens = p_tokens, mp_user_id = p_mp_user, mp_conectado_at = now(), updated_at = now() where id = p_org;
  if o.es_dueno then
    v_prueba := 'no_aplica';
  elsif o.trial_hasta is not null then
    v_prueba := 'ya_tenia';
  else
    insert into pruebas_mp (mp_user_id, organizador_id) values (p_mp_user, p_org) on conflict (mp_user_id) do nothing;
    if found then
      update organizadores set trial_hasta = now() + interval '7 days' where id = p_org;
      v_prueba := 'otorgada';
    else
      v_prueba := 'usada';
    end if;
  end if;
  select * into o from organizadores where id = p_org;
  return json_build_object('prueba', v_prueba, 'org', org_json(o));
end $$;

-- Pago de suscripción (idempotente): suma días desde el vencimiento vigente
create or replace function public.api_suscripcion_pago(p_key text, p_payment_id text, p_org uuid, p_monto numeric, p_dias integer, p_origen text) returns json
language plpgsql security definer set search_path = public as $$
declare o organizadores; v_nuevo boolean := false;
begin
  perform _chk(p_key);
  insert into pagos_suscripcion (payment_id, organizador_id, monto, dias, origen)
  values (p_payment_id, p_org, p_monto, p_dias, coalesce(p_origen, 'mercadopago'))
  on conflict (payment_id) do nothing;
  if found then
    v_nuevo := true;
    update organizadores set pagado_hasta = greatest(now(), pagado_hasta, trial_hasta) + make_interval(days => p_dias),
      updated_at = now() where id = p_org;
  end if;
  select * into o from organizadores where id = p_org;
  return json_build_object('nuevo', v_nuevo, 'org', org_json(o));
end $$;

-- =====================================================================
-- API: tómbolas
-- =====================================================================
create or replace function public.api_tombola_crear(p_key text, p_org uuid, p_slug text, p json) returns json
language plpgsql security definer set search_path = public as $$
declare j jsonb := p::jsonb; t tombolas; s text := p_slug;
begin
  perform _chk(p_key);
  while exists (select 1 from tombolas where slug = s) loop
    s := p_slug || '-' || substr(md5(random()::text), 1, 4);
  end loop;
  insert into tombolas (organizador_id, slug, nombre, premio, precio, minutos_reserva, info_sorteo)
  values (p_org, s, j->>'nombre', coalesce(j->>'premio', ''), (j->>'precio')::int,
          coalesce((j->>'minutos_reserva')::int, 15),
          coalesce(nullif(j->>'info_sorteo', ''), 'Se sortea por Lotería Nacional una vez completa la tómbola.'))
  returning * into t;
  insert into casilleros (tombola_id, n) select t.id, generate_series(0, 99);
  return row_to_json(t);
end $$;

create or replace function public.api_tombola_update(p_key text, p_org uuid, p_tombola uuid, p json) returns json
language plpgsql security definer set search_path = public as $$
declare j jsonb := p::jsonb; t tombolas;
begin
  perform _chk(p_key);
  update tombolas set
    nombre = coalesce(j->>'nombre', nombre),
    premio = coalesce(j->>'premio', premio),
    precio = coalesce((j->>'precio')::int, precio),
    minutos_reserva = coalesce((j->>'minutos_reserva')::int, minutos_reserva),
    info_sorteo = coalesce(j->>'info_sorteo', info_sorteo),
    estado = coalesce(j->>'estado', estado),
    numero_ganador = case when j ? 'numero_ganador' then (j->>'numero_ganador')::int else numero_ganador end,
    detalle_ganador = case when j ? 'detalle_ganador' then j->>'detalle_ganador' else detalle_ganador end,
    updated_at = now()
  where id = p_tombola and organizador_id = p_org returning * into t;
  if not found then raise exception 'NO_EXISTE'; end if;
  return row_to_json(t);
end $$;

create or replace function public.api_tombolas_de_org(p_key text, p_org uuid) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform _chk(p_key);
  perform liberar_vencidas();
  return coalesce((select json_agg(x order by x.created_at desc) from (
    select t.*, (select count(*) from casilleros n where n.tombola_id = t.id and n.estado = 'pagado') as vendidos,
           (select count(*) from compras c where c.tombola_id = t.id and c.estado in ('pendiente','excepcion')) as atencion
      from tombolas t where t.organizador_id = p_org) x), '[]'::json);
end $$;

create or replace function public.api_tombola_get(p_key text, p_tombola uuid) returns json
language plpgsql security definer set search_path = public as $$
begin perform _chk(p_key); return (select row_to_json(t) from tombolas t where id = p_tombola); end $$;

-- Datos públicos de una tómbola (sin celulares ni datos privados de compradores)
create or replace function public.api_tombola_publica(p_key text, p_slug text) returns json
language plpgsql security definer set search_path = public as $$
declare t tombolas; o organizadores; v_ganador text;
begin
  perform _chk(p_key);
  select * into t from tombolas where slug = p_slug;
  if not found then return null; end if;
  select * into o from organizadores where id = t.organizador_id;
  perform liberar_vencidas();
  if t.numero_ganador is not null then
    select c.nombre into v_ganador from casilleros n join compras c on c.id = n.compra_id
     where n.tombola_id = t.id and n.n = t.numero_ganador and n.estado = 'pagado';
  end if;
  return json_build_object(
    'tombola', json_build_object('id', t.id, 'slug', t.slug, 'nombre', t.nombre, 'premio', t.premio, 'precio', t.precio,
       'minutos_reserva', t.minutos_reserva, 'info_sorteo', t.info_sorteo, 'numero_ganador', t.numero_ganador,
       'detalle_ganador', t.detalle_ganador, 'ganador_nombre', v_ganador, 'estado', t.estado),
    'organizador', json_build_object('id', o.id, 'nombre', o.nombre,
       'alias', case when o.acepta_transferencia then o.alias end,
       'titular', case when o.acepta_transferencia then o.titular end),
    'medios', json_build_object('mp', o.mp_tokens is not null, 'transferencia', o.acepta_transferencia and o.alias is not null),
    'activa', org_activa(o.id) and t.estado = 'activa',
    'suspendida', not org_activa(o.id),
    'numeros', (select json_agg(json_build_object('n', n, 'e', estado, 'h', reservado_hasta) order by n) from casilleros where tombola_id = t.id),
    'ahora', now());
end $$;

-- =====================================================================
-- API: compras (comprador)
-- =====================================================================
create or replace function public.api_reservar(p_key text, p_tombola uuid, p_numeros integer[], p_nombre text, p_celular text) returns json
language plpgsql security definer set search_path = public as $$
begin perform _chk(p_key); return reservar_t(p_tombola, p_numeros, p_nombre, p_celular); end $$;

create or replace function public.api_mis_compras(p_key text, p_tombola uuid, p_celular text) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform _chk(p_key);
  perform liberar_vencidas();
  return coalesce((select json_agg(row_to_json(x) order by x.created_at desc) from (
    select id, codigo, nombre, numeros, estado, nota_admin, reservado_hasta, monto, created_at
      from compras where tombola_id = p_tombola and celular = p_celular and estado <> 'cancelada') x), '[]'::json);
end $$;

create or replace function public.api_compra(p_key text, p_compra uuid) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform _chk(p_key);
  perform liberar_vencidas();
  return (select json_build_object('id', c.id, 'codigo', c.codigo, 'nombre', c.nombre, 'celular', c.celular, 'numeros', c.numeros,
      'estado', c.estado, 'monto', c.monto, 'reservado_hasta', c.reservado_hasta, 'nota_admin', c.nota_admin,
      'tombola_id', c.tombola_id, 'organizador_id', t.organizador_id, 'slug', t.slug, 'tombola_nombre', t.nombre, 'premio', t.premio)
    from compras c join tombolas t on t.id = c.tombola_id where c.id = p_compra);
end $$;

create or replace function public.api_comprobante(p_key text, p_compra uuid, p_celular text, p_mime text, p_nombre text, p_data_b64 text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _chk(p_key);
  if not exists (select 1 from compras where id = p_compra and celular = p_celular) then raise exception 'NO_EXISTE'; end if;
  perform confirmar_comprobante(p_compra, 'db');
  insert into comprobantes (compra_id, mime, nombre_archivo, data) values (p_compra, p_mime, p_nombre, decode(p_data_b64, 'base64'))
  on conflict (compra_id) do update set mime = excluded.mime, nombre_archivo = excluded.nombre_archivo, data = excluded.data, created_at = now();
end $$;

create or replace function public.api_cancelar(p_key text, p_compra uuid, p_celular text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _chk(p_key);
  if not exists (select 1 from compras where id = p_compra and celular = p_celular) then raise exception 'NO_EXISTE'; end if;
  perform cancelar_reserva(p_compra);
end $$;

create or replace function public.api_registrar_pago(p_key text, p_compra uuid, p_payment_id text, p_monto numeric, p_metodo text) returns text
language plpgsql security definer set search_path = public as $$
begin perform _chk(p_key); return registrar_pago(p_compra, p_payment_id, p_monto, p_metodo); end $$;

create or replace function public.api_registrar_evento_pago(p_key text, p_payment_id text, p_compra uuid, p_monto numeric, p_estado text, p_metodo text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _chk(p_key);
  insert into pagos (payment_id, compra_id, monto, estado_mp, metodo)
  values (p_payment_id, (select id from compras where id = p_compra), p_monto, p_estado, p_metodo)
  on conflict (payment_id) do update set estado_mp = excluded.estado_mp, updated_at = now()
  where pagos.resultado is null;
end $$;

-- =====================================================================
-- API: gestión de una tómbola (organizador)
-- =====================================================================
create or replace function public.api_admin_compras(p_key text, p_tombola uuid) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform _chk(p_key);
  perform liberar_vencidas();
  return coalesce((select json_agg(row_to_json(x) order by x.created_at desc) from (
    select c.id, c.codigo, c.nombre, c.celular, c.numeros, c.estado, c.nota_admin, c.reservado_hasta, c.created_at, c.updated_at,
           c.monto, c.mp_payment_id, c.metodo_pago, c.pagado_at,
           (cb.compra_id is not null) as tiene_comprobante, cb.mime
      from compras c left join comprobantes cb on cb.compra_id = c.id
     where c.tombola_id = p_tombola and c.estado <> 'cancelada') x), '[]'::json);
end $$;

create or replace function public.api_admin_numeros(p_key text, p_tombola uuid) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform _chk(p_key);
  perform liberar_vencidas();
  return (select json_agg(json_build_object('n', n.n, 'e', n.estado, 'nombre', c.nombre, 'celular', c.celular, 'codigo', c.codigo) order by n.n)
    from casilleros n left join compras c on c.id = n.compra_id where n.tombola_id = p_tombola);
end $$;

create or replace function public.api_admin_ver_comprobante(p_key text, p_compra uuid) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform _chk(p_key);
  return (select json_build_object('mime', mime, 'nombre', nombre_archivo, 'b64', encode(data, 'base64')) from comprobantes where compra_id = p_compra);
end $$;

create or replace function public.api_admin_aprobar(p_key text, p_compra uuid) returns void
language plpgsql security definer set search_path = public as $$
begin perform _chk(p_key); perform aprobar_compra(p_compra); end $$;

create or replace function public.api_admin_rechazar(p_key text, p_compra uuid, p_nota text) returns void
language plpgsql security definer set search_path = public as $$
begin perform _chk(p_key); perform rechazar_compra(p_compra, p_nota); end $$;

create or replace function public.api_admin_marcar_devuelta(p_key text, p_compra uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _chk(p_key);
  update compras set estado = 'devuelta', updated_at = now() where id = p_compra and estado = 'excepcion';
  if not found then raise exception 'ESTADO_INVALIDO'; end if;
end $$;

-- =====================================================================
-- API: dueño de la plataforma
-- =====================================================================
create or replace function public.api_dueno_resumen(p_key text) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform _chk(p_key);
  return json_build_object(
    'organizadores', coalesce((select json_agg(x order by x->>'created_at' desc) from (
       select (org_json(o)::jsonb || jsonb_build_object(
         'tombolas', (select count(*) from tombolas t where t.organizador_id = o.id),
         'vendidos', (select count(*) from casilleros n join tombolas t on t.id = n.tombola_id where t.organizador_id = o.id and n.estado = 'pagado'),
         'pagado_total', (select coalesce(sum(monto), 0) from pagos_suscripcion p where p.organizador_id = o.id))) as x
       from organizadores o) s), '[]'::json),
    'pagos', coalesce((select json_agg(row_to_json(p)) from (
       select ps.payment_id, ps.monto, ps.dias, ps.origen, ps.created_at, o.nombre, o.email
         from pagos_suscripcion ps join organizadores o on o.id = ps.organizador_id order by ps.created_at desc limit 50) p), '[]'::json));
end $$;

create or replace function public.api_dueno_bloquear(p_key text, p_org uuid, p_bloq boolean) returns void
language plpgsql security definer set search_path = public as $$
begin perform _chk(p_key); update organizadores set bloqueado = p_bloq, updated_at = now() where id = p_org and not es_dueno; end $$;

-- =====================================================================
-- Permisos: nadie puede ejecutar funciones salvo las api_* (con la clave del servidor)
-- =====================================================================
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.api_org_crear(text, text, text, text, text), public.api_org_login(text, text), public.api_org_get(text, uuid),
  public.api_org_tokens(text, uuid), public.api_org_update(text, uuid, json), public.api_org_por_mp_user(text, text),
  public.api_org_conectar_mp(text, uuid, text, text), public.api_suscripcion_pago(text, text, uuid, numeric, int, text),
  public.api_tombola_crear(text, uuid, text, json), public.api_tombola_update(text, uuid, uuid, json),
  public.api_tombolas_de_org(text, uuid), public.api_tombola_get(text, uuid), public.api_tombola_publica(text, text),
  public.api_reservar(text, uuid, int[], text, text), public.api_mis_compras(text, uuid, text), public.api_compra(text, uuid),
  public.api_comprobante(text, uuid, text, text, text, text), public.api_cancelar(text, uuid, text),
  public.api_admin_compras(text, uuid), public.api_admin_numeros(text, uuid), public.api_admin_ver_comprobante(text, uuid),
  public.api_admin_aprobar(text, uuid), public.api_admin_rechazar(text, uuid, text), public.api_admin_marcar_devuelta(text, uuid),
  public.api_registrar_pago(text, uuid, text, numeric, text), public.api_registrar_evento_pago(text, text, uuid, numeric, text, text),
  public.api_dueno_resumen(text), public.api_dueno_bloquear(text, uuid, boolean)
to anon;
