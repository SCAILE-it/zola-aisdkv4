type SourcesListProps = {
  sources: Array<{
    url: string
    title?: string
  }>
}

export function SourcesList({ sources }: SourcesListProps) {
  if (!sources.length) return null

  return (
    <div className="border-border mt-4 flex flex-col gap-2 rounded-lg border p-3">
      <p className="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
        Sources
      </p>
      <ul className="space-y-2 text-sm">
        {sources.map((source, index) => (
          <li key={`${source.url}-${index}`}>
            <a
              className="text-primary hover:underline"
              href={source.url}
              target="_blank"
              rel="noreferrer"
            >
              {source.title ?? source.url}
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}
