import { Card } from '@fantom/ui'

export default function VideoLibraryPage() {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-fantom-text">Video Library</h1>
        <p className="mt-1 text-sm text-fantom-text-muted">
          Upload video clips for AI-edited Shorts, Long-form, and Episodic videos.
        </p>
      </div>

      {/* Empty state */}
      <Card className="flex flex-col items-center gap-4 py-20 text-center">
        <svg
          className="h-12 w-12 text-fantom-text-muted"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M15 10l4.553-2.069A1 1 0 0121 8.82v6.36a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"
          />
        </svg>
        <div>
          <p className="font-medium text-fantom-text">No videos yet</p>
          <p className="mt-1 text-sm text-fantom-text-muted">Video upload coming in next phase</p>
        </div>
      </Card>
    </div>
  )
}
