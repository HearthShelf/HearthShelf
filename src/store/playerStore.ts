import { create } from 'zustand'
import type { ABSChapter, ABSAudioTrack, ABSPlaybackSession } from '@/api/types'

interface PlayerState {
  sessionId: string | null
  libraryItemId: string | null
  title: string | null
  author: string | null
  duration: number
  currentTime: number
  isPlaying: boolean
  chapters: ABSChapter[]
  tracks: ABSAudioTrack[]
  playbackSpeed: number
  volume: number
  // Bumped to ask the audio engine to seek to `seekTarget` (seconds).
  seekTarget: number
  seekNonce: number
  // A panel the mini play bar asked the full player to open on arrival
  // (chapters / bookmarks / queue). Consumed and cleared by PlayerPage.
  requestedPanel: 'chapters' | 'bookmarks' | 'queue' | null
  // True when the most recent progress sync to ABS failed, so the player can
  // show a "Sync issue" pill instead of "Synced".
  syncError: boolean

  openSession: (session: ABSPlaybackSession) => void
  closeSession: () => void
  setCurrentTime: (time: number) => void
  setDuration: (duration: number) => void
  setPlaying: (playing: boolean) => void
  togglePlaying: () => void
  setSpeed: (speed: number) => void
  setVolume: (volume: number) => void
  seek: (time: number) => void
  requestPanel: (panel: 'chapters' | 'bookmarks' | 'queue') => void
  clearRequestedPanel: () => void
  setSyncError: (error: boolean) => void
}

const initialState = {
  sessionId: null,
  libraryItemId: null,
  title: null,
  author: null,
  duration: 0,
  currentTime: 0,
  isPlaying: false,
  chapters: [] as ABSChapter[],
  tracks: [] as ABSAudioTrack[],
  playbackSpeed: 1,
  volume: 1,
  seekTarget: 0,
  seekNonce: 0,
  requestedPanel: null as 'chapters' | 'bookmarks' | 'queue' | null,
  syncError: false,
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  ...initialState,

  openSession: (s) =>
    set({
      sessionId: s.id,
      libraryItemId: s.libraryItemId,
      title: s.displayTitle,
      author: s.displayAuthor,
      duration: s.duration,
      currentTime: s.currentTime,
      chapters: s.chapters,
      tracks: s.audioTracks,
      isPlaying: true,
      seekTarget: s.currentTime,
      seekNonce: get().seekNonce + 1,
    }),

  closeSession: () =>
    set((state) => ({
      ...initialState,
      seekNonce: state.seekNonce,
      volume: state.volume,
      playbackSpeed: state.playbackSpeed,
    })),

  setCurrentTime: (currentTime) => set({ currentTime }),
  setDuration: (duration) => set({ duration }),
  setPlaying: (isPlaying) => set({ isPlaying }),
  togglePlaying: () => set((s) => ({ isPlaying: !s.isPlaying })),
  setSpeed: (playbackSpeed) => set({ playbackSpeed }),
  setVolume: (volume) => set({ volume: Math.max(0, Math.min(1, volume)) }),
  seek: (time) =>
    set((s) => ({
      seekTarget: time,
      seekNonce: s.seekNonce + 1,
      currentTime: time,
    })),
  requestPanel: (requestedPanel) => set({ requestedPanel }),
  clearRequestedPanel: () => set({ requestedPanel: null }),
  setSyncError: (syncError) => set({ syncError }),
}))
