import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Icon } from '@/components/common/Icon'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { useToast } from '@/hooks/useToast'
import {
  getCommunityConfig,
  setCommunityConfig,
  socialKeys,
  type CommunityConfig,
} from '@/api/social'

// The fields the admin can patch here (everything but canEdit).
type CommunityPatch = Partial<
  Pick<
    CommunityConfig,
    'defaultShare' | 'defaultShareListening' | 'notesEnabled' | 'clubsEnabled' | 'clubsAiEnabled'
  >
>

// A small on/off select control, styled like the rest of the config cards.
function ToggleField({
  label,
  value,
  onChange,
  onCopy,
  offCopy,
  onLabel = 'On',
  offLabel = 'Off',
}: {
  label: string
  value: boolean
  onChange: (v: boolean) => void
  onCopy: string
  offCopy: string
  onLabel?: string
  offLabel?: string
}) {
  return (
    <div className="cfg-card">
      <div className="field full">
        <label>{label}</label>
        <select
          className="fld"
          value={value ? 'on' : 'off'}
          onChange={(e) => onChange(e.target.value === 'on')}
        >
          <option value="on">{onLabel}</option>
          <option value="off">{offLabel}</option>
        </select>
      </div>
      <div className="banner info" style={{ marginTop: 'var(--s4)' }}>
        <Icon name="info" />
        {value ? onCopy : offCopy}
      </div>
    </div>
  )
}

// Community (social) admin settings: leaderboard/presence sharing defaults and
// the notes/clubs kill-switches. The sharing defaults only govern users who
// never set their own preference - flipping one is retroactive for them but
// never overrides an explicit choice.
export function ConfigCommunity() {
  const qc = useQueryClient()
  const { toast, show } = useToast()
  const { data, isLoading } = useQuery({
    queryKey: socialKeys.communityConfig,
    queryFn: getCommunityConfig,
    staleTime: 30 * 1000,
  })

  const save = useMutation({
    mutationFn: (patch: CommunityPatch) => setCommunityConfig(patch),
    onSuccess: (next: CommunityConfig) => {
      qc.setQueryData(socialKeys.communityConfig, next)
      // Re-rank the leaderboard with the new default applied (prefix match hits
      // every window).
      qc.invalidateQueries({ queryKey: ['social', 'leaderboard'] })
      show('Community settings saved')
    },
    onError: () => show('Could not save - admin permission required'),
  })

  if (isLoading || !data) {
    return (
      <>
        <div className="page-head">
          <div className="eyebrow">Admin</div>
          <h1 className="title-xl">Community</h1>
        </div>
        <LoadingSpinner className="py-12" label="Loading..." />
      </>
    )
  }

  return (
    <>
      {toast && (
        <div className="p-toast">
          <Icon name="check_circle" fill /> {toast}
        </div>
      )}
      <div className="page-head">
        <div className="eyebrow">Admin</div>
        <h1 className="title-xl">Community</h1>
        <p className="page-sub">
          Shared, cross-user features - the leaderboard, who's listening, notes, and book clubs.
        </p>
      </div>

      <div className="section-head">
        <Icon name="groups" />
        <h2>Default sharing</h2>
      </div>
      <ToggleField
        label="New and existing listeners appear on the leaderboard"
        value={data.defaultShare}
        onChange={(v) => save.mutate({ defaultShare: v })}
        onLabel="On - opt-out (shared by default)"
        offLabel="Off - opt-in (hidden by default)"
        onCopy="Listeners are shown on the leaderboard unless they turn sharing off for themselves. Anyone who already chose to hide stays hidden."
        offCopy="Listeners are hidden from the leaderboard unless they turn sharing on for themselves. Anyone who already chose to share stays shown."
      />

      <div className="section-head" style={{ marginTop: 'var(--s6)' }}>
        <Icon name="graphic_eq" />
        <h2>Listening now</h2>
      </div>
      <ToggleField
        label="Show listeners on a book as recently listening"
        value={data.defaultShareListening}
        onChange={(v) => save.mutate({ defaultShareListening: v })}
        onLabel="On - opt-out (shown by default)"
        offLabel="Off - opt-in (hidden by default)"
        onCopy="Listeners show up under 'Listening recently' on a book unless they turn it off. This is real-time presence, so consider leaving it off by default."
        offCopy="No one shows as recently listening unless they turn it on for themselves. Presence is more sensitive than a reading list, so this ships off."
      />

      <div className="section-head" style={{ marginTop: 'var(--s6)' }}>
        <Icon name="forum" />
        <h2>Notes &amp; clubs</h2>
      </div>
      <ToggleField
        label="Public notes"
        value={data.notesEnabled}
        onChange={(v) => save.mutate({ notesEnabled: v })}
        onCopy="Listeners can leave notes on a book, hidden ahead of each reader's position so nothing spoils. Turn off to hide notes everywhere."
        offCopy="Notes are turned off. Existing notes are hidden and no new ones can be posted until you turn this back on."
      />
      <div style={{ marginTop: 'var(--s4)' }}>
        <ToggleField
          label="Book clubs"
          value={data.clubsEnabled}
          onChange={(v) => save.mutate({ clubsEnabled: v })}
          onCopy="Listeners can start and join reading groups that move through books together. Turn off to hide clubs everywhere."
          offCopy="Book clubs are turned off. Existing clubs are hidden until you turn this back on."
        />
      </div>
      <div style={{ marginTop: 'var(--s4)' }}>
        <ToggleField
          label="Let clubs use AI for next-book picks"
          value={data.clubsAiEnabled}
          onChange={(v) => save.mutate({ clubsAiEnabled: v })}
          onLabel="On - AI picks allowed"
          offLabel="Off - simple picks only"
          onCopy="Club owners can ask the AI to suggest the club's next book. Each request uses your configured AI provider and counts against the same limit as QuestGiver. Turn off to keep clubs on the built-in picks, which need no AI."
          offCopy="Clubs suggest next books using a simple built-in match on the club's genres. No AI is called. Turn on to allow richer AI picks (uses your AI provider)."
        />
      </div>
    </>
  )
}
