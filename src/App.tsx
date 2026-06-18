import { Wordmark } from '@/components/common/Wordmark'

function App() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-2 p-8 text-center">
      <Wordmark className="text-5xl" />
      <p className="text-neutral-400">
        Browser-first AudiobookShelf client. v0.1 scaffold.
      </p>
    </div>
  )
}

export default App
