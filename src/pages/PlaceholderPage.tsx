/** Placeholder for pages whose functionality arrives in later milestones. */
interface PlaceholderPageProps {
  title: string;
  blurb: string;
}

export function PlaceholderPage({ title, blurb }: PlaceholderPageProps) {
  return (
    <section className="page">
      <h1>{title}</h1>
      <p className="muted">{blurb}</p>
      <p className="muted">Coming in a later milestone.</p>
    </section>
  );
}
