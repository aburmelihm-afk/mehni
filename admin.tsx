import { createFileRoute, redirect } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  AreaChart, Area, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { ShieldCheck, Users, Activity, MessageSquare, Star, Ban, Info } from "lucide-react";
import { Panel, pageMeta } from "@/components/bits";
import { useApp } from "@/lib/app-store";
import { supabase } from "@/lib/supabase";

export const Route = createFileRoute("/admin")({
  head: () => pageMeta("لوحة الإدارة — مهني AI", "Admin"),
  // الحارس هنا للجلسة فقط. قرار «إداري» يتخذه الخادم دائمًا (404 لغير الإداري).
  beforeLoad: async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw redirect({ to: "/login" });
  },
  component: AdminDashboard,
});

const COLORS = ["#7c5cff", "#22c55e", "#f59e0b", "#ef4444", "#06b6d4", "#8b5cf6"];
const SERVICE_AR: Record<string, string> = {
  assistant: "المساعد", resume: "السيرة", documents: "المستندات", business: "الأعمال", translate: "الترجمة",
};
const STATUS_AR: Record<string, string> = {
  pending: "قيد الانتظار", completed: "مكتمل", released: "مُحرَّر", failed: "فاشل", charged: "محسوب",
};
const label = (m: Record<string, string>, v: string) => m[v] ?? v;

async function getAdminStats() {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-stats-mehni`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
      Authorization: `Bearer ${session?.access_token ?? ""}`,
    },
    body: JSON.stringify({}),
  });
  if (res.status === 404) throw new Error("forbidden"); // الخادم يخفي المسار عن غير الإداريين
  if (!res.ok) throw new Error(`error_${res.status}`);
  return res.json();
}

function Stat({ icon: Icon, t, value, sub, tone = "text-primary-glow" }: any) {
  return (
    <Panel className="min-w-0">
      <div className="flex items-center gap-2 text-xs text-muted-foreground"><Icon className={`size-4 ${tone}`} />{t}</div>
      <div className="mt-2 text-2xl font-bold tabular-nums">{value}</div>
      {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
    </Panel>
  );
}

function StatusList({ title, rows }: { title: string; rows: { name: string; count: number }[] }) {
  return (
    <Panel>
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Info className="size-4 text-primary-glow" />{title}</h2>
      <ul className="space-y-2 text-sm">
        {(rows ?? []).map(r => (
          <li key={r.name} className="flex items-center justify-between gap-3">
            <span>{label(STATUS_AR, r.name)}</span>
            <span className="tabular-nums font-semibold">{r.count}</span>
          </li>
        ))}
        {(rows ?? []).length === 0 && <li className="text-muted-foreground">لا بيانات</li>}
      </ul>
    </Panel>
  );
}

function AdminDashboard() {
  const { tr } = useApp();
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: ["admin-stats"],
    queryFn: getAdminStats,
    refetchInterval: 60_000,
    retry: false,
  });

  if (isLoading) return <div className="p-10 text-center text-muted-foreground">جارٍ التحميل…</div>;
  if (error?.message === "forbidden")
    return <div className="p-10 text-center text-muted-foreground">{tr("غير مصرّح بالوصول إلى لوحة الإدارة.", "Not authorized.")}</div>;
  if (error)
    return (
      <div className="p-10 text-center">
        <p className="mb-3 text-muted-foreground">{tr("تعذّر تحميل الإحصاءات.", "Failed to load stats.")}</p>
        <button onClick={() => refetch()} className="rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">
          {tr("إعادة المحاولة", "Retry")}
        </button>
      </div>
    );

  const pieData = (data.byService ?? []).map((s: any) => ({ name: label(SERVICE_AR, s.name), value: s.count }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-6 text-primary-glow" />
          <h1 className="text-xl font-bold md:text-2xl">لوحة الإدارة</h1>
        </div>
        <p className="max-w-md text-xs text-muted-foreground">{data.window?.definition}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat icon={Users} t="المستخدمون" value={data.users.total} sub={`+${data.users.newRolling30d} بـ30 يومًا`} />
        <Stat icon={Activity} t="نشطون 24 ساعة" value={data.active.rolling24h} sub="متدحرجة" />
        <Stat icon={Activity} t="نشطون 30 يومًا" value={data.active.rolling30d} sub="متدحرجة" />
        <Stat icon={MessageSquare} t="طلبات AI" value={data.requests.total} sub={`${data.requests.rolling30d} بـ30 يومًا`} />
        <Stat icon={Star} t="متوسط التقييم" value={data.feedback.avgRatingLatest20} sub={`آخر ${data.feedback.latestCount} تقييمًا`} />
        <Stat icon={Ban} t="حسابات معلّقة" value={data.suspended} tone={data.suspended > 0 ? "text-amber-500" : undefined} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <h2 className="mb-3 font-semibold">الطلبات والنشاط — آخر 30 يومًا (تقويمي UTC)</h2>
          <div className="h-64">
            <ResponsiveContainer>
              <AreaChart data={data.daily}>
                <defs>
                  <linearGradient id="gReq" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#7c5cff" stopOpacity={0.35} /><stop offset="100%" stopColor="#7c5cff" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="date" fontSize={11} /><YAxis fontSize={11} allowDecimals={false} />
                <Tooltip /><Legend />
                <Area type="monotone" dataKey="requests" name="الطلبات" stroke="#7c5cff" fill="url(#gReq)" />
                <Area type="monotone" dataKey="activeUsers" name="مستخدمون نشطون" stroke="#22c55e" fill="none" strokeWidth={2} strokeDasharray="4 4" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel>
          <h2 className="mb-3 font-semibold">الاستخدام حسب الخدمة (30 يومًا)</h2>
          <div className="h-64">
            <ResponsiveContainer>
              <PieChart>
                <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={3}>
                  {pieData.map((_: any, i: number) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip /><Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <StatusList title="حالات الحجوزات — آخر 30 يومًا (حسب quota_day)" rows={data.reservations.last30DaysByQuotaDate} />
        <StatusList title={`حالات الحجوزات — شهر ${data.window.calendarMonth} (تقويمي UTC)`} rows={data.reservations.calendarMonth} />

        <Panel>
          <h2 className="mb-3 font-semibold">الخطط</h2>
          <ul className="space-y-2 text-sm">
            {(data.plans ?? []).map(p => (
              <li key={p.name} className="flex items-center justify-between gap-3">
                <span>{p.name}</span><span className="tabular-nums font-semibold">{p.count}</span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel>
          <h2 className="mb-3 font-semibold">أحدث التقييمات</h2>
          <ul className="max-h-56 space-y-2 overflow-y-auto pe-1 text-sm">
            {(data.feedback.latest ?? []).map((f: any) => (
              <li key={f.at + f.name} className="rounded-xl border bg-background/50 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{f.name}</span>
                  <span className="text-amber-500">{"★".repeat(f.rating)}<span className="text-muted-foreground/40">{"★".repeat(5 - f.rating)}</span></span>
                </div>
                {f.comment && <p className="mt-1 text-muted-foreground">{f.comment}</p>}
                <p className="mt-1 text-xs text-muted-foreground">{new Date(f.at).toLocaleString("ar")}</p>
              </li>
            ))}
            {(data.feedback.latest ?? []).length === 0 && <li className="text-muted-foreground">لا تقييمات بعد</li>}
          </ul>
        </Panel>
      </div>
    </div>
  );
}
