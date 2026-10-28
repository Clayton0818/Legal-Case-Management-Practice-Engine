// Shared building blocks for the inner staff pages (espresso & champagne,
// Style B). Styling only — no data or behaviour lives here. Red / amber /
// green stay semantic (danger / warning / success) so alerts keep meaning.

type Tone = "neutral" | "info" | "warning" | "danger" | "success" | "brand";

const PILL_TONE: Record<Tone, { box: string; dot: string }> = {
  neutral: { box: "bg-slate-100 text-slate-700", dot: "bg-slate-400" },
  info: { box: "bg-[#EAEFF3] text-[#2C4256]", dot: "bg-[#5A7A94]" },
  warning: { box: "bg-[#F7EEDC] text-[#6B4614]", dot: "bg-[#C08A3E]" },
  danger: { box: "bg-red-50 text-red-800", dot: "bg-red-600" },
  success: { box: "bg-[#E5F1E8] text-[#23502F]", dot: "bg-[#3F8A57]" },
  brand: { box: "bg-espresso text-champagne-light", dot: "bg-champagne" },
};

const NOTICE_TONE: Record<Exclude<Tone, "brand" | "neutral">, string> = {
  info: "bg-[#EAEFF3] text-[#2C4256] ring-[#5A7A94]/20",
  warning: "bg-[#F7EEDC] text-[#6B4614] ring-[#C08A3E]/25",
  danger: "bg-red-50 text-red-800 ring-red-300",
  success: "bg-[#E5F1E8] text-[#23502F] ring-[#3F8A57]/25",
};

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow ? <p className="text-sm font-medium text-slate-500">{eyebrow}</p> : null}
        <h1 className="font-display text-4xl font-normal leading-none tracking-tight text-slate-900 md:text-5xl">{title}</h1>
        {description ? <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-600">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function SectionTitle({ children, hint }: { children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="mb-3">
      <h2 className="font-display text-2xl font-normal leading-tight text-slate-900">{children}</h2>
      {hint ? <p className="mt-1 text-sm text-slate-600">{hint}</p> : null}
    </div>
  );
}

export function Card({ children, className = "", dark = false }: { children: React.ReactNode; className?: string; dark?: boolean }) {
  const surface = dark ? "bg-espresso text-ivory-text" : "bg-white shadow-[0_1px_2px_rgba(36,27,23,0.05)] ring-1 ring-slate-900/5";
  return <div className={`rounded-[1.125rem] ${surface} ${className}`}>{children}</div>;
}

export function Notice({ tone = "warning", children }: { tone?: keyof typeof NOTICE_TONE; children: React.ReactNode }) {
  return (
    <div role={tone === "danger" ? "alert" : undefined} className={`rounded-[1.125rem] p-4 text-sm font-medium ring-1 ${NOTICE_TONE[tone]}`}>
      {children}
    </div>
  );
}

export function StatusPill({ tone = "neutral", children }: { tone?: Tone; children: React.ReactNode }) {
  const t = PILL_TONE[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${t.box}`}>
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${t.dot}`} />
      {children}
    </span>
  );
}
