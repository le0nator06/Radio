import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'

const originFallback = typeof window !== 'undefined' ? window.location.origin : undefined
const API_BASE = import.meta.env.VITE_API_BASE ?? originFallback ?? 'http://localhost:4000'
const STREAM_URL = import.meta.env.VITE_STREAM_URL ?? `${API_BASE}/stream`

type Track = {
  id: string
  title: string
  url: string
  thumbnail?: string
  duration?: number
  startedAt?: number
  source: 'youtube' | 'soundcloud'
  requestedBy: {
    id: string
    displayName: string
    avatar?: string
  }
}

type StreamState = {
  current: Track | null
  queue: Track[]
  listeners: number
  paused: boolean
}

type Me = {
  user: {
    id: string
    displayName: string
    avatar?: string
    isAdmin?: boolean
  } | null
  canQueue?: boolean
}

async function fetchJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {})
    }
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    throw new Error(payload.message ?? 'Server error')
  }

  return response.json() as Promise<T>
}

function formatDuration(seconds?: number | null) {
  if (seconds == null) return 'live'
  const total = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(total / 60)
  const rem = total % 60
  return `${minutes}:${rem.toString().padStart(2, '0')}`
}

function App() {
  const [state, setState] = useState<StreamState | null>(null)
  const [user, setUser] = useState<Me['user']>(null)
  const [canQueue, setCanQueue] = useState(false)
  const [url, setUrl] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const audioRef = useRef<HTMLAudioElement | null>(null)
  // Verlauf bereits gespielter Tracks (nur lokal im Client)
  const [history, setHistory] = useState<Track[]>([])
  const [displayTrack, setDisplayTrack] = useState<Track | null>(null)
  const displayTrackRef = useRef<Track | null>(null)
  const [isAudioEnded, setIsAudioEnded] = useState(false)

  const refreshState = useCallback(async () => {
    try {
      const data = await fetchJSON<StreamState>('/api/status')
      setState(data)
    } catch (statusError) {
      console.error(statusError)
    }
  }, [])

  useEffect(() => {
    let active = true

    // Check for error messages in URL
    const urlParams = new URLSearchParams(window.location.search)
    const errorParam = urlParams.get('error')
    if (errorParam === 'no_permission') {
      setError('Du hast keine Berechtigung, diesen Radio-Stream zu nutzen.')
      // Clear the error parameter from URL
      window.history.replaceState({}, '', window.location.pathname)
    } else if (errorParam === 'login_failed') {
      setError('Steam-Login fehlgeschlagen.')
      window.history.replaceState({}, '', window.location.pathname)
    }

    fetchJSON<Me>('/api/me')
      .then((data) => {
        if (active) {
          setUser(data.user)
          setCanQueue(data.canQueue ?? false)
        }
      })
      .catch(() => {
        if (active) {
          setUser(null)
          setCanQueue(false)
        }
      })

    void refreshState()
    const id = setInterval(() => void refreshState(), 1000)

    return () => {
      active = false
      clearInterval(id)
    }
  }, [refreshState])

  // Update time only when not paused to prevent timeline jumping
  useEffect(() => {
    if (state?.paused) {
      // Don't update time while paused - freeze at current moment
      return
    }
    // When resuming, sync now immediately
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [state?.paused])

  useEffect(() => {
    displayTrackRef.current = displayTrack
  }, [displayTrack])

  // Wenn der Server einen aktuellen Track meldet, immer ins UI uebernehmen.
  useEffect(() => {
    if (state?.current) {
      setDisplayTrack(state.current)
      setIsAudioEnded(false)
    }
  }, [state?.current?.id, state?.current])

  // Sync audio element with server pause state
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    if (state?.paused) {
      if (!audio.paused) {
        audio.pause()
      }
    } else {
      if (audio.paused && audio.readyState >= 2) {
        audio.play().catch(() => {
          // Ignore autoplay errors
        })
      }
    }
  }, [state?.paused])

  // Audio-Events steuern, wann der letzte Track wirklich "fertig" ist.
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const handlePlaying = () => {
      setIsAudioEnded(false)
    }

    const handleEnded = () => {
      const finished = displayTrackRef.current
      if (finished) {
        setHistory((prev) => [finished, ...prev])
      }
      setIsAudioEnded(true)
      setDisplayTrack(null)
    }

    audio.addEventListener('playing', handlePlaying)
    audio.addEventListener('ended', handleEnded)

    return () => {
      audio.removeEventListener('playing', handlePlaying)
      audio.removeEventListener('ended', handleEnded)
    }
  }, [])

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (!url.trim()) {
      setError('Bitte zuerst einen YouTube-Link einfuegen.')
      return
    }

    setSubmitting(true)
    setError(null)
    setMessage(null)
    try {
      await fetchJSON('/api/queue', {
        method: 'POST',
        body: JSON.stringify({ url })
      })
      setUrl('')
      setMessage('Track wurde zur Warteschlange hinzugefuegt.')
      await refreshState()
    } catch (submitError) {
      setError((submitError as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  const handleLogout = async () => {
    try {
      await fetchJSON('/auth/logout', { method: 'POST' })
      setUser(null)
      setCanQueue(false)
      setMessage('Du bist abgemeldet.')
    } catch (logoutError) {
      setError((logoutError as Error).message)
    }
  }

  const handlePause = async () => {
    if (!user) return
    try {
      const newPaused = !(state?.paused ?? false)
      await fetchJSON('/api/pause', {
        method: 'POST',
        body: JSON.stringify({ paused: newPaused })
      })
      await refreshState()
    } catch (pauseError) {
      setError((pauseError as Error).message)
    }
  }

  const handleSkip = async () => {
    if (!user) return
    try {
      await fetchJSON('/api/skip', {
        method: 'POST'
      })
      await refreshState()
    } catch (skipError) {
      setError((skipError as Error).message)
    }
  }

  const handleRemoveTrack = async (trackId: string) => {
    if (!user) return
    try {
      await fetchJSON(`/api/queue/${trackId}`, {
        method: 'DELETE'
      })
      await refreshState()
    } catch (removeError) {
      setError((removeError as Error).message)
    }
  }

  const handleMoveTrack = async (trackId: string, newIndex: number) => {
    if (!user) return
    try {
      await fetchJSON(`/api/queue/${trackId}`, {
        method: 'PATCH',
        body: JSON.stringify({ index: newIndex })
      })
      await refreshState()
    } catch (moveError) {
      setError((moveError as Error).message)
    }
  }

  // Alle kommenden Songs werden direkt aus dem Server-Queue gelesen
  const upcoming = useMemo(() => state?.queue ?? [], [state])
  // Prioritaet: solange der Server einen aktuellen Track meldet, diesen anzeigen.
  // Wenn der Server kurzzeitig keinen current kennt, aber der Player noch laeuft,
  // den zuletzt bekannten displayTrack weiter als "Live" anzeigen.
  const serverCurrent = state?.current ?? null
  const currentTrack = serverCurrent ?? (!isAudioEnded ? displayTrack : null)
  // In der Warteschlange sollen nur kommende Songs erscheinen
  const queueCount = upcoming.length

  // Fortschritt basiert auf dem vom Server gemeldeten Startzeitpunkt.
  // Bei Pause: Server liefert bereits angepasstes startedAt, also nur Server-Daten nutzen.
  // Bei Play: lokales now nutzen für smooth updates zwischen Polls.
  const elapsedSeconds = currentTrack?.startedAt
    ? Math.max(0, (now - currentTrack.startedAt) / 1000)
    : 0
  const durationSeconds = currentTrack?.duration ?? null
  const hasProgress = Boolean(currentTrack?.startedAt && durationSeconds)
  // Bei Pause nicht lokal hochzählen - Server-startedAt ist bereits korrigiert
  const elapsedDisplay = hasProgress && durationSeconds ? Math.min(durationSeconds, elapsedSeconds) : elapsedSeconds
  const progressPercent = hasProgress && durationSeconds ? Math.min(100, (elapsedDisplay / durationSeconds) * 100) : 0
  const remainingSeconds = hasProgress && durationSeconds ? Math.max(0, durationSeconds - elapsedDisplay) : null
  // Warteschlange zeigt ausschliesslich kommende Tracks
  const queueList = upcoming

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">SchwanzRadio</p>
          <h1>Dekadenter Steam-Radio-Club</h1>
          <p className="lede">
            Tritt via Steam ein, leg YouTube-Links auf und hoer in Echtzeit zu.
            Dieses Deck laeuft dauerhaft als MP3-Stream.
          </p>
        </div>
        <aside className="session">
          {user ? (
            <div className="session__card">
              <div className="session__user">
                {user.avatar ? (
                  <img src={user.avatar} alt={user.displayName} />
                ) : (
                  <div className="avatar-fallback">{user.displayName[0]}</div>
                )}
                <div>
                  <p className="label">Eingeloggt</p>
                  <div className="session__name">
                    <strong>{user.displayName}</strong>
                    {user.isAdmin && <span className="chip chip--accent">Admin</span>}
                  </div>
                </div>
              </div>
              <button className="ghost" onClick={handleLogout}>
                Logout
              </button>
            </div>
          ) : (
            <a className="steam-button" href={`${API_BASE}/auth/steam`}>
              Mit Steam verbinden
            </a>
          )}
        </aside>
      </header>

      <section className="panel audio-panel">
        <div className="now-playing">
          <div className="now-playing__art">
            {currentTrack?.thumbnail ? (
              <img src={currentTrack.thumbnail} alt={currentTrack.title} />
            ) : (
              <div className="now-playing__placeholder">Kein Bild</div>
            )}
            {currentTrack && <span className="now-playing__pill">{state?.paused ? 'Pausiert' : 'Live'}</span>}
          </div>
          <div className="now-playing__details">
            <p className="label">Live-Stream</p>
            <h2>{currentTrack?.title ?? 'Wartet auf ersten Track'}</h2>
            {currentTrack && (
              <>
                <p className="meta">
                  {currentTrack.requestedBy.displayName}
                  {currentTrack.duration ? ` · ${formatDuration(currentTrack.duration)}` : ''}
                </p>
                {hasProgress && (
                  <div className="progress">
                    <div className="progress__track">
                      <div className="progress__value" style={{ width: `${progressPercent}%` }} />
                    </div>
                    <div className="progress__labels">
                      <span>{formatDuration(elapsedSeconds)}</span>
                      <span>-{formatDuration(remainingSeconds)}</span>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
        <div className="audio-controls">
          <audio ref={audioRef} controls src={STREAM_URL} autoPlay preload="none" />
          {user && (
            <button className="pause-button" onClick={handlePause}>
              {state?.paused ? '▶ Fortsetzen' : '⏸ Pausieren'}
            </button>
          )}
          {user && (
            <button className="ghost" onClick={handleSkip}>
              ⏭ Skip
            </button>
          )}
        </div>
      </section>

      {message && <p className="toast success">{message}</p>}
      {error && <p className="toast error">{error}</p>}

      <section className="panel">
        <div className="panel__header">
          <div>
            <p className="label">Warteschlange</p>
            <h3>{queueCount ? `${queueCount} Tracks` : 'Noch leer'}</h3>
          </div>
          <span className="chip">{state?.listeners ?? 0} Zuhoerer</span>
        </div>
        <div className="queue">
          {queueList.map((track, index) => (
            <article key={track.id} className={index === 0 ? 'queue__item queue__item--current' : 'queue__item'}>
              <div className="queue__thumb">
                {track.thumbnail ? <img src={track.thumbnail} alt={track.title} /> : <div className="thumb-fallback" />}
              </div>
              <div className="queue__info">
                <p className="queue__title">{track.title}</p>
                <p className="queue__meta">
                  {'Wartet'} · {track.requestedBy.displayName} · {formatDuration(track.duration)}
                </p>
              </div>
              {user && (
                <div className="queue__actions">
                  <button
                    className="queue__btn"
                    onClick={() => handleMoveTrack(track.id, index - 1)}
                    disabled={index === 0}
                    title="Nach oben"
                  >
                    ▲
                  </button>
                  <button
                    className="queue__btn"
                    onClick={() => handleMoveTrack(track.id, index + 1)}
                    disabled={index === queueList.length - 1}
                    title="Nach unten"
                  >
                    ▼
                  </button>
                  <button
                    className="queue__btn queue__btn--remove"
                    onClick={() => handleRemoveTrack(track.id)}
                    title="Entfernen"
                  >
                    ✕
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <form onSubmit={handleSubmit} className="queue-form">
          <label htmlFor="link" className="label">
            YouTube-Link einreichen
          </label>
          <div className="form-row">
            <input
              id="link"
              type="url"
              placeholder="https://www.youtube.com/watch?v=..."
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              disabled={!canQueue || submitting}
            />
            <button type="submit" disabled={!canQueue || submitting}>
              {submitting ? 'Wird hinzugefuegt...' : 'Zur Queue' }
            </button>
          </div>
          {!user && <p className="hint">Nur eingeloggte Steam-Nutzer koennen Songs hinzufuegen.</p>}
          {user && !canQueue && <p className="hint">Dein Steam-Account ist nicht auf der Whitelist.</p>}
        </form>
      </section>

      {history.length > 0 && (
        <section className="panel">
          <div className="panel__header">
            <div>
              <p className="label">Verlauf</p>
              <h3>{history.length} gespielte Tracks</h3>
            </div>
          </div>
          <div className="queue">
            {history.map((track) => (
              <article key={track.id} className="queue__item">
                <div className="queue__thumb">
                  {track.thumbnail ? <img src={track.thumbnail} alt={track.title} /> : <div className="thumb-fallback" />}
                </div>
                <div>
                  <p className="queue__title">{track.title}</p>
                  <p className="queue__meta">Gespielt · {track.requestedBy.displayName} · {formatDuration(track.duration)}</p>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

export default App
