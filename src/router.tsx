import { createBrowserRouter, Navigate } from 'react-router-dom'
import { ProtectedLayout } from '@/components/layout/ProtectedLayout'
import { LoginPage } from '@/pages/LoginPage'
import { LibraryPage } from '@/pages/LibraryPage'
import { ContinueListeningPage } from '@/pages/ContinueListeningPage'
import { OAuthCallbackPage } from '@/pages/OAuthCallbackPage'

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
      { index: true, element: <Navigate to="/library" replace /> },
      { path: 'library', element: <LibraryPage /> },
      { path: 'library/:libraryId', element: <LibraryPage /> },
      { path: 'continue', element: <ContinueListeningPage /> },
    ],
  },
])
