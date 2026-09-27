export default async function RewritePage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  return (
    <div data-rewrite-slug={slug} data-rendered-at={performance.now()}>
      Page /rewrite/{slug}
    </div>
  )
}

export async function generateStaticParams() {
  return [{ slug: 'foo' }]
}
