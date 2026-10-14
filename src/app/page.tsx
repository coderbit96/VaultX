export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      <section className="w-full max-w-2xl rounded-3xl border border-white/10 bg-slate-900/80 p-8 shadow-2xl shadow-black/20 sm:p-12">
        <p className="mb-4 text-sm font-semibold uppercase tracking-[0.24em] text-cyan-300">
          VaultX
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          Project foundation is ready
        </h1>
        <p className="mt-5 leading-7 text-slate-300">
          This is the starting page for the VaultX Next.js app. Authentication,
          encryption, uploads, and private storage have not been implemented yet.
        </p>
        <p className="mt-6 rounded-xl border border-amber-300/20 bg-amber-300/5 px-4 py-3 text-sm leading-6 text-amber-100">
          Do not use this app to store personal files until its security and
          storage features are implemented and tested.
        </p>
      </section>
    </main>
  );
}
