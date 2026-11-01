// ═══════════════════════════════════════════════════════════
// admin-stats — النسخة النهائية لـ mehni-app
// • CORS: إعادة Origin المطابق فقط + Vary: Origin (لا "*" أبدًا)
// • Keyset pagination على المفتاح الفريد id (يعمل مع bigint و UUID)
// • بداية الشهر التقويمي UTC صراحةً
// • صفر Migration / صفر تغيير في الجداول أو الدوال الموجودة
// ═══════════════════════════════════════════════════════════
// @ts-ignore
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const BASE_HEADERS = {
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ── CORS على مساري OPTIONS وPOST معًا ──
function resolveCors(req: Request): { ok: boolean; headers: Record<string, string> } {
  const origin = req.headers.get("Origin");
  const allowed = (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (!origin) return { ok: true, headers: { ...BASE_HEADERS, "Vary": "Origin" } };
  if (allowed.includes(origin))
    return { ok: true, headers: { ...BASE_HEADERS, "Access-Control-Allow-Origin": origin, "Vary": "Origin" } };
  return { ok: false, headers: BASE_HEADERS };
}

const json = (body: unknown, status: number, extra: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { ...extra, "Content-Type": "application/json" } });
const notFound = (h: Record<string, string>) => json({ error: "not_found" }, 404, h);

// ── Keyset pagination على عمود فريد ذي ترتيب كلي ──
// ما يضمنه فعلًا:
//   ✓ يمنع تكرار الصفوف في البيانات المستقرة: كل جولة تأخذ id > آخر مفتاح مشاهد،
//     فلا يُجلب أي صف مرتين أبدًا.
//   ✓ يعمل مع bigint و UUID دون تعديل (PostgREST يدعم > على الاثنين).
// ما لا يضمنه (بصدق):
//   ⚠ لا يوفّر snapshot isolation: الجولات statements مستقلة؛ إدخال/حذف/تعديل
//     مُلتزم أثناء المسح قد يُفوّت صفًا أو يُدرجه رغم أنه وقع خارج نافذة زمنية،
//     لأن الترتيب على id لا يعكس زمن الإنشاء. أثره على إحصاءات شهرية مهمل.
async function fetchAll(
  db: any, table: string, select: string,
  filters: { col: string; op: string; val: string }[],
  keyCol: string,
): Promise<Record<string, any>[]> {
  const PAGE = 1000;
  let lastKey: number | string | null = null;
  let all: Record<string, any>[] = [];
  for (let guard = 0; guard < 500; guard++) {
    let q = db.from(table).select(select);
    for (const f of filters) q = q.filter(f.col, f.op, f.val);
    if (lastKey !== null) q = q.gt(keyCol, lastKey);
    const { data, error } = await q.order(keyCol, { ascending: true }).limit(PAGE);
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = data ?? [];
    if (rows.length === 0) return all;
    all = all.concat(rows);
    lastKey = rows[rows.length - 1][keyCol];
    if (rows.length < PAGE) return all;
  }
  throw new Error(`${table}: pagination_guard_exceeded`);
}

async function countRows(db: any, table: string, sinceIso?: string): Promise<number> {
  let q = db.from(table).select("id", { count: "exact", head: true });
  if (sinceIso) q = q.gte("created_at", sinceIso);
  const { count, error } = await q;
  if (error) throw new Error(`${table}-count: ${error.message}`);
  return count ?? 0;
}

function groupBy<T>(rows: T[], key: (r: T) => string): { name: string; count: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) { const k = key(r); m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m].map(([name, count]) => ({ name, count }));
}

Deno.serve(async (req: Request) => {
  // ── CORS في OPTIONS وPOST معًا ──
  const cors = resolveCors(req);
  if (req.method === "OPTIONS") {
    return cors.ok ? new Response("ok", { headers: cors.headers }) : new Response("forbidden", { status: 403 });
  }
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, cors.headers);
  if (!cors.ok) return json({ error: "origin_forbidden" }, 403, cors.headers);

  // ── 0) فحص كل الأسرار المطلوبة قبل إنشاء أي عميل — النقص = فشل آمن ──
  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const adminEmailsRaw = Deno.env.get("ADMIN_EMAILS");
  if (!url || !anon || !service || !adminEmailsRaw) {
    console.error("admin-stats: missing required secrets");
    return json({ error: "server_error" }, 500, cors.headers);
  }
  const adminEmails = adminEmailsRaw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (adminEmails.length === 0) {
    console.error("admin-stats: ADMIN_EMAILS empty");
    return json({ error: "server_error" }, 500, cors.headers);
  }

  // ── 1) من المتصل؟ التوكن من الهيدر فقط ──
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return notFound(cors.headers);

  const userClient = createClient(url, anon, { global: { headers: { Authorization: auth } } });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  const banned = user?.banned_until && new Date(user.banned_until) > new Date();
  if (authErr || !user || banned) return notFound(cors.headers);

  // ── 2) إداري؟ بريد مؤكد إلزاميًا + ضمن القائمة (Secret — الخادم فقط) ──
  if (!user.email_confirmed_at) return notFound(cors.headers);
  if (!adminEmails.includes((user.email ?? "").toLowerCase())) return notFound(cors.headers);

  // ── 3) service role داخليًا فقط ──
  const db = createClient(url, service);

  try {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const since30 = new Date(now - 30 * dayMs).toISOString();
    const since24 = new Date(now - dayMs).toISOString();
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const monthStartIso = monthStart.toISOString();
    const sinceEarliest = since30 < monthStartIso ? since30 : monthStartIso;

    const rows = await fetchAll(db, "ai_requests", "id, user_id, service_type, created_at",
      [{ col: "created_at", op: "gte", val: sinceEarliest }], "id");

    // quota_day من نوع date ← نافذة الجلب الأسبق تغطي الفترتين معًا
    const resv = await fetchAll(db, "ai_usage_reservations", "id, status, quota_day",
      [{ col: "quota_day", op: "gte", val: sinceEarliest.slice(0, 10) }], "id");
    // last30Days: مبني على quota_day (date) — أي حجوزات أيام التقويم الثلاثين الأخيرة،
    // ليس 30×24 ساعة بدقة (granularity اليوم لا الدقيقة)
    const resvRolling30 = resv.filter(r => r.quota_day >= since30.slice(0, 10));
    const resvCalendar = resv.filter(r => r.quota_day >= monthStartIso.slice(0, 10));

    const totalUsers = await countRows(db, "profiles");
    const newUsers30 = await countRows(db, "profiles", since30);
    const totalRequests = await countRows(db, "ai_requests");

    // ── النشاط: متدحرج مقابل تقويمي ──
    const rows30 = rows.filter(r => r.created_at >= since30);
    const active24 = new Set(rows.filter(r => r.created_at >= since24).map(r => r.user_id)).size;
    const active30 = new Set(rows30.map(r => r.user_id)).size;
    const monthRows = rows.filter(r => r.created_at >= monthStartIso);
    const activeMonth = new Set(monthRows.map(r => r.user_id)).size;

    const byService = groupBy(rows30, r => r.service_type);

    // ── السلسلة التقويمية: آخر 30 يومًا (UTC) ──
    const dailyMap = new Map<string, { requests: number; users: Set<string> }>();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now - i * dayMs).toISOString().slice(0, 10);
      dailyMap.set(d, { requests: 0, users: new Set() });
    }
    for (const r of rows30) {
      const bucket = dailyMap.get(r.created_at.slice(0, 10));
      if (bucket) { bucket.requests++; bucket.users.add(r.user_id); }
    }

    // ── التقييمات: آخر 20 (متوسطها موسوم صراحةً) ──
    const { data: fb, error: fbErr } = await db.from("feedback")
      .select("user_id, rating, message, created_at")
      .order("created_at", { ascending: false }).limit(20);
    if (fbErr) throw new Error(`feedback: ${fbErr.message}`);
    const fbIds = [...new Set((fb ?? []).map(f => f.user_id))];
    let nameOf: Record<string, string> = {};
    if (fbIds.length) {
      const { data: profs, error: profErr } = await db.from("profiles")
        .select("id, full_name").in("id", fbIds);
      if (profErr) throw new Error(`profiles: ${profErr.message}`);
      nameOf = Object.fromEntries((profs ?? []).map(p => [p.id, p.full_name]));
    }
    const ratings = (fb ?? []).map(f => f.rating);

    // ── الخطط: جلب مُصفّح على id (فريد) — لا يتوقف عند حد 1000 سجل ──
    const subs = await fetchAll(db, "subscriptions", "id, plan", [], "id");
    const plans = groupBy(subs, s => s.plan);

    // ── المعلّقون — أي فشل هنا = فشل آمن كامل ──
    let suspended = 0, page = 1;
    for (;;) {
      const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
      if (error) throw new Error(`listUsers: ${error.message}`);
      const us = data?.users ?? [];
      suspended += us.filter(u => u.banned_until && new Date(u.banned_until) > new Date()).length;
      if (us.length < 200) break;
      if (++page > 50) throw new Error("listUsers: page_guard_exceeded");
    }

    return json({
      window: {
        definition: "rolling = متدحرج من لحظة الطلب | calendar = منذ أول الشهر التقويمي (UTC)",
        rolling24hSince: since24,
        rolling30dSince: since30,
        calendarMonth: monthStartIso.slice(0, 7),
        fetchedSince: sinceEarliest,
      },
      users: { total: totalUsers, newRolling30d: newUsers30 },
      active: { rolling24h: active24, rolling30d: active30, calendarMonth: activeMonth },
      requests: { total: totalRequests, rolling30d: rows30.length, calendarMonthToDate: monthRows.length },
      byService,
      daily: [...dailyMap].map(([date, b]) => ({ date, requests: b.requests, activeUsers: b.users.size })),
      feedback: {
        avgRatingLatest20: ratings.length
          ? +(ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(2) : 0,
        latestCount: (fb ?? []).length,
        latest: (fb ?? []).map(f => ({
          name: nameOf[f.user_id] ?? "—", rating: f.rating, comment: f.message, at: f.created_at,
        })),
      },
      plans,
      suspended,
      reservations: {
        last30DaysByQuotaDate: groupBy(resvRolling30, r => r.status),
        calendarMonth: groupBy(resvCalendar, r => r.status),
      },
    }, 200, cors.headers);
  } catch (e) {
    console.error("admin-stats failed:", e);
    return json({ error: "stats_failed" }, 500, cors.headers);
  }
});
