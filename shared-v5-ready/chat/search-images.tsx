import Image from "next/image"

type SearchImagesProps = {
  results: Array<{
    url: string
    title?: string
    source?: string
  }>
}

export function SearchImages({ results }: SearchImagesProps) {
  if (!results.length) return null

  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
      {results.map((result, index) => (
        <div
          key={`${result.url}-${index}`}
          className="overflow-hidden rounded-lg border border-border"
        >
          <Image
            src={result.url}
            alt={result.title ?? "Search result"}
            width={400}
            height={400}
            className="h-full w-full object-cover"
          />
        </div>
      ))}
    </div>
  )
}
