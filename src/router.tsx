import { createBrowserRouter } from 'react-router-dom'
import { ProtectedLayout } from '@/components/layout/ProtectedLayout'
import { LoginPage } from '@/pages/LoginPage'
import { HomePage } from '@/pages/HomePage'
import { LibraryPage } from '@/pages/LibraryPage'
import { BookDetailPage } from '@/pages/BookDetailPage'
import { SeriesPage } from '@/pages/SeriesPage'
import { SeriesDetailPage } from '@/pages/SeriesDetailPage'
import { OAuthCallbackPage } from '@/pages/OAuthCallbackPage'
import { ComingSoonPage } from '@/pages/ComingSoonPage'
import { SettingsPage } from '@/pages/SettingsPage'

export const router = createBrowserRouter([
  {
    path: '/login',
    element: <LoginPage />,
  },
  {
    path: '/oauth/callback',
    element: <OAuthCallbackPage />,
  },
  {
    path: '/',
    element: <ProtectedLayout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'library', element: <LibraryPage /> },
      { path: 'library/:libraryId', element: <LibraryPage /> },
      { path: 'book/:itemId', element: <BookDetailPage /> },
      { path: 'series', element: <SeriesPage /> },
      { path: 'series/:seriesId', element: <SeriesDetailPage /> },
      // Stub routes for the full sidebar nav - replaced by real pages as each
      // build phase lands. Keeps the nav graceful instead of 404-ing.
      { path: 'search', element: <ComingSoonPage title="Search" eyebrow="Find anything" icon="search" /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'collections', element: <ComingSoonPage title="Collections" eyebrow="Hand-built shelves" icon="folder_special" /> },
      { path: 'playlists', element: <ComingSoonPage title="Playlists" eyebrow="Your queues" icon="queue_music" /> },
      { path: 'stats', element: <ComingSoonPage title="Stats" eyebrow="Your listening" icon="insights" /> },
      { path: 'sessions', element: <ComingSoonPage title="History" eyebrow="Recent listens" icon="history" /> },
      { path: 'player', element: <ComingSoonPage title="Now playing" eyebrow="The player" icon="graphic_eq" /> },
      { path: 'account', element: <ComingSoonPage title="Account" eyebrow="Your account" icon="person" /> },
      { path: 'upload', element: <ComingSoonPage title="Upload" eyebrow="Add to library" icon="upload" /> },
      { path: 'config', element: <ComingSoonPage title="Server & admin" eyebrow="Administration" icon="dns" /> },
      { path: '*', element: <ComingSoonPage title="Not found" eyebrow="404" icon="explore_off" /> },
    ],
  },
])
