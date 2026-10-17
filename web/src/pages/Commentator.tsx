export function CommentatorPage() {
  return (
    <div className="mx-auto flex min-h-[calc(100vh-56px)] max-w-3xl flex-col items-center justify-center px-6 text-center">
      <div className="mb-8 grid h-20 w-20 place-items-center rounded-2xl border border-ink-700 bg-gradient-to-br from-ink-800 to-ink-900 shadow-xl">
        <svg viewBox="0 0 24 24" className="h-10 w-10 text-accent-400" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
          <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" />
        </svg>
      </div>
      <p className="text-xs font-semibold uppercase tracking-[0.25em] text-accent-400">Commentator</p>
      <h1 className="mt-3 text-3xl font-bold text-ink-50">Moduł w przygotowaniu</h1>
      <p className="mt-4 max-w-xl text-ink-400">
        Ten moduł będzie rozwijany w kolejnym etapie. Wszystkie dane drużyn, zawodników, flot i deklaracji są już gromadzone w zakładce
        <span className="font-semibold text-ink-200"> vMix graphics</span>.
      </p>
    </div>
  );
}
