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
import { PlayerPage } from '@/pages/PlayerPage'
import { SearchPage } from '@/pages/SearchPage'
import { CollectionsPage } from '@/pages/CollectionsPage'
import { CollectionDetailPage } from '@/pages/CollectionDetailPage'
import { PlaylistsPage } from '@/pages/PlaylistsPage'
import { PlaylistDetailPage } from '@/pages/PlaylistDetailPage'
import { SessionsPage } from '@/pages/SessionsPage'
import { AuthorsPage } from '@/pages/AuthorsPage'
import { AuthorDetailPage } from '@/pages/AuthorDetailPage'
import { NarratorsPage } from '@/pages/NarratorsPage'

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
      { path: 'authors', element: <AuthorsPage /> },
      { path: 'author/:authorId', element: <AuthorDetailPage /> },
      { path: 'narrators', element: <NarratorsPage /> },
      // Stub routes for the full sidebar nav - replaced by real pages as each
      // build phase lands. Keeps the nav graceful instead of 404-ing.
      { path: 'search', element: <SearchPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'collections', element: <CollectionsPage /> },
      { path: 'collections/:collectionId', element: <CollectionDetailPage /> },
      { path: 'playlists', element: <PlaylistsPage /> },
      { path: 'playlists/:playlistId', element: <PlaylistDetailPage /> },
      { path: 'stats', element: <ComingSoonPage title="Stats" eyebrow="Your listening" icon="insights" /> },
      { path: 'sessions', element: <SessionsPage /> },
      { path: 'player', element: <PlayerPage /> },
      { path: 'account', element: <ComingSoonPage title="Account" eyebrow="Your account" icon="person" /> },
      { path: 'upload', element: <ComingSoonPage title="Upload" eyebrow="Add to library" icon="upload" /> },
      { path: 'config', element: <ComingSoonPage title="Server & admin" eyebrow="Administration" icon="dns" /> },
      { path: '*', element: <ComingSoonPage title="Not found" eyebrow="404" icon="explore_off" /> },
    ],
  },
])
